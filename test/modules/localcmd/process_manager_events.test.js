/**
 * ProcessManager 进程事件订阅 API 测试
 *
 * 验证 onProcessEvent / _emitProcessEvent：
 * - stdout/stderr 数据产生 log 事件（带 [STDOUT]/[STDERR] 前缀，与日志文件逐字一致）
 * - close 恰好产生一次 exit 事件
 * - kill 后 close 恰好产生一次 exit（status='killed'，防双发）
 * - 启动失败恰好产生一次 exit（error 非空，无 started）
 * - pushEvents=false 透传到事件
 * - 取消订阅函数生效；listener 抛异常不影响进程与其他监听器
 * - lifecycleRegistry 强制清理（agent 删除）→ exit 事件 status='killed'
 * - 集成推送时序（真实子进程 + EventPusher）：30s 批量（intervalMs 注入）、退出立即推送
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";

import { ProcessManager } from "../../../modules/localcmd/process_manager.js";
import { ProcessEventPusher } from "../../../src/platform/services/process_events/event_pusher.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

/**
 * 等待进程完成（状态不为 'running'）
 */
async function waitForCompletion(pm, processId, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const proc = pm.getProcess(processId);
    if (proc && proc.status !== "running") {return proc;}
    await new Promise((r) => setTimeout(r, 100));
  }
  return pm.getProcess(processId);
}

/**
 * 等待事件数组满足条件
 * @param {any[]} events
 * @param {(events: any[]) => boolean} predicate
 * @param {number} [maxWaitMs]
 * @returns {Promise<boolean>}
 */
async function waitForEvents(events, predicate, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (predicate(events)) {return true;}
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate(events);
}

/**
 * 收集当前 ProcessManager 的全部进程事件（每个测试独立 pm，事件不串）
 * @param {ProcessManager} pm
 * @returns {any[]}
 */
function collectEvents(pm) {
  const events = [];
  pm.onProcessEvent((evt) => events.push(evt));
  return events;
}

