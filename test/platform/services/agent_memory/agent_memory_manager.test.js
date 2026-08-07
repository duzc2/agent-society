/**
 * AgentMemoryManager 单元测试
 *
 * 测试内容：
 * 1. 初始化（配置读取、禁用状态）
 * 2. 创建/获取记忆实例
 * 3. 关闭记忆实例
 * 4. 全局错误回调
 * 5. 配置管理
 *
 * 注意：某些测试需要 hmemory 包。如果不可用，会跳过相关测试。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AgentMemoryManager } from "../../../../src/platform/services/agent_memory/agent_memory_manager.js";
import { makeTestLogger, testLoggerRoot } from "../../../helpers/test_logger.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const TEST_DIR = "test/.tmp/agent_memory_manager_test";

// Mock Runtime
function createMockRuntime(config = {}) {
  return {
    dataDir: TEST_DIR,
    config: config,
    log: makeTestLogger("AgentMemory"),
    loggerRoot: testLoggerRoot,
    _agents: new Map()
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

describe("AgentMemoryManager", () => {
  let manager;
  let mockRuntime;

  beforeEach(async () => {
    hmemoryAvailable = await isHMemoryAvailable();

    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
      manager = null;
    }
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("构造函数", () => {
    it("应创建实例", () => {
      mockRuntime = createMockRuntime();
      manager = new AgentMemoryManager(mockRuntime);

      assert.notStrictEqual(manager, undefined);
      assert.strictEqual(manager.runtime, mockRuntime);
      assert.notStrictEqual(manager._memories, undefined);
      assert.strictEqual(manager._memories.size, 0);
      assert.strictEqual(manager._config, null);
    });
  });

  describe("initialize - 初始化", () => {
    it("记忆功能禁用时应返回", async () => {
      mockRuntime = createMockRuntime({ agentMemory: { enabled: false } });
      manager = new AgentMemoryManager(mockRuntime);

      await manager.initialize();

      // 禁用状态下 _config 为 null
      assert.strictEqual(manager._config, null);
    });

    it("记忆功能启用时应加载配置", async () => {
      mockRuntime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 5000,
          llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
          embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 1536 },
          recall: { limit: 3, minConfidence: 0.8 }
        }
      });
      manager = new AgentMemoryManager(mockRuntime);

      await manager.initialize();

      assert.strictEqual(manager._config.enabled, true);
      assert.strictEqual(manager._config.maxEntries, 5000);
      assert.strictEqual(manager._config.recall.limit, 3);
      assert.strictEqual(manager._config.recall.minConfidence, 0.8);
    });

    it("配置为空时不应抛出错误", async () => {
      mockRuntime = createMockRuntime({});
      manager = new AgentMemoryManager(mockRuntime);

      await manager.initialize();
      assert.strictEqual(manager._config, null);
    });
  });

  describe("getOrCreateMemory - 获取或创建记忆", () => {
    beforeEach(() => {
      mockRuntime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 1000,
          recall: { limit: 5, minConfidence: 0.7 },
          llm: {
            provider: "openai",
            baseUrl: "http://localhost:1234/v1",
            apiKey: "test",
            model: "test-model"
          },
          embedding: {
            provider: "openai",
            baseUrl: "http://localhost:1234/v1",
            apiKey: "test",
            model: "test-embedding",
            dimensions: 1536
          }
        }
      });
      manager = new AgentMemoryManager(mockRuntime);
    });

    it("功能禁用时返回 null", async () => {
      mockRuntime.config.agentMemory.enabled = false;
      await manager.initialize();

      const memory = await manager.getOrCreateMemory("agent-1");
      assert.strictEqual(memory, null);
    });

    it("未初始化时返回 null", async () => {
      const memory = await manager.getOrCreateMemory("agent-1");
      assert.strictEqual(memory, null);
    });

    it("应创建新的记忆实例 (如果 hmemory 可用)", async () => {
      await manager.initialize();
      registerAgent(mockRuntime, "agent-1");

      const memory = await manager.getOrCreateMemory("agent-1");

      if (hmemoryAvailable) {
        assert.notStrictEqual(memory, undefined);
        assert.notStrictEqual(memory, null);
        assert.strictEqual(manager._memories.has("agent-1"), true);

        // 验证 hmemory 数据目录已创建
        const agentMemoryPath = path.join(TEST_DIR, "agent-memory");
        assert.strictEqual(existsSync(agentMemoryPath), true);
      } else {
        assert.strictEqual(memory, null);
      }
    });

    it("应缓存记忆实例 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        return; // 跳过
      }

      await manager.initialize();
      registerAgent(mockRuntime, "agent-1");

      const memory1 = await manager.getOrCreateMemory("agent-1");
      const memory2 = await manager.getOrCreateMemory("agent-1");

      assert.strictEqual(memory1, memory2);
      assert.strictEqual(manager._memories.size, 1);
    });

    it("不同智能体应有独立实例 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        return; // 跳过
      }

      await manager.initialize();
      registerAgent(mockRuntime, "agent-1");
      registerAgent(mockRuntime, "agent-2");

      const memory1 = await manager.getOrCreateMemory("agent-1");
      const memory2 = await manager.getOrCreateMemory("agent-2");

      assert.notStrictEqual(memory1, memory2);
      assert.strictEqual(manager._memories.size, 2);
    });
  });

  describe("closeMemory - 关闭记忆", () => {
    beforeEach(async () => {
      mockRuntime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 1000,
          recall: { limit: 5, minConfidence: 0.7 },
          llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
          embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 1536 }
        }
      });
      manager = new AgentMemoryManager(mockRuntime);
      await manager.initialize();
    });

    it("应关闭指定智能体的记忆 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        return; // 跳过
      }

      registerAgent(mockRuntime, "agent-1");
      await manager.getOrCreateMemory("agent-1");
      assert.strictEqual(manager._memories.has("agent-1"), true);

      await manager.closeMemory("agent-1");
      assert.strictEqual(manager._memories.has("agent-1"), false);
    });

    it("关闭不存在的记忆不应抛出错误", async () => {
      await manager.closeMemory("non-existent");
      // 如果没有抛出错误，测试通过
      assert.strictEqual(true, true);
    });
  });

  describe("closeAll - 关闭所有记忆", () => {
    beforeEach(async () => {
      mockRuntime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 1000,
          recall: { limit: 5, minConfidence: 0.7 },
          llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
          embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 1536 }
        }
      });
      manager = new AgentMemoryManager(mockRuntime);
      await manager.initialize();
    });

    it("应关闭所有记忆实例 (如果 hmemory 可用)", async () => {
      if (!hmemoryAvailable) {
        return; // 跳过
      }

      registerAgent(mockRuntime, "agent-1");
      registerAgent(mockRuntime, "agent-2");
      registerAgent(mockRuntime, "agent-3");
      await manager.getOrCreateMemory("agent-1");
      await manager.getOrCreateMemory("agent-2");
      await manager.getOrCreateMemory("agent-3");

      assert.strictEqual(manager._memories.size, 3);

      await manager.closeAll();

      assert.strictEqual(manager._memories.size, 0);
    });

    it("空管理器关闭不应抛出错误", async () => {
      await manager.closeAll();
      // 如果没有抛出错误，测试通过
      assert.strictEqual(manager._memories.size, 0);
    });
  });

  describe("config getter - 配置获取", () => {
    it("应返回当前配置", async () => {
      const testConfig = {
        enabled: true,
        maxEntries: 5000,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 1536 },
        recall: { limit: 3, minConfidence: 0.8 }
      };
      mockRuntime = createMockRuntime({ agentMemory: testConfig });
      manager = new AgentMemoryManager(mockRuntime);
      await manager.initialize();

      assert.notStrictEqual(manager.config, undefined);
      assert.strictEqual(manager.config.enabled, true);
      assert.strictEqual(manager.config.maxEntries, 5000);
      assert.strictEqual(manager.config.recall.limit, 3);
    });

    it("未初始化时应返回 null", () => {
      mockRuntime = createMockRuntime();
      manager = new AgentMemoryManager(mockRuntime);

      assert.strictEqual(manager.config, null);
    });
  });
});
