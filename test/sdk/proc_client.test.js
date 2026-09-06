/**
 * ProcClient SDK × ProcMessageHub 集成测试（HTTP 化传输）
 *
 * 真实 Hono 路由（registry 激活 proc_message_channel_routes）+ @hono/node-server 随机端口，
 * SDK 走真实 fetch（connect / 长轮询 / up）。验证 API 契约：
 * - 显式传参 / env 注入（SOCIETY_PROC_HTTP_URL / SOCIETY_PROC_TOKEN / SOCIETY_PROC_PROCESS_ID）连接
 * - agentId 由服务端按 token 解析；addr 权威形式
 * - send 对象首参重载 → hub bus 收到；notifyWeb → hub 广播 proc_event
 * - hub sendToProc → SDK onMessage 收到（经长轮询下发）
 * - close 等待上行落地 + disconnect 注销
 * - 被同名顶替 → replaced 停止轮询（不重连风暴）
 * - 缺连接参数 / 缺 name / 未就绪 send 报错
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { ProcMessageHub } from "../../src/platform/services/proc_messaging/proc_message_hub.js";
import { createProcClient, ProcClient } from "../../sdk/proc_client.js";

function makeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("ProcClient SDK × ProcMessageHub", () => {
  /** @type {{hub, busSends, broadcasts, server, httpUrl, cleanup}} */
  let env;
  const savedEnv = {};

  beforeEach(async () => {
    const busSends = [];
    const broadcasts = [];
    const hub = new ProcMessageHub({
      logger: makeLogger(),
      bus: { send: (msg) => { busSends.push(msg); return { messageId: "mid-" + busSends.length }; } },
      heartbeatBroker: { broadcast: (type, payload, ttlMs) => { broadcasts.push({ type, payload, ttlMs }); return broadcasts.length; } }
    });

    // 真路由：副作用导入触发 registry.declare，provide 激活
    const { registry } = await import("../../src/platform/core/module_registry.js");
    await import("../../src/platform/services/proc_messaging/proc_message_channel_routes.js");
    for (const [, mod] of registry._modules) {
      if (mod.name === "proc-message-channel-routes") { mod.status = "declared"; }
    }
    const app = new Hono();
    await registry.provide({
      app,
      log: makeLogger(),
      society: { runtime: { procMessageHub: hub } }
    });

    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    const httpUrl = `http://127.0.0.1:${server.address().port}`;

    env = { hub, busSends, broadcasts, server, httpUrl, cleanup: async () => { server.close(); hub.shutdown(); } };
  });

  afterEach(async () => {
    // 恢复本测试改过的环境变量
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) { delete process.env[k]; }
      else { process.env[k] = savedEnv[k]; }
    }
    await env.cleanup();
  });

  function procEnvSet(entries) {
    for (const [k, v] of Object.entries(entries)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  it("显式传参连接成功（addr + isReady）", async () => {
    env.hub.registerSpawn({ token: "t1", agentId: "agent-1" });
    // welcome 事件在 createProcClient 返回前已发出（connect 完成时），此处只验连接结果；
    // 后续事件（replaced）的订阅见专门用例
    const proc = await createProcClient({
      name: "crawler", baseUrl: env.httpUrl, token: "t1",
      log: makeLogger(), autoReconnect: false
    });
    assert.strictEqual(proc.isReady(), true);
    assert.strictEqual(proc.addr, "proc:crawler#agent-1");
    await proc.close();
  });

  it("env 注入连接（SOCIETY_PROC_HTTP_URL/SOCIETY_PROC_TOKEN）", async () => {
    env.hub.registerSpawn({ token: "t-env", agentId: "agent-1" });
    procEnvSet({ SOCIETY_PROC_HTTP_URL: env.httpUrl, SOCIETY_PROC_TOKEN: "t-env" });
    const proc = await createProcClient({ name: "crawler", autoReconnect: false, log: makeLogger() });
    assert.strictEqual(proc.isReady(), true);
    await proc.close();
  });

  it("无 SOCIETY_PROC_AGENT_ID env 也能连接（agentId 由服务端按 token 解析）", async () => {
    env.hub.registerSpawn({ token: "t2", agentId: "agent-9" });
    procEnvSet({ SOCIETY_PROC_HTTP_URL: env.httpUrl, SOCIETY_PROC_TOKEN: "t2" });
    const proc = await createProcClient({ name: "crawler", autoReconnect: false, log: makeLogger() });
    assert.strictEqual(proc.addr, "proc:crawler#agent-9");
    await proc.close();
  });

  it("SDK send 对象首参重载：send({ text }) → hub bus 收到 kind=proc_msg", async () => {
    env.hub.registerSpawn({ token: "t3", agentId: "agent-1" });
    const proc = await createProcClient({ name: "crawler", baseUrl: env.httpUrl, token: "t3", autoReconnect: false, log: makeLogger() });
    proc.send({ text: "完成" });
    // 上行是异步 fetch，轮询断言直到 bus 收到
    for (let i = 0; i < 30 && env.busSends.length === 0; i++) { await sleep(50); }
    assert.strictEqual(env.busSends.length, 1);
    assert.strictEqual(env.busSends[0].to, "agent-1");
    assert.deepStrictEqual(env.busSends[0].extras, { kind: "proc_msg", procName: "crawler" });
    await proc.close();
  });

  it("SDK notifyWeb → hub 广播 proc_event", async () => {
    env.hub.registerSpawn({ token: "t4", agentId: "agent-1" });
    const proc = await createProcClient({ name: "crawler", baseUrl: env.httpUrl, token: "t4", autoReconnect: false, log: makeLogger() });
    proc.notifyWeb("progress", { percent: 42 });
    for (let i = 0; i < 30 && env.broadcasts.length === 0; i++) { await sleep(50); }
    assert.strictEqual(env.broadcasts.length, 1);
    assert.strictEqual(env.broadcasts[0].payload.event, "progress");
    await proc.close();
  });

  it("hub sendToProc → SDK onMessage 经长轮询收到", async () => {
    env.hub.registerSpawn({ token: "t5", agentId: "agent-1" });
    const proc = await createProcClient({ name: "crawler", baseUrl: env.httpUrl, token: "t5", autoReconnect: false, log: makeLogger() });
    const received = [];
    proc.onMessage((p) => received.push(p));
    env.hub.sendToProc("proc:crawler#agent-1", { payload: { text: "下发" } });
    for (let i = 0; i < 30 && received.length === 0; i++) { await sleep(50); }
    assert.deepStrictEqual(received, [{ text: "下发" }]);
    await proc.close();
  });

  it("connect 携带 processId → hub 可按 processId 寻址到 SDK", async () => {
    env.hub.registerSpawn({ token: "t6", agentId: "agent-1" });
    procEnvSet({ SOCIETY_PROC_HTTP_URL: env.httpUrl, SOCIETY_PROC_TOKEN: "t6", SOCIETY_PROC_PROCESS_ID: "pid-42" });
    const proc = await createProcClient({ name: "crawler", autoReconnect: false, log: makeLogger() });
    const received = [];
    proc.onMessage((p) => received.push(p));
    const sent = env.hub.sendToProcess("pid-42", { payload: { text: "定向" } });
    assert.strictEqual(sent.ok, true);
    for (let i = 0; i < 30 && received.length === 0; i++) { await sleep(50); }
    assert.deepStrictEqual(received, [{ text: "定向" }]);
    await proc.close();
  });

  it("被同名进程顶替 → 旧会话 poll 返回 replaced，SDK 停止轮询", async () => {
    env.hub.registerSpawn({ token: "t7", agentId: "agent-1" });
    const events = [];
    const proc = await createProcClient({ name: "crawler", baseUrl: env.httpUrl, token: "t7", autoReconnect: false, log: makeLogger() });
    proc.onEvent((e) => events.push(e.event));

    // 同名新连接顶替
    const second = env.hub.connect({ token: "t7", name: "crawler" });
    assert.ok(second.ok);

    for (let i = 0; i < 30 && !events.includes("replaced"); i++) { await sleep(50); }
    assert.ok(events.includes("replaced"), "应收到 replaced 事件");
    assert.strictEqual(proc.isReady(), false);
    await proc.close();
  });

  it("close 等待未完成上行落地：send 后立即 close，消息仍到达 bus", async () => {
    env.hub.registerSpawn({ token: "t8", agentId: "agent-1" });
    const proc = await createProcClient({ name: "crawler", baseUrl: env.httpUrl, token: "t8", autoReconnect: false, log: makeLogger() });
    proc.send({ text: "最后一条" });
    await proc.close();
    assert.strictEqual(env.busSends.length, 1, "close 应等待上行落地");
    assert.strictEqual(env.busSends[0].payload.text, "最后一条");
  });

  it("createProcClient 缺连接参数 → 明确报错", async () => {
    const saved = process.env.SOCIETY_PROC_HTTP_URL;
    delete process.env.SOCIETY_PROC_HTTP_URL;
    const savedToken = process.env.SOCIETY_PROC_TOKEN;
    delete process.env.SOCIETY_PROC_TOKEN;
    try {
      await assert.rejects(
        () => createProcClient({ name: "x" }),
        /SOCIETY_PROC_HTTP_URL/
      );
    } finally {
      if (saved !== undefined) { process.env.SOCIETY_PROC_HTTP_URL = saved; }
      if (savedToken !== undefined) { process.env.SOCIETY_PROC_TOKEN = savedToken; }
    }
  });

  it("createProcClient 缺 name → 报错", async () => {
    await assert.rejects(
      () => createProcClient({ baseUrl: env.httpUrl, token: "t" }),
      /name 必填/
    );
  });

  it("未就绪时 send → 报错", () => {
    const raw = new ProcClient({ name: "x", baseUrl: "http://127.0.0.1:1", token: "t", autoReconnect: false, log: makeLogger() });
    assert.throws(() => raw.send({ text: "x" }), /未连接/);
  });
});

