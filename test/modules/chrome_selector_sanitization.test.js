/**
 * Chrome 选择器清理属性测试
 * Feature: chrome-selector-sanitization
 *
 * 使用 fast-check 进行属性测试，验证 _sanitizeSelector 方法的正确性
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import * as fc from "fast-check";
import { sanitizeSelector } from "../../modules/chrome/utils.js";

describe("Feature: chrome-selector-sanitization", () => {

  // 生成有效的 CSS 选择器字符
  const selectorCharArb = fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '#', '.', '-', '_', '[', ']', '=', '>', '+', '~', ':', '*'
  );

  // 生成有效的 CSS 选择器（不以引号开头结尾）
  const validSelectorArb = fc.array(selectorCharArb, { minLength: 1, maxLength: 30 })
    .map(chars => chars.join(''))
    .filter(s => !s.startsWith('"') && !s.startsWith("'") && s.trim().length > 0);

  // 生成干净的选择器（无外层引号和空白）
  const cleanSelectorArb = fc.array(selectorCharArb, { minLength: 1, maxLength: 20 })
    .map(chars => chars.join(''))
    .filter(s =>
      !s.startsWith('"') && !s.startsWith("'") &&
      !s.endsWith('"') && !s.endsWith("'") &&
      s === s.trim() && s.length > 0
    );

  // ==================== Property 1: Outer Quote Removal ====================
  // **Validates: Requirements 1.1, 1.2, 1.3**
  describe("Property 1: Outer Quote Removal", () => {

    it("should remove outer double quotes from any selector", () => {
      fc.assert(
        fc.property(validSelectorArb, (selector) => {
          const quoted = `"${selector}"`;
          const result = sanitizeSelector(quoted);

          assert.strictEqual(result.cleaned, selector.trim());
          assert.strictEqual(result.modified, true);
        }),
        { numRuns: 100 }
      );
    });

    it("should remove outer single quotes from any selector", () => {
      fc.assert(
        fc.property(validSelectorArb, (selector) => {
          const quoted = `'${selector}'`;
          const result = sanitizeSelector(quoted);

          assert.strictEqual(result.cleaned, selector.trim());
          assert.strictEqual(result.modified, true);
        }),
        { numRuns: 100 }
      );
    });

    it("should trim leading and trailing whitespace from any selector", () => {
      const whitespaceArb = fc.array(fc.constantFrom(' ', '\t'), { minLength: 1, maxLength: 3 })
        .map(chars => chars.join(''));

      fc.assert(
        fc.property(validSelectorArb, whitespaceArb, whitespaceArb, (selector, leadingWs, trailingWs) => {
          const padded = `${leadingWs}${selector}${trailingWs}`;
          const result = sanitizeSelector(padded);

          assert.strictEqual(result.cleaned, selector.trim());
          assert.strictEqual(result.modified, true);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ==================== Property 2: Clean Selector Idempotence ====================
  // **Validates: Requirements 1.4**
  describe("Property 2: Clean Selector Idempotence", () => {

    it("should return clean selectors unchanged", () => {
      fc.assert(
        fc.property(cleanSelectorArb, (selector) => {
          const result = sanitizeSelector(selector);

          assert.strictEqual(result.cleaned, selector);
          assert.strictEqual(result.modified, false);
          assert.strictEqual(result.original, selector);
        }),
        { numRuns: 100 }
      );
    });

    it("should be idempotent - sanitizing twice gives same result", () => {
      const anySelectorArb = fc.oneof(
        cleanSelectorArb,
        cleanSelectorArb.map(s => `"${s}"`),
        cleanSelectorArb.map(s => `'${s}'`),
        cleanSelectorArb.map(s => `  ${s}  `)
      );

      fc.assert(
        fc.property(anySelectorArb, (selector) => {
          const first = sanitizeSelector(selector);
          const second = sanitizeSelector(first.cleaned);

          assert.strictEqual(second.cleaned, first.cleaned);
          assert.strictEqual(second.modified, false);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ==================== Property 3: Internal Quote Preservation ====================
  // **Validates: Requirements 1.5**
  describe("Property 3: Internal Quote Preservation", () => {

    // 生成属性名
    const attrNameCharArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', '-');
    const attrNameArb = fc.array(attrNameCharArb, { minLength: 1, maxLength: 10 })
      .map(chars => chars.join(''))
      .filter(s => /^[a-z]/.test(s));

    // 生成属性值
    const attrValueCharArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', '0', '1', '2', '3', '-', '_');
    const attrValueArb = fc.array(attrValueCharArb, { minLength: 1, maxLength: 10 })
      .map(chars => chars.join(''));

    it("should preserve internal double quotes in attribute selectors", () => {
      fc.assert(
        fc.property(attrNameArb, attrValueArb, (attrName, attrValue) => {
          const selector = `[${attrName}="${attrValue}"]`;
          const result = sanitizeSelector(selector);

          assert.strictEqual(result.cleaned, selector);
          assert.strictEqual(result.modified, false);
        }),
        { numRuns: 100 }
      );
    });

    it("should preserve internal single quotes in attribute selectors", () => {
      fc.assert(
        fc.property(attrNameArb, attrValueArb, (attrName, attrValue) => {
          const selector = `[${attrName}='${attrValue}']`;
          const result = sanitizeSelector(selector);

          assert.strictEqual(result.cleaned, selector);
          assert.strictEqual(result.modified, false);
        }),
        { numRuns: 100 }
      );
    });

    it("should remove outer quotes while preserving internal quotes", () => {
      fc.assert(
        fc.property(attrNameArb, attrValueArb, (attrName, attrValue) => {
          const innerSelector = `[${attrName}="${attrValue}"]`;
          const outerQuoted = `"${innerSelector}"`;
          const result = sanitizeSelector(outerQuoted);

          assert.strictEqual(result.cleaned, innerSelector);
          assert.strictEqual(result.modified, true);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ==================== Edge Cases ====================
  describe("Edge Cases", () => {
    it("should handle empty string", () => {
      const result = sanitizeSelector("");
      assert.strictEqual(result.cleaned, "");
      assert.strictEqual(result.modified, false);
    });

    it("should handle null", () => {
      const result = sanitizeSelector(null);
      assert.strictEqual(result.cleaned, null);
      assert.strictEqual(result.modified, false);
    });

    it("should handle undefined", () => {
      const result = sanitizeSelector(undefined);
      assert.strictEqual(result.cleaned, undefined);
      assert.strictEqual(result.modified, false);
    });

    it("should handle only quotes", () => {
      const result = sanitizeSelector('""');
      assert.strictEqual(result.cleaned, "");
      assert.strictEqual(result.modified, true);
    });

    it("should only remove outermost quotes (nested quotes)", () => {
      const result = sanitizeSelector(`"'#id'"`);
      assert.strictEqual(result.cleaned, "'#id'");
      assert.strictEqual(result.modified, true);
    });

    it("should handle mismatched quotes (no removal)", () => {
      const result = sanitizeSelector(`"#id'`);
      assert.strictEqual(result.cleaned, `"#id'`);
      assert.strictEqual(result.modified, false);
    });
  });
});
