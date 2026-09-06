/**
 * LLM Fetch 服务。
 *
 * 提供带超时和调试功能的自定义 fetch 包装器，用于将请求/响应日志
 * 和请求体增强注入到 AI SDK 的底层 HTTP 调用中。
 */
export class LlmFetchService {
  /**
   * @param {{
   *   log: Logger,
   *   exchangeState: import("./client_exchange_state.js").ClientExchangeState,
   *   augmentService: import("./llm_augment_service.js").LlmAugmentService,
   *   streamService: import("./llm_stream_service.js").LlmStreamService,
   *   resolveStreamFlag: (config: any) => boolean
   * }} deps
   */
  constructor({ log, exchangeState, augmentService, streamService, resolveStreamFlag }) {
    this._log = log;
    this._exchangeState = exchangeState;
    this._augmentService = augmentService;
    this._streamService = streamService;
    this._resolveStreamFlag = resolveStreamFlag;
  }

  /**
   * 创建带超时控制的自定义 fetch 函数。
   * @param {any} config
   * @returns {(url: string|Request, options?: RequestInit & { signal?: AbortSignal }) => Promise<Response>}
   */
  createTimeoutFetch(config) {
    const originalFetch = globalThis.fetch;
    const self = this;
    // 从配置中读取超时时间，默认30分钟（1800000毫秒）
    const timeoutMs = config.timeout ?? 1800000;
    const normalizeHeaders = (headers) => {
      if (!headers) {
        return {};
      }
      if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
      }
      if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
      }
      return { ...headers };
    };
    const redactSensitiveHeaders = (headers) => {
      const nextHeaders = { ...headers };
      for (const key of Object.keys(nextHeaders)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === "authorization" || normalizedKey === "proxy-authorization" || normalizedKey === "x-api-key") {
          nextHeaders[key] = "[REDACTED]";
        }
      }
      return nextHeaders;
    };
    const serializeRequestBody = async (body, sourceRequest) => {
      if (typeof body === "string") {
        return body;
      }
      if (body == null && sourceRequest instanceof Request) {
        try {
          return await sourceRequest.clone().text();
        } catch (error) {
          return `[UNREADABLE_REQUEST_BODY:${error?.message ?? String(error)}]`;
        }
      }
      if (body == null) {
        return "";
      }
      if (body instanceof URLSearchParams) {
        return body.toString();
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const entries = [];
        for (const [name, value] of body.entries()) {
          if (typeof value === "string") {
            entries.push([name, value]);
          } else {
            entries.push([name, `[Blob name=${value?.name ?? ""} type=${value?.type ?? ""} size=${value?.size ?? ""}]`]);
          }
        }
        return JSON.stringify(entries);
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return await body.text();
      }
      if (body instanceof ArrayBuffer) {
        return Buffer.from(body).toString("utf8");
      }
      if (ArrayBuffer.isView(body)) {
        return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
      }
      if (typeof body === "object") {
        try {
          return JSON.stringify(body);
        } catch {
          return String(body);
        }
      }
      return String(body);
    };
    const readResponseBodySafely = async (response) => {
      try {
        return await response.text();
      } catch (error) {
        return `[UNREADABLE_RESPONSE_BODY:${error?.message ?? String(error)}]`;
      }
    };

    void this._log.info(`[DEBUG] LlmClient._createTimeoutFetch created`, { timeoutMs });

    return async function timeoutFetch(url, options) {
      const requestId = Math.random().toString(36).substring(2, 10);
      const startTime = Date.now();
      const sourceRequest = url instanceof Request ? url : null;
      const requestUrl = url.toString?.() || url;
      const requestMethod = options?.method || sourceRequest?.method || "GET";
      const rawRequestHeaders = options?.headers || sourceRequest?.headers;
      const requestAugmentationId = self._augmentService.extractRequestAugmentationIdFromHeaders(rawRequestHeaders);
      const requestAugmentation = requestAugmentationId
        ? self._exchangeState.augmentations.get(requestAugmentationId) ?? null
        : null;
      const forwardRequestHeaders = self._augmentService.buildForwardRequestHeaders(rawRequestHeaders);
      const streamInjectedRequestBody = self._augmentService.injectConfiguredStreamIntoRequestBody(
        requestUrl,
        options?.body,
        config
      );
      // 向 OpenAI 兼容服务注入 thinking 字段（如 z.ai glm 系列），需在
      // reasoning 注入之前完成，两者作用于请求体不同字段互不干扰。
      const thinkingInjectedRequestBody = self._augmentService.injectThinkingIntoRequestBody(
        requestUrl,
        streamInjectedRequestBody,
        config
      );
      const augmentedRequestBody = self._augmentService.injectAssistantToolReasoningIntoRequestBody(
        requestUrl,
        thinkingInjectedRequestBody,
        requestAugmentation
      );
      // 用动态计算的输出上限覆盖 ai-sdk 内部的默认值（如 Anthropic provider
      // 对未知模型回退到 4096），确保发送给 API 的 max_tokens 是我们计算的值。
      let requestBodySource = augmentedRequestBody;
      const maxTokensOverride = self._exchangeState.maxTokensOverride;
      if (maxTokensOverride != null && typeof requestBodySource === "string") {
        try {
          const parsedBody = JSON.parse(requestBodySource);
          if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
            parsedBody.max_tokens = maxTokensOverride;
            requestBodySource = JSON.stringify(parsedBody);
          }
        } catch {
          // 非 JSON 体，不注入
        }
      }
      const requestHeaders = redactSensitiveHeaders(
        normalizeHeaders(forwardRequestHeaders)
      );
      const requestBody = await serializeRequestBody(requestBodySource, sourceRequest);

      void self._log.info(`[DEBUG] Fetch request started`, {
        requestId,
        url: requestUrl,
        timeoutMs
      });
      const fullHttpRequestSnapshot = JSON.stringify({
        requestId,
        method: requestMethod,
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody
      });
      void self._log.info(`[DEBUG] Full HTTP request before fetch: ${fullHttpRequestSnapshot}`);

      // 创建 AbortController 用于超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        void self._log.info(`[DEBUG] Fetch timeout triggered`, { requestId, timeoutMs });
      }, timeoutMs);

      // 合并 signal（如果外部传入了 abortSignal）
      const originalSignal = options?.signal;
      if (originalSignal) {
        // 如果外部 signal 已经触发，立即取消
        if (originalSignal.aborted) {
          controller.abort();
        } else {
          // 监听外部 signal 的变化
          originalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      // 打印完整的 HTTP 请求体，方便验证记忆上下文等 ephemeral 内容
      try {
        const parsedBody = typeof requestBodySource === "string"
          ? JSON.parse(requestBodySource)
          : requestBodySource;
        const messages = parsedBody?.messages;
        const system = parsedBody?.system;
        let logLines = [];
        logLines.push(`[LLM-REQUEST-BODY] requestId=${requestId} url=${requestUrl}`);
        if (system) {
          logLines.push(`┌─ system ───────────────────────────`);
          logLines.push(`│ ${typeof system === "string" ? system : JSON.stringify(system, null, 2)}`);
          logLines.push(`└────────────────────────────────────`);
        }
        if (Array.isArray(messages)) {
          logLines.push(`messagesCount=${messages.length}`);
          messages.forEach((m, i) => {
            const role = m?.role ?? "unknown";
            const content = m?.content;
            logLines.push(`┌─ [${i}] role=${role} ──────────────────`);
            if (typeof content === "string") {
              logLines.push(`│ ${content}`);
            } else if (Array.isArray(content)) {
              content.forEach((part, pi) => {
                if (part?.type === "text") {
                  logLines.push(`│ [part ${pi}:text] ${part.text}`);
                } else if (part?.type === "image_url") {
                  const url = part?.image_url?.url ?? "";
                  logLines.push(`│ [part ${pi}:image] ${url.slice(0, 80)}${url.length > 80 ? "..." : ""}`);
                } else {
                  logLines.push(`│ [part ${pi}:${part?.type ?? "unknown"}]`);
                }
              });
            } else {
              logLines.push(`│ ${String(content ?? "")}`);
            }
            logLines.push(`└────────────────────────────────────`);
          });
        }
        void self._log.info(logLines.join("\n"));
      } catch (_e) {
        void self._log.info(`[LLM-REQUEST-BODY] requestId=${requestId} url=${requestUrl} body=${String(requestBodySource ?? "")}`);
      }

      try {
        const fetchOptions = {
          ...options,
          headers: forwardRequestHeaders,
          ...(requestBodySource !== undefined ? { body: requestBodySource } : {}),
          signal: controller.signal,
        };

        const response = await originalFetch(url, fetchOptions);
        clearTimeout(timeoutId);

        const latency = Date.now() - startTime;
        const responseHeaders = redactSensitiveHeaders(
          normalizeHeaders(response.headers)
        );
        const responseContentType = (response.headers?.get?.("content-type") ?? "").toLowerCase();
        const isStreamingResponse = responseContentType.includes("text/event-stream");

        // 流式响应不阻塞等待完整 body，避免卡住导致超时。
        // 但我们需要保存 body 供 _buildAssistantMessageFromStreamResponse 回退使用，
        // 因此启动后台异步读取，读取完后更新 _lastHttpExchange。
        let responseBody;
        if (isStreamingResponse) {
          responseBody = "[SSE_STREAMING_BODY]";
          // 后台异步读取完整流式 body，不阻塞 fetch 返回
          const streamClone = response.clone();
          readResponseBodySafely(streamClone).then((fullBody) => {
            if (self._exchangeState.lastHttpExchange?.response) {
              self._exchangeState.lastHttpExchange.response.body = fullBody;
            }
          }).catch(() => {
            // 后台读取失败不影响主流程
          });
        } else {
          responseBody = await readResponseBodySafely(response.clone());
        }

        // 非流式 Anthropic Messages 响应：给缺失 signature 的 thinking 块补占位
        // 签名，避免 ai-sdk 响应 schema 校验失败被统一包装为 "Invalid JSON
        // response"（背景详见 LlmAugmentService.repairThinkingSignatureInResponseBody）。
        let finalResponse = response;
        if (!isStreamingResponse && response.ok) {
          const signatureRepair = self._augmentService.repairThinkingSignatureInResponseBody(requestUrl, responseBody);
          if (signatureRepair.repairedCount > 0) {
            const patchedHeaders = new Headers(response.headers);
            patchedHeaders.set("content-length", String(Buffer.byteLength(signatureRepair.body, "utf8")));
            responseBody = signatureRepair.body;
            void self._log.info(`[DEBUG] Patched placeholder signature into thinking blocks`, {
              requestId,
              url: requestUrl,
              repairedCount: signatureRepair.repairedCount
            });
            // 完整响应体已从 clone 读出，原响应体流不再被消费；主动释放避免占用连接
            response.body?.cancel().catch((cancelError) => {
              void self._log.error("释放原始响应体流失败", {
                requestId,
                url: requestUrl,
                errorMessage: cancelError?.message ?? String(cancelError),
                stack: cancelError?.stack ?? null
              });
            });
            finalResponse = new Response(responseBody, {
              status: response.status,
              statusText: response.statusText,
              headers: patchedHeaders
            });
          }
        }

        const isStreamLikeResponse = isStreamingResponse || self._streamService.isStreamLikeResponseBody(responseBody);
        let responseJsonParseError = null;
        if (responseBody && responseBody !== "" && !isStreamLikeResponse) {
          try {
            JSON.parse(responseBody);
          } catch (error) {
            responseJsonParseError = error?.message ?? String(error);
          }
        }
        self._exchangeState.lastHttpExchange = {
          requestId,
          capturedAt: new Date().toISOString(),
          latencyMs: latency,
          request: {
            method: requestMethod,
            url: requestUrl,
            headers: requestHeaders,
            body: requestBody
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody
          }
        };

        void self._log.info(`[DEBUG] Fetch request completed`, {
          requestId,
          status: response.status,
          statusText: response.statusText,
          latencyMs: latency,
        });
        void self._log.debug(`LLM response received`, {
          requestId,
          status: response.status,
          statusText: response.statusText,
          contentLength: typeof responseBody === 'string' ? responseBody.length : JSON.stringify(responseBody).length,
          latencyMs: latency,
          content:typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
        });
        if (response.ok && responseBody === "") {
          void self._log.error(`[ERROR] Empty HTTP response body from LLM service`, {
            requestId,
            latencyMs: latency,
            request: {
              method: requestMethod,
              url: requestUrl,
              headers: requestHeaders,
              body: requestBody
            },
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
              body: responseBody
            }
          });
          const emptyBodyError = new Error("LLM service returned empty response body");
          emptyBodyError.name = "EmptyResponseBodyError";
          emptyBodyError.code = "LLM_EMPTY_RESPONSE_BODY";
          emptyBodyError.requestId = requestId;
          throw emptyBodyError;
        }
        if (!response.ok || responseJsonParseError) {
          void self._log.error(`[ERROR] Full HTTP exchange for LLM request`, {
            requestId,
            latencyMs: latency,
            request: {
              method: requestMethod,
              url: requestUrl,
              headers: requestHeaders,
              body: requestBody
            },
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
              body: responseBody
            },
            responseJsonParseError,
            isStreamLikeResponse
          });
        }

        // 修补发生时 finalResponse 是带占位签名的新 Response，必须返回它
        return finalResponse;
      } catch (error) {
        clearTimeout(timeoutId);
        const latency = Date.now() - startTime;

        // 判断是否是超时错误
        if (error?.name === 'AbortError' && latency >= timeoutMs - 100) {
          const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
          timeoutError.name = 'TimeoutError';
          timeoutError.code = 'ETIMEDOUT';
          void self._log.error(`[DEBUG] Fetch timeout error`, {
            requestId,
            timeoutMs,
            latencyMs: latency,
            url: url.toString?.() || url,
          });
          throw timeoutError;
        }

        // 记录其他网络层错误
        void self._log.error(`[ERROR Fetch ${requestId}] Network Error`, {
          errorType: error?.name || 'UnknownError',
          errorMessage: error?.message || String(error),
          latencyMs: latency,
          request: {
            method: requestMethod,
            url: requestUrl,
            headers: requestHeaders,
            body: requestBody
          }
        });
        throw error;
      }
    };
  }

  /**
   * 创建调试用 fetch 函数（打印到 console.error）。
   * @param {any} config
   * @returns {(url: string|Request, options?: RequestInit) => Promise<Response>}
   */
  createDebugFetch(config) {
    const originalFetch = globalThis.fetch;

    return async function debugFetch(url, options) {
      const requestId = Math.random().toString(36).substring(2, 10);
      const startTime = Date.now();

      // 记录请求信息
      console.error(`[DEBUG Fetch ${requestId}] Request:`, {
        url: url.toString?.() || url,
        method: options?.method || 'GET',
        headers: options?.headers,
        bodyLength: options?.body?.length || 0,
        model: config.model,
      });

      try {
        const response = await originalFetch(url, options);
        const latency = Date.now() - startTime;

        // 克隆响应以便读取 body（不影响原始响应）
        const responseClone = response.clone();

        // 尝试读取响应体
        let responseBody = null;
        let responseText = null;
        try {
          responseText = await responseClone.text();
          // 尝试解析为 JSON
          try {
            responseBody = JSON.parse(responseText);
          } catch {
            // 不是 JSON，保留原始文本
            responseBody = responseText;
          }
        } catch (e) {
          responseBody = `[无法读取响应体: ${e.message}]`;
        }

        // 记录响应信息
        const isError = !response.ok || response.status >= 400;
        const logLevel = isError ? 'ERROR' : 'DEBUG';
        console.error(`[${logLevel} Fetch ${requestId}] Response:`, {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          latencyMs: latency,
          bodyType: typeof responseBody === 'object' ? 'json' : 'text',
          bodyPreview: typeof responseText === 'string'
            ? responseText.substring(0, 2000) // 限制长度
            : JSON.stringify(responseBody).substring(0, 2000),
          isFullBody: typeof responseText === 'string'
            ? responseText.length <= 2000
            : JSON.stringify(responseBody).length <= 2000,
        });

        return response;
      } catch (error) {
        const latency = Date.now() - startTime;
        // 记录网络层错误
        console.error(`[ERROR Fetch ${requestId}] Network Error:`, {
          errorType: error?.name || 'UnknownError',
          errorMessage: error?.message || String(error),
          latencyMs: latency,
          stack: error?.stack,
        });
        throw error;
      }
    };
  }
}