/**
 * 网页页面 ⇄ 进程 HTTP 桥：端到端（真实 fetch 全链路）
 *
 * 页面 fetch → 桥路由（解析 procName）→ hub.requestProc（http 信封）→
 * SDK 长轮询收到 → onRequest 处理 → http_result 上行 → 桥按 id 关联 → 浏览器拿响应。
 */
describe("ProcClient onRequest × HTTP 桥（端到端）", () => {
  /** @type {{hub, busSends, broadcasts, server, httpUrl, cleanup, bridgeApp}} */
  let env;

  beforeEach(async () => {
    const busSends = [];
    const broadcasts = [];
    const hub = new ProcMessageHub({
      logger: makeLogger(),
      bus: { send: (msg) => { busSends.push(msg); return { messageId: "mid-" + busSends.length }; } },
      heartbeatBroker: { broadcast: (type, payload, ttlMs) => { broadcasts.push({ type, payload, ttlMs }); return broadcasts.length; } }
    });

    // 真路由：channel 端点（SDK 走）+ 桥接端点（页面走）注册到同一 app
    const { registry } = await import("../../src/platform/core/module_registry.js");
    await import("../../src/platform/services/proc_messaging/proc_message_channel_routes.js");
    await import("../../src/platform/services/proc_messaging/proc_http_bridge_routes.js");
    for (const [, mod] of registry._modules) {
      if (mod.name === "proc-message-channel-routes" || mod.name === "proc-http-bridge-routes") { mod.status = "declared"; }
    }
    const app = new Hono();
    await registry.provide({
      app,
      log: makeLogger(),
      society: { runtime: { procMessageHub: hub } }
    });

    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    const httpUrl = `http://127.0.0.1:${server.address().port}`;

    env = { hub, busSends, broadcasts, server, httpUrl, cleanup: async () => { server.close(); hub.shutdown(); } };
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("页面 fetch POST JSON → 进程 onRequest → 原路返回 200 body", async () => {
    env.hub.registerSpawn({ token: "b1", agentId: "agent-1" });
    const proc = await createProcClient({ name: "widget", baseUrl: env.httpUrl, token: "b1", autoReconnect: false, log: makeLogger() });
    proc.onRequest(async (req) => {
      return { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, got: req.body, via: req.path } };
    });

    // 模拟页面：同源相对路径 fetch（带 query、带 body）
    const res = await fetch(`${env.httpUrl}/api/proc-http/widget/api/data?x=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { ok: true, got: { text: "hello" }, via: "/api/data" });
    assert.strictEqual(res.headers.get("content-type"), "application/json");
    await proc.close();
  });

  it("进程未注册 onRequest → 页面拿到 404 no_request_handler", async () => {
    env.hub.registerSpawn({ token: "b2", agentId: "agent-1" });
    const proc = await createProcClient({ name: "widget", baseUrl: env.httpUrl, token: "b2", autoReconnect: false, log: makeLogger() });

    const res = await fetch(`${env.httpUrl}/api/proc-http/widget/api/none`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.error, "no_request_handler");
    await proc.close();
  });

  it("onRequest 抛异常 → SDK 记日志代答 500，页面拿到 internal_error", async () => {
    env.hub.registerSpawn({ token: "b3", agentId: "agent-1" });
    const proc = await createProcClient({ name: "widget", baseUrl: env.httpUrl, token: "b3", autoReconnect: false, log: makeLogger() });
    proc.onRequest(async () => {
      throw new Error("业务炸了");
    });

    const res = await fetch(`${env.httpUrl}/api/proc-http/widget/api/boom`);
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.error, "internal_error");
    assert.strictEqual(data.message, "业务炸了");
    await proc.close();
  });

  it("进程在线但从不响应（无 onRequest 也没长轮询取走？）→ 超时语义由 hub 层保证，此处验证正常路径外的 proc_offline", async () => {
    // 离线进程 → 404（hub 层快速失败）
    const res = await fetch(`${env.httpUrl}/api/proc-http/nobody/api/x`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.error, "proc_offline");
  });

  it("onRequest 同名多进程 + ?ws 过滤 → 路由到正确归属进程", async () => {
    env.hub.registerSpawn({ token: "b5a", agentId: "agent-A" });
    env.hub.registerSpawn({ token: "b5b", agentId: "agent-B" });
    const procA = await createProcClient({ name: "twin", baseUrl: env.httpUrl, token: "b5a", autoReconnect: false, log: makeLogger() });
    const procB = await createProcClient({ name: "twin", baseUrl: env.httpUrl, token: "b5b", autoReconnect: false, log: makeLogger() });
    procA.onRequest(async () => ({ status: 200, body: { who: "A" } }));
    procB.onRequest(async () => ({ status: 200, body: { who: "B" } }));

    const res = await fetch(`${env.httpUrl}/api/proc-http/twin/api/who?ws=agent-B`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.who, "B");
    await procA.close();
    await procB.close();
  });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
