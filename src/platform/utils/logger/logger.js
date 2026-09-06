import { mkdir, appendFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { getErrorMessage } from "../error_utils.js";

// 日志轮转配置
const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_BACKUP_FILES = 10;

// 原始 stderr write 函数（用于 stderr 重定向）
let originalStderrWrite = null;
let stderrLogFilePath = null;
let stderrBuffer = "";
let stderrFlushTimeout = null;
// 标志位：防止 Logger 写入 system.log 时触发循环
let isWritingToSystemLog = false;

/**
 * 格式化日期为本地时间字符串（ISO 格式但使用本地时区）
 * @param {Date} [date] - 日期对象，默认为当前时间
 * @returns {string} 格式化后的时间字符串，如 "2026-01-12T15:30:45.123"
 */
export function formatLocalTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * @typedef {"trace"|"debug"|"info"|"warn"|"error"} LogLevel
 */

/**
 * @typedef {"llm_call_start"|"llm_call_success"|"llm_call_error"} LlmEventType
 */

/**
 * @typedef {Object} StructuredLogEntry
 * @property {string} timestamp - ISO时间戳
 * @property {LogLevel} level - 日志级别
 * @property {string} module - 模块名
 * @property {string} message - 日志消息
 * @property {LlmEventType} [eventType] - 事件类型
 * @property {any} [data] - 附加数据
 */

const LEVEL_VALUE = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

/**
 * 统一日志器：支持按模块设置日志等级，并同时输出到控制台与文件。
 */
export class Logger {
  /**
   * @param {{enabled:boolean, logsDir:string|null, defaultLevel:LogLevel, levels:Record<string, LogLevel>, consoleOutput?:boolean}} options
   */
  constructor(options) {
    this.enabled = Boolean(options.enabled);
    this.logsDir = options.logsDir ? String(options.logsDir) : null;
    this.defaultLevel = options.defaultLevel;
    this.levels = options.levels ?? {};
    this.consoleOutput = options.consoleOutput !== false; // 默认启用控制台输出
    this._runDir = null;
    this._systemFilePath = null;
    this._readyPromise = null;
    this._ready = false;
  }

  /**
   * 创建一个绑定模块名的子日志器。
   * @param {string} moduleName
   * @returns {ModuleLogger}
   */
  forModule(moduleName) {
    return new ModuleLogger(this, moduleName);
  }

  /**
   * 准备日志文件（若启用文件输出）。
   * @returns {Promise<void>}
   */
  async ensureReady() {
    if (!this.enabled) return;
    if (this._ready) return;
    if (this._readyPromise) return await this._readyPromise;
    if (!this.logsDir) {
      this._ready = true;
      return;
    }
    this._readyPromise = (async () => {
      await mkdir(this.logsDir, { recursive: true });
      const runDirName = _buildRunDirName();
      const runDir = path.resolve(this.logsDir, runDirName);
      await mkdir(runDir, { recursive: true });
      this._runDir = runDir;
      this._systemFilePath = path.resolve(runDir, "system.log");
      
      // 设置 stderr 日志文件路径并启用 stderr 重定向
      const stderrPath = path.resolve(runDir, "stderr.log");
      _setupStderrRedirect(stderrPath, this);
      
      this._ready = true;
      this._readyPromise = null;
    })();
    return await this._readyPromise;
  }

  /**
   * 输出一条日志（内部使用）。
   * @param {string} moduleName
   * @param {LogLevel} level
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  async write(moduleName, level, message, data) {
    if (!this.enabled) return;
    const effective = this.levels[moduleName] ?? this.defaultLevel;
    if (LEVEL_VALUE[level] < LEVEL_VALUE[effective]) return;

    const line = _formatLine(moduleName, level, message, data);
    if (this.consoleOutput) {
      _writeToConsole(level, line);
    }
    try {
      await this.ensureReady();
      if (this._systemFilePath) {
        await _rotateIfNeeded(this._systemFilePath);
        await appendFile(this._systemFilePath, line + "\n", "utf8");
      }
      const agentId = _extractAgentId(data);
      if (agentId && this._runDir) {
        const agentFile = path.resolve(this._runDir, `agent-${_sanitizeFileSegment(agentId)}.log`);
        await _rotateIfNeeded(agentFile);
        await appendFile(agentFile, line + "\n", "utf8");
      }
    } catch (err) {
      const text = getErrorMessage(err);
      // 使用原始 stderr 写入，避免触发重定向循环
      const originalWrite = originalStderrWrite || process.stderr.write.bind(process.stderr);
      originalWrite(
        _formatLine("logger", "error", "日志写入失败（已忽略，不影响主流程）", { message: text }) + "\n"
      );
    }
  }

  /**
   * 输出结构化日志条目。
   * @param {StructuredLogEntry} entry
   * @returns {Promise<void>}
   */
  async writeStructured(entry) {
    const moduleName = entry.module ?? "unknown";
    const level = entry.level ?? "info";
    const message = entry.message ?? "";
    const data = {
      ...entry.data,
      eventType: entry.eventType
    };
    return this.write(moduleName, level, message, data);
  }

  /**
   * 刷新所有日志缓冲区到磁盘。
   * 在关闭流程中调用，确保不丢失最后的 stderr 输出。
   * @returns {Promise<void>}
   */
  async flush() {
    // 立即刷新 stderr 缓冲区（跳过 50ms 防抖）
    await _flushStderrBuffer(true);
  }
}

/**
 * 模块日志器：把 moduleName 固化，简化调用方使用。
 */
export class ModuleLogger {
  /**
   * @param {Logger} root
   * @param {string} moduleName
   */
  constructor(root, moduleName) {
    this.root = root;
    this.moduleName = moduleName;
  }

  /**
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  trace(message, data) {
    return this.root.write(this.moduleName, "trace", message, data);
  }

  /**
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  debug(message, data) {
    return this.root.write(this.moduleName, "debug", message, data);
  }

  /**
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  info(message, data) {
    return this.root.write(this.moduleName, "info", message, data);
  }

  /**
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  warn(message, data) {
    return this.root.write(this.moduleName, "warn", message, data);
  }

  /**
   * @param {string} message
   * @param {any} [data]
   * @returns {Promise<void>}
   */
  error(message, data) {
    return this.root.write(this.moduleName, "error", message, data);
  }

  /**
   * 刷新所有日志缓冲区到磁盘。
   * @returns {Promise<void>}
   */
  async flush() {
    return this.root.flush();
  }
}

/**
 * 创建一个默认的 Logger 配置（当配置缺失或无效时使用）。
 * @param {any} cfg
 * @returns {{enabled:boolean, logsDir:string|null, defaultLevel:LogLevel, levels:Record<string, LogLevel>, consoleOutput:boolean}}
 */
export function normalizeLoggingConfig(cfg) {
  const enabled = cfg ? Boolean(cfg.enabled ?? true) : false;
  const logsDir = cfg && typeof cfg.logsDir === "string" ? cfg.logsDir : null;
  const defaultLevel = _normalizeLevel(cfg?.defaultLevel) ?? "info";
  const consoleOutput = cfg?.consoleOutput !== false; // 默认启用控制台输出
  /** @type {Record<string, LogLevel>} */
  const levels = {};
  if (cfg && cfg.levels && typeof cfg.levels === "object") {
    for (const [k, v] of Object.entries(cfg.levels)) {
      const lv = _normalizeLevel(v);
      if (lv) levels[String(k)] = lv;
    }
  }
  return { enabled, logsDir, defaultLevel, levels, consoleOutput };
}

/**
 * @param {any} value
 * @returns {LogLevel|null}
 */
function _normalizeLevel(value) {
  const lv = String(value ?? "").toLowerCase();
  if (lv === "trace") return "trace";
  if (lv === "debug") return "debug";
  if (lv === "info") return "info";
  if (lv === "warn") return "warn";
  if (lv === "error") return "error";
  return null;
}

/**
 * @returns {string}
 */
function _buildRunDirName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function _extractAgentId(data) {
  if (!data || typeof data !== "object") return null;
  const direct = typeof data.agentId === "string" ? data.agentId : null;
  if (direct) return direct;
  const meta = data.meta && typeof data.meta === "object" ? data.meta : null;
  if (meta && typeof meta.agentId === "string") return meta.agentId;
  return null;
}

function _sanitizeFileSegment(value) {
  const s = String(value ?? "").trim();
  if (!s) return "unknown";
  const replaced = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return replaced.length > 120 ? replaced.slice(0, 120) : replaced;
}

/**
 * @param {string} moduleName
 * @param {LogLevel} level
 * @param {string} message
 * @param {any} [data]
 * @returns {string}
 */
function _formatLine(moduleName, level, message, data) {
  const ts = _formatTimestamp(new Date());
  const head = `${ts} [${level.toUpperCase()}] [${moduleName}]`;
  if (data === undefined) return `${head} ${message}`;

  const tail = _formatData(data);
  if (tail.includes("\n")) return `${head} ${message}\n${tail}`;
  return `${head} ${message} ${tail}`;
}

/**
 * @param {Date} date
 * @returns {string}
 */
function _formatTimestamp(date) {
  // 使用本地时间格式：YYYY-MM-DD HH:mm:ss.SSS
  return formatLocalTime(date).replace('T', ' ');
}

/**
 * @param {any} data
 * @returns {string}
 */
function _formatData(data) {
  if (data instanceof Error) {
    return data.stack || `${data.name}: ${data.message}`;
  }
  if (typeof data === "string") return data;
  if (typeof data === "number") return String(data);
  if (typeof data === "boolean") return String(data);
  if (typeof data === "bigint") return data.toString();
  if (data === null) return "null";
  if (data === undefined) return "undefined";

  const seen = new WeakSet();
  // Error 属性中字符串的最大保留长度：超长时截断并标注总长，防止单条日志被撑爆
  const MAX_ERROR_STRING_LENGTH = 8000;
  const replacer = (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      // 完整保留 Error 的可枚举自有属性（如 AI SDK APICallError 的 responseBody/statusCode/url/cause），
      // 否则像 "Invalid JSON response" 这类错误只剩 name/message/stack，丢失排查所需的原始响应体。
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const props = {};
      for (const [k, v] of Object.entries(value)) {
        // requestBodyValues 携带完整请求体（可达数十 KB），请求内容由调用方按需单独记录
        if (k === "requestBodyValues") continue;
        props[k] = typeof v === "string" && v.length > MAX_ERROR_STRING_LENGTH
          ? `${v.slice(0, MAX_ERROR_STRING_LENGTH)}…[已截断，共 ${v.length} 字符]`
          : v;
      }
      return { ...props, name: value.name, message: value.message, stack: value.stack };
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };

  try {
    return JSON.stringify(data, replacer, 2);
  } catch {
    return inspect(data, { depth: 6, colors: false, breakLength: 120, maxArrayLength: 200 });
  }
}

/**
 * @param {LogLevel} level
 * @param {string} line
 * @returns {void}
 */
function _writeToConsole(level, line) {
  if (level === "warn" || level === "error") {
    // 使用原始 stderr 写入，避免被 _setupStderrRedirect 劫持导致日志重复
    const write = originalStderrWrite || process.stderr.write.bind(process.stderr);
    write(line + "\n");
    return;
  }
  process.stdout.write(line + "\n");
}

/**
 * 若日志文件超过大小限制则执行轮转。
 * 从旧到新依次移位：file.9 → file.10, ..., file → file.1
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function _rotateIfNeeded(filePath) {
  let st;
  try {
    st = await stat(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  if (st.size <= MAX_LOG_BYTES) return;

  // 从旧到新依次移位：file.9 → file.10, ..., file.1 → file.2, file → file.1
  for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
    try {
      await rename(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  await rename(filePath, `${filePath}.1`);
}

/**
 * 设置 stderr 重定向到日志文件。
 * 将原本直接输出到 stderr 的内容同时写入到指定的日志文件。
 * 
 * @param {string} logFilePath - stderr 日志文件路径
 * @param {Logger} logger - Logger 实例（用于写入 system.log）
 * @returns {void}
 */
function _setupStderrRedirect(logFilePath, logger) {
  if (originalStderrWrite) {
    // 已经设置过了，只更新文件路径
    stderrLogFilePath = logFilePath;
    return;
  }

  stderrLogFilePath = logFilePath;
  originalStderrWrite = process.stderr.write.bind(process.stderr);

  // 重写 process.stderr.write
  process.stderr.write = function(chunk, encoding, callback) {
    // 如果正在由 Logger 写入 system.log 触发的 stderr 输出，只输出到控制台，不重复记录
    if (isWritingToSystemLog) {
      return originalStderrWrite(chunk, encoding, callback);
    }

    const data = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
    
    // 1. 写入原始 stderr（控制台）
    const result = originalStderrWrite(chunk, encoding, callback);
    
    // 2. 写入 stderr.log 文件
    if (stderrLogFilePath) {
      stderrBuffer += data;
      _flushStderrBuffer();
    }
    
    // 3. 同时写入 system.log（通过 Logger）
    if (logger && !data.includes("[logger]") && !data.includes("日志写入失败")) {
      isWritingToSystemLog = true;
      // 异步写入 system.log，不阻塞
      logger.write("stderr", "error", "[STDERR] " + data.replace(/\n$/, "")).finally(() => {
        isWritingToSystemLog = false;
      }).catch(() => {
        // 忽略写入失败
      });
    }
    
    return result;
  };
}

/**
 * 刷新 stderr 缓冲区到文件。
 * @param {boolean} [immediate=false] - 是否立即写入（跳过防抖）
 * @returns {Promise<void>}
 * @private
 */
async function _flushStderrBuffer(immediate = false) {
  if (!stderrBuffer || !stderrLogFilePath) return;

  // 取消之前的防抖定时器
  if (stderrFlushTimeout) {
    clearTimeout(stderrFlushTimeout);
  }

  const doWrite = async () => {
    if (!stderrBuffer) return;

    const content = stderrBuffer;
    stderrBuffer = "";

    try {
      await _rotateIfNeeded(stderrLogFilePath);
      await appendFile(stderrLogFilePath, content, "utf8");
    } catch {
      // 忽略写入失败，防止递归错误
    }
  };

  if (immediate) {
    await doWrite();
  } else {
    stderrFlushTimeout = setTimeout(doWrite, 50); // 50ms 防抖
  }
}
