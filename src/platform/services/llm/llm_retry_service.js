/**
 * LLM 重试服务。
 *
 * 提供空响应重试方差构建、错误类型判断和睡眠等待等重试相关能力。
 * 此服务是无状态的，不持有任何实例状态。
 */
export class LlmRetryService {
  constructor() {}

  /**
   * 为空响应错误构建重试方差（retry variance）。
   * 当上一次请求返回空响应体时，在下一次重试的末尾消息中追加空白字符，
   * 以打乱请求的确定性，尝试绕过模型服务端的缓存或重复检测。
   *
   * @param {number} attempt - 当前重试次数（0-based）
   * @param {Error|null} lastError - 上一次的错误
   * @param {any[]} messages - 当前请求消息列表
   * @returns {{ reason: string, attempt: number, targetIndex: number, whitespaceLength: number, messages: any[] } | null}
   */
  buildRetryVarianceForEmptyResponse(attempt, lastError, messages) {
    if (attempt <= 0 || !this.isEmptyResponseError(lastError) || !Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    const targetIndex = this._findRetryVarianceMessageIndex(messages);
    if (targetIndex < 0) {
      return null;
    }
    const whitespace = " ".repeat(Math.min(attempt, 3));
    const nextMessages = messages.map((message, index) => {
      if (index !== targetIndex) {
        return message;
      }
      return this._appendWhitespaceToMessage(message, whitespace);
    });
    return {
      reason: "empty_response_body",
      attempt: attempt + 1,
      targetIndex,
      whitespaceLength: whitespace.length,
      messages: nextMessages
    };
  }

  /**
   * 判断错误是否是空响应体错误。
   * @param {Error|null} error
   * @returns {boolean}
   */
  isEmptyResponseError(error) {
    const chain = this._collectErrorChain(error);
    return chain.some((item) => {
      const code = item?.code ?? "";
      const name = item?.name ?? "";
      const message = typeof item?.message === "string" ? item.message : "";
      return code === "LLM_EMPTY_RESPONSE_BODY"
        || name === "EmptyResponseBodyError"
        || message.includes("empty response body");
    });
  }

  /**
   * 判断错误是否应视为中止错误。
   * @param {Error} error
   * @param {AbortSignal|null} signal
   * @returns {boolean}
   */
  shouldTreatAsAbortError(error, signal) {
    if (signal?.aborted) {
      return true;
    }
    const errorType = error?.name ?? "UnknownError";
    if (errorType !== "AbortError") {
      return false;
    }
    if (this.isEmptyResponseError(error)) {
      return false;
    }
    return true;
  }

  /**
   * 异步睡眠，支持通过 AbortSignal 提前中断。
   * @param {number} ms - 睡眠毫秒数
   * @param {AbortSignal|null} signal
   * @returns {Promise<void>}
   */
  async sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(resolve, ms);

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          const error = new Error("Sleep interrupted");
          error.name = "AbortError";
          reject(error);
          return;
        }

        const abortHandler = () => {
          clearTimeout(timeoutId);
          const error = new Error("Sleep interrupted");
          error.name = "AbortError";
          reject(error);
        };

        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  // ─── 私有辅助方法 ────────────────────────────────────────

  _findRetryVarianceMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== "user" && message?.role !== "system") {
        continue;
      }
      if (typeof message?.content === "string") {
        return index;
      }
      if (Array.isArray(message?.content)) {
        const hasTextPart = message.content.some((part) => part?.type === "text" && typeof part?.text === "string");
        if (hasTextPart) {
          return index;
        }
      }
    }
    return -1;
  }

  _appendWhitespaceToMessage(message, whitespace) {
    if (!message || typeof whitespace !== "string" || whitespace.length === 0) {
      return message;
    }
    if (typeof message.content === "string") {
      return { ...message, content: `${message.content}${whitespace}` };
    }
    if (Array.isArray(message.content)) {
      let appended = false;
      const nextContent = message.content.map((part) => {
        if (appended || part?.type !== "text" || typeof part?.text !== "string") {
          return part;
        }
        appended = true;
        return { ...part, text: `${part.text}${whitespace}` };
      });
      return { ...message, content: nextContent };
    }
    return message;
  }

  _collectErrorChain(error) {
    const chain = [];
    const visited = new Set();
    let current = error;
    while (current && typeof current === "object" && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      current = current.cause;
    }
    return chain;
  }
}
