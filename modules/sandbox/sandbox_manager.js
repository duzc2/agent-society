/**
 * 沙箱进程管理器
 * 管理隔离的 Node.js 子进程生命周期，所有输出写入文件，支持通过 seek 读取不同位置。
 * 进程通过 node --permission 在 OS 层隔离，无法访问网络、工作区外的文件、或创建子进程。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const CODE_SIZE_THRESHOLD = 30 * 1024; // 30KB，超过则写临时文件

/**
 * @typedef {object} ManagedSandbox
 * @property {string} id - 沙箱实例唯一 ID
 * @property {string} [agentId] - 所属智能体ID
 * @property {import('node:child_process').ChildProcess} process - 子进程对象
 * @property {string} outputFile - 输出文件路径
 * @property {string|null} tempScriptFile - 超长代码时的临时脚本文件路径
 * @property {fs.WriteStream} writeStream - 文件写入流
 * @property {string} createdAt - 创建时间 ISO 字符串
 * @property {string} status - 状态: 'running' | 'completed' | 'error' | 'killed'
 * @property {number|null} exitCode - 退出码
 * @property {string|null} startupError - 启动失败时的错误信息
 */

export class SandboxManager {
  /**
   * @param {{log: any, dataDir: string}} options
   */
  constructor(options) {
    this.log = options.log;
    this.dataDir = options.dataDir;
    this.outputDir = path.join(this.dataDir, "sandbox");
    this.defaultWindowSize = 5000;

    /** @type {Map<string, ManagedSandbox>} */
    this._sandboxes = new Map();

    /** @type {Function|null} */
    this._beforeExitHandler = null;
    /** @type {Function|null} */
    this._uncaughtExceptionHandler = null;

    this._ensureOutputDir();
    this._setupProcessCleanup();
  }

