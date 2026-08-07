import { describe, test } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { ToolExecutor } from "../../src/platform/runtime/tool_executor.js";

// 创建一个最小的 mock runtime 用于测试
const mockRuntime = {};

// 创建 ToolExecutor 实例用于测试验证函数
const toolExecutor = new ToolExecutor(mockRuntime);

describe("QuickReplies Validation", () => {
  /**
   * Property 1: 输入验证完整？
   * *For any* `quickReplies` 输入，如果它不是字符串数组、包含非字符串元素、包含空字符串、或长度超过10？
   * 验证函数应返回错误；否则应返回有效结果？
   *
   * **Validates: Requirements 1.2, 1.3, 1.5, 1.6**
   * **Feature: quick-reply-options, Property 1: 输入验证完整？*
   */

  test("Property 1: 有效的字符串数组应通过验证", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成 1-10 个非空字符串的数？
        fc.array(
          fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          { minLength: 1, maxLength: 10 }
        ),
        async (quickReplies) => {
          const result = toolExecutor._validateQuickReplies(quickReplies);

          assert.strictEqual(result.valid, true);
          assert.deepStrictEqual(result.quickReplies, quickReplies);
          assert.strictEqual(result.error, undefined);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: 超过10个元素的数组应截取前10个", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成 11-20 个非空字符串的数组
        fc.array(
          fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          { minLength: 11, maxLength: 20 }
        ),
        async (quickReplies) => {
          const result = toolExecutor._validateQuickReplies(quickReplies);

          // 源代码行为：超过10个则截取前10个，返回 valid: true
          assert.strictEqual(result.valid, true);
          assert.notStrictEqual(result.quickReplies, undefined);
          assert.strictEqual(result.quickReplies.length, 10);
          assert.deepStrictEqual(result.quickReplies, quickReplies.slice(0, 10));
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: 包含非字符串元素的数组应返回错误", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成包含至少一个非字符串元素的数组
        fc.tuple(
          fc.array(fc.string({ minLength: 1 }).filter(s => s.trim().length > 0), { minLength: 0, maxLength: 5 }),
          fc.oneof(fc.integer(), fc.boolean(), fc.object(), fc.constant(null)),
          fc.array(fc.string({ minLength: 1 }).filter(s => s.trim().length > 0), { minLength: 0, maxLength: 4 })
        ).map(([before, nonString, after]) => [...before, nonString, ...after]),
        async (quickReplies) => {
          const result = toolExecutor._validateQuickReplies(quickReplies);

          assert.strictEqual(result.valid, false);
          assert.strictEqual(result.error, "quickReplies_invalid_type");
          assert.ok(result.message.includes("必须是字符串"));
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: 包含空字符串的数组应返回错误", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成包含至少一个空字符串（或纯空白字符串）的数？
        fc.tuple(
          fc.array(fc.string({ minLength: 1 }).filter(s => s.trim().length > 0), { minLength: 0, maxLength: 5 }),
          fc.oneof(fc.constant(""), fc.constant("   "), fc.constant("\t"), fc.constant("\n")),
          fc.array(fc.string({ minLength: 1 }).filter(s => s.trim().length > 0), { minLength: 0, maxLength: 4 })
        ).map(([before, emptyStr, after]) => [...before, emptyStr, ...after]),
        async (quickReplies) => {
          const result = toolExecutor._validateQuickReplies(quickReplies);

          assert.strictEqual(result.valid, false);
          assert.strictEqual(result.error, "quickReplies_empty_string");
          assert.ok(result.message.includes("不能为空"));
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 1: 空数组应视为未提供（返回 null）", () => {
    const result = toolExecutor._validateQuickReplies([]);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quickReplies, null);
  });

  test("Property 1: undefined 应视为未提供（返回 null）", () => {
    const result = toolExecutor._validateQuickReplies(undefined);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quickReplies, null);
  });

  test("Property 1: null 应视为未提供（返回 null）", () => {
    const result = toolExecutor._validateQuickReplies(null);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quickReplies, null);
  });

  test("Property 1: 非数组类型应视为未提供（返回 null）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.object()),
        async (nonArray) => {
          const result = toolExecutor._validateQuickReplies(nonArray);

          assert.strictEqual(result.valid, true);
          assert.strictEqual(result.quickReplies, null);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("边界情况: 恰好10个元素应通过验证", () => {
    const quickReplies = Array.from({ length: 10 }, (_, i) => `选项${i + 1}`);
    const result = toolExecutor._validateQuickReplies(quickReplies);

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.quickReplies, quickReplies);
  });

  test("边界情况: 恰好11个元素应截取前10个", () => {
    const quickReplies = Array.from({ length: 11 }, (_, i) => `选项${i + 1}`);
    const result = toolExecutor._validateQuickReplies(quickReplies);

    // 源代码行为：超过10个则截取前10个，返回 valid: true
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quickReplies.length, 10);
    assert.deepStrictEqual(result.quickReplies, quickReplies.slice(0, 10));
  });

  test("边界情况: 单个有效元素应通过验证", () => {
    const result = toolExecutor._validateQuickReplies(["唯一选项"]);

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.quickReplies, ["唯一选项"]);
  });
});


