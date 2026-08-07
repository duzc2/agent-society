/**
 * Bigfile 核心服务
 *
 * 职责：
 * - 大文件读取、搜索、统计、JSON/JSONL 分析等核心逻辑
 * - 直接 fs.open + handle.read 字节块循环，内存 O(1)
 * - 统一输出截断（按字节）
 *
 * IO 策略：
 * - _readBytes: 单次 handle.read，用于 bigfile_read
 * - _walkLines: 生成器，256KB 块循环 + TextDecoder({stream:true})，用于其余工具
 * - JSON 工具: _streamJsonNavigate 流式逐字符解析，不加载完整文件到内存
 *
 * 硬限制：
 * - MAX_OUTPUT_BYTES = 256KB：从文件中读取的内容字节硬上限
 * - 所有收集文件内容的工具在超限时立即停止读取
 *
 * 设计约束：
 * - 无状态：每个调用独立 open → read → close，不缓存文件句柄或索引
 * - UTF-8 安全：TextDecoder stream 模式跨越块边界
 * - try/finally 保证文件句柄关闭
 */
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// 常量
// ============================================================================

/** 输出硬上限（字节数）：256KB */
const MAX_OUTPUT_BYTES = 256 * 1024; // 256KB

/** _walkLines 单次块大小 */
const WALK_CHUNK_SIZE = 256 * 1024; // 256KB

/** jsonKeys 对象键收集上限 */
const MAX_JSON_KEYS = 1000;

// Byte order mark
const BOM = 0xfeff;

// ============================================================================
// 模块级单例
// ============================================================================

const utf8Encoder = new TextEncoder();

// ============================================================================
// 辅助函数（命名导出，可独立测试）
// ============================================================================

/**
 * 计算 UTF-8 字符串的字节长度。
 * @param {string} str
 * @returns {number}
 */
export function byteLength(str) {
  return utf8Encoder.encode(str).length;
}

/**
 * 按字节硬上限截断输出文本，返回截断元数据。
 * 使用 TextDecoder({fatal:false}) 保证不在多字节字符中间截断。
 * @param {string} text
 * @returns {{ content: string, truncated: boolean, original_length: number }}
 */
export function truncateByBytes(text) {
  const str = text == null ? "" : String(text);
  const encoded = utf8Encoder.encode(str);
  if (encoded.length <= MAX_OUTPUT_BYTES) {
    return { content: str, truncated: false, original_length: str.length };
  }
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(
    encoded.subarray(0, MAX_OUTPUT_BYTES)
  );
  return { content: truncated, truncated: true, original_length: str.length };
}

/**
 * 按点分隔路径表达式导航 JSON 节点。
 * "" 或 "." 返回根；"a.b.0" 依次访问对象属性和数组索引。
 * @param {any} node
 * @param {string} expr
 * @returns {any|undefined}
 */
export function navigateJsonPath(node, expr) {
  if (expr === "" || expr === ".") return node;
  const parts = expr.split(".");
  let current = node;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = current[part];
    }
  }
  return current;
}

/**
 * 深度受限的子树提取。
 * 超过 maxDepth 的对象/数组被替换为类型描述字符串。
 * @param {any} node
 * @param {number} maxDepth
 * @returns {any}
 */
export function extractSubtree(node, maxDepth) {
  if (maxDepth === 0) {
    if (Array.isArray(node)) return `[Array(${node.length})]`;
    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node);
      return `{Object with ${keys.length} keys}`;
    }
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => {
      if (item !== null && typeof item === "object") {
        return extractSubtree(item, maxDepth - 1);
      }
      return item;
    });
  }

  if (node !== null && typeof node === "object") {
    const result = {};
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val !== null && typeof val === "object") {
        result[key] = extractSubtree(val, maxDepth - 1);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  return node;
}

/**
 * 按点分隔路径获取嵌套字段值。
 * @param {object} obj
 * @param {string} field - 如 "user.name"
 * @returns {any|undefined}
 */
export function getNestedField(obj, field) {
  if (field === "") return obj;
  if (obj === null || obj === undefined) return undefined;
  const parts = field.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * 对对象字段值进行模式匹配。
 * @param {object} obj
 * @param {string} field
 * @param {string} pattern
 * @param {boolean} isRegex
 * @returns {boolean}
 */
export function matchField(obj, field, pattern, isRegex) {
  const value = getNestedField(obj, field);
  if (value === undefined || value === null) return false;
  const str = typeof value === "string" ? value : String(value);
  if (isRegex) {
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false;
    }
  }
  return str.includes(pattern);
}

// ============================================================================
// BigfileService 类
// ============================================================================

export class BigfileService {
  /**
   * @param {{ runtime: any, log: any }} deps
   */
  constructor({ runtime, log: logger }) {
    this.runtime = runtime;
    this.log = logger;
  }

  /**
   * 从 ctx 解析 agent 对应工作区的绝对路径。
   * @param {any} ctx
   * @param {string} relPath
   * @returns {Promise<string>} 绝对路径
   */
  async _resolveAbsolutePath(ctx, relPath) {
    const agentId = ctx?.agent?.id;
    if (!agentId) throw new Error("no_agent");
    const wsId = this.runtime.findWorkspaceIdForAgent(agentId);
    if (!wsId) throw new Error("workspace_not_assigned");
    const { getWorkspaceManager } = await import("../../src/platform/services/workspace/workspace_manager.js");
    const ws = await getWorkspaceManager().getWorkspace(wsId);
    return ws.resolveAbsolutePath(relPath);
  }

  // ==========================================================================
  // IO 原语
  // ==========================================================================

