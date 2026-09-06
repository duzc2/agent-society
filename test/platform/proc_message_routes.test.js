/**
 * proc_message_routes — /api/proc-messaging/* 集成测试
 *
 * 验证：
 * - GET /api/proc-messaging/processes → hub.listProcs 透传
 * - POST /api/proc-messaging/send → hub 寻址分发（uuid → sendToProcess / 非 uuid → sendToProc）
 * - 参数校验：缺 target / 缺 payload / 非法 JSON
 * - hub 离线 → 404
 * - hub 不可用 → 500
 *
 * registry 是全局单例、模块只激活一次，因此走独立 declare+provide 流程
 * （不经 HTTPServer.setSociety，避免与集成测试互相污染）。
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { Hono } from "hono";
import { registry } from "../../src/platform/core/module_registry.js";
import { makeTestLogger } from "../helpers/test_logger.js";
// 副作用导入：触发 proc_message_routes.js 的 registry.declare()
import "../../src/platform/services/proc_messaging/proc_message_routes.js";

/** mock hub：记录调用并按用例脚本返回 */
function makeMockHub() {
  return {
    listProcs() {
      return [{ procId: "p-1", procName: "crawler", agentId: "agent-1", addr: "proc:crawler#agent-1", processId: "11111111-1111-1111-1111-111111111111", connectedAt: 1 }];
    },
    sendToProcess(processId, message) {
      this._calls.push({ fn: "sendToProcess", processId, payload: message.payload });
      if (processId === "00000000-0000-0000-0000-000000000000") { return { ok: false, error: "proc_offline" }; }
      return { ok: true, messageId: "mid-proc-" + this._calls.length };
    },
    sendToProc(addr, message) {
      this._calls.push({ fn: "sendToProc", addr, payload: message.payload });
      if (addr === "proc:nobody#agent-1") { return { ok: false, error: "proc_offline" }; }
      return { ok: true, messageId: "mid-addr-" + this._calls.length };
    },
    _calls: []
  };
}

describe("/api/proc-messaging routes", () => {
  let app;
  let hub;

  before(async () => {
    // 重置 proc-message-routes 模块状态（其他测试可能已激活过同名模块）
    for (const [, mod] of registry._modules) {
      if (mod.name === "proc-message-routes" && mod.status !== "declared") {
        mod.status = "declared";
      }
    }
    registry._services.delete("app");
    registry._services.delete("society");

    hub = makeMockHub();
    const honoApp = new Hono();

    // 提供 declare 所需依赖（proc_message_routes 从 society.runtime.procMessageHub 取 hub）
    await registry.provide({
      app: honoApp,
      log: makeTestLogger("ProcRoutes"),
      society: { runtime: { procMessageHub: hub } }
    });

    app = honoApp;
  });

  async function getJson(path) {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
  }

  async function postJson(path, data, raw) {
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
  }

  it("GET /processes → hub.listProcs 透传", async () => {
    const { status, body } = await getJson("/api/proc-messaging/processes");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.processes.length, 1);
    assert.strictEqual(body.processes[0].procName, "crawler");
    assert.strictEqual(body.processes[0].processId, "11111111-1111-1111-1111-111111111111");
  });

  it("POST /send uuid target → sendToProcess", async () => {
    const { status, body } = await postJson("/api/proc-messaging/send", {
      target: "11111111-1111-1111-1111-111111111111",
      payload: { text: "hi" }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(hub._calls.at(-1).fn, "sendToProcess");
    assert.deepStrictEqual(hub._calls.at(-1).payload, { text: "hi" });
  });

  it("POST /send 非 uuid target → sendToProc（按地址）", async () => {
    const { status, body } = await postJson("/api/proc-messaging/send", {
      target: "proc:crawler#agent-1",
      payload: { text: "hi" }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(hub._calls.at(-1).fn, "sendToProc");
  });

  it("POST /send 离线 → 404 + proc_offline", async () => {
    // uuid target：sendToProcess 分支返回 ok:false
    const byUuid = await postJson("/api/proc-messaging/send", {
      target: "00000000-0000-0000-0000-000000000000",
      payload: { text: "hi" }
    });
    assert.strictEqual(byUuid.status, 404);
    assert.strictEqual(byUuid.body.error, "proc_offline");

    // 地址 target：sendToProc 分支返回 ok:false
    const byAddr = await postJson("/api/proc-messaging/send", {
      target: "proc:nobody#agent-1",
      payload: { text: "hi" }
    });
    assert.strictEqual(byAddr.status, 404);
    assert.strictEqual(byAddr.body.error, "proc_offline");
  });

  it("POST /send 缺 target / 缺 payload → 400", async () => {
    const r1 = await postJson("/api/proc-messaging/send", { payload: { text: "x" } });
    assert.strictEqual(r1.status, 400);
    assert.strictEqual(r1.body.error, "missing_target");

    const r2 = await postJson("/api/proc-messaging/send", { target: "proc:crawler#agent-1" });
    assert.strictEqual(r2.status, 400);
    assert.strictEqual(r2.body.error, "missing_payload");
  });

  it("POST /send 非法 JSON → 400 invalid_json", async () => {
    const { status, body } = await postJson("/api/proc-messaging/send", null, "{not json");
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error, "invalid_json");
  });

  it("hub 不可用 → 500 proc_message_hub_unavailable", async () => {
    // 临时移除 society 的 hub 引用，模拟未初始化
    const society = registry.getService("society");
    const saved = society.runtime.procMessageHub;
    society.runtime.procMessageHub = null;
    try {
      const { status, body } = await getJson("/api/proc-messaging/processes");
      assert.strictEqual(status, 500);
      assert.strictEqual(body.error, "proc_message_hub_unavailable");
    } finally {
      society.runtime.procMessageHub = saved;
    }
  });
});