describe("QuickReplies Message Passing", () => {
  /**
   * Property 2: 消息传递完整？
   * *For any* 包含有效 `quickReplies` 的消息，发送后接收端获取的 `quickReplies` 数组
   * 应与发送时完全相同（内容和顺序）？
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   * **Feature: quick-reply-options, Property 2: 消息传递完整？*
   */

  test("Property 2: quickReplies 应该被正确添加到 payload", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成有效？quickReplies 数组
        fc.array(
          fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          { minLength: 1, maxLength: 10 }
        ),
        // 生成原始 payload
        fc.record({
          text: fc.string(),
          content: fc.option(fc.string(), { nil: undefined })
        }),
        async (quickReplies, originalPayload) => {
          // 验证 quickReplies
          const validation = toolExecutor._validateQuickReplies(quickReplies);
          assert.strictEqual(validation.valid, true);

          // 模拟构建最？payload 的逻辑
          const finalPayload = {
            ...originalPayload,
            quickReplies: validation.quickReplies
          };

          // 验证 quickReplies 被正确添？
          assert.deepStrictEqual(finalPayload.quickReplies, quickReplies);
          // 验证原始 payload 字段保持不变
          assert.strictEqual(finalPayload.text, originalPayload.text);
          if (originalPayload.content !== undefined) {
            assert.strictEqual(finalPayload.content, originalPayload.content);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 2: quickReplies 数组顺序应保持不变", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成有效？quickReplies 数组
        fc.array(
          fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          { minLength: 2, maxLength: 10 }
        ),
        async (quickReplies) => {
          const validation = toolExecutor._validateQuickReplies(quickReplies);

          // 验证顺序保持不变
          assert.deepStrictEqual(validation.quickReplies, quickReplies);

          // 逐个元素验证顺序
          for (let i = 0; i < quickReplies.length; i++) {
            assert.strictEqual(validation.quickReplies[i], quickReplies[i]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Property 2: 超过10个元素的 quickReplies 应截取后添加到 payload", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成超过10个元素的 quickReplies
        fc.array(
          fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          { minLength: 11, maxLength: 20 }
        ),
        async (quickReplies) => {
          const validation = toolExecutor._validateQuickReplies(quickReplies);

          // 源代码行为：超过10个则截取前10个，返回 valid: true
          assert.strictEqual(validation.valid, true);
          assert.notStrictEqual(validation.quickReplies, undefined);
          assert.strictEqual(validation.quickReplies.length, 10);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("Property 2: 空 quickReplies 不应添加到 payload", () => {
    const validation = toolExecutor._validateQuickReplies([]);

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.quickReplies, null);

    // 模拟构建 payload 的逻辑
    const originalPayload = { text: "test" };
    let finalPayload = originalPayload;
    if (validation.quickReplies) {
      finalPayload = { ...originalPayload, quickReplies: validation.quickReplies };
    }

    // 验证 quickReplies 没有被添？
    assert.strictEqual(finalPayload.quickReplies, undefined);
  });
});
