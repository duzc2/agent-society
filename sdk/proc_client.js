/**
 * 进程消息协议客户端 SDK（Node 版）
 *
 * 用法（在智能体通过 localcmd_spawn 启动的进程内）：
 *   const { createProcClient } = await import(process.env.SOCIETY_PROC_SDK_URL); // 动态 import（静态 import 无法引用环境变量）
 *   const proc = await createProcClient({ name: "crawler" });    // 只需一个进程名（须唯一，同名会顶掉先接入的连接）
 *   proc.onMessage((payload) => { ... });      // 收到智能体发来的消息
 *   proc.send({ text: "完成" });               // 发消息给智能体（以【服务器进程消息·crawler】出现在其会话中）
 *   proc.notifyWeb("progress", { percent: 42 }); // 发事件给网页（进程控制台）
 *   proc.onRequest(async (req) => ({ status: 200, body: { ok: true } }));
 *     // 收到网页经框架 HTTP 桥转来的请求（页面 fetch /api/proc-http/{name}/...），
 *     // 返回 {status, headers?, body?}；未注册 handler 自动 404，handler 抛异常自动 500
 *
 * 传输：全部走框架 HTTP 服务（不占独立端口）。连接参数缺省从环境变量读取：spawn 时平台自动注入
 * SOCIETY_PROC_HTTP_URL（框架地址，用户配置端口的实际值）/ SOCIETY_PROC_TOKEN / SOCIETY_PROC_PROCESS_ID，
 * 无需手工传递；归属智能体由服务端按 token 解析，进程无需（也不应）声明。
 *
 * 会话模型：connect 建立会话 → 后台长轮询循环收下行（空轮询挂起 ≤25s）→ 上行为普通 POST。
 * 断线自动重连（指数退避 1s→30s）；被同名进程顶替时不重连（避免顶替风暴）。
 *
 * 协议文档：docs/proc-messaging-protocol.md
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** 重连退避上限（毫秒） */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** 长轮询单次等待上限（与服务端 clamp 一致） */
const POLL_WAIT_MS = 25_000;

/**
 * 创建进程消息客户端。
 * @param {object} [options]
 * @param {string} options.name - 进程名（必填；须在本智能体名下唯一——同名进程接入会顶掉先接入的连接）
 * @param {string} [options.baseUrl] - 框架 HTTP 服务地址（缺省 SOCIETY_PROC_HTTP_URL）
 * @param {string} [options.token] - spawn 专属 token（缺省 SOCIETY_PROC_TOKEN）
 * @param {string} [options.processId] - 平台进程 ID（缺省 SOCIETY_PROC_PROCESS_ID；连接时携带，供智能体按 processId 寻址）
 * @param {boolean} [options.autoReconnect] - 断线自动重连（默认 true）
 * @param {object} [options.log] - 日志器（默认 console）
 * @returns {Promise<ProcClient>}
 */
export async function createProcClient(options = {}) {
  const name = options.name;
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("createProcClient: name 必填（进程名；注意须在本智能体名下唯一，同名接入会顶掉先接入的连接）");
  }

  const baseUrl = (options.baseUrl ?? process.env.SOCIETY_PROC_HTTP_URL ?? "").replace(/\/+$/, "");
  const token = options.token ?? process.env.SOCIETY_PROC_TOKEN;
  const processId = options.processId ?? process.env.SOCIETY_PROC_PROCESS_ID ?? null;

  if (!baseUrl || !token) {
    throw new Error(
      "createProcClient: 缺少连接参数（SOCIETY_PROC_HTTP_URL / SOCIETY_PROC_TOKEN）。" +
      "该 SDK 仅在经 agent-society localcmd_spawn 启动的进程内可用（平台会在 spawn 时注入环境变量）。"
    );
  }

  const client = new ProcClient({
    name,
    processId,
    baseUrl,
    token,
    autoReconnect: options.autoReconnect !== false,
    log: options.log ?? console
  });
  await client._connectWithRetry();
  return client;
}

