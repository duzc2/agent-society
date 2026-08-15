/**
 * Bigfile 模块测试
 *
 * 覆盖：
 *   - 辅助函数单元测试（纯逻辑，无文件系统）
 *   - 服务方法测试（patch _resolveAbsolutePath + 真实临时文件）
 *   - 错误处理测试
 *   - 256KB 硬限制测试
 *   - 流式 JSON 解析测试
 *
 * 设计说明：
 *   - 服务直接操作 fs（无状态），mock 简化为仅 patch _resolveAbsolutePath
 *   - 所有 IO 测试使用真实临时文件
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { makeTestLogger } from "../helpers/test_logger.js";
import {
  truncateByBytes,
  byteLength,
  navigateJsonPath,
  extractSubtree,
  getNestedField,
  matchField,
  BigfileService
} from "../../src/platform/services/workspace/file_access/bigfile_service.js";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成指定大小的日志文件内容
 */
function generateLogFile(sizeBytes, linePattern) {
  const line = linePattern || `[2024-01-01 12:00:00] INFO normal operation log message\n`;
  const linesNeeded = Math.ceil(sizeBytes / line.length);
  return Array.from({ length: linesNeeded }, (_, i) => {
    if (i % 100 === 0) return `[2024-01-01 12:${String(Math.floor(i / 60)).padStart(2, "0")}:00] ERROR error occurred at line ${i}\n`;
    if (i % 50 === 0) return `[2024-01-01 12:00:00] WARN warning message at line ${i}\n`;
    return line;
  }).join("");
}

/**
 * 生成指定大小的 JSON 文件内容
 */
function generateJsonFile(sizeBytes) {
  const items = [];
  let currentSize = 2;
  let i = 0;
  while (currentSize < sizeBytes) {
    const item = JSON.stringify({ id: i, name: `item_${i}`, value: Math.random(), nested: { a: i, b: `str_${i}` } });
    currentSize += item.length + (items.length > 0 ? 1 : 0);
    if (currentSize < sizeBytes) items.push(item);
    i++;
  }
  return `[${items.join(",")}]`;
}

/**
 * 生成指定大小的 JSONL 文件内容
 */
function generateJsonlFile(sizeBytes) {
  const lines = [];
  let currentSize = 0;
  let i = 0;
  while (currentSize < sizeBytes) {
    const line = JSON.stringify({ id: i, level: i % 10 === 0 ? "error" : "info", message: `message number ${i}` }) + "\n";
    lines.push(line);
    currentSize += line.length;
    i++;
  }
  return lines.join("");
}

/**
 * 在临时目录中写入文件
 */
function writeTempFile(tmpDir, name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ============================================================================
// byteLength 测试
// ============================================================================

describe("byteLength", () => {
  it("ASCII: 'hello' → 5 bytes", () => {
    assert.strictEqual(byteLength("hello"), 5);
  });

  it("Chinese: '你好' → 6 bytes", () => {
    assert.strictEqual(byteLength("你好"), 6);
  });

  it("Mixed: 'hi你好' → 8 bytes", () => {
    assert.strictEqual(byteLength("hi你好"), 8);
  });

  it("Empty: '' → 0 bytes", () => {
    assert.strictEqual(byteLength(""), 0);
  });
});

// ============================================================================
// truncateByBytes 测试
// ============================================================================

describe("truncateByBytes", () => {
  it("text under 256KB bytes — unchanged", () => {
    const text = "hello world";
    const result = truncateByBytes(text);
    assert.strictEqual(result.content, text);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.original_length, text.length);
  });

  it("text at exactly 262144 bytes (ASCII) — unchanged", () => {
    const text = "a".repeat(262144);
    const result = truncateByBytes(text);
    assert.strictEqual(result.content, text);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.original_length, 262144);
  });

  it("text at exactly 262145 bytes (ASCII) — truncated at 262144 bytes", () => {
    const text = "a".repeat(262145);
    const result = truncateByBytes(text);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.original_length, 262145);
    // Content byte length should be ≤ 262144
    assert.ok(byteLength(result.content) <= 262144);
  });

  it("multi-byte UTF-8: 2-byte chars that exceed limit — truncated safely", () => {
    // £ (U+00A3) is 2 bytes. 131072 * 2 = 262144 (exact)
    const exact = "\u00a3".repeat(131072);
    const over = exact + "\u00a3"; // 262146 bytes
    const result = truncateByBytes(over);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.original_length, 131073);
    // Content byte length should be ≤ 262144
    assert.ok(byteLength(result.content) <= 262144);
  });

  it("null — handled gracefully", () => {
    const result = truncateByBytes(null);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.original_length, 0);
  });

  it("undefined — handled gracefully", () => {
    const result = truncateByBytes(undefined);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.original_length, 0);
  });

  it("empty string — unchanged", () => {
    const result = truncateByBytes("");
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.original_length, 0);
  });
});

// ============================================================================
// navigateJsonPath 测试
// ============================================================================