  /**
   * 一次性字节范围读取。buffer 上限 256KB。
   * @param {string} absPath - 绝对路径
   * @param {number} offset - 起始偏移量
   * @param {number} length - 读取长度
   * @returns {Promise<{ content: string, start: number, total: number, readLength: number }>}
   */
  async _readBytes(absPath, offset, length) {
    const total = (await fs.promises.stat(absPath)).size;
    const actualOffset = Math.max(0, offset);
    const actualLength = Math.min(MAX_OUTPUT_BYTES, length);
    const buffer = Buffer.alloc(actualLength);
    let handle;
    try {
      handle = await fs.promises.open(absPath, "r");
      const { bytesRead } = await handle.read(buffer, 0, actualLength, actualOffset);
      const raw = buffer.subarray(0, bytesRead);
      // strip BOM if present at offset 0 (UTF-16 BE: FE FF)
      let bytes = raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF
        ? raw.subarray(2)
        : raw;
      // also handle UTF-8 BOM (EF BB BF → U+FEFF) and UTF-16 LE BOM (FF FE → U+FEFF)
      // by checking the decoded code point (consistent with _walkLines)
      const rawText = new TextDecoder("utf-8").decode(bytes);
      const text = rawText.length > 0 && rawText.codePointAt(0) === BOM
        ? rawText.slice(1)
        : rawText;
      return { content: text, start: actualOffset, total, readLength: bytesRead };
    } finally {
      if (handle) await handle.close();
    }
  }

  /**
   * 逐行遍历生成器。256KB 块循环，TextDecoder({stream:true}) 安全跨越 UTF-8 块边界。
   *
   * 每个 yield 包含:
   *   lines: string[] — 本批行的文本
   *   lineNumStart: number — 本批第一行的 1-based 行号
   *
   * 最后一个 yield:
   *   lines: []
   *   lineNumStart: lineNum + 1
   *   done: true
   *   totalLines: number
   *
   * @param {string} absPath - 绝对路径
   * @param {number} total - 文件总大小
   * @returns {AsyncGenerator<{lines: string[], lineNumStart: number, [done]: true, [totalLines]: number}>}
   */
  async *_walkLines(absPath, total) {
    let handle;
    try {
      handle = await fs.promises.open(absPath, "r");
      const chunkBuf = Buffer.alloc(WALK_CHUNK_SIZE);
      const decoder = new TextDecoder("utf-8");
      let offset = 0;
      let leftover = "";
      let lineNum = 0;
      let isFirstChunk = true;

      while (offset < total) {
        const { bytesRead } = await handle.read(chunkBuf, 0, WALK_CHUNK_SIZE, offset);
        if (bytesRead === 0) break;

        let text = decoder.decode(chunkBuf.subarray(0, bytesRead), { stream: true });

        // BOM stripping on first chunk's first char
        if (isFirstChunk && text.codePointAt(0) === BOM) {
          text = text.slice(1);
        }
        isFirstChunk = false;

        const combined = leftover + text;
        const lines = combined.split("\n");
        leftover = lines.pop() || "";

        if (lines.length > 0) {
          yield { lines, lineNumStart: lineNum + 1 };
          lineNum += lines.length;
        }
        offset += bytesRead;
      }

      // 刷新 decoder 残留
      leftover += decoder.decode();
      if (leftover !== "") {
        // Last chunk with no trailing newline — still count as a line
        yield { lines: [leftover], lineNumStart: lineNum + 1 };
        lineNum++;
      }

      yield { lines: [], lineNumStart: lineNum + 1, done: true, totalLines: lineNum };
    } finally {
      if (handle) await handle.close();
    }
  }

  // ==========================================================================
  // bigfile_read — 字节范围读取
  // ==========================================================================

  async read(ctx, args) {
    const { path: relPath, offset = 0, length = 500 } = args;
    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] read 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    let result;
    try {
      result = await this._readBytes(absPath, offset, length);
    } catch (e) {
      this.log.error("[Bigfile] read 失败", {
        path: relPath, offset, length,
        error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    const truncated = truncateByBytes(result.content);

    return {
      ok: true,
      content: truncated.content,
      truncated: truncated.truncated,
      original_length: truncated.original_length || result.readLength,
      start: result.start,
      total: result.total,
      read_length: result.readLength
    };
  }

  // ==========================================================================
  // bigfile_get_info — 文件元数据
  // ==========================================================================

  async getInfo(ctx, args) {
    const { path: relPath } = args;
    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] getInfo 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "stat_error", message: e.message };
    }

    const ext = path.extname(relPath).toLowerCase();
    let estimated_type = "text";
    if (ext === ".json") estimated_type = "json";
    else if (ext === ".jsonl" || ext === ".ndjson") estimated_type = "jsonl";
    else if (ext === ".log") estimated_type = "log";

    let total_size = 0;
    try {
      total_size = (await fs.promises.stat(absPath)).size;
    } catch (e) {
      this.log.error("[Bigfile] getInfo stat 失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "stat_error", message: e.message };
    }

    // _walkLines 扫描全文计数行数
    let total_lines = 0;
    try {
      for await (const chunk of this._walkLines(absPath, total_size)) {
        if (chunk.done) {
          total_lines = chunk.totalLines;
          break;
        }
      }
    } catch (e) {
      this.log.warn("[Bigfile] getInfo line count 失败，使用 0", {
        path: relPath, error: e.message
      });
      total_lines = 0;
    }

    return {
      ok: true,
      total_size,
      total_lines,
      extension: ext,
      estimated_type
    };
  }

  // ==========================================================================
  // bigfile_read_lines — 行号范围读取（两阶段）
  // ==========================================================================

