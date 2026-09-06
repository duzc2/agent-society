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
// 收集 sendInput 调用的参数（面板 stdin 端点测试用）
const sendInputCalls = [];

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

  sendInput(processId, data) {
    sendInputCalls.push({ processId, data });
    if (processId === "no-such-pid") { return { ok: false, error: "process_not_found" }; }
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
    sendInputCalls.length = 0;
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
      procMessageHub: {
        sendToProc: (target) => ({ ok: true, messageId: "mock-1", addr: target }),
        sendToProcess: (processId) => ({ ok: true, messageId: "mock-2", processId }),
        listProcsByAgent: (agentId) => [{ procName: "crawler", agentId, addr: "proc:crawler#" + agentId, processId: "pid-crawler" }]
      },
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

  describe("proc_send 参数校验", () => {
    it("text/payload 都缺 → proc_empty_message", async () => {
      const ctx = makeCtx();
      const r1 = await localcmdModule.executeToolCall(ctx, "proc_send", {});
      assert.strictEqual(r1.error, "proc_empty_message");
      const r2 = await localcmdModule.executeToolCall(ctx, "proc_send", { text: "", payload: null });
      assert.strictEqual(r2.error, "proc_empty_message");
    });

    it("payload 非普通对象（字符串/数组）→ proc_invalid_payload", async () => {
      const ctx = makeCtx();
      const r1 = await localcmdModule.executeToolCall(ctx, "proc_send", { payload: "hi" });
      assert.strictEqual(r1.error, "proc_invalid_payload");
      const r2 = await localcmdModule.executeToolCall(ctx, "proc_send", { payload: [1, 2] });
      assert.strictEqual(r2.error, "proc_invalid_payload");
    });

    it("text + payload 并存 → 合并为 { ...payload, text } 下发", async () => {
      const ctx = makeCtx();
      const hub = mockRuntime.procMessageHub;
      const sends = [];
      hub.sendToProcess = (processId, message) => { sends.push({ processId, payload: message.payload }); return { ok: true, messageId: "mock-3" }; };
      const result = await localcmdModule.executeToolCall(ctx, "proc_send", { processId: "pid-1", text: "你好", payload: { url: "http://x" } });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(sends[0].payload, { url: "http://x", text: "你好" });
    });

    it("无 processId 多进程 → proc_ambiguous 错误信息直接给出各进程 processId", async () => {
      const ctx = makeCtx();
      const hub = mockRuntime.procMessageHub;
      hub.listProcsByAgent = (agentId) => [
        { procName: "crawler", agentId, addr: "proc:crawler#" + agentId, processId: "pid-a" },
        { procName: "monitor", agentId, addr: "proc:monitor#" + agentId, processId: "pid-b" }
      ];
      const result = await localcmdModule.executeToolCall(ctx, "proc_send", { text: "x" });
      assert.strictEqual(result.error, "proc_ambiguous");
      assert.match(result.message, /crawler \(processId=pid-a\)/);
      assert.match(result.message, /monitor \(processId=pid-b\)/);
      assert.match(result.message, /请传.*processId/);
    });
  });

  describe("面板 stdin 端点（POST processes/:id/input）", () => {
    it("合法 input → sendInput 收到原样字符串", async () => {
      const resp = await handler(
        makeReq(),
        null,
        ["processes", "pid-x", "input"],
        { input: "hi\n" }
      );
      assert.deepStrictEqual(resp, { ok: true });
      assert.strictEqual(sendInputCalls.length, 1);
      assert.strictEqual(sendInputCalls[0].processId, "pid-x");
      assert.strictEqual(sendInputCalls[0].data, "hi\n");
    });

    it("缺 input → missing_input，不触碰 sendInput", async () => {
      const resp = await handler(
        makeReq(),
        null,
        ["processes", "pid-x", "input"],
        {}
      );
      assert.strictEqual(resp.error, "missing_input");
      assert.strictEqual(sendInputCalls.length, 0);
    });

    it("process_not_found 透传（进程不存在）", async () => {
      const resp = await handler(
        makeReq(),
        null,
        ["processes", "no-such-pid", "input"],
        { input: "hi" }
      );
      assert.strictEqual(resp.ok, false);
      assert.strictEqual(resp.error, "process_not_found");
    });
  });

  describe("系统提示词注入（registerSystemPromptProvider 回调产出）", () => {
    it("提示词含 proc-event 页面订阅推送说明，且不再教写 workspace-files 页面文件", async () => {
      const captured = [];
      const rt = {
        ...mockRuntime,
        registerSystemPromptProvider: (name, fn) => captured.push({ name, fn })
      };
      await localcmdModule.shutdown();
      await localcmdModule.init(rt);
      const provider = captured.find((p) => p.name === "localcmd");
      assert.ok(provider, "init 应注册 localcmd 系统提示词提供器");
      const prompt = provider.fn();

      // 推送说明：页面 JS 可订阅 proc-event 实时收进程推送，无需轮询
      assert.ok(prompt.includes("proc-event"), "应含 proc-event 订阅说明");
      assert.ok(prompt.includes("window.addEventListener"), "应含页面订阅代码要点");
      assert.ok(prompt.includes("无需任何轮询"), "应明确无需轮询");
      assert.ok(prompt.includes("禁止自造 /api/poll"), "应禁止智能体自造轮询接口");

      // 旧坏范式应清除：不再教"写 html 文件到工作区让用户自己打开"
      assert.strictEqual(prompt.includes("workspace-files"), false, "不应再出现 workspace-files 路径");
      assert.strictEqual(prompt.includes("widget.html 由 localcmd 写入工作区"), false, "不应再教写工作区页面文件");
    });
  });
});
