/**
 * localcmd 模块 executeToolCall — pushEvents 透传测试
 *
 * mock.module 替换 process_manager.js，验证 3 处 spawn 调用点
 * （白名单 allow / confirm 回退 / confirm 用户允许）都透传 pushEvents：
 * - 默认（未传）→ true
 * - 显式传 false → false
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";

import { makeTestLogger, testLoggerRoot } from "../../helpers/test_logger.js";

const PROCESS_MANAGER_URL = new URL("../../../modules/localcmd/process_manager.js", import.meta.url).href;

// 收集 spawn 调用的参数（MockProcessManager 实例共享）
const spawnCalls = [];

class MockProcessManager {
  constructor() {
    this.log = makeTestLogger("MockPM");
  }

  getSystemInfo() {
    return { platform: "win32", shell: "cmd", shellType: "cmd" };
  }

  getSystemPromptSection() {
    return "";
  }

  onProcessEvent() {
    return () => {};
  }

  async spawn(command, args = [], options = {}) {
    spawnCalls.push({ command, args, options });
    return { ok: true, processId: `mock-${spawnCalls.length}` };
  }

  async killAll() {}

  kill() {
    return { ok: true };
  }
}

describe("localcmd executeToolCall — pushEvents 透传", () => {
  let localcmdModule;
  let handler;
  let tempDataDir;
  let mockRuntime;

  before(async () => {
    // mock.module 必须在测试上下文内调用，且动态 import 必须在 mock 之后
    await mock.module(PROCESS_MANAGER_URL, {
      namedExports: { ProcessManager: MockProcessManager },
    });
    localcmdModule = (await import("../../../modules/localcmd/index.js")).default;
  });

  beforeEach(async () => {
    spawnCalls.length = 0;
    tempDataDir = path.join(os.tmpdir(), `localcmd_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });

    mockRuntime = {
      loggerRoot: testLoggerRoot,
      org: {
        getAgent: () => null,
        getOrgName: () => null,
      },
      dataDir: tempDataDir,
      registerSystemPromptProvider: () => {},
      heartbeatBroker: null,
    };

    try { await localcmdModule.shutdown(); } catch {}

    await localcmdModule.init(mockRuntime);
    handler = localcmdModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await localcmdModule.shutdown(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  function makeReq(method = "POST") {
    return { method };
  }

  function makeCtx(agentId = "agent-1") {
    return {
      agent: { id: agentId, name: "测试智能体" },
      runtime: {
        findWorkspaceIdForAgent: () => "org1",
        org: mockRuntime.org,
      },
    };
  }

  it("白名单 allow 分支：默认 pushEvents=true，显式 false 透传 false", async () => {
    // 配置白名单使命令直接放行
    await handler(
      makeReq(),
      null,
      ["policies", "org1"],
      { whitelist: [{ type: "glob", pattern: "echo*" }], blacklist: [] }
    );

    const ctx = makeCtx();
    const r1 = await localcmdModule.executeToolCall(ctx, "localcmd_spawn", {
      command: "echo", args: ["hi"], intent: "测试", cwd: tempDataDir
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].options.pushEvents, true, "默认应透传 pushEvents=true");

    const r2 = await localcmdModule.executeToolCall(ctx, "localcmd_spawn", {
      command: "echo", args: ["hi2"], intent: "测试", cwd: tempDataDir, pushEvents: false
    });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(spawnCalls.length, 2);
    assert.strictEqual(spawnCalls[1].options.pushEvents, false, "显式 false 应透传");
  });

  it("confirm 分支心跳不可用时回退 spawn：pushEvents 透传", async () => {
    // 无白名单 → "echo hi" 走 confirm；heartbeatBroker 为 null → 回退 spawn
    const ctx = makeCtx();
    const result = await localcmdModule.executeToolCall(ctx, "localcmd_spawn", {
      command: "echo", args: ["hi"], intent: "测试", cwd: tempDataDir
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(spawnCalls.length, 1, "回退分支应调用 spawn");
    assert.strictEqual(spawnCalls[0].options.pushEvents, true);
  });

  it("confirm 分支用户允许后 spawn：pushEvents 透传", async () => {
    mockRuntime.heartbeatBroker = {
      broadcast: () => "msg-1",
      clearMessage: () => {},
    };

    const ctx = makeCtx();
    // 不 await：executeToolCall 挂起在用户确认的 Promise 上
    const pending = localcmdModule.executeToolCall(ctx, "localcmd_spawn", {
      command: "echo", args: ["hi"], intent: "测试", cwd: tempDataDir, pushEvents: false
    });

    // 模拟前端确认（允许）
    const resp = await handler(
      makeReq(),
      null,
      ["confirm-response"],
      { messageId: "msg-1", allowed: true }
    );
    assert.strictEqual(resp.ok, true);

    const result = await pending;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(spawnCalls.length, 1, "用户允许后应调用 spawn");
    assert.strictEqual(spawnCalls[0].options.pushEvents, false, "显式 false 应透传");
  });

  it("黑名单 reject 分支不调用 spawn", async () => {
    await handler(
      makeReq(),
      null,
      ["policies", "org1"],
      { whitelist: [], blacklist: [{ type: "glob", pattern: "rm*" }] }
    );

    const ctx = makeCtx();
    const result = await localcmdModule.executeToolCall(ctx, "localcmd_spawn", {
      command: "rm", args: ["-rf", "x"], intent: "测试", cwd: tempDataDir
    });
    assert.strictEqual(result.error, "command_blocked_by_policy");
    assert.strictEqual(spawnCalls.length, 0, "黑名单命令不应调用 spawn");
  });
});
