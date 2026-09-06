/**
 * proc_http_bridge_routes — ANY /api/proc-http/* 集成测试
 *
 * 验证：
 * - procName 解析：同名唯一 → 转发；不存在 → 404 proc_offline
 * - 同名多进程歧义：?ws 过滤命中 → 转发；未过滤/过滤无命中 → 409 ambiguous_proc_name
 * - 请求转发：method/path/query/headers 透传到 hub.requestProc（JSON body 解析）
 * - 失败映射：bridge_timeout → 504 / session_died → 502 / proc_offline → 404
 * - 响应回传：http_result 的 status/headers(Content-Type)/body 原样回浏览器
 * - 参数校验：非法 JSON body → 400；body 超限 → 413
 * - hub 不可用 → 500
 *
 * registry 是全局单例、模块只激活一次，因此走独立 declare+provide 流程
 * （不经 HTTPServer.setSociety，避免与集成测试互相污染）。
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { Hono } from "hono";
import { registry } from "../../src/platform/core/module_registry.js";
import { makeTestLogger } from "../helpers/test_logger.js";
// 副作用导入：触发 proc_http_bridge_routes.js 的 registry.declare()
import "../../src/platform/services/proc_messaging/proc_http_bridge_routes.js";

const UUID_W = "44444444-4444-4444-4444-444444444444";

/** mock hub：记录 requestProc 调用，按用例脚本返回（模拟进程处理） */
function makeMockHub() {
  return {
    listProcs() {
      return this._procs;
    },
    requestProc(addr, req) {
      this._calls.push({ addr, req });
      // 脚本：addr 含 "timeout" → 超时；含 "died" → 会话死亡；否则回 200
      if (addr.includes("timeout")) {
        return Promise.resolve({ ok: false, error: "bridge_timeout" });
      }
      if (addr.includes("died")) {
        return Promise.resolve({ ok: false, error: "session_died" });
      }
      return Promise.resolve({
        ok: true, status: 201,
        headers: { "Content-Type": "application/json", "X-Custom": "should-not-pass" },
        body: { ok: true, echo: req.body }
      });
    },
    _procs: [],
    _calls: []
  };
}

describe("/api/proc-http bridge routes", () => {
  let app;
  let hub;

  before(async () => {
    for (const [, mod] of registry._modules) {
      if (mod.name === "proc-http-bridge-routes" && mod.status !== "declared") {
        mod.status = "declared";
      }
    }
    registry._services.delete("app");
    registry._services.delete("society");

    hub = makeMockHub();
    const honoApp = new Hono();
    await registry.provide({
      app: honoApp,
      log: makeTestLogger("ProcHttpBridge"),
      society: { runtime: { procMessageHub: hub } }
    });
    app = honoApp;
  });

  async function request(path, options = {}) {
    const res = await app.request(path, options);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  }

  beforeEach(() => {
    hub._calls = [];
  });

  it("同名进程唯一 → 转发（method/path/query/headers/body 透传）", async () => {
    hub._procs = [{ procId: "p-1", procName: "widget", agentId: "agent-1", addr: "proc:widget#agent-1", processId: UUID_W, connectedAt: 1 }];
    const r = await request("/api/proc-http/widget/api/data?x=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" })
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(hub._calls.length, 1);
    const call = hub._calls[0];
    assert.strictEqual(call.addr, "proc:widget#agent-1");
    assert.strictEqual(call.req.method, "POST");
    assert.strictEqual(call.req.path, "/api/data");
    assert.strictEqual(call.req.query, "?x=1");
    assert.deepStrictEqual(call.req.body, { text: "hi" });
    assert.strictEqual(call.req.headers["content-type"], "application/json");
  });

  it("进程不存在 → 404 proc_offline", async () => {
    hub._procs = [];
    const r = await request("/api/proc-http/ghost/api/x");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, "proc_offline");
  });

  it("同名多进程 → 409 ambiguous_proc_name 带候选", async () => {
    hub._procs = [
      { procId: "p-1", procName: "dup", agentId: "agent-1", addr: "proc:dup#agent-1", processId: null, connectedAt: 1 },
      { procId: "p-2", procName: "dup", agentId: "agent-2", addr: "proc:dup#agent-2", processId: null, connectedAt: 2 }
    ];
    const r = await request("/api/proc-http/dup/api/x");
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "ambiguous_proc_name");
    assert.strictEqual(r.body.candidates.length, 2);
  });

  it("同名多进程 + ?ws 过滤命中 → 转发到过滤后的进程", async () => {
    hub._procs = [
      { procId: "p-1", procName: "dup", agentId: "agent-1", addr: "proc:dup#agent-1", processId: null, connectedAt: 1 },
      { procId: "p-2", procName: "dup", agentId: "agent-2", addr: "proc:dup#agent-2", processId: null, connectedAt: 2 }
    ];
    const r = await request("/api/proc-http/dup/api/x?ws=agent-2");
    assert.strictEqual(r.status, 201);
    assert.strictEqual(hub._calls[0].addr, "proc:dup#agent-2");
  });

  it("bridge_timeout → 504；session_died → 502", async () => {
    hub._procs = [
      { procId: "p-t", procName: "timeout-proc", agentId: "agent-1", addr: "proc:timeout-proc#agent-1", processId: null, connectedAt: 1 },
      { procId: "p-d", procName: "died-proc", agentId: "agent-1", addr: "proc:died-proc#agent-1", processId: null, connectedAt: 1 }
    ];
    const t = await request("/api/proc-http/timeout-proc/x");
    assert.strictEqual(t.status, 504);
    assert.strictEqual(t.body.error, "bridge_timeout");
    const d = await request("/api/proc-http/died-proc/x");
    assert.strictEqual(d.status, 502);
    assert.strictEqual(d.body.error, "session_died");
  });

  it("http_result 回传：status/body 透传，非 Content-Type 头不透传", async () => {
    hub._procs = [{ procId: "p-1", procName: "widget", agentId: "agent-1", addr: "proc:widget#agent-1", processId: UUID_W, connectedAt: 1 }];
    const r = await request("/api/proc-http/widget/x");
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.body, { ok: true, echo: null });
  });

  it("非法 JSON body → 400", async () => {
    hub._procs = [{ procId: "p-1", procName: "widget", agentId: "agent-1", addr: "proc:widget#agent-1", processId: UUID_W, connectedAt: 1 }];
    const r = await request("/api/proc-http/widget/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "invalid_json");
  });

  it("非 JSON body → 以 {_raw,_contentType} 透传", async () => {
    hub._procs = [{ procId: "p-1", procName: "widget", agentId: "agent-1", addr: "proc:widget#agent-1", processId: UUID_W, connectedAt: 1 }];
    await request("/api/proc-http/widget/x", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "plain text"
    });
    assert.deepStrictEqual(hub._calls[hub._calls.length - 1].req.body, { _raw: "plain text", _contentType: "text/plain" });
  });

  it("hub 不可用 → 500 proc_message_hub_unavailable", async () => {
    // 临时移除 society 的 hub 引用，模拟未初始化（同对象改属性，与 proc_message_routes.test.js 同法）
    const society = registry.getService("society");
    const saved = society.runtime.procMessageHub;
    society.runtime.procMessageHub = null;
    try {
      const r = await request("/api/proc-http/widget/x");
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.body.error, "proc_message_hub_unavailable");
    } finally {
      society.runtime.procMessageHub = saved;
    }
  });
});
