import { describe, it } from "node:test";
import assert from "node:assert";
import { getFileManagerLaunchSpec, openPathInFileManager } from "../../src/platform/utils/process/open_in_file_manager.js";

// mock.fn polyfill for node:test compatibility with bun
function mockFn(impl) {
  const calls = [];
  const fn = (...args) => { calls.push({ arguments: args }); return impl ? impl(...args) : undefined; };
  fn.mock = { calls, resetCalls: () => { calls.length = 0; }, callCount: () => calls.length };
  return fn;
}

/**
 * 为不同平台生成文件管理器启动参数，确保跨平台路径打开行为稳定。
 */
describe("open_in_file_manager", () => {
  it("should build Windows start command", () => {
    const spec = getFileManagerLaunchSpec("win32", "C:/agent-society/workspaces/task-1");

    assert.deepStrictEqual(spec, {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `start "" "${String.raw`C:\agent-society\workspaces\task-1`}"`],
      spawnOptions: {
        windowsVerbatimArguments: true
      }
    });
  });

  it("should build open launch arguments on macOS", () => {
    const spec = getFileManagerLaunchSpec("darwin", "/tmp/workspaces/task-1");

    assert.deepStrictEqual(spec, {
      command: "open",
      args: ["/tmp/workspaces/task-1"]
    });
  });

  it("should default to xdg-open on Linux-like platforms", () => {
    const spec = getFileManagerLaunchSpec("linux", "/tmp/workspaces/task-1");

    assert.deepStrictEqual(spec, {
      command: "xdg-open",
      args: ["/tmp/workspaces/task-1"]
    });
  });

  it("should reject relative target paths", () => {
    assert.throws(() => openPathInFileManager("relative/path"), /target_path_must_be_absolute/);
  });

  it("should merge platform specific spawn options", async () => {
    const unref = mockFn(() => undefined);
    const once = mockFn((eventName, handler) => {
      if (eventName === "spawn") {
        handler();
      }
      return child;
    });
    const child = { once, unref };
    const spawnImpl = mockFn(() => child);

    await openPathInFileManager("C:/agent-society/workspaces/task-1", {
      platform: "win32",
      spawnImpl
    });

    assert.strictEqual(spawnImpl.mock.callCount(), 1);
    assert.deepStrictEqual(spawnImpl.mock.calls[0].arguments, ["cmd.exe", ["/d", "/s", "/c", `start "" "${String.raw`C:\agent-society\workspaces\task-1`}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true
    }]);
    assert.ok(unref.mock.callCount() > 0);
  });
});
