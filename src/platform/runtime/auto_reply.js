/**
 * AutoReplyManager - 自动回复管理器
 *
 * 定期检查所有智能体的自动回复配置，当智能体处于 idle 状态
 * 且持续达到配置的延迟秒数后，自动发送配置的回复内容。
 *
 * 该功能服务端驱动，关闭网页不受影响。
 */
export class AutoReplyManager {
  /**
   * @param {import("../core/runtime.js").Runtime} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.log = runtime.loggerRoot.forModule("auto_reply");
    this._checkTimer = null;
    /** @type {Map<string, number>} - agentId -> 最后一次自动发送的时间戳 */
    this._lastAutoSendTime = new Map();
  }

  /**
   * 启动自动回复检测定时器。
   */
  start() {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(() => this._checkAll(), 5000); // 每 5 秒检查
    this._checkTimer.unref?.(); // 不阻止进程退出
    void this.log.debug("自动回复管理器已启动");
  }

  /**
   * 停止自动回复检测定时器。
   */
  stop() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
      void this.log.debug("自动回复管理器已停止");
    }
  }

  /**
   * 检查所有智能体的自动回复条件。
   */
  _checkAll() {
    const org = this.runtime.org;
    if (!org) return;

    const agents = org.listAgents();
    const now = Date.now();

    for (const a of agents) {
      const cfg = a.autoReplyConfig;
      if (!cfg || !cfg.enabled) continue;

      const status = this.runtime.getAgentComputeStatus?.(a.id);
      if (status !== "idle") {
        // 离开 idle 就重置计时，下次重新算
        this._lastAutoSendTime.set(a.id, now);
        continue;
      }

      const lastSend = this._lastAutoSendTime.get(a.id) ?? 0;
      const idleMs = now - lastSend;
      const delayMs = (cfg.delaySeconds ?? 30) * 1000;

      if (idleMs >= delayMs) {
        const content = (cfg.content ?? "").trim();
        if (!content) continue;

        // 发送消息到智能体
        this.runtime.bus.send({
          to: a.id,
          from: "user",
          payload: { text: content }
        });

        // 更新最后发送时间
        this._lastAutoSendTime.set(a.id, now);
        void this.log.info("自动回复已发送", { agentId: a.id, content: content.substring(0, 50) });
      }
    }
  }
}
