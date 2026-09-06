import { registry } from "../../core/module_registry.js";

/**
 * 注册进程消息协议相关的 Hono 路由。
 * 由 registry 在依赖就绪时自动调用，与模块加载顺序无关。
 * @param {{ app: import('hono').Hono, log: any, society: any }} deps
 */
function registerProcMessageRoutes({ app, log, society }) {

  // GET /api/proc-messaging/processes — 在线接入进程列表（面板进程控制台用）
  app.get('/api/proc-messaging/processes', (c) => {
    const hub = society?.runtime?.procMessageHub;
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    return c.json({ ok: true, processes: hub.listProcs() });
  });

  // POST /api/proc-messaging/send — 网页 → 进程下发消息（面板发送框用）
  // body: { target: processId|addr, payload: any }
  app.post('/api/proc-messaging/send', async (c) => {
    const hub = society?.runtime?.procMessageHub;
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }

    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "invalid_json", message: err.message }, 400);
    }

    const target = typeof body?.target === "string" ? body.target.trim() : "";
    if (!target) {
      return c.json({ error: "missing_target", message: "target 必填（localcmd_spawn 返回的 processId，或进程地址 proc:<name>#<agentId>）" }, 400);
    }
    if (body?.payload === undefined || body?.payload === null) {
      return c.json({ error: "missing_payload", message: "payload 必填" }, 400);
    }

    // target 兼容两种寻址：processId（平台生成的进程 ID）或进程地址
    // processId 为 uuid 格式且在索引中 → sendToProcess；否则按地址解析
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
    const result = isUuid && typeof hub.sendToProcess === "function"
      ? hub.sendToProcess(target, { payload: body.payload })
      : hub.sendToProc(target, { payload: body.payload });

    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 404);
    }
    return c.json({ ok: true, messageId: result.messageId });
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: 'proc-message-routes',
  requires: ['app', 'log', 'society'],
  provides: [],
  async init(deps) { registerProcMessageRoutes(deps); return {}; }
});
