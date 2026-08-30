/**
 * 关闭管理器模块
 *
 * 【职责】统一管理系统的优雅关闭流程和进程退出监控
 *
 * 【处理的事件】
 * - SIGINT/SIGTERM/SIGBREAK/SIGHUP - 信号
 * - beforeExit - 事件循环即将为空
 * - exit - 进程即将退出（同步日志）
 * - uncaughtException - 未捕获异常
 * - unhandledRejection - 未处理Promise拒绝
 *
 * 【关闭流程 (CleanupHookChain 六阶段)】
 * 1. stop_accepting  — 停止接收新消息 (2000ms 超时)
 * 2. drain_inflight  — 等待当前处理完成 (30000ms 超时)
 * 3. persist_state   — 持久化组织状态和对话历史 (5000ms 超时)
 * 4. close_resources — 关闭所有注册的资源 (10000ms 超时)
 * 5. flush_logs      — 刷新日志缓冲区 (2000ms 超时)
 * 6. exit            — 记录关闭摘要 (1000ms 超时)
 *
 * @module runtime/shutdown_manager
 */

import fs from "node:fs";
import path from "node:path";
import { CleanupHookChain } from "./cleanup_hooks.js";

/**
 * 关闭管理器类
 */
export class ShutdownManager {
  constructor(runtime) {
    this.runtime = runtime;
    this._isShuttingDown = false;
    this._forceExit = false;
    this._shutdownStartTime = null;
    this._exitEvents = [];
    this._heartbeatInterval = null;
    this._drainTimedOut = false;

    // 保存处理器引用，供 destroy() 反注册
    this._signalHandlers = new Map();
    this._uncaughtExceptionHandler = null;
    this._unhandledRejectionHandler = null;
    this._warningHandler = null;
    this._beforeExitHandler = null;
    this._exitHandler = null;

    // 初始化六阶段清理钩子链
    this._cleanupHooks = new CleanupHookChain(this.runtime);
    this._registerCleanupHooks();

    // 注册所有事件处理器
    this._setupSignalHandlers();
    this._setupExitHandlers();
    this._setupErrorHandlers();
    this._setupHeartbeat();
  }

  /**
   * 销毁管理器，移除所有全局监听器和定时器。
   * 用于测试环境清理，防止进程挂起。
   */
  destroy() {
    // 1. 清除心跳定时器
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }

    // 2. 移除信号处理器
    for (const [signal, handler] of this._signalHandlers) {
      process.removeListener(signal, handler);
    }
    this._signalHandlers.clear();

    // 3. 移除 beforeExit / exit
    if (this._beforeExitHandler) {
      process.removeListener('beforeExit', this._beforeExitHandler);
      this._beforeExitHandler = null;
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }

    // 4. 移除错误处理器
    if (this._uncaughtExceptionHandler) {
      process.removeListener('uncaughtException', this._uncaughtExceptionHandler);
      this._uncaughtExceptionHandler = null;
    }
    if (this._unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
      this._unhandledRejectionHandler = null;
    }
    if (this._warningHandler) {
      process.removeListener('warning', this._warningHandler);
      this._warningHandler = null;
    }

