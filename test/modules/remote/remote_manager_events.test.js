/**
 * RemoteManager 远程进程事件订阅 API 测试
 *
 * mock.module("ssh2") 注入假 Client/Stream，验证：
 * - stdout/stderr data 产生 log 事件（带 [STDOUT]/[STDERR] 前缀）
 * - stream close 恰好产生一次 exit 事件（status completed）
 * - killRemoteProcess → close → 恰好一次 exit（status='killed'，防双发）
 * - stream error 后 close → 仅一次 exit（startupError 守卫）
 * - pushEvents=false 透传到事件
 * - 取消订阅函数生效
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";

import { makeTestLogger } from "../../helpers/test_logger.js";

/** 假 SSH 流：EventEmitter + stderr 子流 + signal/close/write */
class MockStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this._closed = false;
  }

  signal() {}

  close() {
    if (!this._closed) {
      this._closed = true;
      this.emit("close", 0, null);
    }
  }

  write() {}
}

/** 假 SSH Client：connect 后微任务触发 ready；exec 立即回调返回 MockStream */
class MockClient extends EventEmitter {
  constructor() {
    super();
    this.streams = [];
    this._closed = false;
  }

  connect() {
    queueMicrotask(() => {
      if (!this._closed) {this.emit("ready");}
    });
  }

  exec(cmd, cb) {
    const stream = new MockStream();
    this.streams.push(stream);
    cb(null, stream);
  }

  end() {
    this._closed = true;
    this.emit("close");
  }
}

/** 等待事件数组满足条件 */
async function waitForEvents(events, predicate, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (predicate(events)) {return true;}
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate(events);
}

describe("RemoteManager — 远程进程事件订阅 API", () => {
  let mgr;
  let tempDataDir;

  before(async () => {
    // mock.module 必须在测试上下文内调用，且动态 import 必须在 mock 之后
    await mock.module("ssh2", { namedExports: { Client: MockClient } });
  });

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `remote_events_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });
    // 动态 import 在 mock.module 之后，使 mock 拦截生效
    const RemoteManager = (await import("../../../modules/remote/remote_manager.js")).default;
    mgr = new RemoteManager(makeTestLogger("Remote-Events"), tempDataDir);
  });

  afterEach(async () => {
    try { await mgr.closeAll(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  function collectEvents() {
    const events = [];
    mgr.onProcessEvent((evt) => events.push(evt));
    return events;
  }

  /** 启动一个远程进程并返回 { processId, client, stream } */
  async function spawnOne(pushEvents) {
    const result = await mgr.spawnRemoteProcess(
      "agent-1",
      { host: "127.0.0.1", username: "test" },
      "echo",
      ["hi"],
      undefined,
      undefined,
      pushEvents
    );
    assert.strictEqual(result.ok, true);
    const client = mgr._connections.get("agent-1").client;
    assert.ok(client instanceof MockClient, "应使用 MockClient");
    const stream = client.streams[client.streams.length - 1];
    return { processId: result.processId, client, stream };
  }

  it("stdout/stderr data 产生 log 事件（带 [STDOUT]/[STDERR] 前缀）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents();
    const { stream } = await spawnOne();

    stream.emit("data", Buffer.from("hello-out\n", "utf8"));
    stream.stderr.emit("data", Buffer.from("hello-err\n", "utf8"));

    await waitForEvents(events, (es) => es.some(e => e.type === "log" && e.text.includes("hello-out")));

    const logs = events.filter(e => e.type === "log");
    assert.ok(
      logs.some(e => e.text.startsWith("[STDOUT]") && e.text.includes("hello-out")),
      `stdout log 事件应带 [STDOUT] 前缀，实际: ${logs.map(e => e.text).join(" | ")}`
    );
    assert.ok(
      logs.some(e => e.text.startsWith("[STDERR]") && e.text.includes("hello-err")),
      `stderr log 事件应带 [STDERR] 前缀，实际: ${logs.map(e => e.text).join(" | ")}`
    );
    for (const e of events) {
      assert.strictEqual(e.processId, events[0].processId);
      assert.strictEqual(e.pushEvents, true);
      assert.strictEqual(typeof e.ts, "number", "事件 ts 应为真实时间戳");
    }
  });

  it("stream close 恰好产生一次 exit 事件（status completed）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents();
    const { stream } = await spawnOne();

    stream.emit("close", 0, null);
    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "completed");
    assert.strictEqual(exits[0].exitCode, 0);
  });

  it("killRemoteProcess → close → 恰好一次 exit（status='killed'）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents();
    const { processId } = await spawnOne();

    const killResult = await mgr.killRemoteProcess("agent-1", processId);
    assert.strictEqual(killResult.ok, true);

    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));
    await new Promise((r) => setTimeout(r, 100)); // 留出双发窗口

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "killed");
    assert.strictEqual(exits[0].exitCode, 0);
  });

  it("stream error 后 close → 仅一次 exit（startupError 守卫防双发）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents();
    const { stream } = await spawnOne();

    stream.emit("error", new Error("remote boom"));
    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));

    // error 后再触发 close（ssh2 中 error 后可能仍有关闭）
    stream.emit("close", 1, null);
    await new Promise((r) => setTimeout(r, 100));

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `error→close 场景 exit 应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "error");
    assert.ok(exits[0].error, "exit 事件 error 字段应非空");
  });

  it("pushEvents=false 透传到事件", {
    timeout: 10000
  }, async () => {
    const events = collectEvents();
    const { stream } = await spawnOne(false);

    stream.emit("data", Buffer.from("x\n", "utf8"));
    stream.emit("close", 0, null);
    await waitForEvents(events, (es) => es.length > 0);

    assert.ok(events.length > 0, "应产生事件");
    for (const e of events) {
      assert.strictEqual(e.pushEvents, false, "pushEvents 应透传为 false");
    }
  });

  it("取消订阅函数生效；listener 抛异常不影响其他监听器", {
    timeout: 10000
  }, async () => {
    const eventsA = [];
    const eventsB = [];
    let boomCalled = false;

    const unsubA = mgr.onProcessEvent((evt) => { eventsA.push(evt); });
    mgr.onProcessEvent(() => { boomCalled = true; throw new Error("listener boom"); });
    mgr.onProcessEvent((evt) => { eventsB.push(evt); });

    const { stream } = await spawnOne();
    // spawn 过程中 started 事件可能已到达 eventsA，记录取消订阅时的计数
    const countBeforeUnsub = eventsA.length;
    unsubA();
    stream.emit("data", Buffer.from("x\n", "utf8"));
    stream.emit("close", 0, null);
    await waitForEvents(eventsB, (es) => es.some(e => e.type === "exit"));

    assert.strictEqual(eventsA.length, countBeforeUnsub, "取消订阅后不应再收到事件");
    assert.strictEqual(boomCalled, true, "抛异常的 listener 应被调用");
  });
});
