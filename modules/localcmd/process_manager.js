/**
 * 本地进程管理器
 * 负责管理子进程的生命周期，所有输出写入文件，支持通过 seek 读取不同位置。
 * 确保主进程退出时所有子进程都被终止并清理文件。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";

// 日志文件名解析: <YYYY-MM-DD-HHMMSS>-<UUID>.log
const LOG_FILENAME_RE = /^(\d{4}-\d{2}-\d{2}-\d{6})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.log$/i;
// processId 格式校验(防路径注入)
const PROCESS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 历史文件头部/尾部解析窗口
const HEAD_READ_SIZE = 64 * 1024;
const TAIL_READ_SIZE = 4096;

/**
 * 返回缓冲区尾部不完整 UTF-8 多字节序列的起始下标，无则返回 -1。
 *
 * UTF-8 一个序列最多 4 字节（1 个头字节 + 最多 3 个续字节），因此允许携带的残尾
 * 最多 3 字节；残尾超过 3 字节说明字节流本身非法，返回 -1 交给解码器产出 U+FFFD
 * 或触发回退，避免无界缓冲。
 *
 * @param {Buffer} buf
 * @returns {number} 残尾起始下标；-1 表示无残尾
 */
function _incompleteUtf8Index(buf) {
  const n = buf.length;
  if (n === 0) return -1;
  const last = buf[n - 1];
  if ((last & 0x80) === 0) return -1;        // ASCII 尾，序列完整
  if ((last & 0xe0) === 0xc0) return n - 1;  // 2 字节序列头在尾部
  if ((last & 0xf0) === 0xe0) return n - 1;  // 3 字节序列头在尾部
  if ((last & 0xf8) === 0xf0) return n - 1;  // 4 字节序列头在尾部
  if ((last & 0xc0) === 0x80) {
    // 尾部是续字节：向前统计连续续字节个数 c
    let c = 1;
    let i = n - 2;
    while (i >= 0 && (buf[i] & 0xc0) === 0x80) { c++; i--; }
    if (c > 3) return -1;                    // 残尾不可能超过 3 个续字节
    if (i < 0) return 0;                     // 整个缓冲都是续字节 → 整体作为残尾携带
    const head = buf[i];
    let need;
    if ((head & 0xe0) === 0xc0) need = 2;
    else if ((head & 0xf0) === 0xe0) need = 3;
    else if ((head & 0xf8) === 0xf0) need = 4;
    else return -1;                          // 非法的头字节
    if (c < need - 1) return i;              // 序列不完整 → 从头字节开始携带
    if (c > need - 1) return n - (c - (need - 1)); // 序列已完整，多出的续字节是新的残尾
    return -1;                               // 序列恰好完整
  }
  return -1;                                 // 其他非法字节（0xF8-0xFF）
}

/**
 * 子进程输出自适应流式解码器。
 *
 * 背景：cmd 等系统命令在中文 Windows 下输出 GBK 字节，现代程序（Node、Python 3 等）
 * 输出 UTF-8。解码策略按内容自动判定，候选列表固定为 UTF-8 → GBK，**不依赖本地机器
 * 设置**（不读取 chcp 代码页），保证任何操作系统、任何代码页环境下行为一致：
 * - 合法 UTF-8 → 按 UTF-8 解码；
 * - 非法 UTF-8 → 按 GBK 解码（GBK 几乎能解码任意字节序列，作为最终回退）。
 *
 * 同时处理两个方向的跨 chunk 边界问题（UTF-8 残尾携带、GBK 前导字节携带），
 * 保证磁盘日志始终是完整 UTF-8。
 *
 * 与原 _decodeBuffer 的差异：
 * 1. UTF-8 合法性用 TextDecoder(fatal) 精确判定，程序合法输出的 U+FFFD 字符不会误触发回退；
 * 2. GBK 双字节字符被切块时前导字节跨 chunk 携带（原实现此处会产生乱码）；
 * 3. 回退目标固定为 GBK，而非本地 chcp 检测的编码（原实现在 UTF-8 代码页或非 Windows
 *    系统上无回退能力，GBK 输出会乱码）。
 *
 * 已知限制：GBK 字节恰好构成合法 UTF-8 序列时无法区分，按 UTF-8 解码。
 */
export class AdaptiveStreamDecoder {
  /**
   * @param {any} log 日志器（iconv 解码失败时记录）
   */
  constructor(log) {
    this._log = log;
    this._utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    /** UTF-8 残尾：跨 chunk 的不完整序列字节 */
    this._carry = null;
    /** GBK 残尾：跨 chunk 的双字节编码前导字节 */
    this._gbkLead = null;
  }

  /**
   * 解码一个 chunk。TextDecoder 的抛错是编码检测的控制流信号（非法 UTF-8 即回退 GBK），
   * 不是需要记录的异常。
   * @param {Buffer|Uint8Array} chunk
   * @returns {string}
   */
  write(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length === 0) return "";
    let buf = this._carry ? Buffer.concat([this._carry, data]) : data;
    this._carry = null;

