import { registry } from "../../../core/module_registry.js";

/**
 * 注册心跳相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, log: any, heartbeatBroker: any }} deps
 */
function registerHeartbeatRoutes({ app, log, heartbeatBroker }) {

  app.post('/api/heartbeat', async (c) => {
    let body = {};
    try {
      body = await c.req.json().catch(() => null) ?? {};
    } catch {
      // 请求体解析失败，视为空对象
    }

    const broker = heartbeatBroker;
    if (!broker) {
      return c.json({ error: "heartbeat_broker_unavailable" }, 500);
    }

    const lastMessageId = body.lastMessageId ?? 0;

    // 记录客户端在线（离线→在线转变会触发 onClientOnline 回调，供保活重投等消费）
    broker.markClientSeen();

    // 检测客户端序列号是否来自上一服务器会话（服务器重启后 _nextId 重置为 1）
    const needRefresh = lastMessageId > 0 && lastMessageId >= broker.getNextId();

    const messages = broker.drain(lastMessageId);
    const result = {};
    if (needRefresh) result.needRefresh = true;
    if (messages.length > 0) result.messages = messages;
    return c.json(result);
  });

  app.post('/api/heartbeat/clear', async (c) => {
    let body = {};
    try {
      body = await c.req.json().catch(() => null) ?? {};
    } catch {
      void log.error("心跳清除请求体解析失败");
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }

    const broker = heartbeatBroker;
    if (!broker) {
      return c.json({ ok: false, error: "heartbeat_broker_unavailable" }, 500);
    }

    const messageIds = body.messageIds;
    if (!Array.isArray(messageIds)) {
      return c.json({ ok: false, error: "messageIds_must_be_array" }, 400);
    }

    for (const id of messageIds) {
      if (typeof id === "number" && id > 0) {
        broker.clearMessage(id);
      }
    }

    return c.json({ ok: true });
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'heartbeat-routes',
  requires: ['app', 'log', 'heartbeatBroker'],
  provides: [],
  async init(deps) { registerHeartbeatRoutes(deps); return {}; }
});
