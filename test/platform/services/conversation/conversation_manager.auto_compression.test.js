import { describe, it } from "node:test";
import assert from "node:assert";
import { ConversationManager } from "../../../../src/platform/services/conversation/conversation_manager.js";

function makeSilentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

describe("ConversationManager — processAutoCompression 传递 maxContextTokens", () => {

  it("processAutoCompression 应将 _resolveMaxTokens 的值传给 AutoCompressionManager.process()", async () => {
    // 记录 AutoCompressionManager.process() 收到的第二个参数
    let receivedMaxTokens = undefined;
    const mockAutoCompressionManager = {
      async process(_messages, maxContextTokens) {
        receivedMaxTokens = maxContextTokens;
      }
    };

    // 创建 ConversationManager，手动注入自动压缩管理器
    const manager = new ConversationManager({
      conversations: new Map(),
      configService: {
        getLoadedApp: () => ({
          llm: {
            maxContextTokens: 100000
          },
          llmServices: {
            services: [
              { id: "custom-svc", maxContextTokens: 64000 }
            ]
          }
        })
      },
      logger: makeSilentLogger(),
      agents: new Map([
        ["agent-1", { roleId: "role-1" }]
      ]),
      org: {
        getRole: (id) => {
          if (id === "role-1") return { llmServiceId: "custom-svc" };
          return null;
        }
      },
      llmClient: {} // 需要以触发 autoCompressionManager 构造
    });

    // 覆盖自动压缩管理器
    manager._autoCompressionManager = mockAutoCompressionManager;

    // 创建会话
    manager.conversations.set("agent-1", [
      { role: "user", content: "hello" }
    ]);

    await manager.processAutoCompression("agent-1");

    assert.strictEqual(receivedMaxTokens, 64000,
      `应传入从 _resolveMaxTokens 解析的 64000，实际收到: ${receivedMaxTokens}`);
  });

  it("无 agent 匹配的 llmServiceId 时应使用默认 maxContextTokens", async () => {
    let receivedMaxTokens = undefined;
    const mockAutoCompressionManager = {
      async process(_messages, maxContextTokens) {
        receivedMaxTokens = maxContextTokens;
      }
    };

    const manager = new ConversationManager({
      conversations: new Map(),
      configService: {
        getLoadedApp: () => ({
          llm: { maxContextTokens: 128000 },
          llmServices: { services: [] }
        })
      },
      logger: makeSilentLogger(),
      llmClient: {}
    });

    manager._autoCompressionManager = mockAutoCompressionManager;
    manager.conversations.set("agent-1", [
      { role: "user", content: "hello" }
    ]);

    await manager.processAutoCompression("agent-1");

    assert.strictEqual(receivedMaxTokens, 128000,
      `默认应传入 128000，实际收到: ${receivedMaxTokens}`);
  });

  it("无 _autoCompressionManager 时应静默跳过", async () => {
    const manager = new ConversationManager({
      conversations: new Map(),
      logger: makeSilentLogger()
      // 不传 llmClient → _autoCompressionManager 为 null
    });

    manager.conversations.set("agent-1", [
      { role: "user", content: "hello" }
    ]);

    // 不应抛出异常
    await manager.processAutoCompression("agent-1");
  });

  it("会话不存在时应静默跳过", async () => {
    let processCalled = false;
    const mockAutoCompressionManager = {
      async process() { processCalled = true; }
    };

    const manager = new ConversationManager({
      conversations: new Map(),
      configService: {
        getLoadedApp: () => ({
          llm: { maxContextTokens: 128000 }
        })
      },
      logger: makeSilentLogger(),
      llmClient: {}
    });

    manager._autoCompressionManager = mockAutoCompressionManager;

    await manager.processAutoCompression("non-existent-agent");

    assert.strictEqual(processCalled, false, "会话不存在时不应调用压缩");
  });

  it("_resolveMaxTokens 应遵循 agent → service → default 解析链", () => {
    const manager = new ConversationManager({
      conversations: new Map(),
      configService: {
        getLoadedApp: () => ({
          llm: {
            maxContextTokens: 50000
          },
          llmServices: {
            services: [
              { id: "svc-a", maxContextTokens: 80000 },
              { id: "svc-b", maxContextTokens: 100000 }
            ]
          }
        })
      },
      logger: makeSilentLogger(),
      agents: new Map([
        ["agent-a", { roleId: "role-svc-a" }],
        ["agent-b", { roleId: "role-no-svc" }]
      ]),
      org: {
        getRole: (id) => {
          if (id === "role-svc-a") return { llmServiceId: "svc-a" };
          if (id === "role-no-svc") return { llmServiceId: null };
          return null;
        }
      }
    });

    // agent-a → role-svc-a → svc-a → 80000
    assert.strictEqual(manager._resolveMaxTokens("agent-a"), 80000);

    // agent-b → role-no-svc → null → 全局默认 50000
    assert.strictEqual(manager._resolveMaxTokens("agent-b"), 50000);

    // 未知 agent → contextLimit.maxTokens (constructor 中设为 app.llm.maxContextTokens)
    assert.strictEqual(manager._resolveMaxTokens("unknown"), 50000);
  });
});