export class ProcClient {
  constructor({ name, processId, baseUrl, token, autoReconnect, log }) {
    this.name = name;
    this.processId = processId;
    this.baseUrl = baseUrl;
    this.token = token;
    this.autoReconnect = autoReconnect;
    this.log = log;

    this._sessionId = null;
    this._closed = false;
    this._ready = false;
    /** @type {string|null} 服务端解析后的权威地址（connect 响应 as，如 proc:crawler#agent-1） */
    this._addr = null;

    /** @type {Set<Function>} 消息回调（平台 → 进程） */
    this._messageHandlers = new Set();
    /** @type {Function|null} 桥接请求回调（网页页面 → 进程，经平台 http 信封下发） */
    this._requestHandler = null;
    /** @type {Set<Function>} 事件回调（welcome/replaced/error 等内部事件） */
    this._eventHandlers = new Set();
    /** @type {Set<Function>} 错误回调 */
    this._errorHandlers = new Set();
    /** @type {Set<Promise<void>>} 未完成的上行请求（close 时等待落地，防止进程立即退出丢消息） */
    this._pendingUps = new Set();
  }

  // ============================================================
  // 连接
  // ============================================================

  /**
   * 连接并建立会话（含初次/重连退避）。首次失败直接抛错，重连重试静默。
   * @private
   */
  async _connectWithRetry() {
    let delay = 1000;
    for (;;) {
      try {
        await this._connectOnce();
        return;
      } catch (err) {
        if (!this.autoReconnect || this._closed) {
          throw err;
        }
        (this.log.warn ?? this.log.log)(`[ProcClient] 连接失败，${delay}ms 后重连`, String(err?.message ?? err));
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  /**
   * 单次 connect 建立会话并启动长轮询循环。
   * @private
   */
  async _connectOnce() {
    const res = await this._post("/api/proc-messaging/channel/connect", {
      token: this.token,
      name: this.name,
      ...(this.processId ? { processId: this.processId } : {})
    });
    if (!res.ok) {
      throw new Error(`connect 失败: ${res.error ?? "unknown"}`);
    }

    this._sessionId = res.sessionId;
    this._ready = true;
    if (typeof res.as === "string" && res.as) {
      this._addr = res.as; // 服务端权威地址（归属 agentId 由服务端按 token 解析）
    }
    this._emitEvent("welcome", { sessionId: res.sessionId, as: res.as });
    // 后台轮询循环不阻塞连接完成（fire-and-forget，错误在循环内自处理）
    void this._pollLoop();
  }

  /**
   * 长轮询循环：持续取走平台下发消息；网络断开 → 退避重连；被同名进程顶替 → 停止（不重连）。
   * @private
   */
  async _pollLoop() {
    while (!this._closed && this._ready) {
      let res;
      try {
        res = await this._post("/api/proc-messaging/channel/poll", {
          sessionId: this._sessionId,
          waitMs: POLL_WAIT_MS
        });
      } catch (err) {
        // 网络错误：会话可能仍在服务端（未超时），先尝试用原 sessionId 重连恢复轮询；
        // 服务端已注销（unknown_session）时 connect 会建立新会话
        this._ready = false;
        if (!this.autoReconnect || this._closed) {
          this._emitError(err);
          return;
        }
        (this.log.warn ?? this.log.log)("[ProcClient] 轮询中断，重连", String(err?.message ?? err));
        try {
          await this._connectWithRetry();
        } catch (retryErr) {
          this._emitError(retryErr);
          return;
        }
        continue;
      }

      if (res.replaced === true) {
        (this.log.warn ?? this.log.log)("[ProcClient] 本会话已被同名进程顶替，停止轮询");
        this._ready = false;
        this._sessionId = null;
        this._emitEvent("replaced", { name: this.name });
        return; // 不重连：重连会顶掉新会话形成风暴
      }
      if (!res.ok) {
        // unknown_session：服务端会话已注销（如进程崩溃后被服务端清理），走重连建立新会话
        this._ready = false;
        if (!this.autoReconnect || this._closed) {
          this._emitError(new Error(res.error ?? "poll 失败"));
          return;
        }
        try {
          await this._connectWithRetry();
        } catch (retryErr) {
          this._emitError(retryErr);
          return;
        }
        continue;
      }

      for (const msg of res.messages ?? []) {
        this._handleInbound(msg);
      }
    }
  }

  // ============================================================
  // 入站处理
  // ============================================================

  /**
   * 处理平台下发的消息。
   * @param {any} msg
   * @private
   */
  _handleInbound(msg) {
    switch (msg?.type) {
      case "msg": {
        for (const h of this._messageHandlers) {
          try {
            h(msg.payload ?? null);
          } catch (err) {
            (this.log.error ?? this.log.log)("[ProcClient] onMessage 处理器异常", String(err?.message ?? err));
          }
        }
        break;
      }
      case "http": {
        // 网页页面 → 框架桥 → 本进程：处理并按原信封 id 回 http_result（异常自动 500，不吞异常）
        void this._handleHttpRequest(msg);
        break;
      }
      default: {
        (this.log.warn ?? this.log.log)("[ProcClient] 未知消息类型", String(msg?.type ?? msg));
      }
    }
  }

  /**
   * 桥接请求处理：调 onRequest 回调 → 以原信封 id 上行 http_result。
   * 未注册回调 → 404；回调抛异常/返回非法 → 记日志 + 500（铁律：异常必须留痕）。
   * @param {{id: string, method: string, path: string, query?: string, headers?: object, body?: any}} msg
   * @private
   */
  async _handleHttpRequest(msg) {
    const id = msg.id;
    let result;
    try {
      if (!this._requestHandler) {
        result = { status: 404, body: { error: "no_request_handler" } };
      } else {
        const out = await this._requestHandler({
          method: msg.method,
          path: msg.path,
          query: msg.query ?? "",
          headers: msg.headers ?? {},
          body: msg.body ?? null
        });
        result = {
          status: Number(out?.status) || 200,
          headers: out?.headers ?? {},
          body: out?.body ?? null
        };
      }
    } catch (err) {
      (this.log.error ?? this.log.log)("[ProcClient] onRequest 处理器异常", String(err?.message ?? err), String(err?.stack ?? ""));
      result = { status: 500, body: { error: "internal_error", message: String(err?.message ?? err) } };
    }
    this._postUp({
      v: 1,
      id,
      type: "http_result",
      status: result.status,
      headers: result.headers,
      body: result.body
    });
  }

  // ============================================================
  // 出站
  // ============================================================

  /**
   * 发消息给智能体（缺省目标 = 归属智能体，以【服务器进程消息·进程名】插入其会话）。
   * @param {string|object} [to] - 目标智能体 ID（缺省归属智能体）；传对象时等价于 send(undefined, 那个对象)
   * @param {any} [payload] - 消息载荷（建议 { text, data } 结构）
   * @returns {{messageId: string}}
   */
  send(to, payload) {
    this._assertReady();
    // 对象首参重载：send({ text }) = 发给归属智能体，避免误把对象当作 to 序列化进协议
    if (to !== null && typeof to === "object") {
      payload = to;
      to = undefined;
    }
    const messageId = randomUUID();
    this._postUp({
      v: 1,
      id: messageId,
      type: "msg",
      to: typeof to === "string" && to.trim() ? to.trim() : undefined,
      payload: payload ?? null
    });
    return { messageId };
  }

  /**
   * 向网页推送事件（进程控制台显示）。
   * @param {string} event - 事件名（如 "progress"；必填）
   * @param {any} [data] - 事件数据
   */
  notifyWeb(event, data) {
    this._assertReady();
    if (!event || typeof event !== "string") {
      throw new Error("notifyWeb: event 必填（事件名，如 \"progress\"）");
    }
    this._postUp({
      v: 1,
      id: randomUUID(),
      type: "event",
      event,
      data: data ?? null
    });
  }

  /**
   * 上报错误（平台侧记录日志并广播到网页）。
   * @param {string} message
   * @param {any} [details]
   */
  reportError(message, details) {
    this._assertReady();
    this._postUp({
      v: 1,
      id: randomUUID(),
      type: "error",
      message: typeof message === "string" ? message : String(message),
      details: details ?? null
    });
  }

  // ============================================================
  // 订阅
  // ============================================================

  /**
   * 订阅来自平台的消息（智能体 proc_send / 网页发送）。
   * @param {(payload: any) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onMessage(handler) {
    this._messageHandlers.add(handler);
    return () => this._messageHandlers.delete(handler);
  }

  /**
   * 订阅客户端事件（welcome/replaced/error）。
   * @param {(event: any) => void} handler
   * @returns {() => void}
   */
  onEvent(handler) {
    this._eventHandlers.add(handler);
    return () => this._eventHandlers.delete(handler);
  }

  /**
   * 订阅网页经框架 HTTP 桥转来的请求（页面 fetch /api/proc-http/{name}/...）。
   * 回调收 {method, path, query, headers, body}，返回 {status, headers?, body?}（可异步）；
   * 后注册的回调替换先注册的（单 handler 语义）。未注册时桥接请求自动 404。
   * @param {(req: {method: string, path: string, query: string, headers: object, body: any}) => Promise<{status?: number, headers?: object, body?: any}> | {status?: number, headers?: object, body?: any}} handler
   */
  onRequest(handler) {
    this._requestHandler = handler;
    return () => { if (this._requestHandler === handler) { this._requestHandler = null; } };
  }

  /** 当前是否已连接就绪 */
  isReady() {
    return this._ready && this._sessionId !== null;
  }

  /** 进程地址（服务端按 token 解析归属后的权威形式，来自 connect 的 as） */
  get addr() {
    return this._ready ? this._addr : null;
  }

  /** 检查心跳连通性 */
  async close() {
    this._closed = true;
    const sessionId = this._sessionId;
    this._sessionId = null;
    this._ready = false;
    // 等待未完成的上行落地：HTTP 上行是异步 fetch，进程 close 后立即 exit
    // 会把还没发出的请求一起带走（TCP 同步 write 无此问题）
    await Promise.allSettled([...this._pendingUps]);
    if (sessionId) {
      // 通知服务端立即注销（fire-and-forget；失败由服务端惰性过期兜底）
      try {
        await this._post("/api/proc-messaging/channel/disconnect", { sessionId });
      } catch {
        // 网络失败即放弃，服务端惰性过期兜底
      }
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  _assertReady() {
    if (!this._ready || !this._sessionId) {
      throw new Error("ProcClient 未连接（进程消息通道不可达），请在就绪后调用");
    }
  }

  /** 上行消息（异步发送；请求加入 _pendingUps，close 时等待落地） */
  _postUp(msg) {
    const p = this._post("/api/proc-messaging/channel/up", { sessionId: this._sessionId, msg })
      .catch((err) => {
        (this.log.error ?? this.log.log)("[ProcClient] 上行发送失败", String(err?.message ?? err));
      })
      .finally(() => {
        this._pendingUps.delete(p);
      });
    this._pendingUps.add(p);
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 长轮询上限 + 网络兜底：服务端无响应时不能无限挂起
      signal: AbortSignal.timeout(40_000)
    });
    const data = await res.json().catch(() => ({}));
    return data;
  }

  _emitEvent(event, data) {
    for (const h of this._eventHandlers) {
      try {
        h({ event, data });
      } catch (err) {
        (this.log.warn ?? this.log.log)("[ProcClient] 事件处理器异常", String(err?.message ?? err));
      }
    }
  }

  _emitError(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    this._emitEvent("error", e);
    for (const h of this._errorHandlers) {
      try {
        h(e);
      } catch (handlerErr) {
        (this.log.warn ?? this.log.log)("[ProcClient] 错误处理器异常", String(handlerErr?.message ?? handlerErr));
      }
    }
  }
}

/**
 * 将 SDK 安装路径转换为可 import 的 file:// URL（spawn 注入 SOCIETY_PROC_SDK_URL 用）。
 * @param {string} sdkPath - sdk/proc_client.js 的绝对路径
 * @returns {string}
 */
export function sdkImportUrl(sdkPath) {
  return pathToFileURL(sdkPath).href;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
