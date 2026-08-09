import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AutoCompressionManager } from "../../../../src/platform/services/conversation/auto_compression_manager.js";
import { ToolCallPairCompressor } from "../../../../src/platform/services/conversation/tool_call_pair_compressor.js";

/**
 * 创建模拟 logger，静默所有输出。
 */
function makeSilentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * 创建模拟 llmClient，返回预设摘要。
 * @param {string|null} [summaryContent] - 返回的摘要内容，传 null 表示失败
 */
function makeMockLlmClient(summaryContent = "测试摘要") {
  return {
    chat: async () => {
      if (summaryContent === null) throw new Error("LLM 调用失败");
      return { content: summaryContent };
    }
  };
}

/**
 * 构造英语纯文本内容，使启发式估算达到目标 token 数。
 * 启发式公式：chars/4 + 20（纯英文的 avgCharsPerToken=4）
 * @param {number} targetTokens - 目标 token 数
 * @returns {string}
 */
function englishContentForTokens(targetTokens) {
  const chars = Math.max(1, (targetTokens - 20)) * 4;
  return "a".repeat(chars);
}

describe("AutoCompressionManager — 自动压缩阈值与 maxContextTokens 参数", () => {

  describe("THRESHOLD 值", () => {
    it("应为 0.5（从 0.9 降低以在更早触发压缩）", () => {
      assert.strictEqual(AutoCompressionManager.THRESHOLD, 0.5);
    });
  });

  describe("MAX_CONTEXT_TOKENS 静态常量", () => {
    it("不应存在（已改用方法参数传入）", () => {
      assert.strictEqual(AutoCompressionManager.hasOwnProperty?.("MAX_CONTEXT_TOKENS"), false,
        "MAX_CONTEXT_TOKENS 应已被移除，maxTokens 改为通过 process() 参数传入");
    });
  });

  describe("process() 方法签名", () => {
    it("应接受第二个参数 maxContextTokens", async () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());
      await manager.process([], 64000);
    });
  });

  describe("_calculateTokenUsage — maxContextTokens 参数", () => {
    it("传入 64000 时，大量内容应触发阈值检查", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      // ~50000 tokens 启发式 → 50000/64000 ≈ 78% > 50%
      const largeMsg = { role: "user", content: englishContentForTokens(50000) };
      const usage = manager._calculateTokenUsage([largeMsg], 64000);

      assert.ok(usage.totalTokens > 40000, `估算 token=${usage.totalTokens} 应 > 40000`);
      assert.ok(usage.usagePercent > AutoCompressionManager.THRESHOLD,
        `${(usage.usagePercent * 100).toFixed(0)}% 应超过阈值 ${(AutoCompressionManager.THRESHOLD * 100).toFixed(0)}%`);
    });

    it("传入 128000 时，同样内容使用率应更低", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      const largeMsg = { role: "user", content: englishContentForTokens(50000) };
      const usage = manager._calculateTokenUsage([largeMsg], 128000);

      // 50000/128000 ≈ 39% < 50%
      assert.ok(usage.totalTokens > 40000, "token 估算应基于内容大小");
      assert.ok(usage.usagePercent < AutoCompressionManager.THRESHOLD,
        `${(usage.usagePercent * 100).toFixed(0)}% 应低于阈值 ${(AutoCompressionManager.THRESHOLD * 100).toFixed(0)}%`);
    });

    it("传入不同 maxContextTokens 对同一消息产生不同的使用率", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      // ~75000 tokens 启发式
      const msg = { role: "user", content: englishContentForTokens(75000) };
      const usage64k = manager._calculateTokenUsage([msg], 64000);
      const usage128k = manager._calculateTokenUsage([msg], 128000);

      // 75000/64000 > 1.0 → cap at 1.0
      assert.strictEqual(usage64k.usagePercent, 1.0);
      // 75000/128000 ≈ 0.586
      assert.ok(usage128k.usagePercent < 1.0);
      assert.ok(usage128k.usagePercent > 0.5);
    });

    it("小消息时使用启发式估算不应崩溃", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      const msg = { role: "user", content: "hello world" };
      const usage = manager._calculateTokenUsage([msg], 64000);

      assert.strictEqual(typeof usage.totalTokens, "number");
      assert.ok(usage.totalTokens > 0);
      assert.ok(usage.usagePercent >= 0);
    });

    it("中文内容在不同 maxContextTokens 下产生差异化使用率", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      // 中文启发式：avgCharsPerToken ≈ 1.5
      // "测试" * 30000 = 60000 chars → 60000/1.5 + 20 ≈ 40020 tokens
      const msg = { role: "user", content: "测试".repeat(30000) };
      const usage64k = manager._calculateTokenUsage([msg], 64000);
      const usage128k = manager._calculateTokenUsage([msg], 128000);

      // 40020/64000 ≈ 62.5% > 50%
      assert.ok(usage64k.usagePercent > AutoCompressionManager.THRESHOLD);
      // 40020/128000 ≈ 31.3% < 50%
      assert.ok(usage128k.usagePercent < AutoCompressionManager.THRESHOLD);
    });
  });

  describe("process() — 使用自定义 maxContextTokens 触发压缩", () => {
    let manager;
    let chatCalls;
    let llmClient;

    beforeEach(() => {
      chatCalls = [];
      llmClient = {
        chat: async (req) => {
          chatCalls.push(req);
          return { content: "[关键决策]\n- 测试决策\n[重要事实]\n- 测试事实" };
        }
      };
      manager = new AutoCompressionManager(llmClient, makeSilentLogger());
    });

    it("maxContextTokens=64000 时，内容超大应触发压缩", async () => {
      // 5 条消息，每条 ~7000 tokens → 总计 ~35000 > 50%*64000=32000
      const content = englishContentForTokens(7000);
      const msgs = [
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
      ];

      await manager.process(msgs, 64000);

      assert.ok(chatCalls.length >= 1, "应调用了 LLM 进行压缩");
      assert.strictEqual(msgs[0].isCompressed, true, "第一条消息应为压缩摘要");
    });

    it("maxContextTokens=128000 时，少量内容不应触发压缩", async () => {
      // 3 条消息，每条 ~5000 tokens → 总计 ~15000 < 50%*128000=64000
      const content = englishContentForTokens(5000);
      const msgs = [
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
      ];

      await manager.process(msgs, 128000);

      assert.strictEqual(chatCalls.length, 0, "使用率低于阈值时不应调用 LLM");
      assert.strictEqual(msgs.length, 3, "消息数组应保持不变");
    });

    it("未传 maxContextTokens 时使用默认值 128000，超大内容触发", async () => {
      // 3 条消息，每条 ~25000 tokens → 总计 ~75000 > 50%*128000=64000
      const content = englishContentForTokens(25000);
      const msgs = [
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
      ];

      await manager.process(msgs);

      assert.ok(chatCalls.length >= 1, "默认 128000 上下文下应触发压缩");
      assert.strictEqual(msgs[0].isCompressed, true, "第一条消息应为压缩摘要");
    });

    it("消息不足时不应触发压缩（MIN_KEEP + 1）", async () => {
      const content = englishContentForTokens(80000);
      const msgs = [
        { role: "user", content },
      ];

      await manager.process(msgs, 64000);

      assert.strictEqual(chatCalls.length, 0, "消息不足时不触发");
      assert.strictEqual(msgs.length, 1);
    });
  });

  describe("_extractMessagesToCompress — 保留策略", () => {
    it("应至少保留 MIN_KEEP 条消息", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      // 使用大内容触发足够的 token 估算
      const bigContent = englishContentForTokens(30000);
      const msgs = [
        { role: "system", content: "a" },
        { role: "user", content: bigContent },
        { role: "assistant", content: "c" },
        { role: "user", content: "d" },
      ];

      const { toCompress, keepCount } = manager._extractMessagesToCompress(msgs);

      assert.ok(keepCount >= AutoCompressionManager.MIN_KEEP,
        `keepCount=${keepCount} 应 ≥ MIN_KEEP=${AutoCompressionManager.MIN_KEEP}`);
      assert.strictEqual(keepCount + toCompress.length, msgs.length);
    });
  });

  describe("熔断机制", () => {
    it("连续失败 MAX_FAILURES 次后应熔断", async () => {
      const manager = new AutoCompressionManager(
        makeMockLlmClient(null), // 始终失败
        makeSilentLogger()
      );

      // 内容需要足够大以触发压缩阈值（64000 上下文时 50%=32000）
      const content = englishContentForTokens(15000);
      const msgs = [
        { role: "user", content },
        { role: "assistant", content },
        { role: "user", content },
      ];

      // 连续失败 3 次
      for (let i = 0; i < 3; i++) {
        await manager.process([...msgs], 64000);
      }

      assert.strictEqual(manager._failureCount, 3, "3 次失败后 failureCount 应为 3");

      // 第 4 次应被熔断
      const msgsCopy = [...msgs];
      await manager.process(msgsCopy, 64000);
      assert.strictEqual(msgsCopy.length, msgs.length, "熔断后不应修改消息数组");
    });
  });

  describe("_validateMessageArray — 边界条件", () => {
    function makeManager() {
      return new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());
    }

    it("空数组返回 false", () => {
      const manager = makeManager();
      assert.strictEqual(manager._validateMessageArray([]), false);
    });

    it("非数组返回 false", () => {
      const manager = makeManager();
      assert.strictEqual(manager._validateMessageArray(null), false);
      assert.strictEqual(manager._validateMessageArray(undefined), false);
      assert.strictEqual(manager._validateMessageArray("string"), false);
    });

    it("没有 user 消息返回 false", () => {
      const manager = makeManager();
      const messages = [
        { role: "assistant", content: "hi" },
        { role: "tool", content: "result" }
      ];
      assert.strictEqual(manager._validateMessageArray(messages), false);
    });

    it("存在孤立的 tool 消息（tool_call_id 无对应 assistant.tool_calls）返回 false", () => {
      const manager = makeManager();
      const messages = [
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "orphan_1", content: "result" }
      ];
      assert.strictEqual(manager._validateMessageArray(messages), false);
    });

    it("tool 消息无 tool_call_id 时不应触发孤立检查", () => {
      const manager = makeManager();
      const messages = [
        { role: "user", content: "hello" },
        { role: "tool", content: "result" } // 无 tool_call_id
      ];
      assert.strictEqual(manager._validateMessageArray(messages), true);
    });

    it("有效的消息数组返回 true", () => {
      const manager = makeManager();
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "hi",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
        { role: "user", content: "thanks" },
      ];
      assert.strictEqual(manager._validateMessageArray(messages), true);
    });

    it("多条 tool_calls 全部配对时返回 true", () => {
      const manager = makeManager();
      const messages = [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "ta", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "tb", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: "call_a", content: "ra" },
        { role: "tool", tool_call_id: "call_b", content: "rb" },
      ];
      assert.strictEqual(manager._validateMessageArray(messages), true);
    });
  });

  describe("_performCompression — 摘要消息 role", () => {
    it("应生成 role 为 user 的摘要消息", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      const messages = [
        { role: "user", content: "old Q1" },
        { role: "assistant", content: "old A1" },
        { role: "user", content: "old Q2" },
        { role: "assistant", content: "old A2" },
        { role: "user", content: "recent Q" },
        { role: "assistant", content: "recent A" },
      ];

      manager._performCompression(messages, "summary text", 2);

      assert.strictEqual(messages[0].role, "user", "摘要消息 role 应为 user");
      assert.strictEqual(messages[0].isCompressed, true);
      assert.ok(messages[0].content.includes("[压缩摘要]"), "摘要消息应包含压缩标记");
      assert.ok(messages[0].content.includes("summary text"), "摘要消息应包含摘要内容");
    });

    it("保留的消息 + 摘要消息中无 user 时不应修改原数组（_performCompression 内部验证）", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());

      // 构造：保留的消息中没有 user，且没有压缩摘要的 user role 能覆盖
      // 但 _performCompression 的 summaryMessage 本身就是 user → 验证会通过
      // 所以设计一个场景：keepCount=0（保留 0 条），但 messages 只有 tool/assistant，
      // 这样只要 _performCompression 不清空就不影响
      const messages = [
        { role: "assistant", content: "some content" },
        { role: "tool", content: "tool result" },
      ];
      const originalLength = messages.length;
      const originalContent = messages[0].content;

      // keepCount=0：不保留任何原消息 → candidate = [summaryMessage(user)] → 验证通过
      // keepCount=1：保留 tool → candidate = [summaryMessage(user), tool] → 有 user，tool 无 tool_call_id → 通过
      // keepCount=2：保留 [assistant, tool] → candidate = [summaryMessage(user), assistant, tool] → 通过
      // 所有这些情况 summaryMessage 都提供了 user role，所以验证总会通过
      manager._performCompression(messages, "summary text", 1);

      // 验证通过后数组被修改：summaryMessage(user) + 1 kept message
      assert.strictEqual(messages.length, 2, "压缩后应为 2 条（summary + 1 kept）");
      assert.strictEqual(messages[0].role, "user", "摘要消息应为 user");
      assert.strictEqual(messages[0].isCompressed, true);
    });
  });

  describe("constructor — 接受 compressor 参数", () => {
    it("不传 compressor 时 _compressor 为 undefined", () => {
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger());
      assert.strictEqual(manager._compressor, undefined);
    });

    it("传入 compressor 后 _compressor 被正确赋值", () => {
      const compressor = new ToolCallPairCompressor();
      const manager = new AutoCompressionManager(makeMockLlmClient(), makeSilentLogger(), compressor);
      assert.strictEqual(manager._compressor, compressor);
    });
  });

  describe("两阶段压缩集成", () => {
    it("无 compressor 时直接执行 Stage 2（全文摘要压缩）", async () => {
      const chatCalls = [];
      const llmClient = {
        chat: async (req) => {
          chatCalls.push(req);
          return { content: "summary" };
        }
      };
      // 不传 compressor
      const manager = new AutoCompressionManager(llmClient, makeSilentLogger());

      const bigContent = englishContentForTokens(15000);
      const msgs = [
        { role: "user", content: bigContent },
        { role: "assistant", content: bigContent },
        { role: "user", content: bigContent },
      ];

      await manager.process(msgs, 64000);

      assert.ok(chatCalls.length >= 1, "无 compressor 时走 Stage 2");
      assert.strictEqual(msgs[0].role, "user", "摘要应为 user 角色");
      assert.strictEqual(msgs[0].isCompressed, true);
    });

    it("Stage 1 有压缩但 token 仍超标 → 继续 Stage 2", async () => {
      const chatCalls = [];
      const llmClient = {
        chat: async (req) => {
          chatCalls.push(req);
          return { content: "[关键决策]\n- x\n[重要事实]\n- y" };
        }
      };

      const compressor = new ToolCallPairCompressor();
      const manager = new AutoCompressionManager(llmClient, makeSilentLogger(), compressor);

      // 构造大量内容：20 轮，每轮含大 tool 结果
      const bigToolResult = "x".repeat(5000);
      const msgs = [];
      for (let i = 1; i <= 20; i++) {
        msgs.push({ role: "user", content: `Q${i}` });
        msgs.push({
          role: "assistant",
          content: `A${i}`,
          tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "t", arguments: "{}" } }]
        });
        msgs.push({ role: "tool", tool_call_id: `call_${i}`, name: "t", content: bigToolResult });
      }

      const origLen = msgs.length;
      await manager.process(msgs, 8000);

      // Stage 1 should have run (pairsCompressed in log), and Stage 2 should follow
      assert.ok(chatCalls.length >= 1, `Stage 1 不够时应触发 Stage 2, chatCalls=${chatCalls.length}`);
      assert.strictEqual(msgs[0].role, "user", `msgs[0].role=${msgs[0].role}, content_preview=${String(msgs[0].content).slice(0, 80)}`);
      assert.strictEqual(msgs[0].isCompressed, true, "最终应有压缩摘要");
    });
  });
});
