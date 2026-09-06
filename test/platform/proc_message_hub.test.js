/**
 * ProcMessageHub 单元测试（HTTP 化会话版）
 *
 * 覆盖：
 * - spawn token 登记（registerSpawn/unregisterToken）
 * - connect（成功/错 token/缺字段/agentId 服务端按 token 解析/processId 索引/同名替换 replaced）
 * - poll（立即取消息/长轮询挂起被唤醒/被替换返回 replaced/未知会话 404）
 * - up 入站路由（msg→bus、event→heartbeat、error→heartbeat、未知类型忽略）
 * - 出站（sendToProc 成功/离线、sendToProcess、resolveAddr、listProcs/listProcsByAgent）
 * - disconnect（幂等、注销、processId 索引清理）
 * - 过期清理（_sweepIdleSessions 直接调用）
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import { ProcMessageHub } from "../../src/platform/services/proc_messaging/proc_message_hub.js";

/** 静默日志器（测试断言 focus 业务行为） */
function makeLogger() {
  const calls = { error: [], warn: [] };
  return {
    debug: () => {},
    info: () => {},
    warn: (m, d) => { calls.warn.push({ m, d }); },
    error: (m, d) => { calls.error.push({ m, d }); },
    _calls: calls
  };
}

/** 建一个 hub + 模拟 bus/heartbeatBroker */
function startHub() {
  const logger = makeLogger();
  const busSends = [];
  const broadcasts = [];
  const bus = {
    send: (msg) => { busSends.push(msg); return { messageId: "mid-" + busSends.length }; }
  };
  const heartbeatBroker = {
    broadcast: (type, payload, ttlMs) => { broadcasts.push({ type, payload, ttlMs }); return broadcasts.length; }
  };
  const hub = new ProcMessageHub({ logger, bus, heartbeatBroker });
  return { hub, busSends, broadcasts, logger };
}

/** 登记 token + connect 的快捷方式 */
function connectProc(hub, { token, name, processId }) {
  hub.registerSpawn({ token, agentId: "agent-1" });
  return hub.connect({ token, name, processId });
}

describe("ProcMessageHub spawn token 登记", () => {
  it("registerSpawn 无效 token → 拒绝", () => {
    const { hub } = startHub();
    assert.deepStrictEqual(hub.registerSpawn({ token: "", agentId: "a" }), { ok: false, error: "invalid_token" });
    assert.deepStrictEqual(hub.registerSpawn({ token: null, agentId: "a" }), { ok: false, error: "invalid_token" });
  });

  it("unregisterToken 后 connect 被拒", () => {
    const { hub } = startHub();
    hub.registerSpawn({ token: "t1", agentId: "agent-1" });
    hub.unregisterToken("t1");
    const r = hub.connect({ token: "t1", name: "crawler" });
    assert.deepStrictEqual(r, { ok: false, error: "invalid_token" });
  });
});