  async readLines(ctx, args) {
    const { path: relPath, start_line, end_line } = args;
    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] readLines 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_lines_error", message: e.message };
    }

    let total_size;
    try {
      total_size = (await fs.promises.stat(absPath)).size;
    } catch (e) {
      this.log.error("[Bigfile] readLines stat 失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_lines_error", message: e.message };
    }

    const startLine = Math.max(1, start_line);
    const endLineNum = end_line; // may be very large

    // early exit: start_line > end_line — collect nothing
    if (startLine > endLineNum) {
      return {
        ok: true,
        lines: [],
        truncated: false,
        original_length: 0,
        start_line: startLine > 0 ? startLine : 0,
        end_line: endLineNum,
        total_lines: 0
      };
    }

    let collected = [];
    let doneCollection = false;
    let totalLines = 0;
    let actualEndLine = 0;
    let accumulatedBytes = 0;
    let byteLimitTruncated = false;

    try {
      for await (const chunk of this._walkLines(absPath, total_size)) {
        if (chunk.done) {
          totalLines = chunk.totalLines;
          break;
        }

        for (let i = 0; i < chunk.lines.length; i++) {
          if (byteLimitTruncated) break;
          const absLine = chunk.lineNumStart + i;

          if (!doneCollection && absLine < startLine) continue;

          if (!doneCollection && absLine >= startLine) {
            doneCollection = true;
            const lineBytes = byteLength(chunk.lines[i]);
            if (accumulatedBytes + lineBytes > MAX_OUTPUT_BYTES) {
              byteLimitTruncated = true;
              break;
            }
            accumulatedBytes += lineBytes;
            collected.push(chunk.lines[i]);
            actualEndLine = absLine;
            if (absLine >= endLineNum) {
              doneCollection = true;
            }
            continue;
          }

          if (doneCollection && absLine <= endLineNum) {
            const lineBytes = byteLength(chunk.lines[i]);
            if (accumulatedBytes + lineBytes > MAX_OUTPUT_BYTES) {
              byteLimitTruncated = true;
              break;
            }
            accumulatedBytes += lineBytes;
            collected.push(chunk.lines[i]);
            actualEndLine = absLine;
          }
        }
      }
    } catch (e) {
      this.log.error("[Bigfile] readLines 遍历失败", {
        path: relPath, start_line, end_line,
        error: e.message, stack: e.stack
      });
      return { error: "read_lines_error", message: e.message };
    }

    const text = collected.join("\n");
    const truncated = truncateByBytes(text);

    return {
      ok: true,
      lines: truncated.content ? truncated.content.split("\n") : collected,
      truncated: truncated.truncated || byteLimitTruncated,
      original_length: truncated.original_length || text.length,
      start_line: collected.length > 0 ? startLine : (startLine > totalLines ? startLine : 0),
      end_line: actualEndLine || endLineNum,
      total_lines: totalLines
    };
  }

  // ==========================================================================
  // bigfile_search — 规则化搜索（滑动窗口）
  // ==========================================================================

  async search(ctx, args) {
    const {
      path: relPath,
      pattern,
      is_regex = false,
      max_results = 100,
      context_lines = 0
    } = args;

    // 验证正则
    if (is_regex) {
      try {
        new RegExp(pattern);
      } catch {
        return { error: "invalid_regex", message: `无效的正则表达式: ${pattern}` };
      }
    }

    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] search 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "load_error", message: e.message };
    }

    let total_size;
    try {
      total_size = (await fs.promises.stat(absPath)).size;
    } catch (e) {
      this.log.error("[Bigfile] search stat 失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "load_error", message: e.message };
    }

    const finalized = [];
    const ring = []; // [{lineNum, text}], max context_lines+1 entries
    let pending = []; // [{line, col, text, ctx: {before:[], after:[]}, needed}]
    let searchRegex = null;
    if (is_regex) {
      searchRegex = new RegExp(pattern);
    }

    const matches = (line) => {
      if (is_regex) {
        // Reset lastIndex for exec()
        searchRegex.lastIndex = 0;
        const m = searchRegex.exec(line);
        return m ? m.index + 1 : -1;
      }
      const idx = line.indexOf(pattern);
      return idx !== -1 ? idx + 1 : -1;
    };

    const maxRingSize = context_lines + 1;

    // Track accumulated bytes of collected match content (text + contexts)
    let accumulatedMatchBytes = 0;
    let byteLimitTruncated = false;
    let doneProcessing = false; // true when enough context matches are fully collected

    try {
      for await (const chunk of this._walkLines(absPath, total_size)) {
        if (chunk.done || byteLimitTruncated || doneProcessing) break;

        for (let i = 0; i < chunk.lines.length; i++) {
          if (finalized.length >= max_results || byteLimitTruncated || doneProcessing) break;

          const line = chunk.lines[i];
          const absLine = chunk.lineNumStart + i;

          // 1. 加入 sliding window
          ring.push({ lineNum: absLine, text: line });
          if (ring.length > maxRingSize) ring.shift();

          // 2. 填充 pending 的 after-context
          for (const m of pending) {
            if (m.needed > 0) {
              m.ctx.after.push({ line: absLine, text: line });
              m.needed--;
            }
          }

          // 3. 当前行匹配？
          const col = matches(line);
          if (col !== -1) {
            if (context_lines === 0) {
              // Check byte limit before adding: use running counter (O(1) per match)
              const matchBytes = byteLength(JSON.stringify({ line: absLine, col, text: line }));
              if (accumulatedMatchBytes + matchBytes > MAX_OUTPUT_BYTES) {
                byteLimitTruncated = true;
                break;
              }
              accumulatedMatchBytes += matchBytes;
              finalized.push({ line: absLine, col, text: line });
            } else if (pending.length < max_results) {
              // Only create new pending entry if we haven't reached max_results
              const before = ring
                .filter(r => r.lineNum !== absLine)
                .map(r => ({ line: r.lineNum, text: r.text }));
              const matchEntry = {
                line: absLine,
                col,
                text: line,
                ctx: { before, after: [] },
                needed: context_lines
              };
              pending.push(matchEntry);
            }
          }

          // 4. Early exit: all tracked pending entries have their after-context
          if (pending.length >= max_results && pending.every(m => m.needed === 0)) {
            doneProcessing = true;
            break;
          }

          if (finalized.length >= max_results) break;
        }

        if (finalized.length >= max_results || byteLimitTruncated || doneProcessing) break;
      }

      // 4. 合并 pending 到 finalized（检查字节限制）
      for (const m of pending) {
        const matchRepr = {
          line: m.line,
          col: m.col,
          text: m.text,
          context_before: m.ctx.before,
          context_after: m.ctx.after
        };
        const matchBytes = byteLength(JSON.stringify(matchRepr));
        if (accumulatedMatchBytes + matchBytes > MAX_OUTPUT_BYTES) {
          byteLimitTruncated = true;
          break;
        }
        accumulatedMatchBytes += matchBytes;
        finalized.push(matchRepr);
      }
    } catch (e) {
      this.log.error("[Bigfile] search 遍历失败", {
        path: relPath, pattern, error: e.message, stack: e.stack
      });
      return { error: "load_error", message: e.message };
    }

    // sort by line number
    finalized.sort((a, b) => (a.line || 0) - (b.line || 0));

    const matches2 = finalized.slice(0, max_results);
    const output = JSON.stringify(matches2);
    const truncated = truncateByBytes(output);

    return {
      ok: true,
      matches: matches2,
      count: matches2.length,
      truncated: truncated.truncated || byteLimitTruncated,
      original_length: truncated.original_length
    };
  }

  // ==========================================================================
  // bigfile_stats — 规则化统计
  // ==========================================================================

  async stats(ctx, args) {
    const { path: relPath, rules, line_range } = args;

    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] stats 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    let total_size;
    try {
      total_size = (await fs.promises.stat(absPath)).size;
    } catch (e) {
      this.log.error("[Bigfile] stats stat 失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    // 预编译正则
    const compiledRules = rules.map((r) => {
      if (r.is_regex) {
        try {
          return { ...r, _regex: new RegExp(r.pattern) };
        } catch {
          return { ...r, _regex: null, _error: true };
        }
      }
      return { ...r };
    });

    const statsMap = compiledRules.map((r) => ({
      name: r.name,
      pattern: r.pattern,
      matching_lines: 0
    }));
    let totalLinesChecked = 0;

    const rangeStart = line_range?.start ?? 0;
    const rangeEnd = line_range?.end ?? Number.MAX_SAFE_INTEGER;

    try {
      for await (const chunk of this._walkLines(absPath, total_size)) {
        if (chunk.done) break;

        for (let i = 0; i < chunk.lines.length; i++) {
          const absLine = chunk.lineNumStart + i;
          if (absLine < rangeStart) continue;
          if (absLine > rangeEnd) break;

          totalLinesChecked++;
          const line = chunk.lines[i];

          for (let j = 0; j < compiledRules.length; j++) {
            const rule = compiledRules[j];
            if (rule._error) continue;
            if (rule.is_regex) {
              if (rule._regex?.test(line)) {
                statsMap[j].matching_lines++;
              }
            } else {
              if (line.includes(rule.pattern)) {
                statsMap[j].matching_lines++;
              }
            }
          }
        }
      }
    } catch (e) {
      this.log.error("[Bigfile] stats 遍历失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    const stats = statsMap.map((s) => ({
      ...s,
      total_lines_checked: totalLinesChecked,
      rate: totalLinesChecked > 0
        ? Math.round((s.matching_lines / totalLinesChecked) * 10000) / 100
        : 0
    }));

    return {
      ok: true,
      stats,
      line_range: line_range || null
    };
  }

  // ==========================================================================
  // 流式 JSON 解析器
  // ==========================================================================

  /**
   * 流式逐字符 JSON 导航器。
   *
   * 读取文件 chunk → TextDecoder({stream:true}) 解码 → 逐字符状态机解析。
   * 跟踪当前路径和嵌套深度，不加载完整文件到内存。
   *
   * @param {string} absPath - JSON 文件绝对路径
   * @param {string[]} targetSegments - 目标路径段数组，空数组=根
   * @param {string} mode - 'collect' | 'keys'
   * @returns {Promise<{ found: boolean, valueText?: string, valueType?: string, keys?: string[], count?: number, indices?: object, itemTypes?: string[], sample?: any, error?: string }>}
   */
  async _streamJsonNavigate(absPath, targetSegments, mode) {
    let handle;
    try {
      handle = await fs.promises.open(absPath, "r");
      const total = (await handle.stat()).size;
      if (total === 0) {
        return { found: false, error: "JSON file is empty" };
      }

      const chunkBuf = Buffer.alloc(WALK_CHUNK_SIZE);
      const decoder = new TextDecoder("utf-8");
      let offset = 0;
      let isFirstChunk = true;
      let charIndex = 0; // global character position for error reporting

      // State machine variables
      let state = "EXPECT"; // EXPECT | IN_STRING | IN_NUMBER | IN_LITERAL | COMPLETED
      let nestStack = []; // [{type: 'object'|'array', idx: number}]
      let pathSegments = []; // current path of the value being read
      let pendingKey = null; // object key just read (before ':')
      let inString = false;
      let afterBackslash = false;
      let stringIsKey = false; // true when the current string is an object key
      let stringBuf = "";
      let numBuf = "";

      // collect mode specific
      let collectActive = false;
      let collectDepth = 0; // bracket depth for collect mode
      let collectedChars = [];
      let collectedByteCount = 0;
      let collectStarting = false;

      // keys mode specific
      let keysResult = null; // populated when path target is reached

      // Utility: check if pathSegments matches targetSegments
      const pathMatches = () => {
        if (pathSegments.length !== targetSegments.length) return false;
        for (let i = 0; i < pathSegments.length; i++) {
          if (pathSegments[i] !== targetSegments[i]) return false;
        }
        return true;
      };

      // Consume one character at a time
      while (offset < total && state !== "COMPLETED") {
        const { bytesRead } = await handle.read(chunkBuf, 0, WALK_CHUNK_SIZE, offset);
        if (bytesRead === 0) break;

        let text = decoder.decode(chunkBuf.subarray(0, bytesRead), { stream: true });

        if (isFirstChunk && text.length > 0 && text.codePointAt(0) === BOM) {
          text = text.slice(1);
        }
        isFirstChunk = false;

        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          charIndex++;

          if (state === "COMPLETED") break;

          // If collecting, add character and check byte limit
          if (collectActive && mode === "collect") {
            const chBytes = byteLength(ch);
            if (collectedByteCount + chBytes > MAX_OUTPUT_BYTES) {
              // Stop collecting — byte limit exceeded
              // Return what we have so far as truncated
              state = "COMPLETED";
              break;
            }
            collectedChars.push(ch);
            collectedByteCount += chBytes;
          }

          // ---- IN_STRING: handle string contents ----
          if (inString) {
            if (afterBackslash) {
              afterBackslash = false;
              stringBuf += ch;
              continue;
            }
            if (ch === "\\") {
              afterBackslash = true;
              stringBuf += ch;
              continue;
            }
            if (ch === '"') {
              // String ends
              inString = false;
              stringBuf += ch;

              if (stringIsKey) {
                // This string was an object key
                pendingKey = stringBuf.slice(1, -1); // strip quotes
                stringBuf = "";
                stringIsKey = false;
                if (mode === "collect" && !collectActive) {
                  // Don't collect key characters
                }
              } else {
                // This string is a VALUE
                // Check if we've reached the target path
                if (mode === "collect" && collectActive) {
                  // Already collecting, continue
                } else if (pathMatches()) {
                  // Target reached! This is a primitive value (string)
                  if (mode === "collect") {
                    collectedChars = [stringBuf]; // we already have the collected chars
                    collectedByteCount = byteLength(stringBuf);
                    collectActive = false; // primitive, one-and-done
                    state = "COMPLETED";
                    break;
                  } else if (mode === "keys") {
                    keysResult = {
                      valueType: "string",
                      sample: stringBuf.slice(1, -1)
                    };
                    state = "COMPLETED";
                    break;
                  }
                } else {
                  // Not the target path, save collected chars if in collect mode
                  if (mode === "collect" && !collectActive && collectStarting) {
                    // We were collecting this value but it didn't end up being
                    // the target. Reset.
                    collectStarting = false;
                  }
                }
                stringBuf = "";
              }
              continue;
            }
            // Normal string character
            stringBuf += ch;
            continue;
          }

          // ---- Not in string ----
          // Whitespace
          if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            if (state === "IN_NUMBER") {
              // Number ends at whitespace
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  keysResult = { valueType: "number", sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }
            if (state === "IN_LITERAL") {
              // Literal ends at whitespace
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf]; // numBuf holds literal text
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  const literalType = numBuf === "true" || numBuf === "false" ? "boolean" : "null";
                  keysResult = { valueType: literalType, sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }
            continue;
          }

          // Handle ',' — separator
          if (ch === ",") {
            if (collectActive) continue;
            if (state === "IN_NUMBER") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  keysResult = { valueType: "number", sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }
            if (state === "IN_LITERAL") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  const literalType = numBuf === "true" || numBuf === "false" ? "boolean" : "null";
                  keysResult = { valueType: literalType, sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }

            const top = nestStack[nestStack.length - 1];
            if (!top) {
              state = "COMPLETED";
              break;
            }
            if (top.type === "array") {
              // Next array element
              top.idx++;
              if (pathSegments.length > 0) {
                pathSegments[pathSegments.length - 1] = String(top.idx);
              }
            } else if (top.type === "object") {
              // Between values in object — back to key position
              top.expectingKey = true;
              // Pop the key from pathSegments (if we were at a value)
              if (pendingKey === null && pathSegments.length > 0) {
                // Was at a value — pop key
                pathSegments.pop();
              }
              pendingKey = null;
            }
            // After ',' in object, expect next key
            state = "EXPECT";
            continue;
          }

          // Handle '{'
          if (ch === "{") {
            if (collectActive) {
              collectDepth++;
              continue;
            }

            if (mode === "collect" && pathMatches()) {
              // Found target — start collecting
              collectActive = true;
              collectDepth = 1;
              collectedChars = ["{"];
              collectedByteCount = byteLength("{");
              continue;
            }

            if (mode === "keys" && pathMatches()) {
              // Found target object — read keys
              const keyResult = this._streamJsonReadKeys(handle, text, i + 1, total, chunkBuf, decoder);
              return await keyResult;
            }

            // Push object to nest stack
            nestStack.push({ type: "object", expectingKey: true });
            // If we have a pending key, add it to path
            if (pendingKey !== null) {
              pathSegments.push(pendingKey);
              pendingKey = null;
            }
            state = "EXPECT";
            continue;
          }

          // Handle '}'
          if (ch === "}") {
            if (collectActive) {
              collectDepth--;
              if (collectDepth === 0) {
                // Collected entire value
                collectActive = false;
                state = "COMPLETED";
                break;
              }
              continue;
            }

            if (state === "IN_NUMBER") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  keysResult = { valueType: "number", sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }
            if (state === "IN_LITERAL") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  const literalType = numBuf === "true" || numBuf === "false" ? "boolean" : "null";
                  keysResult = { valueType: literalType, sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }

            // Pop from nest stack
            const nesting = nestStack.pop();
            if (!nesting || nesting.type !== "object") {
              return { found: false, error: `JSON parse error at position ${charIndex}: unexpected }` };
            }
            // Pop key from pathSegments if we were at a value position
            if (pathSegments.length > 0 && pendingKey === null) {
              // We had entered a value — the last segment is the object key
              pathSegments.pop();
            }
            pendingKey = null;

            // If at end of root, and haven't found target yet, it's not here
            if (nestStack.length === 0 && !keysResult && !collectActive) {
              // Root object closed — target not found (unless target was root)
              if (targetSegments.length === 0) {
                // Root was the target
                if (mode === "collect") {
                  // We can't rewind — this shouldn't happen since we collect from start
                }
                // Root target already handled in EXPECT state at start
              }
              state = "COMPLETED";
              // target not found
            }
            state = "EXPECT";
            continue;
          }

          // Handle '['
          if (ch === "[") {
            if (collectActive) {
              collectDepth++;
              continue;
            }

            if (mode === "collect" && pathMatches()) {
              // Found target array — start collecting
              collectActive = true;
              collectDepth = 1;
              collectedChars = ["["];
              collectedByteCount = byteLength("[");
              continue;
            }

            if (mode === "keys" && pathMatches()) {
              // Found target array — analyze it
              const arrResult = await this._streamJsonReadArray(handle, text, i + 1, total, chunkBuf, decoder);
              return await arrResult;
            }

            // Push array to nest stack
            const arrEntry = { type: "array", idx: 0 };
            nestStack.push(arrEntry);
            // If we have a pending key, add it to path
            if (pendingKey !== null) {
              pathSegments.push(pendingKey);
              pendingKey = null;
            }
            // Add "0" for first array element
            pathSegments.push("0");
            state = "EXPECT";
            continue;
          }

          // Handle ']'
          if (ch === "]") {
            if (collectActive) {
              collectDepth--;
              if (collectDepth === 0) {
                collectActive = false;
                state = "COMPLETED";
                break;
              }
              continue;
            }

            if (state === "IN_NUMBER") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  keysResult = { valueType: "number", sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }
            if (state === "IN_LITERAL") {
              state = "EXPECT";
              if (pathMatches()) {
                if (mode === "collect") {
                  collectedChars = [numBuf];
                  collectedByteCount = byteLength(numBuf);
                  collectActive = false;
                  state = "COMPLETED";
                  break;
                } else if (mode === "keys") {
                  const literalType = numBuf === "true" || numBuf === "false" ? "boolean" : "null";
                  keysResult = { valueType: literalType, sample: numBuf };
                  state = "COMPLETED";
                  break;
                }
              }
              numBuf = "";
            }

            // Pop from nest stack
            const arrNest = nestStack.pop();
            if (!arrNest || arrNest.type !== "array") {
              return { found: false, error: `JSON parse error at position ${charIndex}: unexpected ]` };
            }
            // Pop array index from pathSegments
            if (pathSegments.length > 0) {
              pathSegments.pop();
            }
            // If parent is array, its idx is unchanged (comma handler will increment)

            if (nestStack.length === 0 && !keysResult && !collectActive) {
              state = "COMPLETED";
            }
            state = "EXPECT";
            continue;
          }

          // Handle ':'
          if (ch === ":") {
            if (state === "IN_NUMBER") {
              numBuf = "";
            }
            if (collectActive) continue;

            // pendingKey becomes part of pathSegments
            if (pendingKey !== null) {
              pathSegments.push(pendingKey);
              pendingKey = null;
            }
            // Mark that next string in this object is a value, not a key
            const topObj = nestStack[nestStack.length - 1];
            if (topObj && topObj.type === "object") {
              topObj.expectingKey = false;
            }
            state = "EXPECT";
            continue;
          }

          // Handle '"' — start of string
          if (ch === '"') {
            if (state === "IN_NUMBER") {
              numBuf = "";
              state = "EXPECT";
            }
            if (state === "IN_LITERAL") {
              numBuf = "";
              state = "EXPECT";
            }

            inString = true;
            afterBackslash = false;
            stringBuf = "\"";

            // Determine if this is a key or value string
            const top = nestStack[nestStack.length - 1];
            if (top && top.type === "object" && top.expectingKey) {
              stringIsKey = true;
            } else {
              stringIsKey = false;
            }

            state = "IN_STRING";
            continue;
          }

          // Handle digits and minus (number start)
          if (ch === "-" || (ch >= "0" && ch <= "9")) {
            if (collectActive) continue;

            if (state === "EXPECT" || state === "IN_NUMBER") {
              state = "IN_NUMBER";
              numBuf += ch;

              // If first digit of a number value, check for target
              if (numBuf.length === 1 && pathMatches()) {
                if (mode === "collect") {
                  collectStarting = true;
                }
              }
              continue;
            }

            // Digit in unexpected state
            continue;
          }

          // Handle number continuation chars (., e, E, +)
          if ((ch === "." || ch === "e" || ch === "E" || ch === "+") && state === "IN_NUMBER") {
            numBuf += ch;
            continue;
          }

          // Handle literals: t(rue), f(alse), n(ull)
          if (ch === "t" || ch === "f" || ch === "n") {
            if (collectActive) continue;

            if (state === "EXPECT") {
              state = "IN_LITERAL";
              numBuf = ch; // reuse numBuf for literal

              if (pathMatches()) {
                if (mode === "collect") {
                  collectStarting = true;
                }
              }
              continue;
            }
          }

          // continuation of literal chars
          if (state === "IN_LITERAL" && /[a-z]/.test(ch)) {
            numBuf += ch;
            continue;
          }

          // Unrecognized character
          return { found: false, error: `JSON parse error at position ${charIndex}: unexpected character '${ch}'` };
        }

        offset += bytesRead;

        if (state === "COMPLETED") break;
      }

      // Handle results based on mode
      if (mode === "collect") {
        if (collectedChars.length > 0) {
          const valueText = collectedChars.join("");
          return { found: true, valueText };
        }
        // Check if target was the root and nothing was collected
        if (targetSegments.length === 0 && collectedChars.length === 0) {
          return { found: false, error: "path not found" };
        }
        return { found: false, error: "path not found" };
      }

      if (mode === "keys") {
        if (keysResult) return { found: true, ...keysResult };
        // Check root
        if (targetSegments.length === 0) {
          // We should have handled this before entering the loop
          // Fallback
          return { found: false, error: "Root keys resolution incomplete" };
        }
        return { found: false, error: "path not found" };
      }

      return { found: false, error: "Unknown mode" };
    } catch (e) {
      return { found: false, error: `Stream parse error: ${e.message}` };
    } finally {
      if (handle) await handle.close();
    }
  }

  /**
   * Read object keys from the current position in the stream.
   * Assumes we just saw '{' and continues reading.
   * @param {fs.FileHandle} handle
   * @param {string} remaining - remaining text after '{'
   * @param {number} startIndex - start position in remaining
   * @param {number} total - total file size
   * @param {Buffer} chunkBuf
   * @param {TextDecoder} decoder
   * @returns {Promise<object>}
   */
  async _streamJsonReadKeys(handle, remaining, startIndex, total, chunkBuf, decoder) {
    let inStr = false;
    let afterBackslash = false;
    let buf = "";
    let depth = 1; // start inside object
    let keys = [];
    let pos = startIndex;

    for (; pos < remaining.length && keys.length < MAX_JSON_KEYS; pos++) {
      const ch = remaining[pos];

      if (inStr) {
        buf += ch;
        if (afterBackslash) { afterBackslash = false; continue; }
        if (ch === "\\") { afterBackslash = true; continue; }
        if (ch === '"') {
          // End of string — is it a key?
          inStr = false;
          const content = buf.slice(1, -1); // strip quotes
          buf = "";
          // Next non-whitespace should be ':'
          // We don't know yet if it's a key or value. Need to look ahead.
          // For streaming simplicity, we peek ahead for ':'
          let j = pos + 1;
          while (j < remaining.length && (remaining[j] === " " || remaining[j] === "\t" || remaining[j] === "\n" || remaining[j] === "\r")) {
            j++;
          }
          if (j < remaining.length && remaining[j] === ":") {
            if (keys.length < MAX_JSON_KEYS) {
              keys.push(content);
            }
          }
        }
        continue;
      }

      if (depth === 0) {
        // Finished reading this object
        break;
      }

      // Skip whitespace
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
      } else if (ch === '"') {
        inStr = true;
        afterBackslash = false;
        buf = '"';
      }
      // Everything else (digits, letters, etc.) — skip, it's part of a value
    }

    const truncated = keys.length >= MAX_JSON_KEYS;
    return {
      found: true,
      valueType: "object",
      keys,
      count: keys.length,
      truncated
    };
  }

  /**
   * Read array info from the current position in the stream.
   * Assumes we just saw '[' and continues reading.
   * @param {fs.FileHandle} handle
   * @param {string} remaining - remaining text after '['
   * @param {number} startIndex - start position in remaining
   * @param {number} total - total file size
   * @param {Buffer} chunkBuf
   * @param {TextDecoder} decoder
   * @returns {Promise<object>}
   */
  async _streamJsonReadArray(handle, remaining, startIndex, total, chunkBuf, decoder) {
    let inStr = false;
    let afterBackslash = false;
    let buf = "";
    let depth = 1; // start inside array
    let elementCount = 0;
    let itemTypes = [];
    let expectingValue = true;
    let pos = startIndex;

    for (; pos < remaining.length; pos++) {
      const ch = remaining[pos];

      if (inStr) {
        buf += ch;
        if (afterBackslash) { afterBackslash = false; continue; }
        if (ch === "\\") { afterBackslash = true; continue; }
        if (ch === '"') {
          inStr = false;
          buf = "";
          if (expectingValue) {
            elementCount++;
            if (itemTypes.length < 5) itemTypes.push("string");
            expectingValue = false;
          }
        }
        continue;
      }

      if (depth === 0) {
        break;
      }

      // Skip whitespace
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        continue;
      }

      if (ch === ",") {
        expectingValue = true;
        continue;
      }

      if (ch === "{") {
        if (expectingValue) {
          elementCount++;
          if (itemTypes.length < 5) itemTypes.push("object");
          expectingValue = false;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
      } else if (ch === "[") {
        if (expectingValue) {
          elementCount++;
          if (itemTypes.length < 5) itemTypes.push("array");
          expectingValue = false;
        }
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) break;
      } else if (ch === '"') {
        inStr = true;
        afterBackslash = false;
        buf = '"';
      } else if (ch === "t" || ch === "f") {
        if (expectingValue) {
          elementCount++;
          if (itemTypes.length < 5) itemTypes.push("boolean");
          expectingValue = false;
        }
      } else if (ch === "n") {
        if (expectingValue) {
          elementCount++;
          if (itemTypes.length < 5) itemTypes.push("null");
          expectingValue = false;
        }
      } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
        if (expectingValue) {
          elementCount++;
          if (itemTypes.length < 5) itemTypes.push("number");
          expectingValue = false;
        }
      }
      // Consume other chars in values
    }

    return {
      found: true,
      valueType: "array",
      count: elementCount,
      indices: elementCount > 0 ? { from: 0, to: elementCount - 1 } : { from: 0, to: -1 },
      itemTypes: itemTypes.length > 0 ? itemTypes : undefined
    };
  }

  // ==========================================================================
  // bigfile_json_tree — JSON 树形导航（流式解析版）
  // ==========================================================================

  async jsonTree(ctx, args) {
    const { path: relPath, path_expr, max_depth = 2 } = args;

    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] jsonTree 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "json_parse_error", message: e.message };
    }

    // Parse path expression to segments
    const targetSegments = path_expr === "" || path_expr === "." ? [] : path_expr.split(".");

    let navResult;
    try {
      navResult = await this._streamJsonNavigate(absPath, targetSegments, "collect");
    } catch (e) {
      this.log.error("[Bigfile] jsonTree 流式解析失败", {
        path: relPath, path_expr,
        error: e.message, stack: e.stack
      });
      return { error: "json_parse_error", message: e.message };
    }

    if (!navResult.found) {
      if (navResult.error && navResult.error !== "path not found") {
        return { error: "json_parse_error", message: navResult.error };
      }
      return {
        error: "path_not_found",
        message: `JSON路径 ${path_expr || "(root)"} 不存在`
      };
    }

    // Parse the collected value text
    let target;
    try {
      target = JSON.parse(navResult.valueText);
    } catch (e) {
      this.log.error("[Bigfile] jsonTree JSON.parse 子树失败", {
        path: relPath, valueText: navResult.valueText.slice(0, 200),
        error: e.message, stack: e.stack
      });
      return { error: "json_parse_error", message: `子树解析失败: ${e.message}` };
    }

    const subtree = extractSubtree(target, max_depth);
    const content = JSON.stringify(subtree);
    const truncated = truncateByBytes(content);

    return {
      ok: true,
      content: truncated.content,
      truncated: truncated.truncated,
      original_length: truncated.original_length,
      path_expr,
      max_depth
    };
  }

  // ==========================================================================
  // bigfile_json_keys — JSON 键名探索（流式解析版）
  // ==========================================================================

  async jsonKeys(ctx, args) {
    const { path: relPath, path_expr } = args;

    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] jsonKeys 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "json_parse_error", message: e.message };
    }

    // Parse path expression to segments
    const targetSegments = path_expr === "" || path_expr === "." ? [] : path_expr.split(".");

    let navResult;
    try {
      navResult = await this._streamJsonNavigate(absPath, targetSegments, "keys");
    } catch (e) {
      this.log.error("[Bigfile] jsonKeys 流式解析失败", {
        path: relPath, path_expr,
        error: e.message, stack: e.stack
      });
      return { error: "json_parse_error", message: e.message };
    }

    if (!navResult.found) {
      if (navResult.error && navResult.error !== "path not found") {
        return { error: "json_parse_error", message: navResult.error };
      }
      return {
        error: "path_not_found",
        message: `JSON路径 ${path_expr || "(root)"} 不存在`
      };
    }

    // Format result based on valueType
    if (navResult.valueType === "object") {
      return {
        ok: true,
        type: "object",
        keys: navResult.keys,
        count: navResult.count,
        truncated: navResult.truncated || false
      };
    }

    if (navResult.valueType === "array") {
      return {
        ok: true,
        type: "array",
        count: navResult.count,
        indices: navResult.indices,
        itemTypes: navResult.itemTypes
      };
    }

    // primitive
    return {
      ok: true,
      type: "primitive",
      valueType: navResult.valueType,
      sample: navResult.valueType === "null" ? null : (navResult.valueType === "string" ? navResult.sample : navResult.sample)
    };
  }

  // ==========================================================================
  // bigfile_jsonl_filter — JSONL 记录过滤
  // ==========================================================================

  async jsonlFilter(ctx, args) {
    const {
      path: relPath,
      field,
      pattern,
      is_regex = false,
      max_results = 50,
      max_chars_per_record = 2000
    } = args;

    // 验证正则
    if (is_regex) {
      try {
        new RegExp(pattern);
      } catch {
        return { error: "invalid_regex", message: `无效的正则表达式: ${pattern}` };
      }
    }

    let absPath;
    try {
      absPath = await this._resolveAbsolutePath(ctx, relPath);
    } catch (e) {
      this.log.error("[Bigfile] jsonlFilter 解析路径失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    let total_size;
    try {
      total_size = (await fs.promises.stat(absPath)).size;
    } catch (e) {
      this.log.error("[Bigfile] jsonlFilter stat 失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    const records = [];
    let linesProcessed = 0;
    let accumulatedBytes = 0;
    let byteLimitTruncated = false;

    try {
      for await (const chunk of this._walkLines(absPath, total_size)) {
        if (chunk.done) break;

        for (const line of chunk.lines) {
          if (!line.trim()) continue;
          if (records.length >= max_results) break;
          if (byteLimitTruncated) break;

          linesProcessed++;

          let obj;
          try {
            obj = JSON.parse(line.trimEnd());
          } catch {
            continue;
          }

          if (matchField(obj, field, pattern, is_regex)) {
            const recordStr = JSON.stringify(obj);
            const display = recordStr.length > max_chars_per_record
              ? recordStr.slice(0, max_chars_per_record)
              : recordStr;

            const recordBytes = byteLength(display);
            if (accumulatedBytes + recordBytes > MAX_OUTPUT_BYTES) {
              byteLimitTruncated = true;
              break;
            }
            accumulatedBytes += recordBytes;
            records.push(display);
          }
        }

        if (records.length >= max_results || byteLimitTruncated) break;
      }
    } catch (e) {
      this.log.error("[Bigfile] jsonlFilter 遍历失败", {
        path: relPath, error: e.message, stack: e.stack
      });
      return { error: "read_error", message: e.message };
    }

    return {
      ok: true,
      records,
      count: records.length,
      truncated: byteLimitTruncated,
      max_chars_per_record,
      lines_processed: linesProcessed
    };
  }
}
