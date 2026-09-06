/**
 * HeartbeatBroker — 统一心跳消息队列
 *
 * 设计原则：
 * - 无 clientId，无客户端状态。所有客户端（多标签页、v3、mobile）完全平等。
 * - 全局递增 messageId（从 1 开始），client 携带 lastMessageId，
 *   drain(lastMessageId) 只返回 messageId > lastMessageId 且未过期的消息。
 * - 消息可选 TTL：无 TTL 的消息持久存在直到 clearMessage()；
 *   有 TTL 的消息超时后自动从 drain() 结果中排除。
 */

export class HeartbeatBroker {
  constructor(options = {}) {
    this.log = options.logger ?? console;

    /** @type {number} 全局递增消息 ID 计数器（从 1 开始） */
    this._nextId = 1;

    /** @type {Map<number, {messageId: number, type: string, payload: any, createdAt: number, expiresAt: number|null}>} */
    this._messages = new Map();

    /** @type {Set<Function>} drain 前同步回调（在 drain() 执行前被调用，用于注入消息） */
    this._beforeDrainCallbacks = new Set();

    /** @type {number} 最近一次客户端心跳时间（0 = 从未见客户端，离线态） */
    this._lastClientSeenAt = 0;

    /** @type {boolean} 当前在线态（用于离线→在线转变检测，避免重复触发回调） */
    this._clientOnline = false;

    /** @type {Set<Function>} 客户端离线→在线转变回调（保活重投的触发器） */
    this._clientOnlineCallbacks = new Set();
  }

  /** 客户端在线判定窗口：3s 心跳间隔，10s 容忍连续丢包 2-3 次 */
  static CLIENT_ONLINE_WINDOW_MS = 10_000;

  /**
   * 记录一次客户端心跳（POST /api/heartbeat 时调用）。
   * 从离线态进入在线态时触发一次所有 onClientOnline 回调。
   */
  markClientSeen() {
    this._lastClientSeenAt = Date.now();
    if (!this._clientOnline) {
      this._clientOnline = true;
      for (const fn of this._clientOnlineCallbacks) {
        try {
          fn();
        } catch (err) {
          this.log.warn("[HeartbeatBroker] onClientOnline 回调异常:", err?.message || err);
        }
      }
    }
  }

  /**
   * 是否有客户端在线（最近 withinMs 内有过心跳）。
   * 服务重启后为 false（无 clientId 设计：只感知"有没有人在线"，不区分是谁）。
   * @param {number} [withinMs]
   * @returns {boolean}
   */
  isClientOnline(withinMs = HeartbeatBroker.CLIENT_ONLINE_WINDOW_MS) {
    return this._lastClientSeenAt > 0 && Date.now() - this._lastClientSeenAt < withinMs;
  }

  /**
   * 注册客户端离线→在线转变回调（同步调用，无参数）。
   * @param {Function} fn
   */
  onClientOnline(fn) {
    this._clientOnlineCallbacks.add(fn);
  }

  /**
   * 移除客户端上线回调。
   * @param {Function} fn
   */
  offClientOnline(fn) {
    this._clientOnlineCallbacks.delete(fn);
  }

  /**
   * 获取下一个将要分配的 messageId。
   * 用于检测客户端 lastMessageId 是否来自上一服务器会话（重启后 _nextId 会重置为 1）。
   * @returns {number}
   */
  getNextId() {
    return this._nextId;
  }

  /**
   * 广播消息到所有客户端
   * @param {string} type - 消息类型（如 'ui_command', 'cmd_confirm'）
   * @param {any} payload - 消息载荷
   * @param {number} [ttlMs] - 可选 TTL（毫秒），不设则永久存在
   * @returns {number} 分配的消息 ID
   */
  broadcast(type, payload, ttlMs) {
    const messageId = this._nextId++;
    const message = {
      messageId,
      type,
      payload,
      createdAt: Date.now(),
      expiresAt: ttlMs ? Date.now() + ttlMs : null
    };
    this._messages.set(messageId, message);
    return messageId;
  }

  /**
   * 注册 drain 前同步回调。
   * 每次 drain() 执行前依次调用所有回调，回调可在返回前同步调用 broadcast() 注入消息。
   * 回调必须是同步的（非 async），以保证心跳响应尽快返回。
   * @param {Function} fn - 同步回调函数，无参数，无返回值
   */
  onBeforeDrain(fn) {
    this._beforeDrainCallbacks.add(fn);
  }

  /**
   * 移除 drain 前回调。
   * @param {Function} fn
   */
  offBeforeDrain(fn) {
    this._beforeDrainCallbacks.delete(fn);
  }

  /**
   * 拉取新消息
   * @param {number} lastMessageId - 客户端已收到的最大 messageId
   * @returns {Array<{messageId: number, type: string, payload: any}>} 新消息列表（按 messageId 升序）
   */
  drain(lastMessageId) {
    // 同步调用所有 drain 前回调，让监听器有机会在 drain 前注入消息
    for (const fn of this._beforeDrainCallbacks) {
      try {
        fn();
      } catch (err) {
        this.log.warn("[HeartbeatBroker] beforeDrain 回调异常:", err?.message || err);
      }
    }

    const id = typeof lastMessageId === "number" && lastMessageId >= 0 ? lastMessageId : 0;
    const now = Date.now();
    const result = [];

    for (const msg of this._messages.values()) {
      if (msg.messageId <= id) continue;
      if (msg.expiresAt !== null && now >= msg.expiresAt) continue;
      result.push({
        messageId: msg.messageId,
        type: msg.type,
        payload: msg.payload
      });
    }

    // 按 messageId 升序
    result.sort((a, b) => a.messageId - b.messageId);
    return result;
  }

  /**
   * 显式清除消息（如 cmd_confirm 已解决）
   * @param {number} messageId
   */
  clearMessage(messageId) {
    this._messages.delete(messageId);
  }

  /**
   * 刷新消息 TTL（保活重投：页面离线期间消息不过期，回线后仍可 drain 到）。
   * 消息不存在时静默忽略（可能已被 clearMessage）。
   * @param {number} messageId
   * @param {number} ttlMs
   */
  refreshTtl(messageId, ttlMs) {
    const msg = this._messages.get(messageId);
    if (!msg) { return; }
    msg.expiresAt = ttlMs ? Date.now() + ttlMs : null;
  }

  /**
   * 清理所有已过期消息（可由定时器定期调用）
   */
  purgeExpired() {
    const now = Date.now();
    for (const [id, msg] of this._messages) {
      if (msg.expiresAt !== null && now >= msg.expiresAt) {
        this._messages.delete(id);
      }
    }
  }
}
