/**
 * 沙箱模块集成测试
 * 测试完整流程：init → sandbox_spawn → get_status → read_output → kill → shutdown
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";

import sandboxModule from "../../../modules/sandbox/index.js";
import { testLoggerRoot } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("sandbox 模块集成测试", () => {
  /** @type {string} */
  let testDataDir;
  /** @type {string} */
  let testWorkspace;
  /** @type {any} */
  let mockRuntime;
  /** @type {any} */
  let mockCtx;

  beforeEach(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testDataDir = path.join(PROJECT_ROOT, "test", ".tmp", `sandbox_int_${suffix}`);
    testWorkspace = path.join(testDataDir, "workspace");
    await fsp.mkdir(testWorkspace, { recursive: true });

    mockRuntime = {
      loggerRoot: testLoggerRoot,
      org: {
        getAgent: () => null,
        getOrgName: () => null,
      },
      dataDir: testDataDir,
      registerSystemPromptProvider: () => {},
      findWorkspaceIdForAgent: () => null, // 让它回退到 process.cwd()
    };

    mockCtx = {
      agent: { id: "test-agent-1", name: "TestAgent" },
      runtime: mockRuntime,
    };

    // 先确保干净
    try { await sandboxModule.shutdown(); } catch {}
  });

  afterEach(async () => {
    try { await sandboxModule.shutdown(); } catch {}
    try { await fsp.rm(testDataDir, { recursive: true, force: true }); } catch {}
  });

  it("完整流程: init → spawn → get_status → read_output → kill → shutdown", async () => {
    // 初始化
    await sandboxModule.init(mockRuntime);

    // 工具定义
    const tools = sandboxModule.getToolDefinitions();
    assert.ok(Array.isArray(tools));
    assert.strictEqual(tools.length, 4);
    const toolNames = tools.map(t => t.function.name);
    assert.ok(toolNames.includes("sandbox_spawn"));
    assert.ok(toolNames.includes("sandbox_read_output"));
    assert.ok(toolNames.includes("sandbox_get_status"));
    assert.ok(toolNames.includes("sandbox_kill"));

    // spawn
    const spawnResult = await sandboxModule.executeToolCall(
      mockCtx,
      "sandbox_spawn",
      { code: "console.log('integration test');" }
    );
    assert.ok(spawnResult.ok, `spawn failed: ${spawnResult.error}`);
    assert.ok(spawnResult.processId);

    const processId = spawnResult.processId;

    // get_status — 应该是 running
    let status = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_get_status", { processId }
    );
    assert.ok(status.ok);

    // 等待完成
    const start = Date.now();
    while (Date.now() - start < 10000) {
      status = await sandboxModule.executeToolCall(
        mockCtx, "sandbox_get_status", { processId }
      );
      if (status.status !== "running") break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.strictEqual(status.status, "completed");
    assert.strictEqual(status.exitCode, 0);

    // read_output
    const output = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_read_output", { processId, offset: 0 }
    );
    assert.ok(output.ok);
    assert.ok(output.content.includes("integration test"));

    // kill — 进程已完成，kill 应返回 error
    const killResult = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_kill", { processId }
    );
    assert.strictEqual(killResult.ok, false);
    assert.ok(killResult.error.includes("not_running"));

    // shutdown
    await sandboxModule.shutdown();

    // shutdown 后工具调用应工作（但 manager 为空会导致报错）
    const afterShutdown = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_info", { processId }
    );
    assert.ok(afterShutdown.error);
  });

  it("spawn 参数校验：空 code 应返回 error", async () => {
    await sandboxModule.init(mockRuntime);

    const r1 = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_spawn", { code: "" }
    );
    assert.ok(r1.error === "code_must_be_non_empty_string");

    const r2 = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_spawn", {}
    );
    assert.ok(r2.error === "code_must_be_non_empty_string");
  });

  it("spawn 参数校验：超 10MB code 应返回 error", async () => {
    await sandboxModule.init(mockRuntime);

    const hugeCode = "// " + "x".repeat(11 * 1024 * 1024);
    const result = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_spawn", { code: hugeCode }
    );
    assert.strictEqual(result.error, "code_too_long");
  });

  it("未知工具调用应返回 error", async () => {
    await sandboxModule.init(mockRuntime);

    const result = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_unknown", {}
    );
    assert.strictEqual(result.error, "unknown_tool");
  });

  it("long-running process 使用 spawn → get_status → kill 流程", async () => {
    // 设置 mock runtime 使用 testWorkspace
    mockRuntime.findWorkspaceIdForAgent = () => "test-org";
    // 模拟 getWorkspaceManager
    const origModule = await import("../../../src/platform/services/workspace/workspace_manager.js");
    const WM = origModule.getWorkspaceManager();
    try {
      WM.getWorkspacePath = (id) => testWorkspace;
    } catch {}

    await sandboxModule.init(mockRuntime);

    // 启动一个长时间运行的进程（使用 setTimeout 模拟）
    const spawnResult = await sandboxModule.executeToolCall(
      mockCtx,
      "sandbox_spawn",
      { code: "console.log('started');\nsetTimeout(() => console.log('still running'), 30000);\nsetInterval(() => {}, 1000);" }
    );
    assert.ok(spawnResult.ok);
    const processId = spawnResult.processId;

    // 等一小会儿
    await new Promise(r => setTimeout(r, 1000));

    // 检查状态 — 因为网络被 blocked，进程应该已经 crash
    // 或者如果不是 crash，kill 它
    const status = await sandboxModule.executeToolCall(
      mockCtx, "sandbox_get_status", { processId }
    );
    assert.ok(status.ok);

    // 如果还在 running，kill
    if (status.status === "running") {
      const killResult = await sandboxModule.executeToolCall(
        mockCtx, "sandbox_kill", { processId }
      );
      assert.ok(killResult.ok);

      // 等待终止
      const start = Date.now();
      let s;
      while (Date.now() - start < 5000) {
        s = await sandboxModule.executeToolCall(
          mockCtx, "sandbox_get_status", { processId }
        );
        if (s.status !== "running") break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(s.status !== "running");
    }

    await sandboxModule.shutdown();
  });
});