    // 5. 清空退出事件记录
    this._exitEvents = [];
  }

  /**
   * 注册六阶段关闭钩子，将原有关闭逻辑迁移到对应阶段。
   * 每个钩子通过闭包捕获 this.runtime，在 execute() 时按序执行。
   */
  _registerCleanupHooks() {
    const self = this;

    // 阶段 1: stop_accepting — 停止接收新消息
    this._cleanupHooks.register('stop_accepting', () => {
      self.runtime._stopRequested = true;
      self.runtime._computeScheduler?.stop();
    });

    // 阶段 2: drain_inflight — 等待当前处理完成
    this._cleanupHooks.register('drain_inflight', async () => {
      const runtime = self.runtime;
      const shutdownTimeoutMs = runtime._shutdownTimeoutMs || 30000;
      const waitStart = Date.now();
      const loopPromise = runtime._computeScheduler?.runningPromise;

      if (loopPromise) {
        const result = await Promise.race([
          loopPromise.catch((err) => {
            self.runtime.log.error('计算调度器异常退出（关闭中）', {
              error: err?.message,
              stack: err?.stack,
              name: err?.name,
              code: err?.code,
            });
          }),  // 吞掉 reject，不阻塞关闭流程
          new Promise((resolve) => {
            const timer = setTimeout(() => {
              self._drainTimedOut = true;
              resolve();
            }, shutdownTimeoutMs);
            if (timer && typeof timer.unref === "function") timer.unref();
          })
        ]);
        void result;  // 标记已使用
      }

      runtime.log.info('处理等待完成', {
        timedOut: self._drainTimedOut,
        waitDuration: Date.now() - waitStart
      });
    });

    // 阶段 3: persist_state — 原子持久化当前状态
    this._cleanupHooks.register('persist_state', async () => {
      const runtime = self.runtime;

      try {
        await runtime.org.persist();
        runtime.log.info('组织状态已持久化');
      } catch (err) {
        runtime.log.error('组织状态持久化失败', {
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }

      try {
        await runtime._conversationManager.flushAll();
        runtime.log.info('对话历史已持久化');
      } catch (err) {
        runtime.log.error('对话历史持久化失败', {
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    });

    // 阶段 4: close_resources — 关闭所有注册的资源
    this._cleanupHooks.register('close_resources', async () => {
      const runtime = self.runtime;

      // 4a. 关闭 HTTP 服务器
      if (runtime._httpServerRef) {
        try {
          await runtime._httpServerRef.stop();
          runtime.log.info('HTTP服务器已关闭');
        } catch (err) {
          runtime.log.error('HTTP服务器关闭失败', {
            error: err?.message || String(err),
            stack: err?.stack,
            name: err?.name,
            code: err?.code
          });
        }
      }

      // 4b. 关闭浏览器 JS 执行器
      if (runtime._browserJsExecutor) {
        try {
          await runtime._browserJsExecutor.shutdown();
          runtime.log.info('浏览器JS执行器已关闭');
        } catch (err) {
          runtime.log.error('浏览器JS执行器关闭失败', {
            error: err?.message || String(err),
            stack: err?.stack,
            name: err?.name,
            code: err?.code
          });
        }
      }

      // 4c. 关闭 Agent 记忆管理器
      if (runtime.agentMemoryManager) {
        try {
          await runtime.agentMemoryManager.closeAll();
          runtime.log.info('Agent记忆管理器已关闭');
        } catch (err) {
          runtime.log.error('Agent记忆管理器关闭失败', {
            error: err?.message || String(err),
            stack: err?.stack,
            name: err?.name,
            code: err?.code
          });
        }
      }

      // 4d. 通过 LifecycleRegistry 清理所有注册的资源
      try {
        // 遍历所有活跃智能体，强制清理其资源
        const agentIds = [...(runtime._agents?.keys?.() || [])];
        for (const agentId of agentIds) {
          await runtime.lifecycleRegistry.forceCleanupAgent(agentId, 'shutdown').catch((err) => {
            runtime.log.error('智能体资源清理失败（关闭中）', {
              agentId,
              error: err?.message,
              stack: err?.stack,
              name: err?.name,
              code: err?.code,
            });
          });
        }
        runtime.log.info('LifecycleRegistry 资源已清理');
      } catch (err) {
        runtime.log.error('LifecycleRegistry 资源清理失败', {
          error: err?.message || String(err),
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    });

    // 阶段 5: flush_logs — 刷新日志缓冲区
    this._cleanupHooks.register('flush_logs', async () => {
      try {
        await self.runtime.log.flush();
      } catch {
        // 忽略刷新失败
      }
    });

    // 阶段 6: exit — 记录关闭摘要（不调用 process.exit，由调用方决定）
    this._cleanupHooks.register('exit', () => {
      const shutdownDuration = Date.now() - (self._shutdownStartTime || 0);
      self.runtime.log.info('优雅关闭完成', {
        shutdownDuration,
        pendingMessages: self.runtime.bus?.getPendingCount?.(),
        activeAgents: self.runtime._agents?.size,
        drainTimedOut: self._drainTimedOut,
        exitEvents: self._exitEvents.length
      });
    });
  }

  /**
   * 记录退出事件
   */
  _recordExitEvent(event, details) {
    const entry = {
      time: new Date().toISOString(),
      event,
      details,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    this._exitEvents.push(entry);

    // 使用同步写入确保记录
    const message = `[ShutdownManager] ${event} uptime=${entry.uptime.toFixed(1)}s`;
    process.stderr.write(message + '\n');

    // 尝试写入日志
    try {
      this.runtime.log.warn(message, details);
    } catch {
      // 忽略
    }
  }

  /**
   * 设置信号处理器
   */
  _setupSignalHandlers() {
    const signals = ['SIGINT', 'SIGTERM'];

    // Windows 特有信号
    if (process.platform === 'win32') {
      signals.push('SIGBREAK');
    } else {
      signals.push('SIGHUP');
    }

    signals.forEach((signal) => {
      const handler = () => {
        this._recordExitEvent('SIGNAL', { signal });
        if (this._isShuttingDown) {
          this._forceExit = true;
          process.stderr.write(`[ShutdownManager] 强制退出 (${signal})\n`);
          process.exit(1);
        }
        this._shutdown(signal).then(() => {
          process.exit(0);
        });
      };
      this._signalHandlers.set(signal, handler);
      process.on(signal, handler);
    });
  }

  /**
   * 设置退出事件处理器
   */
  _setupExitHandlers() {
    // beforeExit - 事件循环即将为空
    this._beforeExitHandler = (code) => {
      this._recordExitEvent('BEFORE_EXIT', { code });
      if (!this._isShuttingDown) {
        this._shutdown('beforeExit');
      }
    };
    process.once('beforeExit', this._beforeExitHandler);

    // exit - 最终同步日志
    this._exitHandler = (code) => {
      const summary = `[ShutdownManager] 进程退出 code=${code} events=${this._exitEvents.length}`;
      process.stderr.write(summary + '\n');

      // 尝试写入文件
      try {
        const dataDir = this.runtime.dataDir;
        const logPath = path.join(dataDir, 'logs', 'shutdown.log');
        const content = this._exitEvents.map(e =>
          `[${e.time}] ${e.event} ${JSON.stringify(e.details || {})}`
        ).join('\n') + '\n';

        const logDir = path.dirname(logPath);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(logPath, `[EXIT code=${code}]\n${content}`);
      } catch {
        // 忽略
      }
    };
    process.once('exit', this._exitHandler);
  }

  /**
   * 设置错误处理器
   */
  _setupErrorHandlers() {
    // 未捕获异常
    this._uncaughtExceptionHandler = (error) => {

      this._recordExitEvent('UNCAUGHT_EXCEPTION', {
        message: error?.message,
        stack: error?.stack?.substring(0, 1000)
      });

      // 紧急持久化：同步写入崩溃恢复文件（在 _shutdown 前确保落盘）
      try {
        const dataDir = this.runtime.dataDir;
        const recoveryDir = path.join(dataDir, 'crash-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });

        const timestamp = Date.now();
        const tmpFile = path.join(recoveryDir, `${timestamp}.json.tmp`);
        const finalFile = path.join(recoveryDir, `${timestamp}.json`);

        const crashData = JSON.stringify({
          timestamp: new Date().toISOString(),
          pid: process.pid,
          error: {
            message: error?.message ?? String(error),
            stack: error?.stack?.substring(0, 2000) ?? null,
          },
          memory: process.memoryUsage(),
          nodeOptions: process.env.NODE_OPTIONS ?? null,
          cwd: process.cwd(),
        });

        fs.appendFileSync(tmpFile, crashData + '\n');
        try {
          fs.renameSync(tmpFile, finalFile);
        } catch {
          // 原子重命名失败，文件保留 .tmp 后缀亦可接受
        }
      } catch (persistErr) {
        process.stderr.write(
          `[ShutdownManager] 崩溃持久化失败: ${String(persistErr?.message ?? persistErr)}\n`
        );
      }

      if (!this._isShuttingDown) {
        this._shutdown('uncaughtException').then(() => {
          process.exit(1);
        }).catch(() => {
          process.exit(1);
        });
      }
    };
    process.on('uncaughtException', this._uncaughtExceptionHandler);

    // 未处理Promise拒绝（与 uncaughtException 同等对待：记录完整堆栈并优雅关机。
    // 只记录不退出会让进程带着损坏的内部状态继续运行，形成"僵尸进程"）
    this._unhandledRejectionHandler = (reason) => {
      const err = reason instanceof Error ? reason : null;
      void this.runtime.log.error("[ShutdownManager] 未处理Promise拒绝", {
        reason: err?.message ?? String(reason),
        name: err?.name ?? null,
        stack: err?.stack ?? null
      });
      this._recordExitEvent('UNHANDLED_REJECTION', {
        reason: err?.message ?? String(reason),
        stack: err?.stack ?? null
      });
      if (!this._isShuttingDown) {
        this._shutdown('unhandledRejection').then(() => {
          process.exit(1);
        }).catch(() => {
          process.exit(1);
        });
      }
    };
    process.on('unhandledRejection', this._unhandledRejectionHandler);

    // 系统警告
    this._warningHandler = (warning) => {
      this._recordExitEvent('WARNING', {
        name: warning.name,
        message: warning.message
      });
    };
    process.on('warning', this._warningHandler);
  }

  /**
   * 设置心跳监控
   */
  _setupHeartbeat() {
    // 每30秒记录一次心跳
    this._heartbeatInterval = setInterval(() => {
      this.runtime.log.debug('[ShutdownManager] HEARTBEAT', {
        uptime: process.uptime(),
        memory: process.memoryUsage()
      });
    }, 30000).unref();
  }

  /**
   * 执行关闭流程（通过 CleanupHookChain 六阶段执行）
   */
  async _shutdown(signal) {
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;
    this._shutdownStartTime = Date.now();

    this.runtime.log.info('开始优雅关闭', { signal });

    // 停止心跳
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
    }

    // 通过钩子链按序执行六个关闭阶段
    await this._cleanupHooks.execute();
    // 清理所有全局进程监听器（SIGINT/SIGTERM/.../uncaughtException/...）
    this.destroy();
  }

  /**
   * 手动触发关闭
   */
  async shutdown(options = {}) {
    if (this._isShuttingDown) {
      return {
        ok: false,
        pendingMessages: this.runtime.bus.getPendingCount(),
        activeAgents: this.runtime._agents.size,
        shutdownDuration: Date.now() - (this._shutdownStartTime || 0)
      };
    }
    const signal = options.signal ?? 'MANUAL';
    await this._shutdown(signal);
    const shutdownDuration = Date.now() - (this._shutdownStartTime || 0);
    return {
      ok: true,
      pendingMessages: this.runtime.bus.getPendingCount(),
      activeAgents: this.runtime._agents.size,
      shutdownDuration
    };
  }

  /**
   * 检查是否正在关闭
   */
  isShuttingDown() {
    return this._isShuttingDown;
  }

  /**
   * 获取关闭状态信息
   * @returns {{isShuttingDown:boolean, shutdownStartTime:number|null, shutdownTimeoutMs:number|null}}
   */
  getShutdownStatus() {
    return {
      isShuttingDown: this._isShuttingDown ?? false,
      shutdownStartTime: this._shutdownStartTime ?? null,
      shutdownTimeoutMs: this.runtime._shutdownTimeoutMs ?? null
    };
  }

  /**
   * 获取清理钩子链实例（供扩展模块注册自定义钩子）
   */
  getCleanupHooks() {
    return this._cleanupHooks;
  }
}
