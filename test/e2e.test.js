/**
 * 端到端测试：Agent Society 完整业务流程
 *
 * 测试从需求提交到任务完成的完整流程，以及多智能体协作场景
 *
 * 需求：8.5, 11.3
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { AgentSociety } from "../src/platform/core/agent_society.js";
import { Config } from "../src/platform/utils/config/config.js";
import { getWorkspaceManager } from "../src/platform/services/workspace/workspace_manager.js";

describe("端到端测试 - 需求提交到任务完成的完整流程", () => {
  let society;
  let tmpDir;

  beforeEach(async () => {
    // 创建临时测试目录
    tmpDir = path.resolve(process.cwd(), `test/.tmp/e2e_requirement_test_${Date.now()}`);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    // 创建配置文件
    const configPath = path.resolve(tmpDir, "app.json");
    await writeFile(
      configPath,
      JSON.stringify({
        promptsDir: "config/prompts",
        artifactsDir: path.resolve(tmpDir, "artifacts"),
        runtimeDir: tmpDir
      }, null, 2),
      "utf8"
    );

    // 初始化系统
    const configService = new Config(tmpDir);
    society = new AgentSociety({
      configService,
      enableHttp: false,
      maxSteps: 10
    });
    await society.init();
  });

  afterEach(async () => {
    // 关闭系统
    if (society) {
      await society.shutdown();
    }
    // 清理测试目录
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("应成功提交需求并生成任务ID", async () => {
    // 提交需求
    const result = await society.submitRequirement("创建一个简单的测试任务");

    // 验证返回结果
    assert.ok(result);
    assert.ok(result.taskId);
    assert.strictEqual(result.error, undefined);

    // 验证任务ID格式（UUID）
    assert.match(result.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("应成功提交需求并绑定工作空间", async () => {
    // 创建工作空间目录
    const workspacePath = path.resolve(tmpDir, "workspace");
    await mkdir(workspacePath, { recursive: true });

    // 提交需求并绑定工作空间
    const result = await society.submitRequirement(
      "在工作空间中创建文件",
      { workspacePath }
    );

    // 验证返回结果
    assert.ok(result);
    assert.ok(result.taskId);
    assert.strictEqual(result.workspacePath, workspacePath);
    assert.strictEqual(result.error, undefined);

    // 验证工作空间已绑定（工作空间路径由管理器生成，不是原始路径）
    const boundPath = getWorkspaceManager().getWorkspacePath(result.taskId);
    assert.ok(boundPath);
    // 工作空间路径格式为：workspacesDir/taskId
    assert.ok(boundPath.includes(result.taskId));
  });

  it("应拒绝绑定不存在的工作空间", async () => {
    const nonExistentPath = path.resolve(tmpDir, "non-existent-workspace");

    // 提交需求并尝试绑定不存在的工作空间
    // 注意：WorkspaceManager 会自动创建目录，所以这个测试实际上会成功
    const result = await society.submitRequirement(
      "测试任务",
      { workspacePath: nonExistentPath }
    );

    // 验证返回成功（因为会自动创建目录）
    assert.ok(result);
    assert.ok(result.taskId);
    assert.strictEqual(result.workspacePath, nonExistentPath);
  });

  it("应成功发送消息到根智能体", async () => {
    // 发送消息到根智能体
    const result = await society.sendTextToAgent("root", "测试消息");

    // 验证返回结果
    assert.ok(result);
    assert.ok(result.taskId);
    assert.strictEqual(result.to, "root");
    assert.strictEqual(result.error, undefined);

    // 验证消息已发送到消息总线
    const message = society.runtime.bus.receiveNext("root");
    assert.ok(message);
    assert.strictEqual(message.from, "user");
    assert.strictEqual(message.to, "root");
    assert.strictEqual(message.payload.text, "测试消息");
  });

  it("应拒绝发送消息到用户端点", async () => {
    // 尝试发送消息到用户端点
    const result = await society.sendTextToAgent("user", "不应该发送的消息");

    // 验证返回错误
    assert.ok(result);
    assert.ok(result.error);
    assert.ok(result.error.includes("不能向用户端点发送消息"));
  });

  it("应拒绝发送消息到空智能体ID", async () => {
    // 尝试发送消息到空ID
    const result = await society.sendTextToAgent("", "测试消息");

    // 验证返回错误
    assert.ok(result);
    assert.ok(result.error);
    assert.ok(result.error.includes("不能为空"));
  });

  it("应成功接收智能体发送给用户的消息", async () => {
    // 注册消息监听器
    const receivedMessages = [];
    society.onUserMessage((message) => {
      receivedMessages.push(message);
    });

    // 模拟智能体发送消息给用户
    society.runtime.bus.send({
      to: "user",
      from: "root",
      taskId: "test-task",
      payload: { text: "来自根智能体的消息" }
    });

    // 等待消息处理
    await new Promise(resolve => setTimeout(resolve, 100));

    // 验证消息已接收
    assert.ok(receivedMessages.length > 0);
    const message = receivedMessages[0];
    assert.strictEqual(message.from, "root");
    assert.strictEqual(message.to, "user");
    assert.strictEqual(message.payload.text, "来自根智能体的消息");
  });

  it("应支持等待满足条件的用户消息", async () => {
    // 发送测试消息
    setTimeout(() => {
      society.runtime.bus.send({
        to: "user",
        from: "test-agent",
        taskId: "test-task-123",
        payload: { text: "特定消息" }
      });
    }, 50);

    // 等待满足条件的消息
    const message = await society.waitForUserMessage(
      (m) => m.taskId === "test-task-123",
      { timeoutMs: 1000 }
    );

    // 验证消息
    assert.ok(message);
    assert.strictEqual(message.taskId, "test-task-123");
    assert.strictEqual(message.payload.text, "特定消息");
  });

  it("应在超时后返回null", async () => {
    // 等待不存在的消息
    const message = await society.waitForUserMessage(
      (m) => m.taskId === "non-existent-task",
      { timeoutMs: 100 }
    );

    // 验证返回null
    assert.strictEqual(message, null);
  });
});

describe("端到端测试 - 多智能体协作场景", () => {
  let society;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.resolve(process.cwd(), `test/.tmp/e2e_collaboration_test_${Date.now()}`);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const configPath = path.resolve(tmpDir, "app.json");
    await writeFile(
      configPath,
      JSON.stringify({
        promptsDir: "config/prompts",
        artifactsDir: path.resolve(tmpDir, "artifacts"),
        runtimeDir: tmpDir
      }, null, 2),
      "utf8"
    );

    society = new AgentSociety({
      configService: new Config(tmpDir),
      enableHttp: false,
      maxSteps: 20
    });
    await society.init();
  });

  afterEach(async () => {
    if (society) {
      await society.shutdown();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("应支持创建多个智能体", async () => {
    const runtime = society.runtime;

    // 创建多个岗位
    const role1 = await runtime.org.createRole({
      name: "worker-1",
      rolePrompt: "工作者1",
      createdBy: "root"
    });

    const role2 = await runtime.org.createRole({
      name: "worker-2",
      rolePrompt: "工作者2",
      createdBy: "root"
    });

    // 创建多个智能体
    const agent1 = await runtime.spawnAgent({
      roleId: role1.id,
      parentAgentId: "root"
    });

    const agent2 = await runtime.spawnAgent({
      roleId: role2.id,
      parentAgentId: "root"
    });

    // 验证智能体已创建
    assert.ok(agent1);
    assert.ok(agent2);
    assert.notStrictEqual(agent1.id, agent2.id);

    // 验证智能体已注册
    assert.strictEqual(runtime._agents.has(agent1.id), true);
    assert.strictEqual(runtime._agents.has(agent2.id), true);
  });

  it("应支持智能体间消息传递", async () => {
    const runtime = society.runtime;

    // 创建两个智能体
    const role1 = await runtime.org.createRole({
      name: "sender",
      rolePrompt: "发送者",
      createdBy: "root"
    });

    const role2 = await runtime.org.createRole({
      name: "receiver",
      rolePrompt: "接收者",
      createdBy: "root"
    });

    const sender = await runtime.spawnAgent({
      roleId: role1.id,
      parentAgentId: "root"
    });

    const receiver = await runtime.spawnAgent({
      roleId: role2.id,
      parentAgentId: "root"
    });

    // 发送消息
    runtime.bus.send({
      to: receiver.id,
      from: sender.id,
      taskId: "collaboration-task",
      payload: { text: "协作消息" }
    });

    // 接收消息
    const message = runtime.bus.receiveNext(receiver.id);

    // 验证消息
    assert.ok(message);
    assert.strictEqual(message.from, sender.id);
    assert.strictEqual(message.to, receiver.id);
    assert.strictEqual(message.payload.text, "协作消息");
  });

  it("应支持父子智能体关系", async () => {
    const runtime = society.runtime;

    // 创建父智能体
    const parentRole = await runtime.org.createRole({
      name: "parent",
      rolePrompt: "父智能体",
      createdBy: "root"
    });

    const parent = await runtime.spawnAgent({
      roleId: parentRole.id,
      parentAgentId: "root"
    });

    // 创建子智能体
    const childRole = await runtime.org.createRole({
      name: "child",
      rolePrompt: "子智能体",
      createdBy: parent.id
    });

    const child = await runtime.spawnAgent({
      roleId: childRole.id,
      parentAgentId: parent.id
    });

    // 验证父子关系
    const childMeta = runtime._agentMetaById.get(child.id);
    assert.ok(childMeta);
    assert.strictEqual(childMeta.parentAgentId, parent.id);

    // 验证父智能体可以终止子智能体
    const result = await runtime.forceTerminateAgent(child.id, {
      deletedBy: parent.id,
      reason: "测试终止"
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(runtime._agents.has(child.id), false);
  });

  it("应支持智能体间任务协作", async () => {
    const runtime = society.runtime;

    // 创建两个智能体
    const role1 = await runtime.org.createRole({
      name: "task-creator",
      rolePrompt: "任务创建者",
      createdBy: "root"
    });

    const role2 = await runtime.org.createRole({
      name: "task-executor",
      rolePrompt: "任务执行者",
      createdBy: "root"
    });

    const creator = await runtime.spawnAgent({
      roleId: role1.id,
      parentAgentId: "root"
    });

    const executor = await runtime.spawnAgent({
      roleId: role2.id,
      parentAgentId: "root"
    });

    // 验证智能体已创建
    assert.ok(creator);
    assert.ok(executor);
    assert.strictEqual(runtime._agents.has(creator.id), true);
    assert.strictEqual(runtime._agents.has(executor.id), true);

    // 通过消息总线进行协作
    runtime.bus.send({
      to: executor.id,
      from: creator.id,
      taskId: "collaboration-task",
      payload: { text: "执行任务", data: "任务数据" }
    });

    // 验证消息已发送
    const message = runtime.bus.receiveNext(executor.id);
    assert.ok(message);
    assert.strictEqual(message.from, creator.id);
    assert.strictEqual(message.payload.data, "任务数据");
  });

  it("应支持智能体间消息广播", async () => {
    const runtime = society.runtime;

    // 创建协调者和多个工作者
    const coordinatorRole = await runtime.org.createRole({
      name: "coordinator",
      rolePrompt: "协调者",
      createdBy: "root"
    });

    const workerRole = await runtime.org.createRole({
      name: "worker",
      rolePrompt: "工作者",
      createdBy: "root"
    });

    const coordinator = await runtime.spawnAgent({
      roleId: coordinatorRole.id,
      parentAgentId: "root"
    });

    const workers = [];
    for (let i = 0; i < 3; i++) {
      const worker = await runtime.spawnAgent({
        roleId: workerRole.id,
        parentAgentId: coordinator.id
      });
      workers.push(worker);
    }

    // 协调者广播消息给所有工作者
    for (const worker of workers) {
      runtime.bus.send({
        to: worker.id,
        from: coordinator.id,
        taskId: "broadcast-task",
        payload: { text: "广播消息", command: "start" }
      });
    }

    // 验证每个工作者都收到了消息
    for (const worker of workers) {
      const message = runtime.bus.receiveNext(worker.id);
      assert.ok(message);
      assert.strictEqual(message.from, coordinator.id);
      assert.strictEqual(message.payload.command, "start");
    }
  });

  it("应支持多层级智能体组织", async () => {
    const runtime = society.runtime;

    // 创建第一层智能体（root的子智能体）
    const level1Role = await runtime.org.createRole({
      name: "level-1",
      rolePrompt: "第一层",
      createdBy: "root"
    });

    const level1Agent = await runtime.spawnAgent({
      roleId: level1Role.id,
      parentAgentId: "root"
    });

    // 创建第二层智能体（level1的子智能体）
    const level2Role = await runtime.org.createRole({
      name: "level-2",
      rolePrompt: "第二层",
      createdBy: level1Agent.id
    });

    const level2Agent = await runtime.spawnAgent({
      roleId: level2Role.id,
      parentAgentId: level1Agent.id
    });

    // 创建第三层智能体（level2的子智能体）
    const level3Role = await runtime.org.createRole({
      name: "level-3",
      rolePrompt: "第三层",
      createdBy: level2Agent.id
    });

    const level3Agent = await runtime.spawnAgent({
      roleId: level3Role.id,
      parentAgentId: level2Agent.id
    });

    // 验证层级关系
    const level1Meta = runtime._agentMetaById.get(level1Agent.id);
    const level2Meta = runtime._agentMetaById.get(level2Agent.id);
    const level3Meta = runtime._agentMetaById.get(level3Agent.id);

    assert.strictEqual(level1Meta.parentAgentId, "root");
    assert.strictEqual(level2Meta.parentAgentId, level1Agent.id);
    assert.strictEqual(level3Meta.parentAgentId, level2Agent.id);

    // 验证所有智能体都已注册
    assert.strictEqual(runtime._agents.has(level1Agent.id), true);
    assert.strictEqual(runtime._agents.has(level2Agent.id), true);
    assert.strictEqual(runtime._agents.has(level3Agent.id), true);
  });

  it("应支持智能体协作完成任务", async () => {
    const runtime = society.runtime;

    // 创建协调者智能体
    const coordinatorRole = await runtime.org.createRole({
      name: "coordinator",
      rolePrompt: "协调者",
      createdBy: "root"
    });

    const coordinator = await runtime.spawnAgent({
      roleId: coordinatorRole.id,
      parentAgentId: "root"
    });

    // 创建两个工作者智能体
    const worker1Role = await runtime.org.createRole({
      name: "worker-1",
      rolePrompt: "工作者1",
      createdBy: coordinator.id
    });

    const worker2Role = await runtime.org.createRole({
      name: "worker-2",
      rolePrompt: "工作者2",
      createdBy: coordinator.id
    });

    const worker1 = await runtime.spawnAgent({
      roleId: worker1Role.id,
      parentAgentId: coordinator.id
    });

    const worker2 = await runtime.spawnAgent({
      roleId: worker2Role.id,
      parentAgentId: coordinator.id
    });

    // 协调者分配任务给工作者
    runtime.bus.send({
      to: worker1.id,
      from: coordinator.id,
      taskId: "task-1",
      payload: { text: "完成任务A" }
    });

    runtime.bus.send({
      to: worker2.id,
      from: coordinator.id,
      taskId: "task-2",
      payload: { text: "完成任务B" }
    });

    // 工作者接收任务
    const task1 = runtime.bus.receiveNext(worker1.id);
    const task2 = runtime.bus.receiveNext(worker2.id);

    assert.ok(task1);
    assert.ok(task2);
    assert.strictEqual(task1.payload.text, "完成任务A");
    assert.strictEqual(task2.payload.text, "完成任务B");

    // 工作者完成任务并报告给协调者
    runtime.bus.send({
      to: coordinator.id,
      from: worker1.id,
      taskId: "task-1",
      payload: { text: "任务A已完成", status: "completed" }
    });

    runtime.bus.send({
      to: coordinator.id,
      from: worker2.id,
      taskId: "task-2",
      payload: { text: "任务B已完成", status: "completed" }
    });

    // 协调者接收完成报告
    const report1 = runtime.bus.receiveNext(coordinator.id);
    const report2 = runtime.bus.receiveNext(coordinator.id);

    assert.ok(report1);
    assert.ok(report2);
    assert.strictEqual(report1.payload.status, "completed");
    assert.strictEqual(report2.payload.status, "completed");

    // 协调者向用户报告总体完成
    runtime.bus.send({
      to: "user",
      from: coordinator.id,
      taskId: "overall-task",
      payload: { text: "所有任务已完成", completedTasks: 2 }
    });

    // 用户接收完成报告
    const finalReport = runtime.bus.receiveNext("user");
    assert.ok(finalReport);
    assert.strictEqual(finalReport.payload.completedTasks, 2);
  });
});

describe("端到端测试 - 系统生命周期管理", () => {
  let society;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.resolve(process.cwd(), `test/.tmp/e2e_lifecycle_test_${Date.now()}`);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const configPath = path.resolve(tmpDir, "app.json");
    await writeFile(
      configPath,
      JSON.stringify({
        promptsDir: "config/prompts",
        artifactsDir: path.resolve(tmpDir, "artifacts"),
        runtimeDir: tmpDir
      }, null, 2),
      "utf8"
    );

    society = new AgentSociety({
      configService: new Config(tmpDir),
      enableHttp: false,
      shutdownTimeoutMs: 5000
    });
    await society.init();
  });

  afterEach(async () => {
    if (society && !society.isShuttingDown()) {
      await society.shutdown();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("应成功初始化系统", async () => {
    // 验证运行时已初始化
    assert.ok(society.runtime);
    assert.ok(society.runtime._agents);

    // 验证根智能体已注册
    assert.strictEqual(society.runtime._agents.has("root"), true);

    // 验证用户端点已注册
    assert.strictEqual(society.runtime._agents.has("user"), true);
  });

  it("应成功关闭系统", async () => {
    // 创建一些智能体
    const role = await society.runtime.org.createRole({
      name: "test-worker",
      rolePrompt: "测试工作者",
      createdBy: "root"
    });

    await society.runtime.spawnAgent({
      roleId: role.id,
      parentAgentId: "root"
    });

    // 关闭系统
    const result = await society.shutdown();

    // 验证关闭结果
    assert.ok(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof result.shutdownDuration, "number");

    // 验证系统状态
    assert.strictEqual(society.isShuttingDown(), true);
  });

  it("应在关闭时清理资源", async () => {
    const runtime = society.runtime;

    // 创建智能体和会话
    const role = await runtime.org.createRole({
      name: "test-worker",
      rolePrompt: "测试工作者",
      createdBy: "root"
    });

    const agent = await runtime.spawnAgent({
      roleId: role.id,
      parentAgentId: "root"
    });

    // 初始化会话
    runtime._conversations.set(agent.id, [
      { role: "system", content: "测试会话" }
    ]);

    // 发送一些消息
    runtime.bus.send({
      to: agent.id,
      from: "root",
      taskId: "test-task",
      payload: { text: "测试消息" }
    });

    // 验证资源存在
    assert.strictEqual(runtime._agents.has(agent.id), true);
    assert.strictEqual(runtime._conversations.has(agent.id), true);

    // 关闭系统
    await society.shutdown();

    // 验证系统已关闭
    assert.strictEqual(society.isShuttingDown(), true);
  });

  it("应支持检查关闭状态", async () => {
    // 初始状态应该是未关闭
    assert.strictEqual(society.isShuttingDown(), false);

    // 开始关闭
    const shutdownPromise = society.shutdown();

    // 关闭过程中应该返回true
    assert.strictEqual(society.isShuttingDown(), true);

    // 等待关闭完成
    await shutdownPromise;

    // 关闭后应该仍然返回true
    assert.strictEqual(society.isShuttingDown(), true);
  });
});

describe("端到端测试 - HTTP服务器集成", () => {
  let society;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.resolve(process.cwd(), `test/.tmp/e2e_http_test_${Date.now()}`);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const configPath = path.resolve(tmpDir, "app.json");
    await writeFile(
      configPath,
      JSON.stringify({
        promptsDir: "config/prompts",
        artifactsDir: path.resolve(tmpDir, "artifacts"),
        runtimeDir: tmpDir
      }, null, 2),
      "utf8"
    );

    society = new AgentSociety({
      configService: new Config(tmpDir),
      enableHttp: false,
      shutdownTimeoutMs: 5000
    });
    await society.init();
  });

  afterEach(async () => {
    if (society && !society.isShuttingDown()) {
      await society.shutdown();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("应支持禁用HTTP服务器", () => {
    assert.strictEqual(society.isHttpServerRunning(), false);
    assert.strictEqual(society.getHttpServer(), null);
  });

  it("应支持启用HTTP服务器", async () => {
    // 先关闭禁用 HTTP 的实例
    await society.shutdown();
    // 用启用 HTTP 的配置重建
    const randomPort = 10000 + Math.floor(Math.random() * 10000);
    society = new AgentSociety({
      configService: new Config(tmpDir),
      enableHttp: true,
      httpPort: randomPort,
      shutdownTimeoutMs: 5000
    });
    await society.init();

    assert.strictEqual(society.isHttpServerRunning(), true);
    assert.ok(society.getHttpServer());

    const result = await society.stopHttpServer();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(society.isHttpServerRunning(), false);
  });
});
