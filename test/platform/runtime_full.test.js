/**
 * Runtime 核心功能测试
 * 测试 Runtime 类的实际接口和功能
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { Runtime } from "../../src/platform/core/runtime.js";
import { Config } from "../../src/platform/utils/config/config.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { getWorkspaceManager, WorkspaceManager, _setTestWorkspaceManager, _resetWorkspaceManager } from "../../src/platform/services/workspace/workspace_manager.js";

const TEST_DIR = "test/.tmp/runtime_full_test";

/** 辅助函数：在 runtime.init() 后初始化 workspaceManager 单例 */
function _initWs(runtime) {
  const wm = new WorkspaceManager({ workspacesDir: path.join(TEST_DIR, "workspaces"), dataDir: TEST_DIR, logger: runtime.log });
  _setTestWorkspaceManager(wm);
}

describe("Runtime Core Functionality", () => {
  let runtime;
  let configService;

  beforeEach(async () => {
    _resetWorkspaceManager();
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }

    await mkdir(TEST_DIR, { recursive: true });
    await mkdir(path.join(TEST_DIR, "config"), { recursive: true });
    await mkdir(path.join(TEST_DIR, "agents"), { recursive: true });
    await mkdir(path.join(TEST_DIR, "workspaces"), { recursive: true });

    // 创建最小化的配置 - Config 期望在传入目录的根目录找到 app.json
    await writeFile(
      path.join(TEST_DIR, "app.json"),
      JSON.stringify({
        promptsDir: "config/prompts",
        artifactsDir: path.join(TEST_DIR, "artifacts"),
        runtimeDir: TEST_DIR,
        maxSteps: 10,
        maxToolRounds: 100
      })
    );

    configService = new Config(TEST_DIR);
  });

  afterEach(async () => {
    _resetWorkspaceManager();
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch (e) {
        // 忽略关闭错误
      }
      runtime = null;
    }
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("构造函数", () => {
    it("应创建实例", () => {
      runtime = new Runtime({ configService });
      assert.notStrictEqual(runtime, undefined);
      assert.notStrictEqual(runtime.maxSteps, undefined);
      assert.notStrictEqual(runtime.maxToolRounds, undefined);
    });

    it("应初始化状态管理器", () => {
      runtime = new Runtime({ configService });
      assert.notStrictEqual(runtime._state, undefined);
      assert.notStrictEqual(runtime._agents, undefined);
      assert.notStrictEqual(runtime._agentMetaById, undefined);
    });

    it("应初始化生命周期管理器", () => {
      runtime = new Runtime({ configService });
      assert.notStrictEqual(runtime._lifecycle, undefined);
    });

    it("应初始化工具管理器", () => {
      runtime = new Runtime({ configService });
      assert.notStrictEqual(runtime._tools, undefined);
    });
  });

  describe("init - 初始化", () => {
    it("应成功初始化", async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);

      assert.notStrictEqual(runtime.config, undefined);
      assert.notStrictEqual(runtime.bus, undefined);
      assert.notStrictEqual(runtime.org, undefined);
      assert.notStrictEqual(getWorkspaceManager(), undefined);
    });

    it("应初始化所有核心服务", async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);

      assert.notStrictEqual(runtime.bus, undefined);
      assert.notStrictEqual(runtime.org, undefined);
      assert.notStrictEqual(runtime.prompts, undefined);
      assert.notStrictEqual(getWorkspaceManager(), undefined);

    });

    it("重复初始化应安全", async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);

      // 第二次初始化应该安全（不会抛出错误）
      await runtime.init(); _initWs(runtime);

      assert.notStrictEqual(runtime.config, undefined);
    });
  });

  describe("shutdown - 关闭", () => {
    it("应关闭所有服务", async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);

      const result = await runtime.shutdown();

      assert.notStrictEqual(result, undefined);
      assert.strictEqual(result.ok, true);
    });

    it("应支持多次关闭", async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);

      await runtime.shutdown();
      const result2 = await runtime.shutdown();

      assert.strictEqual(result2.ok, false); // 第二次返回已关闭状态
    });
  });

  describe("spawnAgent - 创建智能体", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应创建智能体", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      assert.notStrictEqual(agent, undefined);
      assert.notStrictEqual(agent.id, undefined);
      assert.strictEqual(agent.roleId, role.id);
    });

    it("应将智能体注册到运行时", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      assert.strictEqual(runtime._agents.has(agent.id), true);
    });

    it("无效角色应报错", async () => {
      await assert.rejects(runtime.spawnAgent({
        roleId: "non-existent",
        parentAgentId: "root"
      }));
    });
  });

  describe("forceTerminateAgent - 终止智能体", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应终止智能体", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      const result = await runtime.forceTerminateAgent(agent.id, {
        deletedBy: "root",
        reason: "测试终止"
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(runtime._agents.has(agent.id), false);
    });

    it("不存在时应返回错误", async () => {
      const result = await runtime.forceTerminateAgent("non-existent", {
        deletedBy: "root"
      });

      assert.strictEqual(result.ok, false);
    });
  });

  describe("listAgentInstances - 列出智能体", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应列出所有智能体", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });
      await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      const agents = runtime.listAgentInstances();

      assert.ok(agents.length >= 2);
    });

    it("应返回智能体基本信息", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      const agents = runtime.listAgentInstances();
      const found = agents.find(a => a.id === agent.id);

      assert.notStrictEqual(found, undefined);
      assert.strictEqual(found.roleId, role.id);
    });
  });

  describe("getAgentStatus - 获取智能体状态", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应获取智能体状态", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      const status = runtime.getAgentStatus(agent.id);

      assert.notStrictEqual(status, undefined);
      assert.strictEqual(status.id, agent.id);
    });

    it("不存在时应返回null", () => {
      const status = runtime.getAgentStatus("non-existent");
      assert.strictEqual(status, null);
    });
  });

  describe("消息总线集成", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应发送消息到智能体", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      const result = runtime.bus.send({
        to: agent.id,
        from: "root",
        payload: { text: "Hello" }
      });

      assert.notStrictEqual(result, undefined);
      assert.notStrictEqual(result.messageId, undefined);
    });

    it("应接收消息", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      runtime.bus.send({
        to: agent.id,
        from: "root",
        payload: { text: "Test message" }
      });

      const message = runtime.bus.receiveNext(agent.id);

      assert.notStrictEqual(message, undefined);
      assert.strictEqual(message.payload.text, "Test message");
    });
  });

  describe("Workspace 操作", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应绑定工作空间到任务", async () => {
      const taskId = "test-task-123";
      const workspacePath = path.join(TEST_DIR, "workspaces", taskId);

      const result = await getWorkspaceManager().bindWorkspace(taskId, workspacePath);

      assert.strictEqual(result.ok, true);
    });

    it("应获取工作空间路径", async () => {
      const taskId = "test-task-456";
      const workspacePath = path.join(TEST_DIR, "workspaces", taskId);

      await getWorkspaceManager().bindWorkspace(taskId, workspacePath);

      const boundPath = getWorkspaceManager().getWorkspacePath(taskId);

      assert.notStrictEqual(boundPath, undefined);
    });
  });

  describe("getQueueDepths - 获取队列深度", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应返回队列深度信息", async () => {
      const depths = runtime.getQueueDepths();

      assert.strictEqual(Array.isArray(depths), true);
    });
  });

  describe("事件系统", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应支持工具调用事件监听", () => {
      const listener = (event) => {};

      // 不应抛出错误
      assert.doesNotThrow(() => {
        runtime.onToolCall(listener);
      });
    });

    it("应支持错误事件监听", () => {
      const listener = (event) => {};

      // 不应抛出错误
      assert.doesNotThrow(() => {
        runtime.onError(listener);
      });
    });
  });

  describe("边界条件", () => {
    beforeEach(async () => {
      runtime = new Runtime({ configService });
      await runtime.init(); _initWs(runtime);
    });

    it("应处理并发创建智能体", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(runtime.spawnAgent({
          roleId: role.id,
          parentAgentId: "root"
        }));
      }

      const agents = await Promise.all(promises);
      assert.strictEqual(agents.length, 5);
    });

    it("应处理特殊字符消息", async () => {
      const role = await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "Prompt",
        createdBy: "root"
      });

      const agent = await runtime.spawnAgent({ roleId: role.id, parentAgentId: "root" });

      const result = runtime.bus.send({
        to: agent.id,
        from: "root",
        payload: { text: "Hello\n\t!@#$%^&*()你好🌍" }
      });

      assert.notStrictEqual(result.messageId, undefined);
    });
  });
});
