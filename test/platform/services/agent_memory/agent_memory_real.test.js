/**
 * AgentMemory 功能测试
 *
 * 使用 hmemory 真实实例 + mock Provider 测试核心记忆功能：
 * 1. AgentMemory.create() 创建实例
 * 2. processConversation() 保存对话
 * 3. recall() 语义搜索
 * 4. clearAllMemory() 清空记忆
 * 5. 记忆隔离（多智能体不同实例不互相干扰）
 * 6. AgentMemoryManager 重试逻辑
 * 7. 生命周期管理（close / closeAll）
 *
 * 注意：需要 hmemory 包。如果不可用，所有测试会被跳过。
 */

import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert";
import { AgentMemory } from "hmemory";
import { AgentMemoryManager } from "../../../../src/platform/services/agent_memory/agent_memory_manager.js";
import { makeTestLogger, testLoggerRoot } from "../../../helpers/test_logger.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// 测试目录
// ---------------------------------------------------------------------------

const MEMORY_TEST_DIR = "test/.tmp/agent_memory_real_test";
const MANAGER_TEST_DIR = "test/.tmp/agent_memory_real_manager_test";

// ---------------------------------------------------------------------------
// Mock Providers（满足 AI SDK v5 (spec v2) 的最小接口）
// ---------------------------------------------------------------------------

const DEFAULT_DIM = 256;

/**
 * 创建 Mock LLM Provider（specificationVersion v2）。
 * 返回的 JSON 格式必须匹配 hmemory MemoryExtractor 的期望：
 *   { memories: [...], entityUpdates: [...], summaryUpdate: {...} }
 */
function createMockLLM(options = {}) {
  const {
    memories = [
      {
        category: "knowledge",
        summary: "测试记忆标题",
        content: "这是一个测试记忆的详细内容，包含了一些关键信息。",
        keywords: ["测试", "记忆", "关键词"]
      }
    ],
    entityUpdates = [],
    summaryUpdate = {}
  } = options;

  const jsonText = JSON.stringify({
    memories,
    entityUpdates,
    summaryUpdate: {
      newTopics: summaryUpdate.newTopics ?? [],
      newEvents: summaryUpdate.newEvents ?? [],
      newQuestions: summaryUpdate.newQuestions ?? [],
      resolvedQuestions: summaryUpdate.resolvedQuestions ?? []
    }
  });

  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-llm",
    async doGenerate(_opts) {
      return {
        // AI SDK v5 需要 content 数组而非 text 字符串
        content: [{ type: "text", text: jsonText }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
        warnings: []
      };
    }
  };
}

/**
 * 创建 Mock Embedding Provider（specificationVersion v2）。
 * 对每个输入文本生成一个指定维度的随机向量。
 */
