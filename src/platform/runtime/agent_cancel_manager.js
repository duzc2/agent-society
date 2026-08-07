/**
 * AgentCancelManager - 智能体取消/停止信号管理器
 *
 * 设计目标：
 * 1. 为每个 agent 提供一个单调递增的 epoch（世代号），用于判定“结果是否过期”；
 * 2. 为每个 agent 提供一个 AbortSignal，用于中止 in-flight 的 LLM/HTTP 等异步请求；
 * 3. 将 abort/stop/terminate 的“取消语义”统一成：递增 epoch + abort 当前 signal。
 *
 * 关键约束：
 * - 任何需要强取消语义的模块，在发起异步请求前应捕获 epoch，并在 await 返回后校验 epoch；
 * - 若 epoch 不一致，则必须丢弃结果（不写对话、不触发工具副作用、不继续推进）。
 */
export class AgentCancelManager {
  /**
   * @param {{logger?: {info?:(m:string,d?:any)=>any, warn?:(m:string,d?:any)=>any, error?:(m:string,d?:any)=>any}}} [options]
   */
  constructor(options = {}) {
    this._log = options.logger;
    /** @type {Map<string, {epoch:number, controller:AbortController, lastReason:string|null, lastAt:string|null}>} */
    this._byAgentId = new Map();
  }

  /**
   * 获取当前 epoch；不存在则初始化为 0。
   * @param {string} agentId
   * @returns {number}
   */
  getEpoch(agentId) {
    if (!agentId) return 0;
    this._ensure(agentId);
    return this._byAgentId.get(agentId).epoch;
  }

  /**
   * 获取当前 AbortSignal；不存在则初始化。
   * @param {string} agentId
   * @returns {AbortSignal|null}
   */
  getSignal(agentId) {
    if (!agentId) return null;
    this._ensure(agentId);
    return this._byAgentId.get(agentId).controller.signal;
  }

  /**
   * 获取最近一次取消的原因与时间戳（用于区分“插话重试”与“用户中止”）。
   * @param {string} agentId
   * @returns {{epoch:number, reason:string|null, at:string|null}}
   */
  getLastAbortInfo(agentId) {
    if (!agentId) return { epoch: 0, reason: null, at: null };
    this._ensure(agentId);
    const entry = this._byAgentId.get(agentId);
    return { epoch: entry.epoch, reason: entry.lastReason, at: entry.lastAt };
  }

  /**
   * 创建一个“运行作用域”，用于一次消息处理或一次 step 推进。
   * 调用方必须在 await 返回后用 epoch 校验是否仍有效。
   *
   * @param {string} agentId
   * @returns {{agentId:string, epoch:number, signal:AbortSignal, assertActive:() => void}}
   */
  newScope(agentId) {
    if (!agentId) {
      const err = new Error("agentId is required");
      err.name = "InvalidArgumentError";
      throw err;
    }
    this._ensure(agentId);
    const snapshot = this._byAgentId.get(agentId);
    const epoch = snapshot.epoch;
    const signal = snapshot.controller.signal;
    return {
      agentId,
      epoch,
      signal,
      assertActive: () => {
        const current = this.getEpoch(agentId);
        if (current !== epoch) {
          const abortErr = new Error("agent scope cancelled");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        if (signal.aborted) {
          const abortErr = new Error("agent scope aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }
      }
    };
  }

  /**
   * 触发取消：递增 epoch + abort 当前 controller，并为后续运行创建新的 controller。
   * @param {string} agentId
   * @param {{reason?:string}} [options]
   * @returns {{agentId:string, epoch:number, reason:string|null}}
   */
  abort(agentId, options = {}) {
    if (!agentId) return { agentId: String(agentId ?? ""), epoch: 0, reason: null };
    this._ensure(agentId);
    const entry = this._byAgentId.get(agentId);

    const reason = typeof options.reason === "string" ? options.reason : "abort_requested";
    const timestamp = new Date().toISOString();

    entry.epoch += 1;
    entry.lastReason = reason;
    entry.lastAt = timestamp;

    try {
      entry.controller.abort();
    } catch (err) {
      void this._log.warn("AbortController.abort 调用失败", {
        agentId,
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
    }

    entry.controller = new AbortController();

    void this._log.info("触发智能体取消", {
      agentId,
      epoch: entry.epoch,
      reason,
      at: timestamp
    });

    return { agentId, epoch: entry.epoch, reason };
  }

  /**
   * 清理指定 agent 的取消状态（用于终止/删除 agent）。
   * @param {string} agentId
   */
  clear(agentId) {
    if (!agentId) return;
    this._byAgentId.delete(agentId);
  }

  /**
   * @param {string} agentId
   * @private
   */
  _ensure(agentId) {
    if (this._byAgentId.has(agentId)) return;
    this._byAgentId.set(agentId, {
      epoch: 0,
      controller: new AbortController(),
      lastReason: null,
      lastAt: null
    });
  }
}
