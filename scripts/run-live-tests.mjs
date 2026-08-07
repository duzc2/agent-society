/**
 * 真实 LLM 集成测试编排脚本
 *
 * 执行策略：
 *   Phase 1: 跑所有 mock 测试（test/**\/\*.test.js）
 *   Phase 2: mock 全通过后，跑真实 LLM 测试（test/live/*.live.js）
 *
 * 信号处理：
 *   Ctrl+C 时转发给当前运行的子进程，确保清理干净。
 *
 * 用法：
 *   npm run test:live        → 先 mock 后 live
 *   npm run test:live:only   → 只跑 live（直接调用 node --test）
 */

import { spawn } from "node:child_process";
import { argv, exit } from "node:process";

// ─── 常量 ──────────────────────────────────────────────────

const MOCK_PATTERN = "test/**/*.test.js";
const LIVE_PATTERN = "test/live/*.live.js";

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 使用 node:test 运行指定 glob 模式下的所有测试文件。
 *
 * @param {string} globPattern - 测试文件 glob 模式
 * @param {{ forceExit?: boolean }} [options]
 * @returns {Promise<number>} 子进程退出码
 */
function spawnTest(globPattern, options = {}) {
  return new Promise((resolve) => {
    const args = ["--test", globPattern];
    if (options.forceExit) {
      args.push("--test-force-exit");
    }

    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      shell: false,
      cwd: process.cwd()
    });

    let resolved = false;

    const cleanup = (code) => {
      if (resolved) return;
      resolved = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(code ?? 1);
    };

    // Ctrl+C / kill 信号转发给子进程
    const onSignal = () => {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    child.on("close", (code) => cleanup(code));

    child.on("error", (err) => {
      console.error(`Failed to spawn test process: ${err.message}`);
      cleanup(1);
    });
  });
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  // ─── Phase 1: Mock tests ───
  const sep = "=".repeat(60);

  console.log(sep);
  console.log("  Phase 1/2: Running mock tests...");
  console.log(`  Pattern: ${MOCK_PATTERN}`);
  console.log(sep);

  const mockStart = Date.now();
  const mockExitCode = await spawnTest(MOCK_PATTERN);
  const mockElapsed = ((Date.now() - mockStart) / 1000).toFixed(1);

  if (mockExitCode !== 0) {
    console.error(`\n${sep}`);
    console.error(`  Mock tests FAILED (exit code: ${mockExitCode}, ${mockElapsed}s)`);
    console.error(`  Live tests will NOT run. Fix mock tests first.`);
    console.error(sep);
    exit(mockExitCode);
  }

  console.log(`  Mock tests PASSED (${mockElapsed}s)`);

  // ─── Phase 2: Live LLM tests ───
  console.log(`\n${sep}`);
  console.log("  Phase 2/2: Running live LLM tests...");
  console.log(`  Pattern: ${LIVE_PATTERN}`);
  console.log(sep);

  const liveStart = Date.now();
  const liveExitCode = await spawnTest(LIVE_PATTERN, { forceExit: true });
  const liveElapsed = ((Date.now() - liveStart) / 1000).toFixed(1);

  // ─── Summary ───
  console.log(`\n${sep}`);
  console.log("  Test Results Summary:");
  console.log(`    Mock tests: PASSED (${mockElapsed}s)`);
  if (liveExitCode === 0) {
    console.log(`    Live tests: PASSED (${liveElapsed}s)`);
  } else {
    console.log(`    Live tests: FAILED (exit code: ${liveExitCode}, ${liveElapsed}s)`);
  }
  console.log(sep);

  exit(liveExitCode);
}

// 仅在直接执行时运行（不 import）
const self = argv[1]?.replace(/\\/g, "/") ?? "";
if (self && import.meta.url.endsWith(self)) {
  main().catch((err) => {
    console.error("Orchestration script failed:", err.message);
    exit(1);
  });
}
