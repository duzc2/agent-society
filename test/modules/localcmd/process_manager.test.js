import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";

import { ProcessManager } from "../../../modules/localcmd/process_manager.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const isWin = process.platform === "win32";

/**
 * 等待进程完成（状态不为 'running'）
 */
async function waitForCompletion(pm, processId, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const proc = pm.getProcess(processId);
    if (proc && proc.status !== "running") return proc;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pm.getProcess(processId);
}

describe("ProcessManager — lifecycle & error handling", () => {
  let pm;
  let testDataDir;

  beforeEach(async () => {
    testDataDir = path.join(
      PROJECT_ROOT, "test", ".tmp",
      `pm_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fsp.mkdir(testDataDir, { recursive: true });

    pm = new ProcessManager({
      log: makeTestLogger("PM-Test"),
      runtime: {
        lifecycleRegistry: {
          register: () => {},
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

  // ── 测试 1：正常退出后，清理前 getProcess / readOutput 应正常 ──
  it("正常退出后清理前 getProcess 和 readOutput 应正常工作", async () => {
    const result = await pm.spawn("cmd.exe", ["/c", "exit", "0"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 等待进程完成
    const proc = await waitForCompletion(pm, processId);
    assert.notStrictEqual(proc, null, "getProcess 应在清理前返回进程信息");
    assert.strictEqual(proc.status, "completed");
    assert.strictEqual(proc.exitCode, 0);

    // readOutput 应正常返回
    const output = await pm.readOutput(processId);
    assert.strictEqual(output.ok, true, "readOutput 应在清理前正常工作");
    assert.strictEqual(output.status, "completed");
    assert.strictEqual(output.exitCode, 0);
  });

  // ── 测试 2：正常退出后在 30min 内不会清理 ──
  it("正常退出后在 30min 内不会被清理（修复后", {
    timeout: 15000
  }, async () => {
    const result = await pm.spawn("cmd.exe", ["/c", "exit", "0"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 等待 12 秒（大于原 10s 但远小于新的 30min）
    await new Promise((r) => setTimeout(r, 12000));

    const proc = pm.getProcess(processId);
    // 修复后应始终不为 null（30min 内不会被清理）
    assert.notStrictEqual(proc, null, "修复后 12s 内不应被清理（timeout 已改为 30min）");
    assert.strictEqual(proc.status, "completed");
    assert.strictEqual(proc.exitCode, 0);
  });

  // ── 测试 3：启动失败后 spawn 返回 ok:true，异步获取 startupError ──
  it("启动失败后 spawn 返回 ok:true，getProcess 异步返回 startupError", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("thisCommandDoesNotExistXYZ123.exe", []);
    // fire-and-forget: spawn 立即返回 ok:true
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 轮询等待 startupError 被设置
    let proc;
    for (let i = 0; i < 50; i++) {
      proc = pm.getProcess(processId);
      if (proc && proc.startupError) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.notStrictEqual(proc, null, "getProcess 应在启动失败后返回进程信息");
    assert.strictEqual(typeof proc.startupError, "string");
    assert.ok(proc.startupError.length > 0, "startupError 应包含错误信息");
  });

  // ── 测试 4：启动失败后 readOutput 返回 process_startup_failed ──
  it("启动失败后 readOutput 应返回 process_startup_failed（含 status 和 reason）", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("thisCommandDoesNotExistXYZ123.exe", []);
    // fire-and-forget: spawn 立即返回 ok:true
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 轮询等待 startupError 被设置，然后再读 output
    for (let i = 0; i < 50; i++) {
      const proc = pm.getProcess(processId);
      if (proc && proc.startupError) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const output = await pm.readOutput(processId);
    assert.strictEqual(output.ok, false);
    assert.strictEqual(output.error, "process_startup_failed");
    assert.strictEqual(output.status, "error");
    assert.strictEqual(typeof output.reason, "string");
    assert.ok(output.reason.length > 0, "reason 应包含错误详情");
  });

  // ── 测试 5：spawn 对所有命令类型都立即返回（不阻塞） ──
  it("spawn 对所有命令类型都立即返回（不阻塞）", {
    timeout: 10000
  }, async () => {
    // 快速命令
    const t1 = Date.now();
    const r1 = await pm.spawn("cmd.exe", ["/c", "exit", "0"]);
    const elapsed1 = Date.now() - t1;
    assert.strictEqual(r1.ok, true);
    assert.ok(elapsed1 < 500, `快速命令 spawn 耗时 ${elapsed1}ms，应 < 500ms`);

    // 带延迟的命令（2s 后才退出）
    const t2 = Date.now();
    const r2 = await pm.spawn("node", ["-e", "setTimeout(()=>process.exit(0),2000)"]);
    const elapsed2 = Date.now() - t2;
    assert.strictEqual(r2.ok, true);
    assert.ok(elapsed2 < 500, `延迟命令 spawn 耗时 ${elapsed2}ms，应 < 500ms`);

    // 驻留命令（无限循环）
    const t3 = Date.now();
    const r3 = await pm.spawn("node", ["-e", "setInterval(()=>{},99999999)"]);
    const elapsed3 = Date.now() - t3;
    assert.strictEqual(r3.ok, true);
    assert.ok(elapsed3 < 500, `驻留命令 spawn 耗时 ${elapsed3}ms，应 < 500ms`);

    // 清理：等待延迟命令完成，kill 驻留命令
    await pm.kill(r3.processId);
    await pm.kill(r2.processId);
  });

  // ── 测试 6：快速同步命令 — 正常完成 ──
  it("快速同步命令 — 正常完成，exitCode=0，能读到输出", async () => {
    const result = await pm.spawn("node", ["-e", "console.log('hello')"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    const proc = await waitForCompletion(pm, processId);
    assert.strictEqual(proc.status, "completed");
    assert.strictEqual(proc.exitCode, 0);

    const output = await pm.readOutput(processId);
    assert.strictEqual(output.ok, true);
    assert.ok(output.content.includes("hello"), `输出应包含 'hello'，实际: ${output.content}`);
  });

  // ── 测试 7：固定时间命令 — 定时结束，exitCode 正确 ──
  it("固定时间命令 — 定时结束，exitCode 正确", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("node", ["-e", "setTimeout(()=>process.exit(42),2000)"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    const proc = await waitForCompletion(pm, processId, 8000);
    assert.notStrictEqual(proc, null);
    assert.notStrictEqual(proc.status, "running", `进程应已完成，实际 status=${proc.status}`);
    assert.strictEqual(proc.exitCode, 42);
  });

  // ── 测试 8：异步驻留命令 — 保持 running，可被 kill ──
  it("异步驻留命令 — 保持 running，可被 kill", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("node", ["-e", "setInterval(()=>{},99999999)"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 等 500ms，验证仍在运行
    await new Promise((r) => setTimeout(r, 500));
    let proc = pm.getProcess(processId);
    assert.strictEqual(proc.status, "running", "驻留进程应保持 running");

    // kill 进程
    const killResult = pm.kill(processId);
    assert.strictEqual(killResult.ok, true);

    // 等待进程不再 running
    await new Promise((r) => setTimeout(r, 1000));
    proc = pm.getProcess(processId);
    assert.notStrictEqual(proc.status, "running", `kill 后进程不应为 running，实际: ${proc.status}`);
  });

  // ── 测试 9：ping 连续测试 — 运行中读输出，可被 kill ──
  it("ping 运行中读输出，可被 kill", {
    timeout: 15000
  }, async () => {
    const pingArgs = isWin ? ["127.0.0.1", "-t"] : ["127.0.0.1"];
    const result = await pm.spawn("ping", pingArgs);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 等 2s 让 ping 产生几行输出
    await new Promise((r) => setTimeout(r, 2000));

    const output = await pm.readOutput(processId);
    assert.strictEqual(output.ok, true);
    assert.ok(
      output.content.includes("127.0.0.1") || output.content.includes("localhost"),
      `ping 输出应包含目标地址，实际: ${output.content.substring(0, 500)}`
    );

    // kill 进程
    pm.kill(processId);

    // 等待进程不再 running
    await new Promise((r) => setTimeout(r, 1000));
    const proc = pm.getProcess(processId);
    assert.notStrictEqual(proc.status, "running", `kill 后进程不应为 running，实际: ${proc.status}`);
  });

  // ── 测试 10：多进程并发 — 互不干扰 ──
  it("多进程并发 — 互不干扰，各自独立", {
    timeout: 15000
  }, async () => {
    // 同时 spawn 3 个不同 node 脚本
    const [r1, r2, r3] = await Promise.all([
      pm.spawn("node", ["-e", "setTimeout(()=>process.exit(0),1000)"]),
      pm.spawn("node", ["-e", "setTimeout(()=>process.exit(99),2000)"]),
      pm.spawn("node", ["-e", "setInterval(()=>{},99999999)"]),
    ]);

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r3.ok, true);

    // 验证 3 个 processId 不同
    assert.notStrictEqual(r1.processId, r2.processId);
    assert.notStrictEqual(r1.processId, r3.processId);
    assert.notStrictEqual(r2.processId, r3.processId);

    // 等待第一个进程完成
    const proc1 = await waitForCompletion(pm, r1.processId, 5000);
    assert.strictEqual(proc1.exitCode, 0);

    // 等待第二个进程完成
    const proc2 = await waitForCompletion(pm, r2.processId, 5000);
    assert.strictEqual(proc2.exitCode, 99);

    // 第三个进程仍在运行
    const proc3 = pm.getProcess(r3.processId);
    assert.strictEqual(proc3.status, "running");

    // 读各自输出确认不串
    const out1 = await pm.readOutput(r1.processId);
    assert.strictEqual(out1.ok, true);
    const out2 = await pm.readOutput(r2.processId);
    assert.strictEqual(out2.ok, true);

    // 进程 1 的输出不应影响进程 2
    // 各自内容应不同
    assert.notStrictEqual(out1.content, out2.content, "不同进程的输出不应相同");

    // kill 驻留进程
    pm.kill(r3.processId);
  });

  // ── 测试 11：运行中持续读取输出 ──
  it("运行中持续读取输出（使用 nextOffset）", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("node", ["-e", "setInterval(()=>console.log('X'),100)"]);
    assert.strictEqual(result.ok, true);
    const processId = result.processId;

    // 等 300ms 后读第一次
    await new Promise((r) => setTimeout(r, 300));
    const read1 = await pm.readOutput(processId, { offset: 0 });
    assert.strictEqual(read1.ok, true);
    assert.ok(read1.content.includes("X"), `第一次读取应包含 'X'，实际: ${read1.content}`);
    assert.ok(read1.nextOffset > 0, "第一次读取后 nextOffset 应 > 0");

    // 等 300ms 后再读第二次（从 nextOffset 开始）
    await new Promise((r) => setTimeout(r, 300));
    const read2 = await pm.readOutput(processId, { offset: read1.nextOffset });
    assert.strictEqual(read2.ok, true);
    // 第二次读取应有新内容（nextOffset 应继续增长）
    assert.ok(
      read2.nextOffset > read1.nextOffset,
      `第二次读取 nextOffset (${read2.nextOffset}) 应 > 第一次 (${read1.nextOffset})`
    );

    // kill 清理
    pm.kill(processId);
  });

  // ── 测试 12：不存在命令异步返回 startupError ──
  it("不存在命令 — spawn 返回 ok:true，异步 getProcess 获得 startupError", {
    timeout: 10000
  }, async () => {
    const result = await pm.spawn("thisCommandDoesNotExistXYZ123.exe", []);
    assert.strictEqual(result.ok, true);

    // 轮询等待 startupError
    let proc;
    for (let i = 0; i < 50; i++) {
      proc = pm.getProcess(result.processId);
      if (proc && proc.startupError) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.notStrictEqual(proc, null);
    assert.strictEqual(typeof proc.startupError, "string");
  });
});
