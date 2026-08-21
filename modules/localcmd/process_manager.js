/**
 * 本地进程管理器
 * 负责管理子进程的生命周期，所有输出写入文件，支持通过 seek 读取不同位置。
 * 确保主进程退出时所有子进程都被终止并清理文件。
 */

import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";

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
    this._systemEncoding = this._detectSystemEncoding();

    /** @type {Map<string, ManagedProcess>} */
    this._processes = new Map();

    // 确保输出目录存在
    this._ensureOutputDir();
    
    // 监听主进程退出信号
    this._setupProcessCleanup();
  }

  /**
   * 确保输出目录存在
   * @private
   */
  async _ensureOutputDir() {
    try {
      await fsp.mkdir(this.outputDir, { recursive: true });
      this.log.debug("[ProcessManager] 输出目录已创建", { outputDir: this.outputDir });
    } catch (error) {
      this.log.error("[ProcessManager] 创建输出目录失败", { error: error.message });
    }
  }

  /**
   * 检测系统编码（Windows 上通过 chcp 获取代码页）
   * @returns {string} 编码名称，如 "cp936"、"utf8"
   * @private
   */
  _detectSystemEncoding() {
    if (process.platform !== "win32") return "utf8";
    try {
      const output = execSync("chcp", { encoding: "utf8", timeout: 2000 });
      const match = output.match(/(\d+)/);
      if (match) {
        const codepage = parseInt(match[1], 10);
        if (codepage === 65001) return "utf8"; // UTF-8 代码页，无需转换
        return `cp${match[1]}`; // 如 cp936 (GBK)、cp437 等
      }
    } catch {
      // 检测失败，回退到 utf8
    }
    return "utf8";
  }

  /**
   * 将子进程输出的 Buffer 解码为 UTF-8 字符串
   * 优先尝试 UTF-8，若出现替换字符 (U+FFFD) 则回退到系统编码
   * @param {Buffer} buffer
   * @returns {string}
   * @private
   */
  _decodeBuffer(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    // 非 Windows 或系统编码已是 UTF-8，直接返回
    if (this._systemEncoding === "utf8") {
      return data.toString("utf8");
    }

    // 先尝试 UTF-8 解码
    const utf8Result = data.toString("utf8");
    // 如果没有替换字符，说明本身就是 UTF-8，直接返回
    if (!utf8Result.includes("\ufffd")) {
      return utf8Result;
    }

    // 出现替换字符，尝试用系统编码解码
    try {
      return iconv.decode(data, this._systemEncoding);
    } catch {
      // iconv 解码失败，返回 UTF-8 结果（至少部分可读）
      return utf8Result;
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
   * 生成输出文件路径
   * @param {string} processId - 进程 ID
   * @returns {string} 输出文件路径
   * @private
   */
  _generateOutputFilePath(processId) {
    const timestamp = new Date().toISOString()
      .replace(/:/g, "")
      .replace(/\..+/, "")
      .replace("T", "-");
    return path.join(this.outputDir, `${timestamp}-${processId}.log`);
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
   * @param {{cwd?: string, env?: object, agentId?: string}} options
   * @returns {Promise<{ok: boolean, processId?: string, error?: string}>}
   */
  async spawn(command, args = [], options = {}) {
    const processId = randomUUID();
    const { cwd, env, agentId } = options;
    const outputFile = this._generateOutputFilePath(processId);

    this.log.info("[ProcessManager] 启动进程", { processId, command, args, cwd, outputFile });

    try {
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
      writeStream.write("-".repeat(50) + "\n");

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

      // 处理 stdout（从系统编码解码为 UTF-8）
      childProcess.stdout?.on("data", (data) => {
        safeWrite(`[STDOUT] ${this._decodeBuffer(data)}`);
      });

      // 处理 stderr（从系统编码解码为 UTF-8）
      childProcess.stderr?.on("data", (data) => {
        safeWrite(`[STDERR] ${this._decodeBuffer(data)}`);
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
      });

      childProcess.on("error", (err) => {
        managedProcess.status = "error";
        managedProcess.startupError = err.message;
        safeWrite(`[PROCESS_ERROR] ${err.message}\n`);

        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.end();
        }

        this.log.error("[ProcessManager] 进程错误", { processId, error: err?.message });
      });

      // 非阻塞 spawn 事件监听（仅日志）
      childProcess.once("spawn", () => {
        this.log.info("[ProcessManager] 进程启动成功", { processId, pid: childProcess.pid, outputFile });
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
