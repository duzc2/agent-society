import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AutoCompressionManager } from "../../../../src/platform/services/conversation/auto_compression_manager.js";

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
});
