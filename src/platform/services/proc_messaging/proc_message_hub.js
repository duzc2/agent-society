/**
 * ProcMessageHub — 服务器进程消息中枢（复用框架 HTTP 服务，会话 + 长轮询）
 *
 * 让"智能体创建的服务器进程"成为消息总线的一等端点。传输不占独立端口：
 * 进程经 SDK 走框架 HTTP 服务的 /api/proc-messaging/channel/* 端点（由
 * proc_message_channel_routes.js 注册），本类只做会话管理与消息路由。
 *
 * - 进程 → 智能体（msg）：转发到 bus.send（extras.kind="proc_msg"，智能体经插话/回合接收）；
 * - 进程 → 网页（event）：广播到 heartbeatBroker（type="proc_event"，60s TTL）；
 * - 平台 → 进程（outbound）：sendToProc() 推入会话队列，由进程长轮询取走。
 *
 * 安全：spawn 专属 token（由 spawn 时 registerSpawn 登记，P3 衔接）；connect 校验
 * token 解析归属 agentId（客户端不声明）；sessionId 为后续请求凭证。
 *
 * 会话方法（与传输解耦，路由层是薄壳，测试直接调用方法）：
 *   connect({token, name, processId}) → {sessionId, as}
 *   poll(sessionId, waitMs)           → {messages:[...]} / {replaced:true}
 *   up(sessionId, msg)                → 入站路由（msg/event/error/http_result）
 *   disconnect(sessionId)
 *
 * 协议信封（与 docs/proc-messaging-protocol.md 对应）：
 *   下行 {"v":1,"id":"uuid","type":"msg"|"http",...}
 *   上行 {"v":1,"id":"uuid","type":"msg"|"event"|"error"|"http_result",...}
 *   （http/http_result：网页页面 ⇄ 进程的桥接请求，按信封 id 关联——协议 v1.1 预留的 RPC 匹配键，见 requestProc）
 *
 * @module services/proc_messaging/proc_message_hub
 */
import { randomUUID } from "node:crypto";

/** 进程地址前缀：proc:<name>#<agentId> */
const PROC_ADDR_PREFIX = "proc:";

/** event 心跳 TTL（毫秒）：进程→网页事件类通知，超出窗口未消费即视为过期（与 ui_command 同策略） */
const PROC_EVENT_TTL_MS = 60_000;

/** 会话过期（毫秒）：超过该时长无 poll/up 活动的会话视为进程已死，惰性注销 */
const SESSION_IDLE_MS = 60_000;

/** 桥接请求超时（毫秒）：必须小于 SESSION_IDLE_MS，否则慢处理会被 sweep 连会话一起注销 */
const HTTP_BRIDGE_TIMEOUT_MS = 30_000;

/** 过期清理周期（毫秒）；unref 定时器，不阻止进程退出 */
const SWEEP_INTERVAL_MS = 30_000;

