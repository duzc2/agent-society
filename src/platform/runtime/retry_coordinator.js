/**
 * 重试协调器 (RetryCoordinator)
 *
 * 当前每个智能体独立计算重试延迟，容易产生"惊群效应"——多个智能体同时收到 429 后，
 * 它们的退避周期可能同步，导致下一轮请求再次同时触发 429。
 * RetryCoordinator 提供全局协调的重试调度，通过槽位分配错开重试时间。
 *
 * 用法：
 *   const coordinator = new RetryCoordinator({ maxSlots: 8 });
 *   const delayMs = coordinator.scheduleRetry(agentId, retryCount);
 *   if (coordinator.isGloballyThrottled()) { // 暂停所有请求 }
 *   if (coordinator.record429(agentId)) { // 触发全局限流 }
 *
 * @module runtime/retry_coordinator
 */

class RetryCoordinator {
  /**
   * @param {{maxSlots?:number, slotMs?:number, baseDelayMs?:number, maxDelayMs?:number}} [options]
   */
  constructor(options = {}) {
    /** @type {number} */
    this._nextSlot = 0;
    this._maxSlots = options.maxSlots ?? 8;
    this._slotMs = options.slotMs ?? 2000;
    this._baseDelay = options.baseDelayMs ?? 1000;
    this._maxDelay = options.maxDelayMs ?? 60000;
    /** @type {Array<{timestamp:number, agentId:string}>} */
    this._recent429s = [];
    /** @type {number} */
    this._globalThrottleUntil = 0;
  }

  /**
   * 为指定智能体调度一次重试，返回需要等待的毫秒数。
   * 使用槽位分配（staggered slots）避免惊群效应。
   * @param {string} agentId
   * @param {number} retryCount - 当前是第几次重试（1-based）
   * @returns {number} 延迟毫秒数
   */
  scheduleRetry(agentId, retryCount) {
    const slot = this._nextSlot;
    this._nextSlot = (this._nextSlot + 1) % this._maxSlots;

    const baseDelay = this._baseDelay * Math.pow(2, Math.min(retryCount, 6));
    const jitter = baseDelay * 0.5 * (Math.random() - 0.5);
    const delay = Math.min(baseDelay + jitter, this._maxDelay);

    return delay + slot * this._slotMs;
  }

  /**
   * 记录一次 429 响应，如果短时间内超过阈值则触发全局限流。
   * @param {string} agentId
   * @returns {boolean} 是否触发了全局限流
   */
  record429(agentId) {
    const now = Date.now();
    this._recent429s.push({ timestamp: now, agentId });
    this._recent429s = this._recent429s.filter(r => now - r.timestamp < 30000);

    if (this._recent429s.length > 10 && this._globalThrottleUntil < now) {
      this._globalThrottleUntil = now + 30000;
      return true;
    }
    return false;
  }

  /**
   * 检查当前是否处于全局限流状态。
   * @returns {boolean}
   */
  isGloballyThrottled() {
    return Date.now() < this._globalThrottleUntil;
  }
}

export { RetryCoordinator };