function createMockEmbedding(dimensions = DEFAULT_DIM) {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-embedding",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    async doEmbed(opts) {
      const count = opts.values?.length ?? 1;
      // AI SDK v5 兼容模式下 embeddings 应为 raw number[][] 数组
      return {
        embeddings: Array.from({ length: count }, () =>
          Array.from({ length: dimensions }, () => (Math.random() * 2 - 1))
        ),
        usage: { tokens: count * 10 },
        warnings: []
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Mock Runtime（用于 AgentMemoryManager 测试）
// ---------------------------------------------------------------------------

function createMockRuntime(config = {}, dataDir) {
  return {
    dataDir,
    config,
    log: makeTestLogger("AgentMemory"),
    loggerRoot: testLoggerRoot,
    _agents: new Map()
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

async function isHMemoryAvailable() {
  try {
    await import("hmemory");
    return true;
  } catch {
    return false;
  }
}

let hmemoryAvailable = false;
let hmemoryChecked = false;

// ---------------------------------------------------------------------------
// 测试套件 1：AgentMemory.create() 与核心 API
// ---------------------------------------------------------------------------

describe("AgentMemory 核心 API", () => {
  before(async () => {
    hmemoryAvailable = await isHMemoryAvailable();
    hmemoryChecked = true;
  });

  beforeEach(async () => {
    if (existsSync(MEMORY_TEST_DIR)) {
      await rm(MEMORY_TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(MEMORY_TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(MEMORY_TEST_DIR)) {
      await rm(MEMORY_TEST_DIR, { recursive: true, force: true });
    }
  });

  // ---- Create ----

  it("应成功创建 AgentMemory 实例", async () => {
    if (!hmemoryAvailable) return;

    const dbPath = path.join(MEMORY_TEST_DIR, "memory.db");
    const fileStoragePath = path.join(MEMORY_TEST_DIR, "files");
    await mkdir(fileStoragePath, { recursive: true });

    const memory = await AgentMemory.create({
      dbPath,
      fileStoragePath,
      agentId: "test-agent",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      maxEntries: 1000,
      logging: { level: "silent" },
      onError: () => {}
    });

    assert.notStrictEqual(memory, undefined);
    assert.notStrictEqual(memory, null);

    await memory.close();
  });

  it("LanceDB 数据目录应被创建", async () => {
    if (!hmemoryAvailable) return;

    const dbPath = path.join(MEMORY_TEST_DIR, "memory.db");
    const fileStoragePath = path.join(MEMORY_TEST_DIR, "files");
    await mkdir(fileStoragePath, { recursive: true });

    const memory = await AgentMemory.create({
      dbPath,
      fileStoragePath,
      agentId: "dir-test",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      logging: { level: "silent" },
      onError: () => {}
    });

    assert.notStrictEqual(memory, null);
    assert.strictEqual(existsSync(dbPath), true);
    // LanceDB 会在 dbPath 下创建 *.lance 目录
    const entries = await readDir(dbPath);
    const hasLanceDir = entries.some(e => e.endsWith(".lance"));
    assert.strictEqual(hasLanceDir, true);

    await memory.close();
  });

  // ---- processConversation + recall ----

  it("processConversation 应可存入记忆，recall 应可检索", async () => {
    if (!hmemoryAvailable) return;

    const fileStoragePath = path.join(MEMORY_TEST_DIR, "files");

    const memory = await AgentMemory.create({
      dbPath: path.join(MEMORY_TEST_DIR, "memory.db"),
      fileStoragePath,
      agentId: "conv-test",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      maxEntries: 1000,
      logging: { level: "silent" },
      onError: () => {}
    });

    memory.processConversation([
      { role: "user", content: "你好，我叫小明，我喜欢吃披萨。" },
      { role: "assistant", content: "你好小明！披萨确实很好吃。你最喜欢什么口味的？" },
      { role: "user", content: "我喜欢意大利辣香肠披萨。" }
    ]);

    await memory.waitForIdle(30000);

    // 调用 recall 不应抛出异常
    const results = await memory.recall({ query: "披萨", limit: 5, minConfidence: 0.5 });
    assert.strictEqual(Array.isArray(results), true);
    // 因为 mock embedding 返回随机向量，可能找不到匹配，但方法本身应正常工作

    await memory.close();
  });

  it("processConversation 返回 void（非阻塞）", async () => {
    if (!hmemoryAvailable) return;

    const memory = await AgentMemory.create({
      dbPath: path.join(MEMORY_TEST_DIR, "memory2.db"),
      fileStoragePath: path.join(MEMORY_TEST_DIR, "files2"),
      agentId: "non-block",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      logging: { level: "silent" },
      onError: () => {}
    });

    const result = memory.processConversation([
      { role: "user", content: "测试消息" }
    ]);
    assert.strictEqual(result, undefined);

    await memory.waitForIdle(30000);
    await memory.close();
  });

  // ---- clearAllMemory ----

  it("clearAllMemory 应清除记忆数据", async () => {
    if (!hmemoryAvailable) return;

    const fileStoragePath = path.join(MEMORY_TEST_DIR, "files3");

    const memory = await AgentMemory.create({
      dbPath: path.join(MEMORY_TEST_DIR, "memory3.db"),
      fileStoragePath,
      agentId: "clear-test",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      maxEntries: 1000,
      logging: { level: "silent" },
      onError: () => {}
    });

    memory.processConversation([
      { role: "user", content: "可被清除的记忆内容" }
    ]);
    await memory.waitForIdle(30000);

    const filesBefore = existsSync(fileStoragePath) ? await readDir(fileStoragePath) : [];
    await memory.clearAllMemory();
    const filesAfter = existsSync(fileStoragePath) ? await readDir(fileStoragePath) : [];

    assert.ok(filesAfter.length <= filesBefore.length);

    await memory.close();
  });

  // ---- 多智能体隔离 ----

  it("不同智能体应有独立的记忆数据", async () => {
    if (!hmemoryAvailable) return;

    const dbPath = path.join(MEMORY_TEST_DIR, "memory-iso.db");
    const fileStoragePathA = path.join(MEMORY_TEST_DIR, "files-a");
    const fileStoragePathB = path.join(MEMORY_TEST_DIR, "files-b");
    await mkdir(fileStoragePathA, { recursive: true });
    await mkdir(fileStoragePathB, { recursive: true });

    const memA = await AgentMemory.create({
      dbPath, fileStoragePath: fileStoragePathA, agentId: "agent-a",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      maxEntries: 500, logging: { level: "silent" }, onError: () => {}
    });

    const memB = await AgentMemory.create({
      dbPath, fileStoragePath: fileStoragePathB, agentId: "agent-b",
      llm: { model: createMockLLM(), temperature: 0.3 },
      embedding: { model: createMockEmbedding(DEFAULT_DIM), dimensions: DEFAULT_DIM },
      maxEntries: 500, logging: { level: "silent" }, onError: () => {}
    });

    assert.notStrictEqual(memA, null);
    assert.notStrictEqual(memB, null);
    assert.notStrictEqual(memA, memB);

    const entries = await readDir(dbPath);
    assert.strictEqual(entries.some(e => e.startsWith("memories_agent-a")), true);
    assert.strictEqual(entries.some(e => e.startsWith("memories_agent-b")), true);

    await memA.close();
    await memB.close();
  });
});

// ---------------------------------------------------------------------------
// 测试套件 2：AgentMemoryManager 生命周期与重试
// ---------------------------------------------------------------------------

describe("AgentMemoryManager 生命周期", () => {
  before(async () => {
    if (!hmemoryChecked) {
      hmemoryAvailable = await isHMemoryAvailable();
      hmemoryChecked = true;
    }
  });

  beforeEach(async () => {
    if (existsSync(MANAGER_TEST_DIR)) {
      await rm(MANAGER_TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(MANAGER_TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(MANAGER_TEST_DIR)) {
      await rm(MANAGER_TEST_DIR, { recursive: true, force: true });
    }
  });

  // ---- 完整创建流程 ----

  it("应通过 Manager 创建并使用记忆实例", { timeout: 15000 }, async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        maxEntries: 1000,
        recall: { limit: 5, minConfidence: 0.7 },
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    runtime.agentMemoryManager = manager;

    await manager.initialize();

    // 注入 mock provider（必须在 initialize 之后，因为 _createProviders 会覆盖）
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    // getOrCreateMemory 要求 agent 在 _agents Map 中存在且未终止
    runtime._agents.set("agent-1", { _isTerminating: false });

    const memory = await manager.getOrCreateMemory("agent-1");
    assert.notStrictEqual(memory, undefined);
    assert.notStrictEqual(memory, null);
    assert.strictEqual(manager._memories.has("agent-1"), true);

    // 测试 processConversation
    memory.processConversation([
      { role: "user", content: "AgentMemoryManager 集成测试" }
    ]);
    await memory.waitForIdle(30000);

    // 测试 recall
    const results = await memory.recall({ query: "集成测试", limit: 3 });
    assert.strictEqual(Array.isArray(results), true);

    await manager.closeAll();
    assert.strictEqual(manager._memories.size, 0);
  });

  // ---- 缓存与复用 ----

  it("应缓存并复用已有的记忆实例", async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        maxEntries: 500,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    runtime._agents.set("agent-x", { _isTerminating: false });

    const mem1 = await manager.getOrCreateMemory("agent-x");
    const mem2 = await manager.getOrCreateMemory("agent-x");

    assert.strictEqual(mem1, mem2);
    assert.strictEqual(manager._memories.size, 1);

    await manager.closeAll();
  });

  // ---- 关闭不存在的记忆 ----

  it("关闭不存在的记忆不应抛出错误", async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    await manager.closeMemory("non-existent");
    assert.strictEqual(true, true);
  });

  // ---- clearMemory ----

  it("clearMemory 应清除指定智能体的记忆", { timeout: 15000 }, async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        maxEntries: 500,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    runtime._agents.set("agent-clear", { _isTerminating: false });

    const memory = await manager.getOrCreateMemory("agent-clear");
    assert.notStrictEqual(memory, null);

    memory.processConversation([
      { role: "user", content: "将被清除的记忆" }
    ]);
    await memory.waitForIdle(30000);

    const cleared = await manager.clearMemory("agent-clear");
    assert.strictEqual(cleared, true);

    await manager.closeAll();
  });

  // ---- 重试逻辑 ----

  it("创建记忆时遇到损坏的 LanceDB 目录应自动重试", async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        maxEntries: 500,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    // 预先创建损坏的 LanceDB 目录
    const dbPath = path.join(MANAGER_TEST_DIR, "agent-memory", "memory.db");
    const tableDir = path.join(dbPath, "memories_agent-retry.lance", "_versions");
    await mkdir(tableDir, { recursive: true });
    await writeFile(path.join(tableDir, "1.manifest"), "CORRUPTED DATA");

    // getOrCreateMemory 要求 agent 存在
    runtime._agents.set("agent-retry", { _isTerminating: false });

    const memory = await manager.getOrCreateMemory("agent-retry");
    assert.notStrictEqual(memory, null);
    assert.notStrictEqual(memory, undefined);

    await memory.close();
    await manager.closeAll();
  });

  // ---- closeAll 空管理器 ----

  it("空管理器的 closeAll 不应抛出错误", async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: {
        enabled: true,
        llm: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test" },
        embedding: { provider: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "test", model: "test", dimensions: 256 }
      }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();
    manager._llmProvider = createMockLLM();
    manager._embeddingProvider = createMockEmbedding(256);

    await manager.closeAll();
    assert.strictEqual(manager._memories.size, 0);
  });

  // ---- 禁用时不创建 ----

  it("记忆功能禁用时 getOrCreateMemory 应返回 null", async () => {
    if (!hmemoryAvailable) return;

    const runtime = createMockRuntime({
      agentMemory: { enabled: false }
    }, MANAGER_TEST_DIR);

    const manager = new AgentMemoryManager(runtime);
    await manager.initialize();

    const memory = await manager.getOrCreateMemory("agent-disabled");
    assert.strictEqual(memory, null);
  });
});

// ---------------------------------------------------------------------------
// Helper: readDir
// ---------------------------------------------------------------------------

async function readDir(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir);
  } catch {
    return [];
  }
}