describe("navigateJsonPath", () => {
  it('"" or "." — returns root node', () => {
    const obj = { a: 1 };
    assert.strictEqual(navigateJsonPath(obj, ""), obj);
    assert.strictEqual(navigateJsonPath(obj, "."), obj);
  });

  it('"a" — {a: 1} returns 1', () => {
    assert.strictEqual(navigateJsonPath({ a: 1 }, "a"), 1);
  });

  it('"a.b" — {a: {b: 2}} returns 2', () => {
    assert.strictEqual(navigateJsonPath({ a: { b: 2 } }, "a.b"), 2);
  });

  it('"a.0" — {a: [10, 20]} returns 10', () => {
    assert.strictEqual(navigateJsonPath({ a: [10, 20] }, "a.0"), 10);
  });

  it('"a.0.name" — {a: [{name: "x"}]} returns "x"', () => {
    assert.strictEqual(navigateJsonPath({ a: [{ name: "x" }] }, "a.0.name"), "x");
  });

  it("non-existent key — undefined", () => {
    assert.strictEqual(navigateJsonPath({ a: 1 }, "b"), undefined);
  });

  it("index exceeds array bounds — undefined", () => {
    assert.strictEqual(navigateJsonPath({ a: [1, 2] }, "a.5"), undefined);
  });

  it("intermediate node is primitive — undefined", () => {
    assert.strictEqual(navigateJsonPath({ a: 42 }, "a.b"), undefined);
  });

  it("intermediate node is null — undefined", () => {
    assert.strictEqual(navigateJsonPath({ a: null }, "a.b"), undefined);
  });

  it("path through empty object — key check returns undefined if missing", () => {
    assert.strictEqual(navigateJsonPath({ a: {} }, "a.b"), undefined);
  });

  it("array as root, accessing by index — correct", () => {
    assert.strictEqual(navigateJsonPath([10, 20, 30], "1"), 20);
  });

  it("negative index — undefined", () => {
    assert.strictEqual(navigateJsonPath([1, 2], "-1"), undefined);
  });

  it("non-integer index on array — undefined", () => {
    assert.strictEqual(navigateJsonPath([1, 2], "abc"), undefined);
  });
});

// ============================================================================
// extractSubtree 测试
// ============================================================================

describe("extractSubtree", () => {
  it("depth=0, object — '{Object with N keys}'", () => {
    assert.strictEqual(extractSubtree({ a: 1, b: 2 }, 0), "{Object with 2 keys}");
  });

  it("depth=0, array — '[Array(N)]'", () => {
    assert.strictEqual(extractSubtree([1, 2, 3], 0), "[Array(3)]");
  });

  it("depth=0, primitive — value itself", () => {
    assert.strictEqual(extractSubtree(42, 0), 42);
    assert.strictEqual(extractSubtree("hello", 0), "hello");
    assert.strictEqual(extractSubtree(true, 0), true);
    assert.strictEqual(extractSubtree(null, 0), null);
  });

  it("depth=0, empty object — '{Object with 0 keys}'", () => {
    assert.strictEqual(extractSubtree({}, 0), "{Object with 0 keys}");
  });

  it("depth=0, empty array — '[Array(0)]'", () => {
    assert.strictEqual(extractSubtree([], 0), "[Array(0)]");
  });

  it("depth=1, shallow object — properties expanded, nested truncated", () => {
    const input = { name: "test", nested: { x: 1, y: 2 } };
    const result = extractSubtree(input, 1);
    assert.strictEqual(result.name, "test");
    assert.strictEqual(result.nested, "{Object with 2 keys}");
  });

  it("depth=1, shallow array — elements expanded", () => {
    const input = [1, { a: 1 }, [2, 3]];
    const result = extractSubtree(input, 1);
    assert.strictEqual(result[0], 1);
    assert.strictEqual(result[1], "{Object with 1 keys}");
    assert.strictEqual(result[2], "[Array(2)]");
  });

  it("depth=2 — two levels visible", () => {
    const input = { a: { b: { c: 1 } } };
    const result = extractSubtree(input, 2);
    assert.deepStrictEqual(result, { a: { b: "{Object with 1 keys}" } });
  });

  it("depth very large — full object visible", () => {
    const input = { a: { b: { c: 42 } } };
    const result = extractSubtree(input, 5);
    assert.deepStrictEqual(result, { a: { b: { c: 42 } } });
  });

  it("nested arrays: [1, [2, [3]]] depth=1", () => {
    const result = extractSubtree([1, [2, [3]]], 1);
    assert.strictEqual(result[0], 1);
    assert.strictEqual(result[1], "[Array(2)]");
  });
});

// ============================================================================
// getNestedField 测试
// ============================================================================