    const idx = _incompleteUtf8Index(buf);
    const testable = idx === -1 ? buf : buf.subarray(0, idx);
    try {
      const text = this._utf8Decoder.decode(testable);
      if (idx !== -1) this._carry = buf.subarray(idx);
      return text;
    } catch {
      // 非法 UTF-8 → 按 GBK 解码（含残尾）
      return this._decodeGbk(buf);
    }
  }

  /**
   * 流结束：冲刷残尾。UTF-8 残尾（流被截断）按 U+FFFD 输出；GBK 前导字节交给 iconv。
   * @returns {string}
   */
  end() {
    let out = "";
    if (this._carry) {
      out += this._carry.toString("utf8");
      this._carry = null;
    }
    if (this._gbkLead) {
      out += iconv.decode(this._gbkLead, "gbk");
      this._gbkLead = null;
    }
    return out;
  }

  /**
   * 整块按 GBK 解码。GBK 为双字节编码：缓冲长度为奇数且尾字节在前导字节
   * 范围（0x81-0xFE）时，该字节大概率是下一个字符的前导，携带到下一块。
   * @param {Buffer} data
   * @returns {string}
   * @private
   */
  _decodeGbk(data) {
    let buf = this._gbkLead ? Buffer.concat([this._gbkLead, data]) : data;
    this._gbkLead = null;
    if (buf.length > 0) {
      const last = buf[buf.length - 1];
      if (buf.length % 2 === 1 && last >= 0x81 && last <= 0xfe) {
        this._gbkLead = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
    }
    try {
      return iconv.decode(buf, "gbk");
    } catch (err) {
      // iconv-lite 不支持该编码时不会到这里（gbk 固定支持），保留日志兜底
      this._log.error("[ProcessManager] GBK 解码失败，退回 UTF-8", {
        error: err?.message ?? String(err),
        stack: err?.stack,
        byteLength: buf.length
      });
      return buf.toString("utf8");
    }
  }
}

/**
 * @typedef {object} ManagedProcess
 * @property {string} id - 进程实例唯一 ID
 * @property {string} [agentId] - 所属智能体ID
 * @property {import('node:child_process').ChildProcess} process - 子进程对象
 * @property {string} command - 执行的命令
 * @property {string[]} args - 命令参数
 * @property {string} outputFile - 输出文件路径
 * @property {fs.WriteStream} writeStream - 文件写入流
 * @property {string} createdAt - 创建时间 ISO 字符串
 * @property {string} status - 状态: 'running' | 'completed' | 'error' | 'killed'
 * @property {number|null} exitCode - 退出码
 * @property {string|null} startupError - 启动失败时的错误信息，正常启动为 null
 * @property {boolean} pushEvents - 是否向所属智能体推送进程事件（默认 true）
 * @property {Function} write - 向进程 stdin 写入数据的方法
 * @property {Function} kill - 终止进程的方法
 */

export class ProcessManager {
  /**
   * @param {{log: any, runtime: any, dataDir: string}} options
   */
  constructor(options) {
    this.log = options.log;
    this.runtime = options.runtime;
    this.dataDir = options.dataDir;
    this.outputDir = path.join(this.dataDir, "localcmd");
    this.defaultWindowSize = 5000; // 默认读取窗口 5000 字符

    /** @type {Map<string, ManagedProcess>} */
    this._processes = new Map();

    /** @type {Set<Function>} 进程事件监听器（日志/启动/退出事件订阅） */
    this._processListeners = new Set();

    /** @type {Map<string, object>} 历史索引缓存: processId -> entry */
    this._historyCache = new Map();

    // 确保基础输出目录存在
    this._ensureOutputDir();

    // 监听主进程退出信号
    this._setupProcessCleanup();
  }

  /**
   * 订阅进程事件（'log' | 'started' | 'exit'）。
   * 事件对象: { processId, agentId, pushEvents, type, text?, pid?, status?, exitCode?, signal?, error?, command?, args?, ts }
   * @param {(evt: object) => void} listener - 事件监听器
   * @returns {() => void} 取消订阅函数
   */
  onProcessEvent(listener) {
    if (typeof listener === "function") {
      this._processListeners.add(listener);
    }
    return () => {
      this._processListeners.delete(listener);
    };
  }

  /**
   * 向所有监听器派发进程事件（逐个捕获异常，不阻断其他监听器）。
   * @param {object} evt - 事件对象
   * @private
   */
  _emitProcessEvent(evt) {
    for (const listener of this._processListeners) {
      try {
        listener(evt);
      } catch (err) {
        this.log.error("[ProcessManager] 进程事件监听器执行失败", {
          processId: evt?.processId ?? null,
          type: evt?.type ?? null,
          error: err?.message ?? String(err),
          stack: err?.stack,
          name: err?.name
        });
      }
    }
  }

