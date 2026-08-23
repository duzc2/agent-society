/**
 * ProcessManager 外部进程（spawnExternalProcess）测试
 *
 * remote 模块把 SSH 远程进程包装成"进程样对象"交给 localcmd 统一管理。
 * 本文件用假的进程样对象（EventEmitter + 假 stdout/stderr/stdin/kill）覆盖：
 * - 完整生命周期：日志文件、解码落盘、live 状态、历史查询
 * - Bug 回归①：PROCESS_END 正则（signal=null 无尾括号 → 磁盘解析 completed）
 * - Bug 回归②：读窗口 UTF-8 边界（分块链式读取无 U+FFFD）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ProcessManager } from "../../../modules/localcmd/process_manager.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

/**
 * 构造假"进程样对象"（满足 spawnExternalProcess 的 childProcess 契约）：
 * stdout/stderr 是独立 EventEmitter；kill 记录调用；close(code, signal) /
 * error(err) / spawn 事件手动触发；stdin.write 返回是否成功。
 */
function makeFakeProcess({ pid = null } = {}) {
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  let stdinOpen = true;
  fake.stdin = {
    writes: [],
    write(data) {
      if (!stdinOpen) return false;
      this.writes.push(data);
      return true;
    },
    close() { stdinOpen = false; },
    get destroyed() { return !stdinOpen; }
  };
  fake.pid = pid;
  fake.killCalls = [];
  fake.kill = (signal) => { fake.killCalls.push(signal); };

  /** 模拟正常结束 */
  fake.emitClose = (code = 0, signal = null) => { fake.emit("close", code, signal); };
  return fake;
}