describe("getNestedField", () => {
  it('"name" on {name: "x"} — "x"', () => {
    assert.strictEqual(getNestedField({ name: "x" }, "name"), "x");
  });

  it('"user.name" on {user: {name: "x"}} — "x"', () => {
    assert.strictEqual(getNestedField({ user: { name: "x" } }, "user.name"), "x");
  });

  it('"items.0" on {items: [{id: 1}]} — {id: 1}', () => {
    assert.deepStrictEqual(getNestedField({ items: [{ id: 1 }] }, "items.0"), { id: 1 });
  });

  it("non-existent top-level key — undefined", () => {
    assert.strictEqual(getNestedField({ a: 1 }, "b"), undefined);
  });

  it("non-existent nested key — undefined", () => {
    assert.strictEqual(getNestedField({ a: { b: 1 } }, "a.c"), undefined);
  });

  it("intermediate is null — undefined", () => {
    assert.strictEqual(getNestedField({ a: null }, "a.b"), undefined);
  });

  it("intermediate is primitive — undefined", () => {
    assert.strictEqual(getNestedField({ a: 42 }, "a.b"), undefined);
  });

  it("field path is empty string — returns object itself", () => {
    const obj = { a: 1 };
    assert.strictEqual(getNestedField(obj, ""), obj);
  });

  it("input is null — undefined", () => {
    assert.strictEqual(getNestedField(null, "a"), undefined);
  });

  it("input is undefined — undefined", () => {
    assert.strictEqual(getNestedField(undefined, "a"), undefined);
  });
});

// ============================================================================
// matchField 测试
// ============================================================================

describe("matchField", () => {
  it("isRegex=false, field value includes pattern — true", () => {
    assert.strictEqual(matchField({ level: "error occurred" }, "level", "error", false), true);
  });

  it("isRegex=false, field value does not include pattern — false", () => {
    assert.strictEqual(matchField({ level: "info" }, "level", "error", false), false);
  });

  it("isRegex=true, regex matches — true", () => {
    assert.strictEqual(matchField({ msg: "abc123def" }, "msg", "\\d{3}", true), true);
  });

  it("isRegex=true, regex does not match — false", () => {
    assert.strictEqual(matchField({ msg: "abcdef" }, "msg", "\\d{3}", true), false);
  });

  it("field value is null — false", () => {
    assert.strictEqual(matchField({ x: null }, "x", "anything", false), false);
  });

  it("field value is undefined — false", () => {
    assert.strictEqual(matchField({}, "x", "anything", false), false);
  });

  it("field value is number 123, pattern '23' — true", () => {
    assert.strictEqual(matchField({ code: 123 }, "code", "23", false), true);
  });

  it("field value is boolean true, pattern 'true' — true", () => {
    assert.strictEqual(matchField({ active: true }, "active", "true", false), true);
  });

  it("field doesn't exist — false", () => {
    assert.strictEqual(matchField({ a: 1 }, "missing", "x", false), false);
  });

  it("invalid regex — returns false (not throw)", () => {
    assert.strictEqual(matchField({ x: "test" }, "x", "[", true), false);
  });

  it("empty pattern, isRegex=false — true", () => {
    assert.strictEqual(matchField({ x: "test" }, "x", "", false), true);
  });

  it("empty pattern, isRegex=true — true", () => {
    assert.strictEqual(matchField({ x: "test" }, "x", "", true), true);
  });
});

// ============================================================================
// BigfileService 测试（patch _resolveAbsolutePath + 真实临时文件）
// ============================================================================