describe("ProcessManager — 进程事件订阅 API", () => {
  let pm;
  let testDataDir;
  let registeredCleanups;

  beforeEach(async () => {
    testDataDir = path.join(
      PROJECT_ROOT, "test", ".tmp",
      `pm_events_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fsp.mkdir(testDataDir, { recursive: true });

    registeredCleanups = [];
    pm = new ProcessManager({
      log: makeTestLogger("PM-Events"),
      runtime: {
        lifecycleRegistry: {
          register: (entry) => registeredCleanups.push(entry),
          unregister: async () => {},
        },
      },
      dataDir: testDataDir,
    });
  });

  afterEach(async () => {
    await pm.killAll();
    try {
      await fsp.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("stdout/stderr 数据产生 log 事件（带 [STDOUT]/[STDERR] 前缀）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn("node", [
      "-e", "console.log('hello-out'); console.error('hello-err')"
    ]);
    assert.strictEqual(result.ok, true);

    await waitForCompletion(pm, result.processId);
    await waitForEvents(events, (es) =>
      es.some(e => e.type === "log" && e.text.includes("hello-out")) &&
      es.some(e => e.type === "log" && e.text.includes("hello-err"))
    );

    const logs = events.filter(e => e.type === "log");
    assert.ok(
      logs.some(e => e.text.startsWith("[STDOUT]") && e.text.includes("hello-out")),
      `stdout log 事件应带 [STDOUT] 前缀，实际: ${logs.map(e => e.text).join(" | ")}`
    );
    assert.ok(
      logs.some(e => e.text.startsWith("[STDERR]") && e.text.includes("hello-err")),
      `stderr log 事件应带 [STDERR] 前缀，实际: ${logs.map(e => e.text).join(" | ")}`
    );
    // 事件必须携带 processId / agentId / pushEvents / ts
    for (const e of events) {
      assert.strictEqual(e.processId, result.processId);
      assert.strictEqual(e.pushEvents, true);
      assert.strictEqual(typeof e.ts, "number", "事件 ts 应为真实时间戳");
    }
  });

  it("close 后恰好产生一次 exit 事件（status 与 exitCode 正确）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn("node", ["-e", "process.exit(7)"]);
    assert.strictEqual(result.ok, true);

    await waitForCompletion(pm, result.processId);
    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "error"); // exitCode 7 ≠ 0 → error
    assert.strictEqual(exits[0].exitCode, 7);
    assert.strictEqual(typeof exits[0].ts, "number");
  });

  it("kill 后 close 恰好产生一次 exit 事件且 status='killed'", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn("node", ["-e", "setInterval(()=>{},99999999)"]);
    assert.strictEqual(result.ok, true);

    // 等 started 事件确认启动
    await waitForEvents(events, (es) => es.some(e => e.type === "started"));

    const killResult = pm.kill(result.processId);
    assert.strictEqual(killResult.ok, true);

    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));
    // 留出双发窗口（若 close 与 kill 都 emit，200ms 内可见）
    await new Promise((r) => setTimeout(r, 200));

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "killed");
    assert.strictEqual(exits[0].exitCode, null);
  });

  it("启动失败恰好产生一次 exit 事件（error 非空，无 started）", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn("thisCommandDoesNotExistXYZ123.exe", []);
    assert.strictEqual(result.ok, true);

    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));
    await new Promise((r) => setTimeout(r, 200)); // 留出双发窗口

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "error");
    assert.ok(exits[0].error, "exit 事件 error 字段应非空");
    assert.ok(!events.some(e => e.type === "started"), "启动失败不应有 started 事件");
  });

  it("pushEvents=false 时事件携带 pushEvents:false", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn(
      "node", ["-e", "console.log('x')"],
      { pushEvents: false }
    );
    assert.strictEqual(result.ok, true);

    await waitForCompletion(pm, result.processId);
    await waitForEvents(events, (es) => es.length > 0);

    assert.ok(events.length > 0, "应产生事件");
    for (const e of events) {
      assert.strictEqual(e.pushEvents, false, "pushEvents 应透传为 false");
    }
  });

  it("取消订阅函数生效；listener 抛异常不影响进程与其他监听器", {
    timeout: 10000
  }, async () => {
    const eventsA = [];
    const eventsB = [];
    let boomCalled = false;

    const unsubA = pm.onProcessEvent((evt) => { eventsA.push(evt); });
    pm.onProcessEvent(() => { boomCalled = true; throw new Error("listener boom"); });
    pm.onProcessEvent((evt) => { eventsB.push(evt); });

    const result = await pm.spawn("node", ["-e", "console.log('x')"]);
    assert.strictEqual(result.ok, true);
    await waitForCompletion(pm, result.processId);
    await waitForEvents(eventsB, (es) => es.length > 0);

    // 取消订阅后，再跑一个进程验证不再收到事件
    const countAfterUnsub = eventsA.length;
    unsubA();
    const result2 = await pm.spawn("node", ["-e", "console.log('y')"]);
    assert.strictEqual(result2.ok, true);
    await waitForCompletion(pm, result2.processId);
    await waitForEvents(eventsB, (es) => es.some(e => e.processId === result2.processId));

    assert.strictEqual(eventsA.length, countAfterUnsub, "取消订阅后不应再收到事件");
    assert.strictEqual(boomCalled, true, "抛异常的 listener 应被调用");

    // 进程与文件写入不受 listener 异常影响
    const out = await pm.readOutput(result.processId);
    assert.strictEqual(out.ok, true);
    assert.ok(out.content.includes("x"), "输出文件应正常写入");
  });

  it("lifecycleRegistry 强制清理（agent 删除）→ exit 事件 status='killed'", {
    timeout: 10000
  }, async () => {
    const events = collectEvents(pm);
    const result = await pm.spawn(
      "node", ["-e", "setInterval(()=>{},99999999)"],
      { agentId: "agent-1" }
    );
    assert.strictEqual(result.ok, true);
    await waitForEvents(events, (es) => es.some(e => e.type === "started"));

    // 找到该进程在生命周期表中的注册条目（模拟 agent 删除时被外部触发清理）
    const entry = registeredCleanups.find(r => r.id === `subprocess:${result.processId}`);
    assert.ok(entry, "进程应注册到生命周期表");
    assert.strictEqual(entry.type, "subprocess");
    assert.strictEqual(entry.ownerAgentId, "agent-1");

    entry.cleanup();
    await waitForEvents(events, (es) => es.some(e => e.type === "exit"));
    await new Promise((r) => setTimeout(r, 200)); // 留出双发窗口

    const exits = events.filter(e => e.type === "exit");
    assert.strictEqual(exits.length, 1, `exit 事件应恰好一次，实际 ${exits.length} 次`);
    assert.strictEqual(exits[0].status, "killed", "强制清理应产生 status='killed' 的 exit 事件");
  });

  it("集成推送时序：批量推送（intervalMs 注入）与退出立即推送", {
    timeout: 15000
  }, async () => {
    // 真实子进程 + ProcessEventPusher（intervalMs=200 注入，替代 30s 默认值）
    // 脚本：t≈0 输出 'a'，t≈300ms 输出 'b'，t≈700ms 退出
    // 预期：a 到达 → 200ms 后第 1 条（含 a 不含 b）；b 到达 → 200ms 后第 2 条（含 b）；
    //       exit → 立即第 3 条（含结束事件）；之后无第 4 条
    const sent = [];
    const pusher = new ProcessEventPusher({
      runtime: {
        bus: {
          send: (m) => {
            sent.push(m);
            return { messageId: `m${sent.length}` };
          }
        }
      },
      log: makeTestLogger("PM-Push"),
      intervalMs: 200
    });
    const unsubscribe = pm.onProcessEvent((evt) => pusher.onEvent(evt));

    try {
      const result = await pm.spawn("node", [
        "-e",
        "console.log('a'); setTimeout(()=>{console.log('b');},300); setTimeout(()=>process.exit(0),700)"
      ], { agentId: "agent-1" });
      assert.strictEqual(result.ok, true);

      // 第 1 条：批量推送（a），不含 b（真实 log 行带 [STDOUT] 前缀）
      await waitForEvents(sent, (msgs) => msgs.length >= 1);
      assert.ok(sent[0].payload.text.includes("\n[STDOUT] a"), "第 1 条应含 a");
      assert.ok(!sent[0].payload.text.includes("\n[STDOUT] b"), "第 1 条不应含 b（b 未到推送周期）");
      assert.strictEqual(sent[0].to, "agent-1", "消息应发给所属智能体");
      assert.strictEqual(sent[0].from, "localcmd", "from 应为 localcmd");
      assert.ok(typeof sent[0].payload.text === "string" && sent[0].payload.text.length > 0);

      // 第 2 条：b 的批量推送
      await waitForEvents(sent, (msgs) => msgs.length >= 2);
      assert.ok(sent[1].payload.text.includes("\n[STDOUT] b"), "第 2 条应含 b");
      assert.ok(!sent[1].payload.text.includes("\n[STDOUT] a"), "第 2 条不应再含 a");

      // 第 3 条：退出立即推送（不等 200ms 周期）
      await waitForEvents(sent, (msgs) => msgs.length >= 3);
      assert.ok(sent[2].payload.text.includes("已结束"), "第 3 条应含结束事件");

      // 进程结束后不应再有推送
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(sent.length, 3, "进程结束后不应再有推送");
    } finally {
      pusher.shutdown();
      unsubscribe();
    }
  });
});