/** 等待轮询条件成立（支持同步/异步条件函数） */
async function waitFor(fn, maxWaitMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * 等待日志文件完全落盘（writeStream.end() 的磁盘冲刷是异步的，
 * status 置位早于文件写完）：尾标记出现且两次读取的文件大小稳定。
 */
async function waitForFileComplete(pm, processId) {
  const ok = await waitFor(async () => {
    const a = await pm.readOutputByFile(processId, { offset: 0, window: 1024 * 1024 });
    if (!a.ok || !a.content.includes("[PROCESS_END]")) return false;
    await new Promise((r) => setTimeout(r, 50));
    const b = await pm.readOutputByFile(processId, { offset: 0, window: 1024 * 1024 });
    return b.ok && b.totalLength === a.totalLength;
  }, 5000);
  if (!ok) throw new Error(`日志文件未在超时内完全落盘: ${processId}`);
}

describe("ProcessManager — spawnExternalProcess（外部进程统一管理）", () => {
  let pm;
  let testDataDir;

  beforeEach(async () => {
    testDataDir = path.join(
      PROJECT_ROOT, "test", ".tmp",
      `ext_proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fsp.mkdir(testDataDir, { recursive: true });

    pm = new ProcessManager({
      log: makeTestLogger("ExtProc-Test"),
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

  // ── 完整生命周期 ──

  it("完整生命周期：日志标记、中文解码落盘、live 状态 running", async () => {
    const fake = makeFakeProcess();
    const result = await pm.spawnExternalProcess("uname", ["-a"], {
      agentId: "agent-1",
      childProcess: fake,
    });
    assert.strictEqual(result.ok, true);

    // live Map 含条目且状态 running
    assert.strictEqual(pm.getProcess(result.processId).status, "running");
    // listHistory 显示 running（live 覆盖）
    const list1 = await pm.listHistory("agent-1");
    assert.strictEqual(list1.total, 1);
    assert.strictEqual(list1.items[0].status, "running");

    // 中文输出经解码器落盘（含跨 chunk 切分）。
    // 每个 data 事件各产生一行 [STDOUT] 前缀（现有行为），断言两个片段均解码正确
    const text = "目录列表完成";
    const buf = Buffer.from(text, "utf8");
    fake.stdout.emit("data", buf.subarray(0, 4));  // 切在多字节字符中间
    fake.stdout.emit("data", buf.subarray(4));
    fake.stderr.emit("data", Buffer.from("警告信息", "utf8"));

    fake.emitClose(0);
    await waitFor(() => pm.getProcess(result.processId)?.status === "completed");

    // 等文件完全落盘后读回验证（writeStream.end() 冲刷是异步的）
    await pm.listHistory("agent-1"); // 扫描入缓存
    await waitForFileComplete(pm, result.processId);
    const output = await pm.readOutput(result.processId);
    assert.strictEqual(output.ok, true);
    assert.ok(output.content.includes("[PROCESS_START] uname -a"), `应有 PROCESS_START 标记: ${output.content.slice(0, 100)}`);
    assert.ok(output.content.includes("[AGENT_ID] agent-1"), "应有 AGENT_ID 标记");
    assert.ok(output.content.includes("[STDOUT] 目"), `第一段应解码为"目"（跨 chunk 边界安全）: ${JSON.stringify(output.content.slice(0, 300))}`);
    assert.ok(output.content.includes("[STDOUT] 录列表完成"), `第二段应解码为"录列表完成": ${JSON.stringify(output.content.slice(0, 300))}`);
    assert.ok(!output.content.includes("�"), "不应有 U+FFFD");
    assert.ok(output.content.includes("[STDERR] 警告信息"), "stderr 应带前缀落盘");
    assert.ok(output.content.includes("[PROCESS_END] exitCode=0"), "应有 PROCESS_END 标记");

    // 历史状态 completed、退出码 0
    const list2 = await pm.listHistory("agent-1");
    assert.strictEqual(list2.items[0].status, "completed");
    assert.strictEqual(list2.items[0].exitCode, 0);
  });

  it("sendInput 写入假 stdin；stdin 关闭后返回 stdin_closed", async () => {
    const fake = makeFakeProcess();
    const result = await pm.spawnExternalProcess("cat", [], { agentId: "agent-1", childProcess: fake });
    assert.strictEqual(result.ok, true);

    const w1 = pm.sendInput(result.processId, "hello\n");
    assert.strictEqual(w1.ok, true);
    assert.deepStrictEqual(fake.stdin.writes, ["hello\n"]);

    // 关闭 stdin 后再写 → stdin_closed
    fake.stdin.close();
    const w2 = pm.sendInput(result.processId, "again\n");
    assert.strictEqual(w2.ok, false);
    assert.match(w2.error, /stdin_closed/);
  });

  it("error 事件 → startupError + [PROCESS_ERROR] 落盘", async () => {
    const fake = makeFakeProcess();
    const result = await pm.spawnExternalProcess("bad-cmd", [], { agentId: "agent-1", childProcess: fake });
    assert.strictEqual(result.ok, true);

    fake.emit("error", new Error("exec failed: command not found"));
    await waitFor(() => pm.getProcess(result.processId)?.status === "error");

    const proc = pm.getProcess(result.processId);
    assert.strictEqual(proc.status, "error");
    assert.match(proc.startupError, /command not found/);

    // 等 [PROCESS_ERROR] 标记落盘（error 文件没有 PROCESS_END 尾标记）。
    // 注意：readOutput 对 startupError 进程有意拒读，改用 readOutputByFile
    await pm.listHistory("agent-1");
    const flushed = await waitFor(async () => {
      const o = await pm.readOutputByFile(result.processId, { offset: 0, window: 65536 });
      return o.ok && o.content.includes("[PROCESS_ERROR]");
    }, 5000);
    assert.ok(flushed, "[PROCESS_ERROR] 标记应已落盘");
    const output = await pm.readOutputByFile(result.processId, { offset: 0, window: 65536 });
    assert.ok(output.content.includes("[PROCESS_ERROR] exec failed"));
  });

  it("kill 流程：adapter.kill 收到 SIGTERM、status killed；pid=null 不触发 taskkill 分支异常", async () => {
    const fake = makeFakeProcess(); // pid 默认 null（远程进程）
    const result = await pm.spawnExternalProcess("sleep", ["100"], { agentId: "agent-1", childProcess: fake });
    assert.strictEqual(result.ok, true);

    const killResult = pm.kill(result.processId);
    assert.strictEqual(killResult.ok, true);
    assert.deepStrictEqual(fake.killCalls, ["SIGTERM"]);
    assert.strictEqual(pm.getProcess(result.processId).status, "killed");

    // kill 后 close(143) 不应把 killed 改成 error
    fake.emitClose(null, "SIGTERM");
    await waitFor(() => pm.getProcess(result.processId)?.exitCode === null);
    assert.strictEqual(pm.getProcess(result.processId).status, "killed");
  });

  it("childProcess 缺失或非法 → 抛错（功能组件禁止空值兼容）", async () => {
    await assert.rejects(
      () => pm.spawnExternalProcess("cmd", [], { agentId: "a", childProcess: null }),
      /childProcess/
    );
    await assert.rejects(
      () => pm.spawnExternalProcess("cmd", [], { agentId: "a", childProcess: {} }),
      /childProcess/
    );
  });

  it("killByAgent 只终止匹配 agent 的运行中进程", async () => {
    const fakeA = makeFakeProcess();
    const fakeB = makeFakeProcess();
    await pm.spawnExternalProcess("a", [], { agentId: "agent-A", childProcess: fakeA });
    await pm.spawnExternalProcess("b", [], { agentId: "agent-B", childProcess: fakeB });

    const r = pm.killByAgent("agent-A");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.killed, 1);
    assert.strictEqual(fakeA.killCalls.length, 1);
    assert.strictEqual(fakeB.killCalls.length, 0);

    // 非 running 进程不再被杀
    const r2 = pm.killByAgent("agent-A");
    assert.strictEqual(r2.killed, 0);
  });
});

describe("ProcessManager — 历史 bug 回归（外部进程路径）", () => {
  let pm;
  let testDataDir;

  beforeEach(async () => {
    testDataDir = path.join(
      PROJECT_ROOT, "test", ".tmp",
      `ext_proc_bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fsp.mkdir(testDataDir, { recursive: true });

    pm = new ProcessManager({
      log: makeTestLogger("ExtProcBug-Test"),
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
    try {
      await fsp.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("Bug①回归：磁盘解析 signal=null 无尾括号 → completed（修复前恒 interrupted）", async () => {
    const fake = makeFakeProcess();
    const result = await pm.spawnExternalProcess("ls", [], { agentId: "agent-1", childProcess: fake });
    fake.stdout.emit("data", Buffer.from("file.txt\n", "utf8"));
    fake.emitClose(0);

    // 等文件尾标记落盘后清掉 live 条目（模拟进程条目 30 分钟后被清理的场景），
    // 此时历史状态只能来自磁盘解析
    await waitFor(() => pm.getProcess(result.processId)?.status === "completed");
    await pm.listHistory("agent-1");
    await waitForFileComplete(pm, result.processId);

    // 直接从磁盘重新解析（绕过 live）：新实例只扫文件
    const pm2 = new ProcessManager({
      log: makeTestLogger("ExtProcBug2-Test"),
      runtime: { lifecycleRegistry: { register: () => {}, unregister: async () => {} } },
      dataDir: testDataDir,
    });
    const list = await pm2.listHistory("agent-1");
    assert.strictEqual(list.total, 1);
    assert.strictEqual(list.items[0].status, "completed", `磁盘解析应为 completed（Bug①修复），实际: ${list.items[0].status}`);
    assert.strictEqual(list.items[0].exitCode, 0);
    assert.ok(list.items[0].durationMs !== null, "durationMs 应可解析");
  });

  it("Bug②回归：中文日志按 window=16 分块链式读取拼接 == 全文，无 U+FFFD", async () => {
    const fake = makeFakeProcess();
    const result = await pm.spawnExternalProcess("echo", [], { agentId: "agent-1", childProcess: fake });
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}行：中文内容测试数据`).join("\n");
    fake.stdout.emit("data", Buffer.from(lines, "utf8"));
    fake.emitClose(0);
    await waitFor(() => pm.getProcess(result.processId)?.status === "completed");

    // 等文件完全落盘后按小窗口链式读取（避免冲刷竞态干扰边界断言）
    await pm.listHistory("agent-1");
    await waitForFileComplete(pm, result.processId);
    const totalLen = (await pm.readOutputByFile(result.processId, { offset: 0, window: 16 })).totalLength;

    let offset = 0;
    let content = "";
    for (let i = 0; i < 500; i++) {
      const prev = offset;
      const chunk = await pm.readOutputByFile(result.processId, { offset, window: 16 });
      if (!chunk.ok) break;
      content += chunk.content;
      offset = chunk.nextOffset;
      if (!chunk.hasMore) break;
      assert.ok(chunk.nextOffset > prev, `偏移必须单调前进: ${prev} -> ${chunk.nextOffset}`);
    }
    assert.strictEqual(offset, totalLen, "应读到文件末尾");
    assert.ok(content.includes(lines), `分块拼接应包含原文，末段: ${JSON.stringify(content.slice(-120))}`);
    assert.ok(!content.includes("�"), `不应有 U+FFFD，实际片段: ${JSON.stringify(content.slice(0, 200))}`);
  });
});
