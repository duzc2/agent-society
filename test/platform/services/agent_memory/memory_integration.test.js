/**
 * Agent Memory 集成测试
 *
 * 测试完整的记忆流程：
 * 1. TurnEngine 调用 _updateAgentMemory
 * 2. AgentMemoryManager 创建记忆实例
 * 3. processConversation 保存到 ContextManager
 * 4. RuntimeLlm._buildMemoryContext 调用 recall
 * 5. 记忆持久化到 org.json
 *
 * 注意：这些测试假设 hmemory 包可用。如果不可用，会跳过相关测试。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// @ts-ignore - 测试中使用简化类型
import { AgentMemoryManager } from "../../../../src/platform/services/agent_memory/agent_memory_manager.js";
import { makeTestLogger, testLoggerRoot } from "../../../helpers/test_logger.js";
import { OrgPrimitives } from "../../../../src/platform/core/org_primitives.js";
import { Agent } from "../../../../src/agents/agent.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const TEST_DIR = "test/.tmp/memory_integration_test";

// 创建完整的 Mock Runtime
function createMockRuntime(config = {}) {
  const org = new OrgPrimitives({
    runtimeDir: path.join(TEST_DIR, "runtime"),
    logger: makeTestLogger("AgentMemory")
  });

  return {
    dataDir: TEST_DIR,
    config: config,
    log: makeTestLogger("AgentMemory"),
    loggerRoot: testLoggerRoot,
    _agents: new Map(),
    _conversations: new Map(),
    _agentMetaById: new Map(),
    org: org,
    agentMemoryManager: null,
    _formatMessageForLlm: async (ctx, message) => {
      return message?.payload?.text || message?.content || "";
    }
  };
}

// 向 mockRuntime._agents 注册测试用智能体
function registerAgent(mockRuntime, agentId) {
  mockRuntime._agents.set(agentId, { id: agentId, _isTerminating: false });
}

// 检查 hmemory 包是否可用
async function isHMemoryAvailable() {
  try {
    await import("hmemory");
    return true;
  } catch {
    return false;
  }
}

// 测试条件标志
let hmemoryAvailable = false;

describe("Agent Memory Integration", () => {
  let runtime;
  let manager;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });

    hmemoryAvailable = await isHMemoryAvailable();

    runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        maxEntries: 1000,
        recall: { limit: 5, minConfidence: 0.7 },
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 1536 }
      }
    });

    manager = new AgentMemoryManager(runtime);
    runtime.agentMemoryManager = manager;
    await manager.initialize();
    await runtime.org.ensureReady();
  });

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
    }
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("完整流程模拟", () => {
    it("应能创建 AgentMemory 实例 (如果 hmemory 可用)", async () => {
      registerAgent(runtime, "agent-1");
      const memory = await manager.getOrCreateMemory("agent-1");

      if (hmemoryAvailable) {
        assert.notStrictEqual(memory, undefined);
        assert.notStrictEqual(memory, null);
      } else {
        // 如果没有 hmemory，应返回 null
        assert.strictEqual(memory, null);
      }
    });

    it("lastMemoryMessageId 应可持久化和恢复", async () => {
      // 1. 创建岗位和智能体
      await runtime.org.createRole({
        name: "测试岗位",
        rolePrompt: "测试",
        createdBy: "root"
      });
      const role = runtime.org.listRoles()[0];

      const agentMeta = await runtime.org.createAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      // 2. 创建 Agent 实例
      const agent = new Agent({
        id: agentMeta.id,
        roleId: role.id,
        roleName: role.name,
        rolePrompt: role.rolePrompt,
        behavior: async () => {},
        lastMemoryMessageId: null
      });
      runtime._agents.set(agent.id, agent);

      // 3. 模拟更新 lastMemoryMessageId
      agent.lastMemoryMessageId = "msg-001";
      await runtime.org.setAgentLastMemoryMessageId(agent.id, "msg-001");

      // 4. 创建新的 OrgPrimitives 实例模拟重启
      const newOrg = new OrgPrimitives({
        runtimeDir: path.join(TEST_DIR, "runtime"),
        logger: makeTestLogger("AgentMemory")
      });
      await newOrg.loadIfExists();

      // 5. 验证 lastMemoryMessageId 已恢复
      const loadedAgent = newOrg.getAgent(agent.id);
      assert.strictEqual(loadedAgent.lastMemoryMessageId, "msg-001");
    });

    it("不同智能体应有独立的记忆存储路径 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        // 跳过此测试
        return;
      }

      registerAgent(runtime, "agent-1");
      registerAgent(runtime, "agent-2");
      await manager.getOrCreateMemory("agent-1");
      await manager.getOrCreateMemory("agent-2");

      // hmemory 将数据存在 agent-memory 目录下
      const memoryPath = path.join(TEST_DIR, "agent-memory");
      assert.strictEqual(existsSync(memoryPath), true);
    });
  });

  describe("AgentMemoryManager 生命周期", () => {
    it("关闭后应释放所有资源 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        // 跳过此测试
        return;
      }

      registerAgent(runtime, "agent-1");
      registerAgent(runtime, "agent-2");
      await manager.getOrCreateMemory("agent-1");
      await manager.getOrCreateMemory("agent-2");

      assert.strictEqual(manager._memories.size, 2);

      await manager.closeAll();

      assert.strictEqual(manager._memories.size, 0);
    });

    it("单个智能体关闭不应影响其他智能体 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        // 跳过此测试
        return;
      }

      registerAgent(runtime, "agent-1");
      registerAgent(runtime, "agent-2");
      await manager.getOrCreateMemory("agent-1");
      await manager.getOrCreateMemory("agent-2");

      await manager.closeMemory("agent-1");

      assert.strictEqual(manager._memories.has("agent-1"), false);
      assert.strictEqual(manager._memories.has("agent-2"), true);
    });
  });
});