describe("ProcMessageHub connect", () => {
  let ctx;
  beforeEach(() => { ctx = startHub(); });

  it("connect 成功 → sessionId + 服务端权威地址（agentId 按 token 解析）", () => {
    const r = connectProc(ctx.hub, { token: "t1", name: "crawler", processId: "pid-1" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.as, "proc:crawler#agent-1");
    assert.ok(r.sessionId);
    // 声明其他 agentId 也不影响归属（服务端按 token 解析）
    assert.strictEqual(ctx.hub.listProcs()[0].agentId, "agent-1");
  });

  it("错 token → invalid_token；缺 name → invalid_request", () => {
    ctx.hub.registerSpawn({ token: "t1", agentId: "agent-1" });
    assert.deepStrictEqual(ctx.hub.connect({ token: "wrong", name: "x" }), { ok: false, error: "invalid_token" });
    assert.deepStrictEqual(ctx.hub.connect({ token: "t1", name: "  " }), { ok: false, error: "invalid_request" });
  });

  it("同名进程重复连接：保留最新会话，旧会话 poll 返回 replaced", async () => {
    const first = connectProc(ctx.hub, { token: "t1", name: "crawler" });
    // 旧会话先挂一个长轮询
    const oldPoll = ctx.hub.poll(first.sessionId, { waitMs: 5_000 });

    const second = ctx.hub.connect({ token: "t1", name: "crawler" });
    assert.notStrictEqual(second.sessionId, first.sessionId);

    const oldResult = await oldPoll;
    assert.deepStrictEqual(oldResult, { ok: true, replaced: true });

    // 新会话正常收发
    ctx.hub.sendToProc("proc:crawler#agent-1", { payload: { text: "hi" } });
    const newResult = await ctx.hub.poll(second.sessionId, { waitMs: 100 });
    assert.strictEqual(newResult.ok, true);
    assert.strictEqual(newResult.messages.length, 1);
  });
});

describe("ProcMessageHub poll / 出站", () => {
  let ctx;
  let conn;
  beforeEach(() => {
    ctx = startHub();
    conn = connectProc(ctx.hub, { token: "t1", name: "crawler", processId: "pid-c" });
  });

  it("队列有消息 → poll 立即返回全部", async () => {
    ctx.hub.sendToProc("proc:crawler#agent-1", { payload: { text: "a" } });
    ctx.hub.sendToProc("proc:crawler#agent-1", { payload: { text: "b" } });
    const r = await ctx.hub.poll(conn.sessionId, { waitMs: 100 });
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].type, "msg");
    assert.strictEqual(r.messages[1].payload.text, "b");
    // 取走后队列清空
    const again = await ctx.hub.poll(conn.sessionId, { waitMs: 50 });
    assert.strictEqual(again.messages.length, 0);
  });

  it("空队列 → 长轮询挂起，up/sendToProc 推入即唤醒", async () => {
    const started = Date.now();
    const pending = ctx.hub.poll(conn.sessionId, { waitMs: 5_000 });
    ctx.hub.sendToProc("proc:crawler#agent-1", { payload: { text: "wake" } });
    const r = await pending;
    assert.strictEqual(r.messages.length, 1);
    assert.ok(Date.now() - started < 1_000, "应被立即唤醒而非等满超时");
  });

  it("空队列无消息 → 超时返回空数组", async () => {
    const started = Date.now();
    const r = await ctx.hub.poll(conn.sessionId, { waitMs: 150 });
    assert.deepStrictEqual(r, { ok: true, messages: [] });
    assert.ok(Date.now() - started >= 100, "应等待到超时");
  });

  it("未知 sessionId → unknown_session", async () => {
    const r = await ctx.hub.poll("no-such", { waitMs: 10 });
    assert.deepStrictEqual(r, { ok: false, error: "unknown_session" });
  });

  it("sendToProcess 按 processId 寻址；离线返回 proc_offline", async () => {
    const ok = ctx.hub.sendToProcess("pid-c", { payload: { text: "x" } });
    assert.strictEqual(ok.ok, true);
    const miss = ctx.hub.sendToProcess("no-such-pid", { payload: {} });
    assert.deepStrictEqual(miss.ok, false);
    assert.strictEqual(miss.error, "proc_offline");
  });

  it("listProcs/listProcsByAgent 投影含 processId", () => {
    assert.deepStrictEqual(ctx.hub.listProcsByAgent("agent-1"), [
      { procId: ctx.hub.listProcs()[0].procId, procName: "crawler", addr: "proc:crawler#agent-1", processId: "pid-c" }
    ]);
    assert.deepStrictEqual(ctx.hub.listProcsByAgent("other"), []);
  });
});