  /**
   * 确保输出目录存在
   * @param {string} [agentId] - 智能体 ID，按 agent 分子目录
   * @private
   */
  async _ensureOutputDir(agentId) {
    const dir = agentId ? path.join(this.outputDir, agentId) : this.outputDir;
    try {
      await fsp.mkdir(dir, { recursive: true });
      this.log.debug("[ProcessManager] 输出目录已创建", { dir });
    } catch (error) {
      this.log.error("[ProcessManager] 创建输出目录失败", { error: error.message });
    }
  }

  /**
   * 设置进程清理监听器
   * @private
   */
  _setupProcessCleanup() {
    const cleanup = async (signal = "UNKNOWN") => {
      const details = { signal, count: this._processes.size };
      this.log.info("[ProcessManager] 主进程退出，正在终止所有子进程...", details);
      try {
        const logDir = path.join(this.dataDir, "logs");
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        const logPath = path.join(logDir, "exit-cause.log");
        const line = JSON.stringify({
          time: new Date().toISOString(),
          event: "PROCESS_MANAGER_CLEANUP",
          pid: process.pid,
          ppid: process.ppid,
          details
        });
        fs.appendFileSync(logPath, line + "\n");
      } catch {}
      await this.killAll();
      process.exit(0);
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGHUP", () => cleanup("SIGHUP"));
    if (process.platform === "win32") {
      process.on("SIGBREAK", () => cleanup("SIGBREAK"));
    }
    process.on("beforeExit", async () => {
      if (this._processes.size > 0) {
        await this.killAll();
      }
    });
    process.on("uncaughtException", async (err) => {
      this.log.error("[ProcessManager] 未捕获的异常", { error: err?.message });
      await this.killAll();
      process.exit(1);
    });
  }

  /**
   * 生成输出文件路径（按 agentId 分子目录）
   * @param {string} processId - 进程 ID
   * @param {string} [agentId] - 智能体 ID
   * @returns {string} 输出文件路径
   * @private
   */
  _generateOutputFilePath(processId, agentId) {
    const timestamp = new Date().toISOString()
      .replace(/:/g, "")
      .replace(/\..+/, "")
      .replace("T", "-");
    const agentDir = agentId ? path.join(this.outputDir, agentId) : this.outputDir;
    return path.join(agentDir, `${timestamp}-${processId}.log`);
  }

  /**
   * 获取当前操作系统信息
   * @returns {{platform: string, shell: string, shellType: string}}
   */
  getSystemInfo() {
    const platform = process.platform;
    let shell = "";
    let shellType = "";

    if (platform === "win32") {
      if (process.env.PSModulePath || process.env.PSExecutionPolicyPreference) {
        shell = "powershell.exe";
        shellType = "powershell";
      } else {
        shell = process.env.COMSPEC || "cmd.exe";
        shellType = "cmd";
      }
    } else if (platform === "darwin") {
      shell = process.env.SHELL || "/bin/zsh";
      shellType = shell.includes("zsh") ? "zsh" : (shell.includes("bash") ? "bash" : "unix");
    } else {
      shell = process.env.SHELL || "/bin/bash";
      shellType = shell.includes("bash") ? "bash" : (shell.includes("zsh") ? "zsh" : "unix");
    }

    return { platform, shell, shellType };
  }

  /**
   * 生成系统环境提示词
   * @returns {string}
   */
  getSystemPromptSection() {
    const { platform, shell, shellType } = this.getSystemInfo();
    
    const platformName = {
      "win32": "Windows",
      "darwin": "macOS", 
      "linux": "Linux"
    }[platform] || platform;

    const shellGuide = {
      "powershell": "PowerShell (支持现代命令如 Get-ChildItem, Write-Host)",
      "cmd": "CMD (传统命令如 dir, echo)",
      "bash": "Bash (支持管道、重定向、脚本)",
      "zsh": "Zsh (类似 Bash，macOS 默认)",
      "unix": "Unix Shell"
    }[shellType] || shell;

    return `【本地命令执行环境】
操作系统: ${platformName}
默认 Shell: ${shellGuide}
进程管理: 支持长期运行进程，所有输出写入文件，通过 seek 读取不同位置

【输出文件说明】
- 每个进程有独立的输出日志文件
- 使用 localcmd_read_output 通过 offset 参数读取指定位置
- 文件在进程结束或主进程退出时自动清理

【读取方法】
1. 首次读取: offset=0，读取文件开头
2. 持续监控: 使用上次返回的 nextOffset 继续读取新内容
3. 查看末尾: 使用 stat 获取文件大小，从末尾读取

【重要提示】
- 向进程发送输入时，通常需要在末尾添加换行符(\\n)才能触发程序处理
- 进程不会自动超时，必须调用 localcmd_kill 终止
- 主进程退出时所有子进程和输出文件会自动清理

【平台注意事项】
- Windows: 路径使用反斜杠(\\)或双反斜杠，PowerShell 命令使用 -Flag 格式
- macOS/Linux: 路径使用正斜杠(/)，支持标准 Unix 命令`;
  }

  /**
   * 启动一个新进程
   * @param {string} command - 要执行的命令
   * @param {string[]} args - 命令参数
   * @param {{cwd?: string, env?: object, agentId?: string, pushEvents?: boolean}} options
   * @returns {Promise<{ok: boolean, processId?: string, error?: string}>}
   */
  async spawn(command, args = [], options = {}) {
    const processId = randomUUID();
    const { cwd, env, agentId, pushEvents = true } = options;
    const outputFile = this._generateOutputFilePath(processId, agentId);

    this.log.info("[ProcessManager] 启动进程", { processId, command, args, cwd, outputFile, agentId });

    try {
      // 确保智能体子目录存在
      await this._ensureOutputDir(agentId);

      // 启动子进程
      const childProcess = spawn(command, args, {
        env: { ...process.env, ...env },
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"] // stdin, stdout, stderr 都使用管道
      });

      // 创建输出文件写入流（追加模式）
      const writeStream = fs.createWriteStream(outputFile, {
        flags: "a",
        encoding: "utf8"
      });

      // 添加文件头标记
      writeStream.write(`[PROCESS_START] ${command} ${args.join(" ")}\n`);
      writeStream.write(`[START_TIME] ${new Date().toISOString()}\n`);
      if (agentId) {
        writeStream.write(`[AGENT_ID] ${agentId}\n`);
      }
      writeStream.write("-".repeat(50) + "\n");

      // 自适应流式解码器：按内容自动判定 UTF-8/GBK（不依赖本地代码页设置），
      // 同时处理跨 chunk 的多字节字符边界
      const stdoutDecoder = new AdaptiveStreamDecoder(this.log);
      const stderrDecoder = new AdaptiveStreamDecoder(this.log);

      const managedProcess = {
        id: processId,
        agentId,
        process: childProcess,
        command,
        args,
        outputFile,
        writeStream,
        createdAt: new Date().toISOString(),
        status: "running",
        exitCode: null,
        startupError: null,
        pushEvents,
        write: (data) => {
          if (childProcess.stdin && !childProcess.stdin.destroyed) {
            childProcess.stdin.write(data);
            return { ok: true };
          }
          return { ok: false, error: "stdin_closed" };
        },
        kill: (signal = "SIGTERM") => {
          return this._killProcess(processId, signal);
        }
      };

      this._processes.set(processId, managedProcess);

      // 安全写入函数：检查流是否可写
      const safeWrite = (data) => {
        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.write(data);
        }
      };

      // 处理 stdout（自适应解码：跨 chunk 边界 + GBK 回退）
      childProcess.stdout?.on("data", (data) => {
        const decoded = stdoutDecoder.write(data);
        const text = `[STDOUT] ${decoded}`;
        safeWrite(text);
        this._emitProcessEvent({ processId, agentId, pushEvents, type: "log", text, ts: Date.now() });
      });

      // 处理 stderr（自适应解码：跨 chunk 边界 + GBK 回退）
      childProcess.stderr?.on("data", (data) => {
        const decoded = stderrDecoder.write(data);
        const text = `[STDERR] ${decoded}`;
        safeWrite(text);
        this._emitProcessEvent({ processId, agentId, pushEvents, type: "log", text, ts: Date.now() });
      });

      // 进程结束
      childProcess.on("close", (code, signal) => {
        // 如果启动已失败，清理已在 catch 块中处理，跳过
        if (managedProcess.startupError) {
          return;
        }
        // 如果进程是被主动 kill 的（_killProcess 已置 status="killed"），保持 killed，
        // 否则 close 时按退出码覆盖会导致 killed 被误标为 error
        if (managedProcess.status !== "killed") {
          managedProcess.status = code === 0 ? "completed" : "error";
        }
        managedProcess.exitCode = code;

        // 冲刷解码器中跨 chunk 残留的字节（UTF-8 残尾 / GBK 前导字节）
        const outRemaining = stdoutDecoder.end();
        if (outRemaining) {
          safeWrite(`[STDOUT] ${outRemaining}`);
        }
        const errRemaining = stderrDecoder.end();
        if (errRemaining) {
          safeWrite(`[STDERR] ${errRemaining}`);
        }

        safeWrite("-".repeat(50) + "\n");
        safeWrite(`[PROCESS_END] exitCode=${code}, signal=${signal}\n`);
        safeWrite(`[END_TIME] ${new Date().toISOString()}\n`);

        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.end();
        }

        // 延迟 30 分钟后从 Map 中移除，给调用方足够的时间读取输出
        const cleanupTimer = setTimeout(async () => {
          this._processes.delete(processId);
          // 从生命周期注册表注销
          if (managedProcess.agentId) {
            try {
              await this.runtime.lifecycleRegistry.unregister(`subprocess:${processId}`);
            } catch (e) {
              this.log.debug("[ProcessManager] 子进程生命周期注销，正常", { processId });
            }
          }
          this.log.info("[ProcessManager] 进程条目已清理", { processId, code });
        }, 1800000);
        if (cleanupTimer && typeof cleanupTimer.unref === "function") {
          cleanupTimer.unref();
        }

        this.log.info("[ProcessManager] 进程结束", { processId, code, signal });
        this._emitProcessEvent({
          processId,
          agentId,
          pushEvents,
          type: "exit",
          status: managedProcess.status,
          exitCode: code,
          signal,
          ts: Date.now()
        });
      });

      childProcess.on("error", (err) => {
        managedProcess.status = "error";
        managedProcess.startupError = err.message;
        safeWrite(`[PROCESS_ERROR] ${err.message}\n`);

        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.end();
        }

        this.log.error("[ProcessManager] 进程错误", { processId, error: err?.message });
        // 启动失败的终端事件（close 事件在 startupError 早退分支被跳过，此处是唯一 exit 事件源）
        this._emitProcessEvent({
          processId,
          agentId,
          pushEvents,
          type: "exit",
          status: "error",
          exitCode: null,
          signal: null,
          error: err.message,
          ts: Date.now()
        });
      });