export class ProcMessageHub {
  /**
   * @param {{logger: any, bus: import("../../core/message_bus.js").MessageBus, heartbeatBroker: import("../heartbeat/heartbeat_broker.js").HeartbeatBroker}} options
   *  - bus / heartbeatBroker 为运行时必建组件，缺失即初始化错误（铁律：功能组件禁止空值兼容）
   */
  constructor({ logger, bus, heartbeatBroker }) {
    this.log = logger;
    this.bus = bus;
    this.heartbeatBroker = heartbeatBroker;

    /** @type {Map<string, {agentId: string, createdAt: number}>} spawn 登记的有效 token */
    this._spawnTokens = new Map();

    /**
     * 在线会话：proc:<name>#<agentId> → session
     * @type {Map<string, {sessionId: string, procName: string, agentId: string, procId: string, processId: string|null, addr: string, queue: Array<any>, waiters: Array<{resolve: Function, timer: any}>, replaced: boolean, connectedAt: number, lastSeenAt: number}>}
     */
    this._procs = new Map();

    /** @type {Map<string, string>} sessionId → addr：poll/up/disconnect 凭证反查 */
    this._sessionIndex = new Map();

    /** spawn processId（平台生成）→ { addr, procId }：智能体按 processId 寻址的索引 */
    this._processIdIndex = new Map();

    /** @type {Map<string, string>} sessionId → addr（被替换/断开的会话保留映射，供 poll 返回 replaced） */
    this._deadSessions = new Map();

    /** @type {Map<string, {resolve: Function, timer: any, addr: string}>} 桥接请求 id → 挂起回调（http/http_result 按信封 id 关联） */
    this._pendingHttp = new Map();

    this._closed = false;

    /** @type {import("node:timers").NodeJSTimeout|null} 会话过期清理（unref，不阻止进程退出） */
    this._sweepTimer = setInterval(() => this._sweepIdleSessions(), SWEEP_INTERVAL_MS);
    if (typeof this._sweepTimer.unref === "function") { this._sweepTimer.unref(); }
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 关闭：注销全部会话并停止清理定时器。
   */
  shutdown() {
    if (this._closed) {return;}
    this._closed = true;

    const count = this._procs.size;
    for (const session of this._procs.values()) {
      this._terminateWaiters(session, "hub_closed");
    }
    for (const session of this._deadSessions.values()) {
      this._terminateWaiters(session, "hub_closed");
    }
    this._procs.clear();
    this._sessionIndex.clear();
    this._deadSessions.clear();
    this._failPendingHttpAll("hub_closed");

    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    this.log.info("[ProcMessageHub] 已关闭", { disconnectedProcs: count });
  }

  // ============================================================
  // spawn token 登记（P3 衔接：process_manager spawn 时调用）
  // ============================================================

  /**
   * 登记一个 spawn 的有效 token（一次 spawn 一个；进程生命周期内存续）。
   *
   * 【token 生命周期语义】token 与"spawn 的进程实例"同生命周期，而非与连接绑定：
   * 进程 SDK 断线重连（网络断开但进程仍存活）时必须能用同一 token 重新 connect；
   * 因此 token 不在 connect 成功后作废，而在进程真正退出时由进程管理器调用
   * unregisterToken 清理（ProcessManager exit 事件 → unregisterToken）。
   * @param {{token: string, agentId: string}} input
   * @returns {{ok: true}}
   */
  registerSpawn({ token, agentId }) {
    if (!token || typeof token !== "string") {
      this.log.warn("[ProcMessageHub] registerSpawn 收到无效 token", { agentId });
      return { ok: false, error: "invalid_token" };
    }
    this._spawnTokens.set(token, { agentId, createdAt: Date.now() });
    return { ok: true };
  }

  /**
   * 作废 token（进程退出/清理时调用；SDK 断线重连期间不要调用）。
   * @param {string} token
   */
  unregisterToken(token) {
    this._spawnTokens.delete(token);
  }

  // ============================================================
  // 会话：connect / poll / up / disconnect（路由层薄壳直接调用）
  // ============================================================

  /**
   * 建立会话（对应 SDK 的 connect；校验 token 并解析归属 agentId）。
   * 同名进程重复连接：保留最新会话，旧会话标记 replaced 并唤醒其挂起的 poll。
   * @param {{token: string, name: string, processId?: string|null}} input
   * @returns {{ok: true, sessionId: string, as: string} | {ok: false, error: string}}
   */
  connect({ token, name, processId }) {
    if (this._closed) {return { ok: false, error: "hub_closed" };}
    const procName = typeof name === "string" && name.trim() ? name.trim() : null;
    if (!token || typeof token !== "string" || !procName) {
      this.log.warn("[ProcMessageHub] connect 字段不完整，拒绝", { hasToken: !!token, procName });
      return { ok: false, error: "invalid_request" };
    }
    const spawn = this._spawnTokens.get(token);
    if (!spawn) {
      this.log.warn("[ProcMessageHub] token 校验失败，拒绝连接", { procName });
      return { ok: false, error: "invalid_token" };
    }
    // agentId 由服务端按 spawn token 解析（token 登记时已绑定归属智能体），客户端无需声明——
    // 系统能确定的信息不让进程提供，也杜绝了冒用其他 agentId 的可能
    const agentId = spawn.agentId;
    const procId = randomUUID();
    const addr = this._addrOf(procName, agentId);

    // spawn processId 索引：使智能体无需知道 name/agentId 即可按 processId 寻址
    const normalizedProcessId = typeof processId === "string" && processId.trim() ? processId.trim() : null;
    if (normalizedProcessId) {
      const existingById = this._processIdIndex.get(normalizedProcessId);
      if (existingById && existingById.addr !== addr) {
        // 同一 spawn processId 不应映射多个地址；保留先注册者并警告
        this.log.warn("[ProcMessageHub] processId 重复映射，忽略新映射", { processId: normalizedProcessId, existingAddr: existingById.addr, newAddr: addr });
      } else if (!existingById) {
        this._processIdIndex.set(normalizedProcessId, { addr, procId });
      }
    }

    // 同名进程重复连接：保留最新会话，旧会话标记 replaced 并立即唤醒其挂起的 poll
    const existing = this._procs.get(addr);
    if (existing) {
      this.log.warn("[ProcMessageHub] 同名进程重新连接，替换旧会话", { addr, oldProcId: existing.procId, newProcId: procId });
      this._procs.delete(existing.addr ?? addr);
      this._sessionIndex.delete(existing.sessionId);
      existing.replaced = true;
      this._deadSessions.set(existing.sessionId, existing);
      this._terminateWaiters(existing, "replaced");
      // 挂在旧会话上的桥接请求快速失败（新会话可能不注册 onRequest，不能替它答）
      this._failPendingHttp(addr, "session_died");
    }

    const now = Date.now();
    const session = {
      sessionId: randomUUID(),
      procName, agentId, procId,
      processId: normalizedProcessId,
      addr,
      queue: [],
      waiters: [],
      replaced: false,
      connectedAt: now,
      lastSeenAt: now
    };
    this._procs.set(addr, session);
    this._sessionIndex.set(session.sessionId, addr);

    this.log.info("[ProcMessageHub] 进程会话已建立", { addr, procId, sessionId: session.sessionId });
    return { ok: true, sessionId: session.sessionId, as: addr };
  }

  /**
   * 长轮询取走下行消息（SDK 保活与收消息的唯一入口）。
   * 队列有消息立即返回；为空则挂起至 waitMs 或有新消息；会话已被同名连接顶替 → replaced。
   * @param {string} sessionId
   * @param {{waitMs?: number}} [options]
   * @returns {Promise<{ok: true, messages: Array<any>} | {ok: true, replaced: boolean} | {ok: false, error: string}>}
   */
  async poll(sessionId, { waitMs = 25_000 } = {}) {
    if (this._closed) {return { ok: false, error: "hub_closed" };}
    const addr = this._sessionIndex.get(sessionId);
    const session = addr ? this._procs.get(addr) : this._deadSessions.get(sessionId);
    if (!session) {
      return { ok: false, error: "unknown_session" };
    }
    session.lastSeenAt = Date.now();
    if (session.replaced) {
      return { ok: true, replaced: true };
    }

    if (session.queue.length > 0) {
      return { ok: true, messages: session.queue.splice(0, session.queue.length) };
    }

    // 长轮询挂起：有消息/被替换/超时 即返回
    return await new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      const finish = (result) => {
        if (waiter.timer) {clearTimeout(waiter.timer);}
        const list = session.waiters;
        const i = list.indexOf(waiter);
        if (i !== -1) {list.splice(i, 1);}
        resolve(result);
      };
      waiter.finish = finish;
      waiter.timer = setTimeout(() => finish({ ok: true, messages: [] }), Math.max(0, waitMs));
      if (typeof waiter.timer.unref === "function") { waiter.timer.unref(); }
      session.waiters.push(waiter);
    });
  }

  /**
   * 入站消息（进程 → 平台）：与传输无关的路由（msg→bus、event/error→heartbeat 广播）。
   * @param {string} sessionId
   * @param {any} msg - 信封 { type: "msg"|"event"|"error", ... }
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  up(sessionId, msg) {
    if (this._closed) {return { ok: false, error: "hub_closed" };}
    const addr = this._sessionIndex.get(sessionId);
    const session = addr ? this._procs.get(addr) : null;
    if (!session) {
      return { ok: false, error: "unknown_session" };
    }
    session.lastSeenAt = Date.now();
    this._routeInbound(session, msg);
    return { ok: true };
  }

  /**
   * 主动断开会话（进程正常退出时 SDK 调用；幂等）。
   * @param {string} sessionId
   * @returns {{ok: true}}
   */
  disconnect(sessionId) {
    const addr = this._sessionIndex.get(sessionId);
    const session = addr ? this._procs.get(addr) : this._deadSessions.get(sessionId);
    if (session) {
      this._unregister(session);
      this._terminateWaiters(session, "disconnected");
      this._deadSessions.delete(sessionId);
      this.log.info("[ProcMessageHub] 进程会话已断开", { addr: session.addr, procId: session.procId });
    }
    return { ok: true };
  }

  // ============================================================
  // 出站：平台 → 进程
  // ============================================================

  /**
   * 向已注册进程发送消息（推入会话队列，长轮询取走）。
   * @param {string} addr - 进程地址（proc:<name>#<agentId> 或纯 <name> 时按默认 agentId 解析，见 resolveAddr）
   * @param {{payload: any}} message
   * @returns {{ok: true, messageId: string} | {ok: false, error: string}}
   */
  sendToProc(addr, message) {
    if (this._closed) {return { ok: false, error: "hub_closed" };}
    const resolved = this.resolveAddr(addr);
    const session = this._procs.get(resolved);
    if (!session) {
      return { ok: false, error: "proc_offline", addr: resolved };
    }
    const msgId = randomUUID();
    session.queue.push({ v: 1, id: msgId, type: "msg", payload: message?.payload ?? null });
    this._wakeWaiters(session);
    this.log.info("[ProcMessageHub] msg 已下发到进程", {
      to: resolved,
      processId: session.procId,
      messageId: msgId,
      payloadPreview: this._preview(message?.payload)
    });
    return { ok: true, messageId: msgId };
  }

  /**
   * 向已注册进程发送消息（按 spawn processId 寻址，智能体无需知道进程 name/agentId）。
   * @param {string} processId - localcmd_spawn 返回的进程 ID
   * @param {{payload: any}} message
   * @returns {{ok: true, messageId: string} | {ok: false, error: string, addr?: string}}
   */
  sendToProcess(processId, message) {
    const mapped = this._processIdIndex.get(processId);
    if (!mapped) {
      return { ok: false, error: "proc_offline", processId };
    }
    return this.sendToProc(mapped.addr, message);
  }

  /**
   * 桥接请求：网页 → 框架端点 → 进程（proc.onRequest 处理）→ 原路返回。
   * 以信封 id 关联请求/响应（协议 v1.1 预留的 RPC 匹配键，本期兑现为 http/http_result）。
   *
   * 失败分支（Promise resolve {ok:false,error}，不 throw）：
   * - proc_offline：进程离线/不可寻址；bridge_timeout：超时（HTTP_BRIDGE_TIMEOUT_MS）；
   * - session_died：挂起期间会话被顶替/注销/过期/hub 关闭（快速失败，浏览器不必等满超时）。
   * @param {string} addr - 进程地址（resolveAddr 语义与 sendToProc 一致）
   * @param {{method: string, path: string, query: string, headers: object, body: any}} req
   * @returns {Promise<{ok: true, status: number, headers: object, body: any} | {ok: false, error: string, addr?: string}>}
   */
  requestProc(addr, req) {
    if (this._closed) {return Promise.resolve({ ok: false, error: "hub_closed" });}
    const resolved = this.resolveAddr(addr);
    const session = this._procs.get(resolved);
    if (!session) {
      return Promise.resolve({ ok: false, error: "proc_offline", addr: resolved });
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const pending = {
        addr: resolved,
        resolve: null,
        timer: null
      };
      const finish = (result) => {
        clearTimeout(pending.timer);
        this._pendingHttp.delete(id);
        resolve(result);
      };
      pending.resolve = finish;
      pending.timer = setTimeout(() => finish({ ok: false, error: "bridge_timeout" }), HTTP_BRIDGE_TIMEOUT_MS);
      if (typeof pending.timer.unref === "function") { pending.timer.unref(); }
      this._pendingHttp.set(id, pending);

      // 信封 type:"http"：进程 SDK onRequest 分支处理；handler 结果以 http_result 原 id 上行
      session.queue.push({
        v: 1, id, type: "http",
        method: req.method, path: req.path, query: req.query ?? "",
        headers: req.headers ?? {}, body: req.body ?? null
      });
      this._wakeWaiters(session);
    });
  }

  /**
   * 解析进程地址：`proc:name#agentId` 原样校验；纯 `name` 或缺省 agentId 时补归属。
   * @param {string} addr
   * @returns {string} 规范地址（不匹配则原样返回，由调用方按 proc_offline 处理）
   */
  resolveAddr(addr) {
    if (!addr || typeof addr !== "string") {return "";}
    if (addr.startsWith(PROC_ADDR_PREFIX)) {return addr;}
    // 纯 name：未知 agentId，按 name 直接匹配（注册表 key 为 name#agentId，此处匹配任意归属同名进程）
    for (const key of this._procs.keys()) {
      if (key === addr) {return key;}
      if (key.startsWith(`${PROC_ADDR_PREFIX}${addr}#`)) {return key;}
    }
    return `${PROC_ADDR_PREFIX}${addr}`;
  }

  /**
   * 列出已注册进程（路由 API 用）。
   * @returns {Array<{procId: string, procName: string, agentId: string, addr: string, processId: string|null, connectedAt: number}>}
   */
  listProcs() {
    const out = [];
    for (const [addr, p] of this._procs) {
      out.push({ procId: p.procId, procName: p.procName, agentId: p.agentId, addr, processId: p.processId ?? null, connectedAt: p.connectedAt });
    }
    return out;
  }

  /**
   * 列出某智能体名下的在线接入进程（proc_send 自动匹配用）。
   * 返回 spawn processId（即 localcmd_spawn 返回的进程 ID，未接入协议握手时为 null），
   * 使多进程场景下智能体可直接拿到 proc_send 所需的 processId。
   * @param {string} agentId
   * @returns {Array<{procId: string, procName: string, addr: string, processId: string|null}>}
   */
  listProcsByAgent(agentId) {
    return this.listProcs()
      .filter((p) => p.agentId === agentId)
      .map(({ procId, procName, addr, processId }) => ({ procId, procName, addr, processId: processId ?? null }));
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /**
   * 入站路由：msg → bus、event/error → heartbeat 广播（与传输无关，TCP 时代逻辑原样保留）。
   * @param {{procName: string, agentId: string, procId: string, addr: string}} session
   * @param {any} msg
   * @private
   */
  _routeInbound(session, msg) {
    const addr = session.addr;

    switch (msg?.type) {
      case "msg": {
        const to = typeof msg.to === "string" && msg.to.trim() ? msg.to.trim() : session.agentId;
        const result = this.bus.send({
          to,
          from: addr,
          payload: msg.payload ?? null,
          extras: { kind: "proc_msg", procName: session.procName }
        });
        this.log.info("[ProcMessageHub] msg 已转发到 bus", {
          from: addr,
          to,
          messageId: result?.messageId ?? null,
          payloadPreview: this._preview(msg.payload),
          processId: session.procId
        });
        break;
      }

      case "event": {
        const eventName = typeof msg.event === "string" && msg.event.trim() ? msg.event.trim() : null;
        if (!eventName) {
          this.log.warn("[ProcMessageHub] event 消息缺少 event 名，忽略", { from: addr });
          break;
        }
        const messageId = this.heartbeatBroker.broadcast("proc_event", {
          procId: session.procId,
          procName: session.procName,
          agentId: session.agentId,
          event: eventName,
          data: msg.data ?? null,
          ts: Date.now()
        }, PROC_EVENT_TTL_MS);
        this.log.info("[ProcMessageHub] event 已广播到网页", {
          from: addr,
          event: eventName,
          messageId,
          dataPreview: this._preview(msg.data)
        });
        break;
      }

      case "http_result": {
        const pending = this._pendingHttp.get(msg.id);
        if (!pending) {
          // 可能已超时/会话死亡被快速失败，迟到的结果丢弃（不视为进程错误）
          this.log.warn("[ProcMessageHub] http_result 无对应挂起请求，丢弃", { from: addr, id: msg.id ?? null });
          break;
        }
        pending.resolve({
          ok: true,
          status: Number(msg.status) || 500,
          headers: msg.headers ?? {},
          body: msg.body ?? null
        });
        break;
      }

      case "error": {
        const message = typeof msg.message === "string" ? msg.message : String(msg.message ?? "unknown");
        this.log.error("[ProcMessageHub] 进程上报错误", {
          from: addr,
          processId: session.procId,
          error: message,
          stack: msg.stack ?? null,
          details: msg.details ?? null
        });
        // 与 event 同语义：广播让网页知晓（事件类，TTL 短）
        const messageId = this.heartbeatBroker.broadcast("proc_event", {
          procId: session.procId,
          procName: session.procName,
          agentId: session.agentId,
          event: "proc_error",
          data: { message, details: msg.details ?? null },
          ts: Date.now()
        }, PROC_EVENT_TTL_MS);
        this.log.info("[ProcMessageHub] error 已广播到网页", { from: addr, messageId });
        break;
      }

      default: {
        this.log.warn("[ProcMessageHub] 未知消息类型，忽略", { from: addr, type: msg?.type ?? null });
      }
    }
  }

  /** 注销会话（仅当注册表仍指向本 procId 时；替换场景不误删新会话） */
  _unregister(session) {
    const existing = this._procs.get(session.addr);
    if (existing && existing.procId === session.procId) {
      this._procs.delete(session.addr);
      this._sessionIndex.delete(session.sessionId);
      if (session.processId) {
        const idx = this._processIdIndex.get(session.processId);
        if (idx && idx.procId === session.procId) {
          this._processIdIndex.delete(session.processId);
        }
      }
      // 挂起的桥接请求快速失败（进程死亡，浏览器不必等满超时）
      this._failPendingHttp(session.addr, "session_died");
    }
  }

  /** 快速失败某地址下全部挂起桥接请求（会话被顶替/注销/过期/关闭时调用） */
  _failPendingHttp(addr, error) {
    for (const [id, pending] of this._pendingHttp) {
      if (pending.addr !== addr) {continue;}
      this._pendingHttp.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
  }

  /** 快速失败全部挂起桥接请求（hub 关闭时调用） */
  _failPendingHttpAll(error) {
    for (const [id, pending] of this._pendingHttp) {
      this._pendingHttp.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
  }

  /** 唤醒会话上全部挂起的 poll（有消息可取） */
  _wakeWaiters(session) {
    for (const waiter of session.waiters.splice(0, session.waiters.length)) {
      if (waiter.timer) {clearTimeout(waiter.timer);}
      waiter.finish({ ok: true, messages: session.queue.splice(0, session.queue.length) });
    }
  }

  /** 终止会话上全部挂起的 poll（标记 replaced 或 hub 关闭） */
  _terminateWaiters(session, reason) {
    const result = reason === "replaced" ? { ok: true, replaced: true } : { ok: false, error: reason };
    for (const waiter of session.waiters.splice(0, session.waiters.length)) {
      if (waiter.timer) {clearTimeout(waiter.timer);}
      waiter.finish(result);
    }
  }

  /** 惰性过期清理：长时间无 poll/up 活动的会话视为进程已死，注销（进程崩溃未 disconnect 的兜底） */
  _sweepIdleSessions() {
    if (this._closed) {return;}
    const now = Date.now();
    for (const session of [...this._procs.values()]) {
      if (now - session.lastSeenAt > SESSION_IDLE_MS) {
        this.log.warn("[ProcMessageHub] 会话超时无活动，注销", { addr: session.addr, procId: session.procId, idleMs: now - session.lastSeenAt });
        this._unregister(session);
        this._terminateWaiters(session, "session_expired");
        this._deadSessions.delete(session.sessionId);
      }
    }
  }

  _addrOf(procName, agentId) {
    return `${PROC_ADDR_PREFIX}${procName}#${agentId}`;
  }

  /**
   * 消息预览（日志用，最长 200 字符）。
   * @param {any} payload
   * @returns {string}
   * @private
   */
  _preview(payload) {
    if (payload === null || payload === undefined) {return "";}
    if (typeof payload === "string") {return payload.slice(0, 200);}
    try {
      return JSON.stringify(payload).slice(0, 200);
    } catch {
      return "[unserializable]";
    }
  }
}