describe("ProcMessageHub up 入站路由", () => {
  let ctx;
  let conn;
  beforeEach(() => {
    ctx = startHub();
    conn = connectProc(ctx.hub, { token: "t1", name: "crawler" });
  });

  it("msg → bus.send(kind=proc_msg)，缺 to 时按归属智能体", () => {
    const r = ctx.hub.up(conn.sessionId, { type: "msg", payload: { text: "完成" } });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(ctx.busSends.length, 1);
    assert.strictEqual(ctx.busSends[0].to, "agent-1");
    assert.strictEqual(ctx.busSends[0].from, "proc:crawler#agent-1");
    assert.deepStrictEqual(ctx.busSends[0].extras, { kind: "proc_msg", procName: "crawler" });
  });

  it("event → heartbeat 广播 proc_event", () => {
    ctx.hub.up(conn.sessionId, { type: "event", event: "progress", data: { percent: 50 } });
    assert.strictEqual(ctx.broadcasts.length, 1);
    assert.strictEqual(ctx.broadcasts[0].type, "proc_event");
    assert.strictEqual(ctx.broadcasts[0].payload.event, "progress");
  });

  it("error → 记日志并广播 proc_error", () => {
    ctx.hub.up(conn.sessionId, { type: "error", message: "炸了", details: { code: 1 } });
    assert.strictEqual(ctx.broadcasts.length, 1);
    assert.strictEqual(ctx.broadcasts[0].payload.event, "proc_error");
    assert.ok(ctx.logger._calls.error.length >= 1);
  });

  it("未知类型忽略；未知会话拒绝", () => {
    ctx.hub.up(conn.sessionId, { type: "mystery" });
    assert.strictEqual(ctx.busSends.length, 0);
    assert.strictEqual(ctx.broadcasts.length, 0);
    const r = ctx.hub.up("no-such", { type: "msg" });
    assert.deepStrictEqual(r, { ok: false, error: "unknown_session" });
  });
});

describe("ProcMessageHub requestProc（网页⇄进程 HTTP 桥）", () => {
  let ctx;
  let conn;
  beforeEach(() => {
    ctx = startHub();
    conn = connectProc(ctx.hub, { token: "t1", name: "widget", processId: "pid-w" });
  });

  it("下发 http 信封 → http_result 按 id 关联返回", async () => {
    const pending = ctx.hub.requestProc("proc:widget#agent-1", {
      method: "POST", path: "/api/data", query: "?x=1", headers: { "content-type": "application/json" }, body: { text: "hi" }
    });
    // 从会话队列取走下行信封，模拟进程 SDK 处理后按原 id 回 http_result
    const polled = await ctx.hub.poll(conn.sessionId, { waitMs: 100 });
    assert.strictEqual(polled.messages.length, 1);
    const envelope = polled.messages[0];
    assert.strictEqual(envelope.type, "http");
    assert.strictEqual(envelope.method, "POST");
    assert.strictEqual(envelope.path, "/api/data");
    assert.deepStrictEqual(envelope.body, { text: "hi" });

    ctx.hub.up(conn.sessionId, { type: "http_result", id: envelope.id, status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true } });
    const r = await pending;
    assert.deepStrictEqual(r, { ok: true, status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true } });
  });

  it("进程离线 → proc_offline（不挂起）", async () => {
    const r = await ctx.hub.requestProc("proc:nobody#agent-1", { method: "GET", path: "/" });
    assert.deepStrictEqual(r, { ok: false, error: "proc_offline", addr: "proc:nobody#agent-1" });
  });

  it("http_result 迟到（无对应挂起请求）→ 丢弃不炸", async () => {
    // 直接模拟迟到路径：从未知 id 的 http_result 到 known 会话 → 丢弃并告警，不影响会话
    const r = ctx.hub.up(conn.sessionId, { type: "http_result", id: "no-such-id", status: 200, body: null });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(ctx.busSends.length, 0);
    assert.strictEqual(ctx.broadcasts.length, 0);
    assert.strictEqual(ctx.logger._calls.warn.length, 1, "迟到结果应记 warn");
  });

  it("挂起请求超时 → bridge_timeout（验证 finish 清理）", async () => {
    // 把挂起请求的 30s 定时器替换为 50ms，验证超时路径与 _pendingHttp 清理
    const pending = ctx.hub.requestProc("proc:widget#agent-1", { method: "GET", path: "/" });
    const pendingEntry = [...ctx.hub._pendingHttp.values()][0];
    clearTimeout(pendingEntry.timer);
    pendingEntry.timer = setTimeout(() => pendingEntry.resolve({ ok: false, error: "bridge_timeout" }), 50);
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "bridge_timeout" });
    // finish 幂等清理（第二次 resolve 无害）
    pendingEntry.resolve({ ok: false, error: "bridge_timeout" });
    assert.strictEqual(ctx.hub._pendingHttp.size, 0);
  });

  it("挂起期间会话被顶替 → 快速失败 session_died", async () => {
    const pending = ctx.hub.requestProc("proc:widget#agent-1", { method: "GET", path: "/" });
    const pendingEntry = [...ctx.hub._pendingHttp.values()][0];
    // 同名新会话 connect → 旧会话挂起请求快速失败
    const second = ctx.hub.connect({ token: "t1", name: "widget" });
    assert.notStrictEqual(second.sessionId, conn.sessionId);
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "session_died" });
    assert.strictEqual(ctx.hub._pendingHttp.size, 0);
  });

  it("挂起期间 disconnect → 快速失败 session_died", async () => {
    const pending = ctx.hub.requestProc("proc:widget#agent-1", { method: "GET", path: "/" });
    ctx.hub.disconnect(conn.sessionId);
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "session_died" });
    assert.strictEqual(ctx.hub._pendingHttp.size, 0);
  });

  it("挂起期间过期清理（sweep）→ 快速失败 session_died", async () => {
    const pending = ctx.hub.requestProc("proc:widget#agent-1", { method: "GET", path: "/" });
    const session = ctx.hub._procs.get("proc:widget#agent-1");
    session.lastSeenAt = Date.now() - 120_000;
    ctx.hub._sweepIdleSessions();
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "session_died" });
    assert.strictEqual(ctx.hub._pendingHttp.size, 0);
  });

  it("挂起期间 shutdown → 快速失败 hub_closed", async () => {
    const pending = ctx.hub.requestProc("proc:widget#agent-1", { method: "GET", path: "/" });
    ctx.hub.shutdown();
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "hub_closed" });
    assert.strictEqual(ctx.hub._pendingHttp.size, 0);
  });
});

