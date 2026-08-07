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