describe("BigfileService — with real temp files", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {BigfileService} */
  let service;
  /** @type {any} */
  let mockRuntime;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigfile-test-"));
    mockRuntime = {
      findWorkspaceIdForAgent: () => "test-ws",
      loggerRoot: { forModule: () => makeTestLogger("bigfile") }
    };
    const log = makeTestLogger("bigfile");
    service = new BigfileService({ runtime: mockRuntime, log });

    // Patch _resolveAbsolutePath to bypass workspace manager
    service._resolveAbsolutePath = async (_ctx, relPath) => path.resolve(tmpDir, relPath);
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // file_read
  // ==========================================================================

  describe("file_read", () => {
    it("read first 500 bytes of 100KB file", async () => {
      const content = "x".repeat(102400);
      writeTempFile(tmpDir, "test.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test.txt" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content.length, 500);
      assert.strictEqual(result.start, 0);
      assert.strictEqual(result.total, 102400);
      assert.strictEqual(result.read_length, 500);
    });

    it("read with custom offset and length", async () => {
      const content = "x".repeat(10000);
      writeTempFile(tmpDir, "test2.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test2.txt", offset: 1000, length: 500 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content.length, 500);
      assert.strictEqual(result.start, 1000);
    });

    it("read at offset beyond file — returns empty", async () => {
      const content = "hello";
      writeTempFile(tmpDir, "test3.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test3.txt", offset: 1000, length: 100 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content.length, 0);
      assert.strictEqual(result.total, content.length);
    });

    it("read file with length exceeding file size — reads only available", async () => {
      const content = "short";
      writeTempFile(tmpDir, "test4.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test4.txt", offset: 3, length: 1000 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.read_length, 2); // "rt"
    });

    it("read cap: length > 256KB is capped by _readBytes", async () => {
      const content = "y".repeat(300000);
      writeTempFile(tmpDir, "test5.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test5.txt", offset: 0, length: 300000 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.read_length, 262144); // capped at 256KB
      assert.strictEqual(result.truncated, false);
    });

    it("read 262144 bytes (exact cap) — not truncated", async () => {
      const content = "z".repeat(262144);
      writeTempFile(tmpDir, "test6.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "test6.txt", offset: 0, length: 262144 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.read_length, 262144);
      assert.strictEqual(result.truncated, false);
    });
  });

  // ==========================================================================
  // file_info
  // ==========================================================================

  describe("file_info", () => {
    it("100KB file — correct size and lines", async () => {
      const content = "a".repeat(102400);
      writeTempFile(tmpDir, "info1.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "info1.txt" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total_size, 102400);
      assert.strictEqual(result.total_lines, 1);
    });

    it(".json extension — estimated_type=json", async () => {
      writeTempFile(tmpDir, "data.json", "{}");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "data.json" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "json");
    });

    it(".jsonl extension — estimated_type=jsonl", async () => {
      writeTempFile(tmpDir, "data.jsonl", "{}\n");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "data.jsonl" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "jsonl");
    });

    it(".ndjson extension — estimated_type=jsonl", async () => {
      writeTempFile(tmpDir, "data.ndjson", "{}\n");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "data.ndjson" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "jsonl");
    });

    it(".log extension — estimated_type=log", async () => {
      writeTempFile(tmpDir, "app.log", "logs...");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "app.log" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "log");
    });

    it(".txt extension — estimated_type=text", async () => {
      writeTempFile(tmpDir, "note.txt", "text");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "note.txt" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "text");
    });

    it("no extension — estimated_type=text", async () => {
      writeTempFile(tmpDir, "README", "content");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "README" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "text");
    });

    it("empty file — total_size=0", async () => {
      writeTempFile(tmpDir, "empty.txt", "");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "empty.txt" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total_size, 0);
      assert.strictEqual(result.total_lines, 0);
    });

    it("upper-case extension (.JSON) — identified as json", async () => {
      writeTempFile(tmpDir, "DATA.JSON", "{}");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "DATA.JSON" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "json");
    });

    it(".log.BAK extension — estimated_type=text", async () => {
      writeTempFile(tmpDir, "app.log.BAK", "backup");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "app.log.BAK" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.estimated_type, "text");
    });

    it("multi-line file — correct total_lines", async () => {
      const content = "a\nb\nc\n";
      writeTempFile(tmpDir, "lines.txt", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.getInfo(ctx, { path: "lines.txt" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total_lines, 3);
    });
  });

  // ==========================================================================
  // file_read_lines
  // ==========================================================================

  describe("file_read_lines", () => {
    it("read lines 1-10 of 100-line file", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeTempFile(tmpDir, "lines100.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "lines100.txt", start_line: 1, end_line: 10 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.lines.length, 10);
      assert.strictEqual(result.lines[0], "line 1");
      assert.strictEqual(result.lines[9], "line 10");
      assert.strictEqual(result.total_lines, 100);
    });

    it("read single line", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      writeTempFile(tmpDir, "lines50.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "lines50.txt", start_line: 1, end_line: 1 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.lines.length, 1);
      assert.strictEqual(result.lines[0], "line 1");
    });

    it("start_line > total_lines — empty result", async () => {
      const lines = ["a", "b", "c"];
      writeTempFile(tmpDir, "small.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "small.txt", start_line: 100, end_line: 200 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.lines.length, 0);
      assert.strictEqual(result.total_lines, 3);
    });

    it("end_line > total_lines — capped to total_lines", async () => {
      const lines = ["a", "b", "c"];
      writeTempFile(tmpDir, "small2.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "small2.txt", start_line: 2, end_line: 100 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.lines.length, 2);
      assert.strictEqual(result.end_line, 3);
    });

    it("start_line > end_line — empty array", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeTempFile(tmpDir, "lines_rev.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "lines_rev.txt", start_line: 50, end_line: 30 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.lines.length, 0);
    });

    it("truncation: large line output exceeding 256KB", async () => {
      // 5000 lines × 91 bytes ≈ 455KB, exceeds 256KB limit
      const longLines = Array.from({ length: 5000 }, (_, i) => "x".repeat(90) + `-${i}`);
      writeTempFile(tmpDir, "longlines.txt", longLines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "longlines.txt", start_line: 1, end_line: 5000 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.truncated, true);
      // Should have fewer lines than 5000
      assert.ok(result.lines.length < 5000);
    });
  });

  // ==========================================================================
  // file_search
  // ==========================================================================

  describe("file_search", () => {
    it("literal pattern search in log file", async () => {
      const content = generateLogFile(50000);
      writeTempFile(tmpDir, "search1.log", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, { path: "search1.log", pattern: "ERROR" });
      assert.strictEqual(result.ok, true);
      assert.ok(result.count > 0);
      assert.ok(result.matches.every(m => m.text.includes("ERROR")));
    });

    it("regex pattern search", async () => {
      const content = generateLogFile(50000);
      writeTempFile(tmpDir, "search2.log", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, { path: "search2.log", pattern: "\\d{4}-\\d{2}-\\d{2}", is_regex: true });
      assert.strictEqual(result.ok, true);
      assert.ok(result.count > 0);
    });

    it("context_lines=2 — each match has context", async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}${i === 9 ? " ERROR found" : ""}`);
      writeTempFile(tmpDir, "search3.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search3.log", pattern: "ERROR", context_lines: 2
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.matches[0].context_before.length, 2);
      assert.strictEqual(result.matches[0].context_after.length, 2);
    });

    it("pattern not found — empty matches", async () => {
      const content = "hello world\nno match here\nanother line\n";
      writeTempFile(tmpDir, "search4.log", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, { path: "search4.log", pattern: "ZZZZZZZ" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.matches.length, 0);
    });

    it("max_results capped", async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i} with match`);
      writeTempFile(tmpDir, "search5.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search5.log", pattern: "match", max_results: 10
      });
      assert.strictEqual(result.ok, true);
      assert.ok(result.count <= 10);
    });

    it("context_lines at boundary — context_before partial", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}${i === 2 ? " ERROR" : ""}`);
      writeTempFile(tmpDir, "search6.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search6.log", pattern: "ERROR", context_lines: 5
      });
      // match at line 3, context_before should only have 2 lines (line 1, 2)
      assert.strictEqual(result.matches[0].context_before.length, 2);
      assert.strictEqual(result.matches[0].context_after.length, 5);
    });

    it("single line file, context_lines — no context", async () => {
      writeTempFile(tmpDir, "search7.log", "just one line ERROR here");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search7.log", pattern: "ERROR", context_lines: 10
      });
      assert.strictEqual(result.matches[0].context_before.length, 0);
      assert.strictEqual(result.matches[0].context_after.length, 0);
    });

    it("invalid regex — returns error", async () => {
      writeTempFile(tmpDir, "search8.log", "content");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search8.log", pattern: "[", is_regex: true
      });
      assert.strictEqual(result.error, "invalid_regex");
    });

    it("regex matching empty string — handled", async () => {
      writeTempFile(tmpDir, "search9.log", "xyz\nabc\n");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "search9.log", pattern: "a*", is_regex: true
      });
      assert.strictEqual(result.ok, true);
    });
  });

  // ==========================================================================
  // file_stats
  // ==========================================================================

  describe("file_stats", () => {
    it("one rule matches 30/100 lines", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? "ERROR: something" : "ok"));
      writeTempFile(tmpDir, "stats1.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats1.log",
        rules: [{ name: "errors", pattern: "ERROR" }]
      });
      assert.strictEqual(result.ok, true);
      const errorStat = result.stats.find(s => s.name === "errors");
      assert.strictEqual(errorStat.matching_lines, 34);
      assert.strictEqual(errorStat.total_lines_checked, 100);
    });

    it("3 rules with different patterns", async () => {
      const lines = [
        "ERROR: critical", "WARN: caution", "INFO: normal",
        "ERROR: failed", "WARN: slow", "INFO: ok"
      ];
      writeTempFile(tmpDir, "stats2.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats2.log",
        rules: [
          { name: "errors", pattern: "ERROR" },
          { name: "warnings", pattern: "WARN" },
          { name: "info", pattern: "INFO" }
        ]
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stats[0].matching_lines, 2);
      assert.strictEqual(result.stats[1].matching_lines, 2);
      assert.strictEqual(result.stats[2].matching_lines, 2);
    });

    it("line_range restricts checked area", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? "ERROR" : "ok"));
      writeTempFile(tmpDir, "stats3.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats3.log",
        rules: [{ name: "errors", pattern: "ERROR" }],
        line_range: { start: 10, end: 20 }
      });
      assert.strictEqual(result.ok, true);
      const errorStat = result.stats.find(s => s.name === "errors");
      assert.strictEqual(errorStat.matching_lines, 5);
      assert.strictEqual(errorStat.total_lines_checked, 11);
    });

    it("no rules match — all matching_lines=0", async () => {
      const lines = ["all normal", "nothing special", "just text"];
      writeTempFile(tmpDir, "stats4.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats4.log",
        rules: [{ name: "no-match", pattern: "ZZZZZZZ" }]
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stats[0].matching_lines, 0);
      assert.strictEqual(result.stats[0].rate, 0);
    });

    it("every line matches — rate=100", async () => {
      const lines = Array.from({ length: 50 }, () => "all match");
      writeTempFile(tmpDir, "stats5.log", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats5.log",
        rules: [{ name: "all", pattern: "match", is_regex: false }]
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stats[0].matching_lines, 50);
      assert.strictEqual(result.stats[0].rate, 100);
    });

    it("one line matches multiple rules — each increments", async () => {
      writeTempFile(tmpDir, "stats6.log", "ERROR: WARN: INFO: multi");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats6.log",
        rules: [
          { name: "errors", pattern: "ERROR" },
          { name: "warnings", pattern: "WARN" },
          { name: "info", pattern: "INFO" }
        ]
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stats[0].matching_lines, 1);
      assert.strictEqual(result.stats[1].matching_lines, 1);
      assert.strictEqual(result.stats[2].matching_lines, 1);
    });

    it("line_range start > end — handles gracefully", async () => {
      writeTempFile(tmpDir, "stats7.log", "a\nb\nc\n");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats7.log",
        rules: [{ name: "x", pattern: "a" }],
        line_range: { start: 100, end: 1 }
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.stats[0].total_lines_checked, 0);
    });

    it("invalid regex rule — that rule has matching_lines=0", async () => {
      writeTempFile(tmpDir, "stats8.log", "test line\n");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats8.log",
        rules: [
          { name: "bad", pattern: "[", is_regex: true },
          { name: "good", pattern: "test" }
        ]
      });
      assert.strictEqual(result.ok, true);
      const goodRule = result.stats.find(s => s.name === "good");
      assert.strictEqual(goodRule.matching_lines, 1);
    });

    it("2MB log file with 10000 lines — byte-chunk scanning works", async () => {
      const content = generateLogFile(2 * 1024 * 1024);
      writeTempFile(tmpDir, "stats_large.log", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.stats(ctx, {
        path: "stats_large.log",
        rules: [{ name: "errors", pattern: "ERROR" }]
      });
      assert.strictEqual(result.ok, true);
      assert.ok(result.stats[0].matching_lines > 0);
      assert.ok(result.stats[0].total_lines_checked > 0);
    });
  });

  // ==========================================================================
  // file_json_tree — 流式解析版
  // ==========================================================================

  describe("file_json_tree", () => {
    it('path_expr="" — returns root at max_depth=2', async () => {
      const json = { users: [{ name: "Alice" }, { name: "Bob" }], count: 2 };
      writeTempFile(tmpDir, "tree1.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree1.json", path_expr: "" });
      assert.strictEqual(result.ok, true);
      const parsed = JSON.parse(result.content);
      assert.strictEqual(parsed.users[0], "{Object with 1 keys}");
      assert.strictEqual(parsed.users[1], "{Object with 1 keys}");
      assert.strictEqual(parsed.count, 2);
    });

    it('path_expr="users" — returns users subtree', async () => {
      const json = { users: [{ name: "Alice" }, { name: "Bob" }], count: 2 };
      writeTempFile(tmpDir, "tree2.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree2.json", path_expr: "users" });
      assert.strictEqual(result.ok, true);
      const parsed = JSON.parse(result.content);
      assert.strictEqual(parsed[0].name, "Alice");
      assert.strictEqual(parsed[1].name, "Bob");
    });

    it('path_expr="users.0" — returns first user', async () => {
      const json = { users: [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }] };
      writeTempFile(tmpDir, "tree3.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree3.json", path_expr: "users.0" });
      assert.strictEqual(result.ok, true);
      const parsed = JSON.parse(result.content);
      assert.strictEqual(parsed.name, "Alice");
      assert.strictEqual(parsed.age, 30);
    });

    it('path_expr="users.0.name" — returns just name value', async () => {
      const json = { users: [{ name: "Alice" }] };
      writeTempFile(tmpDir, "tree4.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree4.json", path_expr: "users.0.name" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, '"Alice"');
    });

    it("max_depth=0 — all objects/arrays become type strings", async () => {
      const json = { a: { b: { c: 1 } } };
      writeTempFile(tmpDir, "tree5.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree5.json", path_expr: "", max_depth: 0 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, '"{Object with 1 keys}"');
    });

    it("non-existent path — path_not_found", async () => {
      const json = { a: 1 };
      writeTempFile(tmpDir, "tree6.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree6.json", path_expr: "b.c" });
      assert.strictEqual(result.error, "path_not_found");
    });

    it("path to boolean — returns 'true'", async () => {
      const json = { enabled: true };
      writeTempFile(tmpDir, "tree7.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree7.json", path_expr: "enabled" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, "true");
    });

    it("path to null — returns 'null'", async () => {
      const json = { value: null };
      writeTempFile(tmpDir, "tree8.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree8.json", path_expr: "value" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, "null");
    });

    it("non-JSON file — parse error", async () => {
      writeTempFile(tmpDir, "bad.json", "not json at all");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "bad.json", path_expr: "" });
      assert.strictEqual(result.error, "json_parse_error");
    });

    it("path into array beyond bounds — path_not_found", async () => {
      const json = { items: [1, 2] };
      writeTempFile(tmpDir, "tree10.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree10.json", path_expr: "items.5" });
      assert.strictEqual(result.error, "path_not_found");
    });

    it("path to number — returns number as string", async () => {
      const json = { count: 42 };
      writeTempFile(tmpDir, "tree11.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "tree11.json", path_expr: "count" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.content, "42");
    });

    it("JSON with escaped characters in key", async () => {
      const json = { 'key\\"with"escape': "value" };
      writeTempFile(tmpDir, "tree_esc.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      // Access via the exact path including escapes
      // The key when navigated is 'key"with"escape' (unescaped)
      const result = await service.jsonTree(ctx, { path: "tree_esc.json", path_expr: "" });
      assert.strictEqual(result.ok, true);
    });
  });

  // ==========================================================================
  // file_json_keys — 流式解析版
  // ==========================================================================

  describe("file_json_keys", () => {
    it('path_expr="" at root object — keys and count', async () => {
      const json = { a: 1, b: 2 };
      writeTempFile(tmpDir, "keys1.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys1.json", path_expr: "" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "object");
      assert.deepStrictEqual(result.keys, ["a", "b"]);
      assert.strictEqual(result.count, 2);
    });

    it('path_expr="" at root array — indices and count', async () => {
      const json = [1, 2, 3];
      writeTempFile(tmpDir, "keys2.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys2.json", path_expr: "" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "array");
      assert.strictEqual(result.count, 3);
      assert.strictEqual(result.indices.from, 0);
      assert.strictEqual(result.indices.to, 2);
    });

    it('path_expr="nested" at object — lists nested keys', async () => {
      const json = { nested: { x: 1, y: 2 } };
      writeTempFile(tmpDir, "keys3.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys3.json", path_expr: "nested" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "object");
      assert.deepStrictEqual(result.keys, ["x", "y"]);
    });

    it('path_expr="items" on array of objects', async () => {
      const json = { items: [{ a: 1 }, { b: 2 }] };
      writeTempFile(tmpDir, "keys4.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys4.json", path_expr: "items" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "array");
      assert.strictEqual(result.count, 2);
    });

    it("path to primitive string — primitive type", async () => {
      const json = { name: "test" };
      writeTempFile(tmpDir, "keys5.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys5.json", path_expr: "name" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "primitive");
      assert.strictEqual(result.valueType, "string");
      assert.strictEqual(result.sample, "test");
    });

    it("path to primitive number — primitive type with stringified sample", async () => {
      const json = { count: 42 };
      writeTempFile(tmpDir, "keys6.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys6.json", path_expr: "count" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "primitive");
      assert.strictEqual(result.valueType, "number");
      assert.strictEqual(result.sample, "42");
    });

    it("path to null — primitive type with null", async () => {
      const json = { val: null };
      writeTempFile(tmpDir, "keys7.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys7.json", path_expr: "val" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "primitive");
      assert.strictEqual(result.valueType, "null");
      assert.strictEqual(result.sample, null);
    });

    it("path to boolean — primitive type", async () => {
      const json = { active: false };
      writeTempFile(tmpDir, "keys8.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys8.json", path_expr: "active" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "primitive");
      assert.strictEqual(result.valueType, "boolean");
      assert.strictEqual(result.sample, "false");
    });

    it("empty object at path", async () => {
      const json = { empty: {} };
      writeTempFile(tmpDir, "keys9.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys9.json", path_expr: "empty" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "object");
      assert.strictEqual(result.count, 0);
      assert.deepStrictEqual(result.keys, []);
    });

    it("empty array at path", async () => {
      const json = { items: [] };
      writeTempFile(tmpDir, "keys10.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys10.json", path_expr: "items" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "array");
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.indices.to, -1);
    });

    it("non-existent path — error", async () => {
      const json = { a: 1 };
      writeTempFile(tmpDir, "keys11.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys11.json", path_expr: "b" });
      assert.strictEqual(result.error, "path_not_found");
    });

    it("large array — returns itemTypes sample", async () => {
      const json = { data: Array.from({ length: 10000 }, (_, i) => i % 3 === 0 ? `str${i}` : i) };
      writeTempFile(tmpDir, "keys12.json", JSON.stringify(json));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonKeys(ctx, { path: "keys12.json", path_expr: "data" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, "array");
      assert.strictEqual(result.count, 10000);
      assert.strictEqual(result.indices.to, 9999);
      assert.ok(Array.isArray(result.itemTypes));
      assert.strictEqual(result.itemTypes.length, 5);
    });
  });

  // ==========================================================================
  // file_jsonl_filter
  // ==========================================================================

  describe("file_jsonl_filter", () => {
    it("match by string field — 30/100 match ERROR in level", async () => {
      let content = "";
      for (let i = 0; i < 100; i++) {
        content += JSON.stringify({ id: i, level: i < 30 ? "error" : "info" }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl1.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl1.jsonl", field: "level", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 30);
    });

    it("match by regex on message field", async () => {
      let content = "";
      for (let i = 0; i < 50; i++) {
        content += JSON.stringify({ id: i, msg: `code${i}` }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl2.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl2.jsonl", field: "msg", pattern: "code[0-9]+", is_regex: true
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 50);
    });

    it("nested field match", async () => {
      let content = "";
      for (let i = 0; i < 20; i++) {
        content += JSON.stringify({ user: { name: i < 5 ? "error_user" : "normal" } }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl3.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl3.jsonl", field: "user.name", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 5);
    });

    it("max_results=3 — returns at most 3 records", async () => {
      let content = "";
      for (let i = 0; i < 50; i++) {
        content += JSON.stringify({ level: "error" }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl4.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl4.jsonl", field: "level", pattern: "error", max_results: 3
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 3);
    });

    it("no records match — empty", async () => {
      let content = "";
      for (let i = 0; i < 10; i++) {
        content += JSON.stringify({ level: "info" }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl5.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl5.jsonl", field: "level", pattern: "ZZZZ"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 0);
    });

    it("some lines invalid JSON — skip those", async () => {
      let content = "";
      for (let i = 0; i < 10; i++) {
        content += JSON.stringify({ id: i, level: "error" }) + "\n";
        if (i === 4) content += "not json at all\n";
      }
      writeTempFile(tmpDir, "jsonl6.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl6.jsonl", field: "level", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 10);
    });

    it("field doesn't exist in some records — skip those", async () => {
      let content = "";
      for (let i = 0; i < 10; i++) {
        const obj = i === 5 ? { id: i } : { id: i, level: "error" };
        content += JSON.stringify(obj) + "\n";
      }
      writeTempFile(tmpDir, "jsonl7.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl7.jsonl", field: "level", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 9);
    });

    it("max_chars_per_record truncation", async () => {
      let content = "";
      for (let i = 0; i < 5; i++) {
        content += JSON.stringify({ level: "error", data: "x".repeat(500) }) + "\n";
      }
      writeTempFile(tmpDir, "jsonl8.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl8.jsonl", field: "level", pattern: "error", max_chars_per_record: 50
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 5);
      for (const rec of result.records) {
        assert.ok(rec.length <= 50);
      }
    });

    it("field value is null — no match", async () => {
      let content = JSON.stringify({ level: null }) + "\n";
      writeTempFile(tmpDir, "jsonl9.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl9.jsonl", field: "level", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 0);
    });

    it("field value is number, string pattern — matched as string", async () => {
      let content = JSON.stringify({ code: 12345 }) + "\n";
      writeTempFile(tmpDir, "jsonl10.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl10.jsonl", field: "code", pattern: "123"
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.count, 1);
    });

    it("1.1MB JSONL file — multi-chunk scanning", async () => {
      const content = generateJsonlFile(1.1 * 1024 * 1024);
      writeTempFile(tmpDir, "jsonl_large.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl_large.jsonl", field: "level", pattern: "error"
      });
      assert.strictEqual(result.ok, true);
      assert.ok(result.count > 0);
      assert.ok(result.lines_processed > 0);
    });

    it("2.5MB JSONL file — multi-chunk scanning", async () => {
      const content = generateJsonlFile(2.5 * 1024 * 1024);
      writeTempFile(tmpDir, "jsonl_large2.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl_large2.jsonl", field: "level", pattern: "info"
      });
      assert.strictEqual(result.ok, true);
      assert.ok(result.count > 0);
    });

    it("invalid regex — returns error", async () => {
      writeTempFile(tmpDir, "jsonl_bad.jsonl", '{"a":1}\n');
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "jsonl_bad.jsonl", field: "a", pattern: "[", is_regex: true
      });
      assert.strictEqual(result.error, "invalid_regex");
    });
  });

  // ==========================================================================
  // 256KB 硬限制测试
  // ==========================================================================

  describe("Hard 256KB limit", () => {
    it("readLines: accumulated bytes exceed 256KB → truncated", async () => {
      // 10000 lines × ~100 bytes = ~1MB, exceeds 256KB
      const lines = Array.from({ length: 10000 }, (_, i) => "line".padEnd(100, "x") + `-${i}`);
      writeTempFile(tmpDir, "limit_lines.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.readLines(ctx, { path: "limit_lines.txt", start_line: 1, end_line: 10000 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.truncated, true);
      // Should collect fewer than 10000 lines
      assert.ok(result.lines.length < 10000);
    });

    it("jsonlFilter: accumulated record bytes exceed 256KB → truncated", async () => {
      // Each matching record is ~25 bytes → 15000 records ≈ 375KB > 256KB
      let content = "";
      for (let i = 0; i < 15000; i++) {
        content += JSON.stringify({ id: i, match: true }) + "\n";
      }
      writeTempFile(tmpDir, "limit_jsonl.jsonl", content);
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonlFilter(ctx, {
        path: "limit_jsonl.jsonl", field: "match", pattern: "true", max_results: 15000
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.truncated, true);
      // Should have fewer than 15000 records
      assert.ok(result.count < 15000);
    });

    it("search: many no-context matches exceed 256KB → truncated", async () => {
      // Each match JSON ~80 bytes. ~3300 matches → 264KB, exceeds 256KB
      const lines = Array.from({ length: 4000 }, (_, i) => "match " + "x".repeat(30) + " line " + i);
      writeTempFile(tmpDir, "limit_search.txt", lines.join("\n"));
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "limit_search.txt", pattern: "match", max_results: 10000
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.truncated, true);
    });
  });

  // ==========================================================================
  // 错误处理
  // ==========================================================================

  describe("Error Handling", () => {
    it("file not found — error message", async () => {
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.read(ctx, { path: "nonexistent.txt" });
      assert.strictEqual(result.error, "read_error");
    });

    it("invalid regex in search — returns error", async () => {
      writeTempFile(tmpDir, "err_search.txt", "content");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.search(ctx, {
        path: "err_search.txt", pattern: "[", is_regex: true
      });
      assert.strictEqual(result.error, "invalid_regex");
    });

    it("non-JSON file for jsonTree — parse error", async () => {
      writeTempFile(tmpDir, "bad_json.txt", "not json");
      const ctx = { agent: { id: "agent-1" } };
      const result = await service.jsonTree(ctx, { path: "bad_json.txt", path_expr: "" });
      assert.strictEqual(result.error, "json_parse_error");
    });
  });
});
