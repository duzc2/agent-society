import { registry } from "../../core/module_registry.js";

/**
 * 进程消息通道路由 — /api/proc-messaging/channel/*（HTTP 化传输的进程侧入口）
 *
 * 进程 SDK 的四个端点（不占独立端口，全部走框架 HTTP 服务）：
 * - POST /channel/connect  {token, name, processId?} → {sessionId, as}
 * - POST /channel/poll     {sessionId, waitMs?}      → {messages:[...]} / {replaced:true}（长轮询，上限 25s）
 * - POST /channel/up       {sessionId, msg}          → 入站路由（msg/event/error）
 * - POST /channel/disconnect {sessionId}             → 注销会话
 *
 * hub 从 society.runtime.procMessageHub 取（bootstrap 随运行时创建）。
 * 面板用的 /processes 与 /send 在 proc_message_routes.js，互不重叠。
 * @param {{ app: import('hono').Hono, log: any, society: any }} deps
 */
function registerProcMessageChannelRoutes({ app, log, society }) {
  const hubOf = () => society?.runtime?.procMessageHub;

  app.post("/api/proc-messaging/channel/connect", async (c) => {
    const hub = hubOf();
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }
    const result = hub.connect({
      token: typeof body?.token === "string" ? body.token : null,
      name: typeof body?.name === "string" ? body.name : null,
      processId: typeof body?.processId === "string" ? body.processId : null
    });
    if (!result.ok) {
      const status = result.error === "invalid_token" ? 401 : 400;
      return c.json(result, status);
    }
    return c.json(result);
  });

  app.post("/api/proc-messaging/channel/poll", async (c) => {
    const hub = hubOf();
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }
    if (typeof body?.sessionId !== "string" || !body.sessionId) {
      return c.json({ error: "missing_session_id" }, 400);
    }
    const waitMs = Math.min(Math.max(Number(body?.waitMs) || 25_000, 0), 25_000);
    const result = await hub.poll(body.sessionId, { waitMs });
    if (!result.ok) {
      return c.json(result, result.error === "unknown_session" ? 404 : 500);
    }
    return c.json(result);
  });

  app.post("/api/proc-messaging/channel/up", async (c) => {
    const hub = hubOf();
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }
    if (typeof body?.sessionId !== "string" || !body.sessionId) {
      return c.json({ error: "missing_session_id" }, 400);
    }
    if (!body?.msg || typeof body.msg !== "object") {
      return c.json({ error: "missing_msg" }, 400);
    }
    const result = hub.up(body.sessionId, body.msg);
    if (!result.ok) {
      return c.json(result, result.error === "unknown_session" ? 404 : 500);
    }
    return c.json(result);
  });

  app.post("/api/proc-messaging/channel/disconnect", async (c) => {
    const hub = hubOf();
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }
    if (typeof body?.sessionId !== "string" || !body.sessionId) {
      return c.json({ error: "missing_session_id" }, 400);
    }
    return c.json(hub.disconnect(body.sessionId));
  });

  void log;
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: "proc-message-channel-routes",
  requires: ["app", "log", "society"],
  provides: [],
  async init(deps) { registerProcMessageChannelRoutes(deps); return {}; }
});
