import { registry } from "../../src/platform/core/module_registry.js";

// 模块内部单例
let _broker = null;

/** 获取 broker 实例（模块内部使用） */
export function getBroker() {
  return _broker;
}

/** 仅供测试使用：注入 mock broker 实例 */
export function _setBroker(b) {
  _broker = b;
}

export class UiCommandBroker {
  /** 保活重播周期：心跳消息 TTL 60s，每 10s 重播一次保证页面任何时刻上线都能在 TTL 内 drain 到 */
  static KEEPALIVE_INTERVAL_MS = 10_000;

  /**
   * @param {{logger?: any}} options
   */
  constructor(options = {}) {
    this.log = options.logger;

    /** @type {Map<string, {resolve: (r: any) => void, timeoutHandle: any, createdAt: number}>} */
    this._pendingResultsByCommandId = new Map();

    /** @type {Map<string, {intervalHandle: any, onlineCallback: Function, currentMessageId: number, deadline: number, command: any}>} */
    this._keepAliveByCommandId = new Map();

    /** @type {import("../../src/platform/services/heartbeat/heartbeat_broker.js").HeartbeatBroker|null} */
    this._heartbeatBroker = null;
  }

  /**
   * Set heartbeat broker for unified push messaging.
   * All commands broadcast via heartbeat to all clients (60s TTL).
   * @param {import("../../src/platform/services/heartbeat/heartbeat_broker.js").HeartbeatBroker} broker
   */
  setHeartbeatBroker(broker) {
    this._heartbeatBroker = broker;
  }

  /**
   * Enqueue a UI command for execution by the active frontend client.
   * Broadcasts via heartbeat to all connected clients with 60s TTL.
   * The first client to respond via resolveResult() wins.
   *
   * keepAliveMs > 0 时启用离线保活重投（B2：页面离线时 RPC 对智能体透明，只感觉慢）：
   * 在窗口期内每 10s 重播一次命令（覆盖过期消息），页面回线（onClientOnline）立即重播。
   * @param {{type: string, payload: any}} command
   * @param {{keepAliveMs?: number}} [options]
   * @returns {{ok: true, commandId: string}}
   */
  enqueueToActive(command, { keepAliveMs = 0 } = {}) {
    if (!this._heartbeatBroker) {
      return { ok: false, error: "heartbeat_broker_not_available" };
    }
    const messageId = this._heartbeatBroker.broadcast('ui_command', command, 60_000);
    if (keepAliveMs > 0) {
      this._startKeepAlive(String(messageId), keepAliveMs, messageId);
    }
    return { ok: true, commandId: String(messageId) };
  }

  /**
   * 启动一条命令的保活循环：窗口期内周期性刷新心跳消息 TTL（messageId 不变，
   * commandId 稳定，客户端回报路径与普通命令完全一致）。
   * resolveResult/clearCommand/超窗 时自停。
   * @param {string} commandId
   * @param {number} keepAliveMs
   * @param {number} messageId
   * @private
   */
  _startKeepAlive(commandId, keepAliveMs, messageId) {
    if (!this._heartbeatBroker) { return; }
    const deadline = Date.now() + keepAliveMs;
    const intervalHandle = setInterval(() => {
      // 保活只服务于 RPC 等待：pending 已消失（工具已 ui_timeout 返回）或超窗 → 停止
      if (!this._pendingResultsByCommandId.has(commandId) || !this._keepAliveByCommandId.has(commandId) || Date.now() >= deadline) {
        this._stopKeepAlive(commandId);
        return;
      }
      // 页面离线时消息不再过期；页面回线后第一次心跳即可 drain 到（最多滞后一个刷新周期）
      this._heartbeatBroker.refreshTtl(messageId, 60_000);
    }, UiCommandBroker.KEEPALIVE_INTERVAL_MS);
    if (typeof intervalHandle.unref === "function") { intervalHandle.unref(); }
    this._keepAliveByCommandId.set(commandId, { intervalHandle, messageId, deadline });
  }

  /** 停止一条命令的保活循环（resolveResult/clearCommand/超窗调用） */
  _stopKeepAlive(commandId) {
    const state = this._keepAliveByCommandId.get(commandId);
    if (state) {
      clearInterval(state.intervalHandle);
      this._keepAliveByCommandId.delete(commandId);
    }
  }

  /**
   * Wait for the client to respond with a result via resolveResult().
   * Times out with a "ui_timeout" error if no result within timeoutMs.
   * @param {string} commandId
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  waitForResult(commandId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this._pendingResultsByCommandId.delete(commandId);
        reject(Object.assign(new Error("ui_timeout"), { code: "ui_timeout", commandId }));
      }, Math.max(0, timeoutMs));

      this._pendingResultsByCommandId.set(commandId, { resolve, timeoutHandle, createdAt: Date.now() });
    });
  }

  /**
   * Resolve a pending command result from the client.
   * @param {string} commandId
   * @param {{ok: boolean, result?: any, error?: any}} payload
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  resolveResult(commandId, payload) {
    const pending = this._pendingResultsByCommandId.get(commandId);
    if (!pending) return { ok: false, error: "command_not_pending" };

    clearTimeout(pending.timeoutHandle);
    this._pendingResultsByCommandId.delete(commandId);
    pending.resolve(payload);

    // 结果已回传，保活循环随之结束
    this._stopKeepAlive(commandId);

    // 立即清除心跳消息，防止其他客户端收到已处理的 ui_command
    if (this._heartbeatBroker) {
      this._heartbeatBroker.clearMessage(Number(commandId));
    }

    return { ok: true };
  }

  /**
   * 清理一条无人等待的命令（如"运行预览"：只广播、客户端不回传结果）。
   * 删除可能存在的 pending，并清除心跳消息，防止页面刷新后 drain 重复执行。
   * @param {string} commandId
   */
  clearCommand(commandId) {
    this._stopKeepAlive(commandId);
    const pending = this._pendingResultsByCommandId.get(commandId);
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      this._pendingResultsByCommandId.delete(commandId);
    }
    if (this._heartbeatBroker) {
      this._heartbeatBroker.clearMessage(Number(commandId));
    }
  }
}

function registerUiCommandRoutes({ app, log, broker }) {
  app.post('/api/ui-commands/result', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const commandId = body?.commandId;
    const ok = body?.ok === true;
    const result = body?.result;
    const error = body?.error;

    if (!commandId || typeof commandId !== "string") {
      return c.json({ error: "missing_command_id" }, 400);
    }

    const resolved = broker.resolveResult(commandId, { ok, result, error });
    if (!resolved.ok) {
      return c.json({ error: "command_not_pending", commandId }, 404);
    }

    void log.debug("UI 命令结果已接收", { commandId, ok });
    return c.json({ ok: true });
  });
}

// 声明式注册：仅用于注册 HTTP 路由，不对外提供任何服务
registry.declare({
  name: 'ui-page-routes',
  requires: ['app', 'heartbeatBroker', 'logRoot'],
  provides: [],
  async init(deps) {
    const log = deps.logRoot.forModule('ui_page');
    const broker = new UiCommandBroker({ logger: log });
    broker.setHeartbeatBroker(deps.heartbeatBroker);
    registerUiCommandRoutes({ app: deps.app, log, broker });
    _broker = broker;
    return {};
  }
});
