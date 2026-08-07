/**
 * Agent Memory 配置测试
 *
 * 测试配置加载和验证
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentMemoryManager } from "../../../../src/platform/services/agent_memory/agent_memory_manager.js";
import { makeTestLogger, testLoggerRoot } from "../../../helpers/test_logger.js";

describe("Agent Memory Configuration", () => {
  function createMockRuntime(config = {}) {
    return {
      dataDir: "/tmp/test",
      config: config,
      log: makeTestLogger("AgentMemory"),
      loggerRoot: testLoggerRoot,
      _agents: new Map()
    };
  }

  const validLLMConfig = {
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "test",
    model: "test"
  };

  const validEmbeddingConfig = {
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "test",
    model: "test",
    dimensions: 1536
  };

  describe("enabled 开关", () => {
    it("未配置时应返回 null", async () => {
      const runtime = createMockRuntime({});
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      const memory = await manager.getOrCreateMemory("agent-1");
      assert.strictEqual(memory, null);
    });

    it("enabled: false 时应返回 null", async () => {
      const runtime = createMockRuntime({ agentMemory: { enabled: false } });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      const memory = await manager.getOrCreateMemory("agent-1");
      assert.strictEqual(memory, null);
    });

    it("enabled: true 时配置应被加载", async () => {
      const runtime = createMockRuntime({
        agentMemory: {
          enabled: true,
          llm: { ...validLLMConfig, model: "test" },
          embedding: { ...validEmbeddingConfig, dimensions: 1536 }
        }
      });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      // 验证配置被正确加载
      assert.strictEqual(manager.config.enabled, true);
      assert.strictEqual(manager.config.llm.model, "test");
      assert.strictEqual(manager.config.embedding.dimensions, 1536);
    });
  });

  describe("默认值", () => {
    it("maxEntries 应有默认值", async () => {
      const runtime = createMockRuntime({
        agentMemory: {
          enabled: true,
          llm: validLLMConfig,
          embedding: validEmbeddingConfig
        }
      });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      assert.strictEqual(manager.config.maxEntries, 10000);
    });

    it("recall 配置应有默认值", async () => {
      const runtime = createMockRuntime({
        agentMemory: {
          enabled: true,
          llm: validLLMConfig,
          embedding: validEmbeddingConfig
        }
      });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      assert.strictEqual(manager.config.recall.limit, 10);
      assert.strictEqual(manager.config.recall.minConfidence, 0.7);
    });
  });

  describe("配置继承", () => {
    it("应正确读取完整配置", async () => {
      const runtime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 5000,
          recall: { limit: 10, minConfidence: 0.8 },
          llm: { provider: "openai", baseUrl: "http://localhost:8000/v1", apiKey: "secret", model: "gpt-4" },
          embedding: { provider: "openai", baseUrl: "http://localhost:8000/v1", apiKey: "secret", model: "embedding-3", dimensions: 768 }
        }
      });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      assert.strictEqual(manager.config.enabled, true);
      assert.strictEqual(manager.config.maxEntries, 5000);
      assert.strictEqual(manager.config.recall.limit, 10);
      assert.strictEqual(manager.config.recall.minConfidence, 0.8);
      assert.strictEqual(manager.config.llm.model, "gpt-4");
      assert.strictEqual(manager.config.embedding.dimensions, 768);
    });
  });

  describe("config 属性", () => {
    it("应暴露 config 属性", async () => {
      const runtime = createMockRuntime({
        agentMemory: {
          enabled: true,
          maxEntries: 1000,
          llm: validLLMConfig,
          embedding: validEmbeddingConfig
        }
      });
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      assert.notStrictEqual(manager.config, undefined);
      assert.strictEqual(manager.config.maxEntries, 1000);
    });

    it("禁用状态下 config 应返回空对象", async () => {
      const runtime = createMockRuntime({});
      const manager = new AgentMemoryManager(runtime);
      await manager.initialize();

      assert.strictEqual(manager.config, null);
    });
  });
});