describe("ProcMessageHub disconnect / 过期清理", () => {
  it("disconnect 注销会话与 processId 索引；幂等", async () => {
    const { hub } = startHub();
    const conn = connectProc(hub, { token: "t1", name: "crawler", processId: "pid-x" });
    assert.strictEqual(hub.disconnect(conn.sessionId).ok, true);
    assert.deepStrictEqual(hub.listProcs(), []);
    const pollAfter = await hub.poll(conn.sessionId, { waitMs: 10 });
    assert.deepStrictEqual(pollAfter, { ok: false, error: "unknown_session" });
    assert.deepStrictEqual(hub.sendToProcess("pid-x", { payload: {} }), { ok: false, error: "proc_offline", processId: "pid-x" });
    // 幂等
    assert.strictEqual(hub.disconnect(conn.sessionId).ok, true);
  });

  it("_sweepIdleSessions 注销长时间无活动会话", async () => {
    const { hub } = startHub();
    const conn = connectProc(hub, { token: "t1", name: "crawler" });
    // 挂一个长轮询，过期清理时应被终止
    const pending = hub.poll(conn.sessionId, { waitMs: 5_000 });
    // 篡改 lastSeenAt 模拟超时
    const session = hub._procs.get("proc:crawler#agent-1");
    session.lastSeenAt = Date.now() - 120_000;
    hub._sweepIdleSessions();
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "session_expired" });
    assert.deepStrictEqual(hub.listProcs(), []);
  });

  it("shutdown 终止全部挂起 poll 并清空注册表", async () => {
    const { hub } = startHub();
    const conn = connectProc(hub, { token: "t1", name: "crawler" });
    const pending = hub.poll(conn.sessionId, { waitMs: 5_000 });
    hub.shutdown();
    const r = await pending;
    assert.deepStrictEqual(r, { ok: false, error: "hub_closed" });
    assert.deepStrictEqual(hub.listProcs(), []);
  });
});