      // 非阻塞 spawn 事件监听（仅日志）
      childProcess.once("spawn", () => {
        this.log.info("[ProcessManager] 进程启动成功", { processId, pid: childProcess.pid, outputFile });
        this._emitProcessEvent({
          processId,
          agentId,
          pushEvents,
          type: "started",
          pid: childProcess.pid ?? null,
          command,
          args,
          ts: Date.now()
        });
      });

      // 注册到生命周期注册表
      if (agentId) {
        const resourceId = `subprocess:${processId}`;
        try {
          this.runtime.lifecycleRegistry.register({
            id: resourceId,
            type: 'subprocess',
            ownerAgentId: agentId,
            cleanup: () => {
              managedProcess.status = "killed";
              childProcess.kill("SIGKILL");
            }
          });
        } catch (e) {
          this.log.warn("[ProcessManager] 子进程生命周期注册失败", { processId, agentId, error: e?.message });
        }
      }

      return {
        ok: true,
        processId,
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      this.log.error("[ProcessManager] 启动进程失败", { processId, command, error: message });

      // 如果进程条目已注册到 Map，标记启动失败并清理
      const mp = this._processes.get(processId);
      if (mp) {
        mp.startupError = message;
        // 关闭写入流
        if (mp.writeStream && mp.writeStream.writable && !mp.writeStream.destroyed) {
          mp.writeStream.end();
        }
        // 尝试终止子进程
        try {
          mp.process?.kill?.("SIGKILL");
        } catch {
          // 忽略 kill 错误
        }
        // 延迟 30 分钟后从 Map 中移除，给调用方足够的时间查询状态和错误信息
        const cleanupTimer = setTimeout(async () => {
          this._processes.delete(processId);
          if (mp.agentId) {
            try {
              await this.runtime.lifecycleRegistry.unregister(`subprocess:${processId}`);
            } catch (e) {
              this.log.debug("[ProcessManager] 启动失败进程生命周期注销", { processId });
            }
          }
          this.log.info("[ProcessManager] 启动失败进程条目已清理", { processId });
        }, 1800000);
        if (cleanupTimer && typeof cleanupTimer.unref === "function") {
          cleanupTimer.unref();
        }
      }

      // 清理可能创建的文件
      try {
        await fsp.unlink(outputFile);
      } catch (e) {
        // 忽略清理错误
      }
      return {
        ok: false,
        processId,
        error: message
      };
    }
  }

  /**
   * 向进程发送输入
   * @param {string} processId - 进程 ID
   * @param {string} data - 要发送的数据
   * @returns {{ok: boolean, error?: string}}
   */
  sendInput(processId, data) {
    const managedProcess = this._processes.get(processId);
    
    if (!managedProcess) {
      return { ok: false, error: "process_not_found" };
    }

    if (managedProcess.status !== "running") {
      return { ok: false, error: `process_not_running (status: ${managedProcess.status})` };
    }

    // 记录输入到文件
    managedProcess.writeStream.write(`[STDIN] ${data}`);
    
    return managedProcess.write(data);
  }

  /**
   * 读取进程输出文件（通过 seek 定位）
   * 
   * @param {string} processId - 进程 ID
   * @param {{offset?: number, window?: number}} options
   * @returns {Promise<{ok: boolean, content?: string, offset?: number, nextOffset?: number, totalLength?: number, hasMore?: boolean, status?: string, exitCode?: number, error?: string}>}
   */
  async readOutput(processId, options = {}) {
    const managedProcess = this._processes.get(processId);
    
    if (!managedProcess) {
      return { ok: false, error: "process_not_found" };
    }

    // 启动失败的进程没有有效的输出文件
    if (managedProcess.startupError) {
      return { ok: false, error: "process_startup_failed", status: managedProcess.status, reason: managedProcess.startupError };
    }

    const {
      offset = 0,  // 默认从文件开头读取
      window = this.defaultWindowSize  // 默认 5000 字符
    } = options;

    try {
      // 获取文件状态
      let stats;
      try {
        stats = await fsp.stat(managedProcess.outputFile);
      } catch (error) {
        return {
          ok: false,
          error: `file_stat_failed: ${error.message}`
        };
      }

      const totalLength = stats.size;

      // 如果偏移量超出文件大小，返回空内容
      if (offset >= totalLength) {
        return {
          ok: true,
          content: "",
          offset: totalLength,
          nextOffset: totalLength,
          totalLength,
          hasMore: false,
          status: managedProcess.status,
          exitCode: managedProcess.exitCode
        };
      }

      // 打开文件并读取指定位置
      let fileHandle;
      try {
        fileHandle = await fsp.open(managedProcess.outputFile, "r");
        
        // 计算要读取的字节数（最多 window 个字符）
        const bytesToRead = Math.min(window, totalLength - offset);
        const buffer = Buffer.alloc(bytesToRead);
        
        // 从指定偏移位置读取
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        
        // 转换为字符串
        const content = buffer.toString("utf8", 0, bytesRead);
        
        const nextOffset = offset + bytesRead;
        const hasMore = nextOffset < totalLength;

        await fileHandle.close();

        return {
          ok: true,
          content,
          offset,
          nextOffset,
          totalLength,
          hasMore,
          status: managedProcess.status,
          exitCode: managedProcess.exitCode
        };
      } catch (error) {
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
        }
        throw error;
      }
    } catch (err) {
      this.log.error("[ProcessManager] 读取输出文件失败", { processId, error: err?.message });
      return {
        ok: false,
        error: `read_failed: ${err?.message}`
      };
    }
  }

  // ─── 历史命令查询 ─────────────────────────────────────────────

  /**
   * 扫描指定 agent 的日志目录，增量更新历史缓存
   * @param {string} agentId - 智能体 ID
   * @private
   */
  async _scanHistoryCache(agentId) {
    const agentDir = path.join(this.outputDir, agentId);
    let names;
    try {
      names = await fsp.readdir(agentDir);
    } catch {
      // 目录不存在 → 该 agent 无历史
      return;
    }

    const seen = new Set();
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      const m = LOG_FILENAME_RE.exec(name);
      if (!m) continue;
      const processId = m[2];
      seen.add(processId);
      const filePath = path.join(agentDir, name);

      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }

      const cached = this._historyCache.get(processId);
      // 增量缓存：size 或 mtimeMs 任一变化才重解析
      if (cached && cached._size === stat.size && cached._mtimeMs === stat.mtimeMs) continue;

      if (stat.size === 0) {
        this._historyCache.delete(processId);
        continue;
      }

      const entry = await this._parseLogEntry(processId, filePath, agentId, stat);
      if (entry) {
        this._historyCache.set(processId, entry);
      } else {
        this._historyCache.delete(processId);
      }
    }

    // 清除已消失文件对应的缓存条目
    for (const pid of this._historyCache.keys()) {
      if (!seen.has(pid)) {
        const entry = this._historyCache.get(pid);
        if (entry && entry.agentId === agentId) {
          this._historyCache.delete(pid);
        }
      }
    }
  }

  /**
   * 解析单个日志文件的头部和尾部，提取命令/时间/状态/退出码
   * @param {string} processId - 进程 ID
   * @param {string} filePath - 日志文件路径
   * @param {string} agentId - 智能体 ID（由目录结构决定）
   * @param {fs.Stats} stat - 文件状态
   * @returns {Promise<object|null>}
   * @private
   */
  async _parseLogEntry(processId, filePath, agentId, stat) {
    let fh, head = "", tail = "";
    try {
      fh = await fsp.open(filePath, "r");
      const headLen = Math.min(stat.size, HEAD_READ_SIZE);
      const headBuf = Buffer.alloc(headLen);
      const { bytesRead: hb } = await fh.read(headBuf, 0, headLen, 0);
      head = headBuf.toString("utf8", 0, hb);

      if (stat.size > TAIL_READ_SIZE) {
        const tailBuf = Buffer.alloc(TAIL_READ_SIZE);
        const { bytesRead: tb } = await fh.read(tailBuf, 0, TAIL_READ_SIZE, stat.size - TAIL_READ_SIZE);
        tail = tailBuf.toString("utf8", 0, tb);
      } else {
        tail = head;
      }
    } catch {
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }

    // 头部逐行扫描
    let command = "", startedAt = null;
    for (const line of head.split("\n")) {
      if (line.startsWith("[PROCESS_START] ")) command = line.slice("[PROCESS_START] ".length);
      else if (line.startsWith("[START_TIME] ")) startedAt = line.slice("[START_TIME] ".length);
      if (command && startedAt) break;
    }

    // 尾部解析
    const endMatch = tail.match(/\[PROCESS_END\] exitCode=(-?\d+|null), signal=(\S*)\]/);
    const endTimeMatch = tail.match(/\[END_TIME\] (.+)/);
    const endedAt = endTimeMatch ? endTimeMatch[1].trim() : null;
    let status = "interrupted"; // 无 END 标记 → 中断（进程被强杀/主进程崩溃）
    let exitCode = null;
    if (endMatch) {
      exitCode = endMatch[1] === "null" ? null : parseInt(endMatch[1], 10);
      if (exitCode === 0) status = "completed";
      else if (exitCode === null && endMatch[2] && endMatch[2] !== "null") status = "killed";
      else status = "error";
    }
    if (tail.includes("[PROCESS_ERROR]")) status = "error";

    const startMs = startedAt ? Date.parse(startedAt) : 0;
    const endMs = endedAt ? Date.parse(endedAt) : NaN;

    return {
      processId, agentId, filePath,
      command: command.slice(0, 2000),
      startedAt, endedAt,
      durationMs: (startMs && Number.isFinite(endMs)) ? endMs - startMs : null,
      status, exitCode, size: stat.size,
      _sortMs: startMs || 0,
      _size: stat.size, _mtimeMs: stat.mtimeMs
    };
  }

  /**
   * 列出指定 agent 的历史命令
   * @param {string} agentId - 智能体 ID
   * @param {{offset?: number, limit?: number, search?: string}} options
   * @returns {Promise<{items: Array<object>, total: number}>}
   */
  async listHistory(agentId, options = {}) {
    const { offset = 0, limit = 50, search = "" } = options;
    const q = (search || "").trim().toLowerCase();

    await this._scanHistoryCache(agentId);

    // live Map 覆盖 + 补充：刚 spawn 的进程文件可能尚未写入/未入缓存
    const liveById = new Map();
    for (const [pid, mp] of this._processes) {
      liveById.set(pid, mp);
    }

    const entries = [];
    for (const [pid, entry] of this._historyCache) {
      if (entry.agentId !== agentId) continue;
      const live = liveById.get(pid);
      if (live) {
        // 内存 Map 状态优先（运行中进程的最准确来源）
        entry.status = live.status;
        entry.exitCode = live.exitCode;
        entry.startedAt = live.createdAt;
        liveById.delete(pid);
      }
      entries.push(entry);
    }

    // 兜底：文件尚未写入但已在 live Map 中的 running 进程
    for (const [pid, mp] of liveById) {
      if (!mp.agentId || mp.agentId !== agentId) continue;
      entries.push({
        processId: pid,
        agentId: mp.agentId,
        command: [mp.command, ...(mp.args || [])].join(" ").slice(0, 2000),
        startedAt: mp.createdAt, endedAt: null, durationMs: null,
        status: mp.status, exitCode: mp.exitCode, size: 0,
        _sortMs: Date.parse(mp.createdAt) || 0
      });
    }

    // 搜索过滤
    const filtered = q
      ? entries.filter(e => (e.command || "").toLowerCase().includes(q))
      : entries;

    // 按开始时间倒序
    filtered.sort((a, b) => (b._sortMs || 0) - (a._sortMs || 0));

    return {
      items: filtered.slice(offset, offset + limit).map(e => ({
        processId: e.processId,
        command: e.command,
        agentId: e.agentId,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        durationMs: e.durationMs,
        status: e.status,
        exitCode: e.exitCode,
        size: e.size
      })),
      total: filtered.length
    };
  }

  /**
   * 按文件路径读取日志输出（不依赖内存 Map，进程清理后仍可读）
   * @param {string} processId - 进程 ID
   * @param {{offset?: number, window?: number}} options
   * @returns {Promise<object>}
   */
  async readOutputByFile(processId, options = {}) {
    if (!PROCESS_ID_RE.test(processId)) {
      return { ok: false, error: "invalid_process_id" };
    }

    const { offset = 0, window = this.defaultWindowSize } = options;

    // 查缓存（需要先被 _scanHistoryCache 加载过）
    const entry = this._historyCache.get(processId);
    if (!entry || !entry.filePath) {
      return { ok: false, error: "process_not_found" };
    }

    let stat;
    try { stat = await fsp.stat(entry.filePath); } catch {
      return { ok: false, error: "file_not_found" };
    }

    if (offset >= stat.size) {
      const live = this._processes.get(processId);
      return {
        ok: true, content: "", offset, nextOffset: stat.size, totalLength: stat.size,
        hasMore: false,
        status: live ? live.status : entry.status,
        exitCode: live ? live.exitCode : entry.exitCode
      };
    }

    const bytesToRead = Math.min(window, stat.size - offset);
    let fh;
    try {
      fh = await fsp.open(entry.filePath, "r");
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fh.read(buf, 0, bytesToRead, offset);
      // 直接 UTF-8 解码（写路径已用 StringDecoder 保证文件是完整 UTF-8）
      const content = buf.toString("utf8", 0, bytesRead);
      const nextOffset = offset + bytesRead;
      const live = this._processes.get(processId);

      return {
        ok: true, content, offset, nextOffset, totalLength: stat.size,
        hasMore: nextOffset < stat.size,
        status: live ? live.status : entry.status,
        exitCode: live ? live.exitCode : entry.exitCode
      };
    } catch (err) {
      return { ok: false, error: `read_failed: ${err?.message}` };
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /**
   * 删除指定 agent 的所有历史日志文件
   * @param {string} agentId - 智能体 ID
   * @returns {Promise<{ok: boolean, deletedCount: number, skippedCount: number}>}
   */
  async deleteHistoryByAgent(agentId) {
    const agentDir = path.join(this.outputDir, agentId);
    let deletedCount = 0;
    let skippedCount = 0;

    try {
      const names = await fsp.readdir(agentDir);
      for (const name of names) {
        if (!name.endsWith(".log")) continue;
        const filePath = path.join(agentDir, name);
        try {
          await fsp.unlink(filePath);
          deletedCount++;
        } catch (e) {
          this.log.warn("[ProcessManager] 删除历史日志失败", { filePath, error: e?.message });
          skippedCount++;
        }
      }
      // 尝试删除目录（如果为空）
      try { await fsp.rmdir(agentDir); } catch { /* 非空则保留 */ }
    } catch {
      // 目录不存在 → 无历史
    }

    // 清理缓存中该 agent 的条目
    for (const [pid, entry] of this._historyCache) {
      if (entry.agentId === agentId) {
        this._historyCache.delete(pid);
      }
    }

    this.log.info("[ProcessManager] 历史已清除", { agentId, deletedCount, skippedCount });
    return { ok: true, deletedCount, skippedCount };
  }

  /**
   * 获取进程信息
   * @param {string} processId - 进程 ID
   * @returns {object|null}
   */
  getProcess(processId) {
    const managedProcess = this._processes.get(processId);
    if (!managedProcess) return null;
    
    return {
      id: managedProcess.id,
      command: managedProcess.command,
      args: managedProcess.args,
      createdAt: managedProcess.createdAt,
      status: managedProcess.status,
      exitCode: managedProcess.exitCode,
      pid: managedProcess.process?.pid ?? null,
      startupError: managedProcess.startupError ?? null
    };
  }

  /**
   * 列出所有进程
   * @returns {Array<object>}
   */
  listProcesses() {
    const list = [];
    for (const [id, managedProcess] of this._processes) {
      list.push({
        id,
        command: managedProcess.command,
        args: managedProcess.args,
        createdAt: managedProcess.createdAt,
        status: managedProcess.status,
        exitCode: managedProcess.exitCode,
        pid: managedProcess.process.pid
      });
    }
    return list;
  }

  /**
   * 终止指定进程
   * @param {string} processId - 进程 ID
   * @param {string} signal - 信号名称
   * @returns {{ok: boolean, error?: string}}
   * @private
   */
  _killProcess(processId, signal = "SIGTERM") {
    const managedProcess = this._processes.get(processId);
    
    if (!managedProcess) {
      return { ok: false, error: "process_not_found" };
    }

    if (managedProcess.status !== "running") {
      return { ok: false, error: `process_not_running (status: ${managedProcess.status})` };
    }

    this.log.info("[ProcessManager] 终止进程", { processId, signal });

    try {
      managedProcess.status = "killed";
      
      // 先尝试优雅终止
      managedProcess.process.kill(signal);
      
      // Windows 特殊处理
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", managedProcess.process.pid.toString(), "/t", "/f"]);
        } catch (e) {
          // 忽略 taskkill 错误
        }
      }

      // 如果 5 秒后还没退出，强制 kill
      setTimeout(() => {
        if (!managedProcess.process.killed) {
          try {
            managedProcess.process.kill("SIGKILL");
          } catch (e) {
            // 进程可能已经结束
          }
        }
      }, 5000);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }

  /**
   * 终止指定进程（公开方法，供工具调用）
   * @param {string} processId - 进程ID
   * @returns {{ok: boolean, error?: string}}
   */
  kill(processId) {
    return this._killProcess(processId, "SIGTERM");
  }

  /**
   * 终止所有子进程并清理文件
   * @returns {Promise<void>}
   */
  async killAll() {
    this.log.info("[ProcessManager] 终止所有子进程", { count: this._processes.size });
    
    const killPromises = [];
    for (const [processId, managedProcess] of this._processes) {
      if (managedProcess.status === "running") {
        killPromises.push(
          new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            managedProcess.process.once("close", done);
            this._killProcess(processId, "SIGTERM");
            setTimeout(done, 100);
          })
        );
      }
    }
    
    await Promise.allSettled(killPromises);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 关闭所有写入流
    for (const managedProcess of this._processes.values()) {
      if (managedProcess.writeStream && !managedProcess.writeStream.destroyed) {
        managedProcess.writeStream.end();
      }
    }
    
    // 清理输出文件
    for (const managedProcess of this._processes.values()) {
      try {
        await fsp.unlink(managedProcess.outputFile);
        this.log.debug("[ProcessManager] 已删除输出文件", { outputFile: managedProcess.outputFile });
      } catch (e) {
        // 忽略清理错误
      }
    }
    
    this._processes.clear();
  }
}
