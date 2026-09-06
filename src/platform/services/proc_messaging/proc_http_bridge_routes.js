import { registry } from "../../core/module_registry.js";

/**
 * 进程 HTTP 桥接路由 — ANY /api/proc-http/{procName}/{path}（网页页面 ⇄ 服务器进程）
 *
 * 让挂在框架静态托管（/workspace-files/{workspaceId}/...）上的页面能经框架端口与
 * 智能体创建的进程双向通信——进程零端口（不监听任何东西，只收发协议信封），
 * 页面与 API 同源（同一个用户配置的框架端口），fetch 相对路径即可。
 *
 * 消息流：
 *   页面 fetch → 本路由解析 procName → hub.requestProc 以 {type:"http"} 信封下发
 *   → 进程 SDK onRequest 处理 → {type:"http_result"} 原信封 id 上行 → 本路由按关联回浏览器。
 *
 * 寻址（系统能自动匹配的不让页面提供）：
 * - 页面只给 procName（智能体起的进程名）+ 相对路径；
 * - 在线同名进程唯一 → 直接路由（常见情形）；多个 → ?ws={workspaceId} 过滤（页面从
 *   location.pathname 取，一行）；仍歧义 → 409 带候选列表，绝不瞎选。
 *
 * 安全模型与现有 API 一致（本地信任：端口由用户配置即信任边界），不另造鉴权。
 *
 * @module services/proc_messaging/proc_http_bridge_routes
 */
/** 桥接转发 body 上限（字节）：与工作区文件服务读取上限一致（10MB） */
const BRIDGE_BODY_LIMIT = 10 * 1024 * 1024;

function registerProcHttpBridgeRoutes({ app, log, society }) {
  const hubOf = () => society?.runtime?.procMessageHub;

  /**
   * 按 procName（可选 ?ws= 过滤）解析目标进程地址。
   * @returns {{addr: string} | {ambig: string[]} | {error: string}}
   */
  function resolveProcAddr(hub, procName, wsFilter) {
    const candidates = hub.listProcs().filter((p) => p.procName === procName);
    if (candidates.length === 0) {
      return { error: "proc_offline" };
    }
    let list = candidates;
    if (wsFilter) {
      const filtered = candidates.filter((p) => {
        // 页面侧 ws 参数是工作区 ID；进程归属 agentId 可能就是工作区 ID（顶层智能体），
        // 也可能是子智能体（进程跑在顶层智能体工作区）——按归属 agentId 精确过滤
        return p.agentId === wsFilter;
      });
      if (filtered.length > 0) { list = filtered; }
      // ws 过滤无命中时保留原候选（ws 可能是子智能体工作区 ID，非 agentId；不瞎选，交给唯一性/歧义判断）
    }
    if (list.length > 1) {
      return { ambig: list.map((p) => ({ agentId: p.agentId, addr: p.addr })) };
    }
    return { addr: list[0].addr };
  }

  app.all("/api/proc-http/:procName/*", async (c) => {
    const hub = hubOf();
    if (!hub) {
      return c.json({ error: "proc_message_hub_unavailable" }, 500);
    }
    const procName = c.req.param("procName");
    // 通配段手工提取：c.req.path 全路径去掉 /api/proc-http/{procName} 前缀
    const prefix = `/api/proc-http/${procName}`;
    const innerPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    const wsFilter = c.req.query("ws") || null;

    let resolved;
    try {
      resolved = resolveProcAddr(hub, procName, wsFilter);
    } catch (err) {
      void log.error("桥接解析进程地址失败", { procName, wsFilter, error: err.message, stack: err.stack });
      return c.json({ error: "internal_error", message: err.message }, 500);
    }
    if (resolved.error) {
      return c.json({ error: resolved.error, procName }, 404);
    }
    if (resolved.ambig) {
      return c.json({ error: "ambiguous_proc_name", procName, candidates: resolved.ambig }, 409);
    }

    // 请求体：JSON 优先，其余以原始文本透传（body 上限内）
    let body = null;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const raw = await c.req.arrayBuffer();
      if (raw.byteLength > BRIDGE_BODY_LIMIT) {
        return c.json({ error: "payload_too_large", limit: BRIDGE_BODY_LIMIT }, 413);
      }
      if (raw.byteLength > 0) {
        const contentType = c.req.header("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(new TextDecoder().decode(raw));
          } catch (err) {
            return c.json({ error: "invalid_json", message: err.message }, 400);
          }
        } else {
          body = { _raw: new TextDecoder().decode(raw), _contentType: contentType };
        }
      }
    }

    // 转发信封：id 由 hub 分配（关联回原路）；headers 全量透传给 handler
    // 注意 Headers 实例的键存于内部槽，Object.entries 取不到，必须用 .entries()
    const reqHeaders = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      reqHeaders[key] = value;
    }

    const result = await hub.requestProc(resolved.addr, {
      method: c.req.method,
      path: innerPath,
      query: new URL(c.req.url).search, // 含 ws= 本身，原样透传给 handler 自行处理
      headers: reqHeaders,
      body
    });

    if (!result.ok) {
      const status = result.error === "bridge_timeout" ? 504
        : (result.error === "session_died" ? 502 : 500);
      void log.warn("桥接请求失败", { procName, addr: resolved.addr, error: result.error });
      return c.json({ error: result.error }, status);
    }

    // 回浏览器：status/headers/body 原样透传（进程 handler 决定语义）
    const resHeaders = {};
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      if (key.toLowerCase() === "content-type") { resHeaders[key] = value; }
    }
    const status = result.status;
    const bodyOut = result.body;
    if (bodyOut === null || bodyOut === undefined) {
      return c.body(null, status, resHeaders);
    }
    if (typeof bodyOut === "object") {
      return c.json(bodyOut, status, resHeaders);
    }
    return c.text(String(bodyOut), status, resHeaders);
  });
}

// 声明式注册：依赖就绪时自动初始化，与加载顺序无关。
registry.declare({
  name: "proc-http-bridge-routes",
  requires: ["app", "log", "society"],
  provides: [],
  async init(deps) { registerProcHttpBridgeRoutes(deps); return {}; }
});
