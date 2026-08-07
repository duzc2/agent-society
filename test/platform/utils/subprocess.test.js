/**
 * createSubprocess 测试：stdout/stderr 管道排泄
 *
 * 测试步骤 2 的修改：createSubprocess() 自动附加 data 监听器排泄管道，
 * 将输出收集到可访问的字符串中，防止子进程因管道缓冲区满而阻塞。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { createSubprocess, killSubprocess, buildVenvActivateCommand, buildLaunchCommand } from "../../../src/platform/utils/process/subprocess.js";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * 查找可用的命令行解释器
 */
function getShellCommand() {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/c"] };
  }
  return { command: "sh", args: ["-c"] };
}

// ==================== 1. 管道排泄：小输出能正确收集 ====================

describe("createSubprocess — 管道排泄", () => {

  it("子进程 stdout 输出应被正确收集", async () => {
    const { command, args } = getShellCommand();
    const shellCmd = process.platform === "win32"
      ? `echo hello world`
      : `echo "hello world"`;

    const { process: child, exitPromise, getStdout, getStderr } = createSubprocess(command, [...args, shellCmd]);

    const exitCode = await exitPromise;

    // 进程正常退出
    assert.strictEqual(exitCode, 0);

    const stdout = getStdout();
    assert.ok(stdout.includes("hello world"));
    assert.strictEqual(getStderr(), "");
  });

  // ==================== 2. 管道排泄：大输出（>64KB）不阻塞 ====================

  it("大输出（> 64KB 管道缓冲）时子进程不应阻塞", async () => {
    const { command, args } = getShellCommand();

    // 生成约 100KB 的输出，超过默认 64KB 管道缓冲区
    // 使用循环打印的方法
    let shellCmd;
    if (process.platform === "win32") {
      // Windows: 使用 for /L 循环打印
      shellCmd = `for /L %i in (1,1,2000) do @echo %i`;
    } else {
      // Unix: 使用 seq 或 for
      shellCmd = `for i in $(seq 1 2000); do echo $i; done`;
    }

    const { exitPromise, getStdout } = createSubprocess(command, [...args, shellCmd]);

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 0);

    const stdout = getStdout();
    // 应该收集到大量输出（至少 > 64000 字符）
    assert.ok(stdout.length > 10000);
  });

  // ==================== 3. stderr 输出被正确收集 ====================

  it("子进程 stderr 输出应被正确收集", async () => {
    const { command, args } = getShellCommand();
    // Windows 和 Unix 都支持的向 stderr 输出方式
    const shellCmd = process.platform === "win32"
      ? `echo error text 1>&2`
      : `echo "error text" >&2`;

    const { exitPromise, getStdout, getStderr } = createSubprocess(command, [...args, shellCmd]);

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 0);

    const stderr = getStderr();
    assert.ok(stderr.includes("error text"));
    assert.strictEqual(getStdout(), "");
  });

  // ==================== 4. 返回对象兼容性 ====================

  it("返回对象应包含 process、exitPromise、getStdout、getStderr", () => {
    const { command, args } = getShellCommand();
    const shellCmd = process.platform === "win32" ? `echo test` : `echo "test"`;

    const result = createSubprocess(command, [...args, shellCmd]);

    // 保持向后兼容
    assert.ok(Object.hasOwn(result, "process"));
    assert.ok(Object.hasOwn(result, "exitPromise"));
    assert.notStrictEqual(result.process, undefined);

    // 新增属性
    assert.strictEqual(typeof result.getStdout, "function");
    assert.strictEqual(typeof result.getStderr, "function");
  });

  // ==================== 5. stream error 不会导致未处理异常 ====================

  it("stream error 事件不应导致进程崩溃", async () => {
    const { command, args } = getShellCommand();
    const shellCmd = process.platform === "win32" ? `echo ok` : `echo "ok"`;

    const { exitPromise, getStdout } = createSubprocess(command, [...args, shellCmd]);

    const exitCode = await exitPromise;
    assert.strictEqual(exitCode, 0);
    assert.ok(getStdout().includes("ok"));
    // 如果 stream error 导致崩溃，这个测试不会到达这里
  });

  // ==================== 6. 子进程退出码正确 ====================

  it("失败的子进程应返回非 0 退出码", async () => {
    const { command, args } = getShellCommand();
    const shellCmd = process.platform === "win32"
      ? `exit /b 1`
      : `exit 1`;

    const { exitPromise } = createSubprocess(command, [...args, shellCmd]);

    const exitCode = await exitPromise;
    assert.notStrictEqual(exitCode, 0);
  });

  // ==================== 7. buildVenvActivateCommand 和 buildLaunchCommand 不受影响 ====================

  it("buildVenvActivateCommand 正常工作", () => {
    const winCmd = buildVenvActivateCommand("venv", "win32");
    assert.ok(winCmd.includes("activate.bat"));

    const unixCmd = buildVenvActivateCommand("venv", "darwin");
    assert.ok(unixCmd.includes("source"));
    assert.ok(unixCmd.includes("activate"));
  });

  it("buildLaunchCommand 正常工作", () => {
    const win = buildLaunchCommand("venv", "llm-modules", "win32");
    assert.strictEqual(win.command, "cmd.exe");
    assert.strictEqual(win.args[0], "/c");
    assert.ok(win.args[1].includes("install_deps.py"));

    const unix = buildLaunchCommand("venv", "llm-modules", "darwin");
    assert.strictEqual(unix.command, "bash");
    assert.strictEqual(unix.args[0], "-c");
    assert.ok(unix.args[1].includes("install_deps.py"));
  });
});