  /**
   * 确保输出目录存在
   * @private
   */
  _ensureOutputDir() {
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      this.log.debug("[SandboxManager] 输出目录已创建", { outputDir: this.outputDir });
    } catch (error) {
      this.log.error("[SandboxManager] 创建输出目录失败", { error: error.message });
    }
  }

  /**
   * 设置主进程退出时的清理逻辑
   * @private
   */
  _setupProcessCleanup() {
    this._beforeExitHandler = async () => {
      if (this._sandboxes.size > 0) {
        this.log.info("[SandboxManager] 主进程退出，正在终止所有沙箱...", { count: this._sandboxes.size });
        await this.killAll();
      }
    };

    this._uncaughtExceptionHandler = async (err) => {
      this.log.error("[SandboxManager] 未捕获的异常", { error: err?.message, stack: err?.stack });
      await this.killAll();
    };

    process.on("beforeExit", this._beforeExitHandler);
    process.on("uncaughtException", this._uncaughtExceptionHandler);
  }

  /**
   * 销毁管理器，移除事件监听器（测试用）
   */
  destroy() {
    if (this._beforeExitHandler) {
      process.removeListener("beforeExit", this._beforeExitHandler);
      this._beforeExitHandler = null;
    }
    if (this._uncaughtExceptionHandler) {
      process.removeListener("uncaughtException", this._uncaughtExceptionHandler);
      this._uncaughtExceptionHandler = null;
    }
  }

  /**
   * 生成输出文件路径
   * @param {string} processId
   * @returns {string}
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
   * 生成超长代码的临时文件路径
   * @param {string} processId
   * @returns {string}
   * @private
   */
  _generateTempFilePath(processId) {
    const dir = path.join(this.outputDir, processId);
    return path.join(dir, "script.mjs");
  }

  /**
   * 启动一个隔离的 Node.js 沙箱进程
   * @param {string} code - 要执行的 JavaScript 代码
   * @param {string} workspacePath - 工作区根目录路径
   * @param {string} [agentId] - 所属智能体ID
   * @returns {Promise<{ok: boolean, processId?: string, error?: string}>}
   */
  async spawn(code, workspacePath, agentId) {
    const processId = randomUUID();
    const outputFile = this._generateOutputFilePath(processId);

    this.log.info("[SandboxManager] 启动沙箱", { processId, codeLength: code.length, workspacePath, outputFile });

    let tempScriptFile = null;

    try {
      // 确保工作区路径存在
      let resolvedWorkspace = workspacePath;
      try {
        const workspaceStat = await fsp.stat(workspacePath);
        if (!workspaceStat.isDirectory()) {
          resolvedWorkspace = process.cwd();
        }
      } catch {
        resolvedWorkspace = process.cwd();
      }

      let childProcess;
      if (code.length <= CODE_SIZE_THRESHOLD) {
        // 短代码：直接用 -e 执行
        childProcess = spawn("node", [
          "--permission",
          `--allow-fs-read=${resolvedWorkspace}`,
          `--allow-fs-write=${resolvedWorkspace}`,
          "--no-warnings",
          "--input-type=module",
          "-e", code,
        ], {
          cwd: resolvedWorkspace,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        // 超长代码：写临时 .mjs 文件执行
        const tempDir = path.dirname(this._generateTempFilePath(processId));
        await fsp.mkdir(tempDir, { recursive: true });
        tempScriptFile = this._generateTempFilePath(processId);
        await fsp.writeFile(tempScriptFile, code, "utf8");

        childProcess = spawn("node", [
          "--permission",
          `--allow-fs-read=${resolvedWorkspace}`,
          `--allow-fs-write=${resolvedWorkspace}`,
          "--no-warnings",
          tempScriptFile,
        ], {
          cwd: resolvedWorkspace,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }

      // 创建输出文件写入流
      const writeStream = fs.createWriteStream(outputFile, {
        flags: "a",
        encoding: "utf8",
      });

      writeStream.write(`[PROCESS_START] sandbox\n`);
      writeStream.write(`[START_TIME] ${new Date().toISOString()}\n`);
      writeStream.write(`${"-".repeat(50)}\n`);

      const managedSandbox = {
        id: processId,
        agentId,
        process: childProcess,
        outputFile,
        tempScriptFile,
        writeStream,
        createdAt: new Date().toISOString(),
        status: "running",
        exitCode: null,
        startupError: null,
      };

      this._sandboxes.set(processId, managedSandbox);

      const safeWrite = (data) => {
        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.write(data);
        }
      };

      childProcess.stdout?.on("data", (data) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        safeWrite(text);
      });

      childProcess.stderr?.on("data", (data) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        safeWrite(text);
      });

      childProcess.on("close", (code, signal) => {
        if (managedSandbox.startupError) {
          return;
        }
        managedSandbox.status = code === 0 ? "completed" : "error";
        managedSandbox.exitCode = code;

        safeWrite(`${"-".repeat(50)}\n`);
        safeWrite(`[PROCESS_END] exitCode=${code}, signal=${signal}\n`);
        safeWrite(`[END_TIME] ${new Date().toISOString()}\n`);

        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.end();
        }

        // 延迟 30 分钟后清理
        const cleanupTimer = setTimeout(async () => {
          this._sandboxes.delete(processId);
          if (managedSandbox.tempScriptFile) {
            try {
              await fsp.unlink(managedSandbox.tempScriptFile);
            } catch {}
            try {
              const tempDir = path.dirname(managedSandbox.tempScriptFile);
              await fsp.rmdir(tempDir);
            } catch {}
          }
          this.log.info("[SandboxManager] 沙箱条目已清理", { processId, code });
        }, 1800000);
        if (cleanupTimer && typeof cleanupTimer.unref === "function") {
          cleanupTimer.unref();
        }

        this.log.info("[SandboxManager] 沙箱进程结束", { processId, code, signal });
      });

      childProcess.on("error", (err) => {
        managedSandbox.status = "error";
        managedSandbox.startupError = err.message;
        safeWrite(`[PROCESS_ERROR] ${err.message}\n`);

        if (writeStream.writable && !writeStream.destroyed) {
          writeStream.end();
        }

        this.log.error("[SandboxManager] 沙箱进程错误", { processId, error: err?.message, stack: err?.stack });
      });

      childProcess.once("spawn", () => {
        this.log.info("[SandboxManager] 沙箱进程启动成功", { processId, pid: childProcess.pid, outputFile });
      });

      return { ok: true, processId };
    } catch (err) {
      const message = err?.message ?? String(err);
      this.log.error("[SandboxManager] 启动沙箱失败", { processId, error: message, stack: err?.stack });

      // 清理已注册的条目
      const sb = this._sandboxes.get(processId);
      if (sb) {
        sb.startupError = message;
        if (sb.writeStream && sb.writeStream.writable && !sb.writeStream.destroyed) {
          sb.writeStream.end();
        }
        try { sb.process?.kill?.("SIGKILL"); } catch {}

        const cleanupTimer = setTimeout(() => {
          this._sandboxes.delete(processId);
        }, 1800000);
        if (cleanupTimer && typeof cleanupTimer.unref === "function") {
          cleanupTimer.unref();
        }
      }

      try { await fsp.unlink(outputFile); } catch {}

      return { ok: false, processId, error: message };
    }
  }

  /**
   * 读取沙箱输出文件
   * @param {string} processId
   * @param {number} [offset=0]
   * @param {number} [window=this.defaultWindowSize]
   * @returns {Promise<{ok: boolean, content?: string, offset?: number, nextOffset?: number, totalLength?: number, hasMore?: boolean, status?: string, exitCode?: number, error?: string}>}
   */
  async readOutput(processId, offset = 0, window = this.defaultWindowSize) {
    const managedSandbox = this._sandboxes.get(processId);

    if (!managedSandbox) {
      return { ok: false, error: "process_not_found" };
    }

    if (managedSandbox.startupError) {
      return { ok: false, error: "process_startup_failed", status: managedSandbox.status, reason: managedSandbox.startupError };
    }

    try {
      let stats;
      try {
        stats = await fsp.stat(managedSandbox.outputFile);
      } catch (error) {
        return { ok: false, error: `file_stat_failed: ${error.message}` };
      }

      const totalLength = stats.size;

      if (offset >= totalLength) {
        return {
          ok: true,
          content: "",
          offset: totalLength,
          nextOffset: totalLength,
          totalLength,
          hasMore: false,
          status: managedSandbox.status,
          exitCode: managedSandbox.exitCode,
        };
      }

      let fileHandle;
      try {
        fileHandle = await fsp.open(managedSandbox.outputFile, "r");

        const bytesToRead = Math.min(window, totalLength - offset);
        const buffer = Buffer.alloc(bytesToRead);

        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);

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
          status: managedSandbox.status,
          exitCode: managedSandbox.exitCode,
        };
      } catch (error) {
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
        }
        throw error;
      }
    } catch (err) {
      this.log.error("[SandboxManager] 读取输出文件失败", { processId, error: err?.message, stack: err?.stack });
      return { ok: false, error: `read_failed: ${err?.message}` };
    }
  }

  /**
   * 获取沙箱状态
   * @param {string} processId
   * @returns {{ok: boolean, status?: string, exitCode?: number, pid?: number, error?: string}}
   */
  getStatus(processId) {
    const managedSandbox = this._sandboxes.get(processId);

    if (!managedSandbox) {
      return { ok: false, error: "process_not_found" };
    }

    return {
      ok: true,
      status: managedSandbox.status,
      exitCode: managedSandbox.exitCode,
      pid: managedSandbox.process?.pid ?? null,
    };
  }

  /**
   * 终止指定沙箱
   * @param {string} processId
   * @returns {{ok: boolean, error?: string}}
   */
  kill(processId) {
    const managedSandbox = this._sandboxes.get(processId);

    if (!managedSandbox) {
      return { ok: false, error: "process_not_found" };
    }

    if (managedSandbox.status !== "running") {
      return { ok: false, error: `process_not_running (status: ${managedSandbox.status})` };
    }

    this.log.info("[SandboxManager] 终止沙箱", { processId });

    try {
      managedSandbox.status = "killed";
      managedSandbox.process.kill("SIGTERM");

      // Windows: 树级终止（通过 PID，不通过进程名）
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", managedSandbox.process.pid.toString(), "/t", "/f"]);
        } catch {
          // taskkill 自身失败不影响
        }
      }

      // 5 秒后仍未退出则强制 SIGKILL
      setTimeout(() => {
        if (!managedSandbox.process.killed) {
          try {
            managedSandbox.process.kill("SIGKILL");
          } catch {}
        }
      }, 5000);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }

  /**
   * 终止所有沙箱并清理文件
   * @returns {Promise<void>}
   */
  async killAll() {
    this.log.info("[SandboxManager] 终止所有沙箱", { count: this._sandboxes.size });

    const killPromises = [];
    for (const [processId, managedSandbox] of this._sandboxes) {
      if (managedSandbox.status === "running") {
        killPromises.push(
          new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            managedSandbox.process.once("close", done);
            try {
              managedSandbox.status = "killed";
              managedSandbox.process.kill("SIGTERM");
              if (process.platform === "win32") {
                try {
                  spawn("taskkill", ["/pid", managedSandbox.process.pid.toString(), "/t", "/f"]);
                } catch {}
              }
            } catch {}
            setTimeout(done, 100);
          })
        );
      }
    }

    await Promise.allSettled(killPromises);
    await new Promise(resolve => setTimeout(resolve, 500));

    // 关闭所有写入流
    for (const managedSandbox of this._sandboxes.values()) {
      if (managedSandbox.writeStream && !managedSandbox.writeStream.destroyed) {
        managedSandbox.writeStream.end();
      }
    }

    // 清理输出文件
    for (const managedSandbox of this._sandboxes.values()) {
      try {
        await fsp.unlink(managedSandbox.outputFile);
        this.log.debug("[SandboxManager] 已删除输出文件", { outputFile: managedSandbox.outputFile });
      } catch {}
    }

    // 清理临时文件
    for (const managedSandbox of this._sandboxes.values()) {
      if (managedSandbox.tempScriptFile) {
        try {
          await fsp.unlink(managedSandbox.tempScriptFile);
        } catch {}
        try {
          const tempDir = path.dirname(managedSandbox.tempScriptFile);
          await fsp.rmdir(tempDir);
        } catch {}
      }
    }

    this._sandboxes.clear();
  }
}
