/**
 * JSON文本视图截断属性测试
 * 功能: json-artifact-viewer-enhancement
 * 属性12: 文本视图截断正确性
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fc from 'fast-check';

// 模拟文本视图截断逻辑
function renderJsonTextView(content) {
  const maxLength = 5000;
  let displayContent = content || "";
  let isTruncated = false;

  if (displayContent.length > maxLength) {
    displayContent = displayContent.substring(0, maxLength);
    isTruncated = true;
  }

  return {
    displayContent,
    isTruncated,
    originalLength: (content || "").length,
    truncatedLength: displayContent.length
  };
}

// 格式化JSON为字符串
function formatJsonString(data, indent = 2) {
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, indent);
    } catch {
      return data;
    }
  }
  return JSON.stringify(data, null, indent);
}

// 简单JSON对象生成器
const simpleJsonObjectArbitrary = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null)
  ),
  { minKeys: 1, maxKeys: 10 }
);

// 大型JSON对象生成器（用于测试截断）
const largeJsonObjectArbitrary = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.string({ minLength: 50, maxLength: 100 }),
  { minKeys: 100, maxKeys: 200 }
);

describe('功能: json-artifact-viewer-enhancement, 属性12: 文本视图截断正确性', () => {
  it('超过5000字符的内容应被截断到5000字符', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5001, maxLength: 10000 }),
        (content) => {
          const result = renderJsonTextView(content);

          assert.strictEqual(result.isTruncated, true);
          assert.strictEqual(result.truncatedLength, 5000);
          assert.strictEqual(result.displayContent, content.substring(0, 5000));

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('小于等于5000字符的内容不应被截断', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 5000 }),
        (content) => {
          const result = renderJsonTextView(content);

          assert.strictEqual(result.isTruncated, false);
          assert.strictEqual(result.displayContent, content);
          assert.strictEqual(result.truncatedLength, content.length);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('正好5000字符的内容不应被截断', () => {
    const content = "a".repeat(5000);
    const result = renderJsonTextView(content);

    assert.strictEqual(result.isTruncated, false);
    assert.strictEqual(result.displayContent, content);
    assert.strictEqual(result.truncatedLength, 5000);
  });

  it('5001字符的内容应被截断', () => {
    const content = "a".repeat(5001);
    const result = renderJsonTextView(content);

    assert.strictEqual(result.isTruncated, true);
    assert.strictEqual(result.truncatedLength, 5000);
  });

  it('空内容应正确处理', () => {
    const result1 = renderJsonTextView("");
    assert.strictEqual(result1.isTruncated, false);
    assert.strictEqual(result1.displayContent, "");

    const result2 = renderJsonTextView(null);
    assert.strictEqual(result2.isTruncated, false);
    assert.strictEqual(result2.displayContent, "");

    const result3 = renderJsonTextView(undefined);
    assert.strictEqual(result3.isTruncated, false);
    assert.strictEqual(result3.displayContent, "");
  });

  it('截断后的内容应是原内容的前缀', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5001, maxLength: 20000 }),
        (content) => {
          const result = renderJsonTextView(content);

          // 截断后的内容应该是原内容的前5000个字符
          assert.ok(content.startsWith(result.displayContent));

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('大型JSON对象格式化后应正确截断', () => {
    fc.assert(
      fc.property(
        largeJsonObjectArbitrary,
        (obj) => {
          const formatted = formatJsonString(obj);
          const result = renderJsonTextView(formatted);

          if (formatted.length > 5000) {
            assert.strictEqual(result.isTruncated, true);
            assert.strictEqual(result.truncatedLength, 5000);
          } else {
            assert.strictEqual(result.isTruncated, false);
            assert.strictEqual(result.displayContent, formatted);
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('截断信息应包含正确的原始长度', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5001, maxLength: 10000 }),
        (content) => {
          const result = renderJsonTextView(content);

          assert.strictEqual(result.originalLength, content.length);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('功能: json-artifact-viewer-enhancement, formatJsonString测试', () => {
  it('格式化JSON对象应产生缩进的字符串', () => {
    fc.assert(
      fc.property(
        simpleJsonObjectArbitrary,
        (obj) => {
          const formatted = formatJsonString(obj);

          // 应该是有效的JSON
          const parsed = JSON.parse(formatted);
          // Normalize to handle null-prototype objects from fc.dictionary
          assert.deepStrictEqual(parsed, JSON.parse(JSON.stringify(obj)));

          // 如果有多个键，应该有换行
          if (Object.keys(obj).length > 1) {
            assert.ok(formatted.includes("\n"));
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('格式化JSON字符串应先解析再格式化', () => {
    fc.assert(
      fc.property(
        simpleJsonObjectArbitrary,
        (obj) => {
          const stringified = JSON.stringify(obj);
          const formatted = formatJsonString(stringified);
          const parsed = JSON.parse(formatted);

          // Normalize to handle null-prototype objects from fc.dictionary
          assert.deepStrictEqual(parsed, JSON.parse(JSON.stringify(obj)));

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
