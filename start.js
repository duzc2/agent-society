#!/usr/bin/env node
/**
 * Agent Society 服务器启动脚本
 * 
 * 用法:
 *   node start.js [数据目录] [选项]
 *   bun run start-wrapper.mjs [数据目录] [选项]
 * 
 * 选项:
 *   --port, -p <端口>  HTTP 服务器端口 (覆盖配置文件)
 *   --no-browser       不自动打开浏览器
 * 
 * 示例:
 *   node start.js                           # 使用默认配置
 *   node start.js ./my-data                 # 自定义数据目录
 *   node start.js --port 3001               # 自定义端口
 *   node start.js ./my-data -p 3001 --no-browser
 */

/**
 * 全局错误处理
 * 防止未捕获的异常导致进程直接退出
 */
function setupGlobalErrorHandlers() {
  const originalExit = process.exit.bind(process);
  let exitWrapped = false;
  const writeExitCause = (event, details = {}) => {
    try {
      const dataDir = path.resolve(process.env.AGENT_SOCIETY_DATA_DIR || "./agent-society-data");
      const logDir = path.join(dataDir, "logs");
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const logPath = path.join(logDir, "exit-cause.log");
      const line = JSON.stringify({
        time: new Date().toISOString(),
        event,
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        details
      });
      appendFileSync(logPath, line + "\n");
    } catch {}
  };

  if (!exitWrapped) {
    process.exit = ((code = 0) => {
      writeExitCause("PROCESS_EXIT", {
        code,
        stack: new Error("process.exit stack").stack ?? null
      });
      return originalExit(code);
    });
    exitWrapped = true;
  }

  // 未处理的 Promise 拒绝
  process.on('unhandledRejection', (reason, promise) => {
    const reasonObj = /** @type {any} */(reason);
    writeExitCause("UNHANDLED_REJECTION", {
      message: reasonObj?.message ?? String(reason),
      stack: reasonObj?.stack ?? null
    });
    console.error('[FATAL] 未处理的 Promise 拒绝 (unhandledRejection):');
    console.error('  原因:', reasonObj?.message ?? String(reason));
    console.error('  堆栈:', reasonObj?.stack ?? '无堆栈信息');
    // 继续运行，不退出进程
  });

  // 捕获警告
  process.on('warning', (warning) => {
    console.warn('[WARNING] 系统警告:', warning.name, warning.message, warning.stack, warning.code);
  });

  // 处理 SIGTERM 信号
  process.on('SIGTERM', () => {
    writeExitCause("SIGNAL", { signal: "SIGTERM" });
    console.log('\n收到 SIGTERM 信号，正在优雅退出...');
    if (process.listenerCount("SIGTERM") <= 1) {
      process.exit(0);
    }
  });

  // 处理 SIGINT 信号 (Ctrl+C)
  process.on('SIGINT', () => {
    writeExitCause("SIGNAL", { signal: "SIGINT" });
    console.log('\n收到 SIGINT 信号，正在优雅退出...');
    if (process.listenerCount("SIGINT") <= 1) {
      process.exit(0);
    }
  });

  process.on('SIGHUP', () => {
    writeExitCause("SIGNAL", { signal: "SIGHUP" });
    console.log('\n收到 SIGHUP 信号，正在优雅退出...');
    if (process.listenerCount("SIGHUP") <= 1) {
      process.exit(0);
    }
  });

  if (process.platform === "win32") {
    process.on('SIGBREAK', () => {
      writeExitCause("SIGNAL", { signal: "SIGBREAK" });
      console.log('\n收到 SIGBREAK 信号，正在优雅退出...');
      if (process.listenerCount("SIGBREAK") <= 1) {
        process.exit(0);
      }
    });
  }

  // 处理 Worker 线程异常（如果使用）
  if (process.listeners('worker').length === 0) {
    process.on('worker', (worker) => {
      worker.on('error', (error) => {
        console.error('[FATAL] Worker 线程错误:', error);
      });
    });
  }
}

// 立即设置全局错误处理
setupGlobalErrorHandlers();

import { AgentSociety } from "./src/platform/core/agent_society.js";
import { Config } from "./src/platform/utils/config/config.js";
import { Logger, normalizeLoggingConfig } from "./src/platform/utils/logger/logger.js";
import { exec } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

/**
 * 解析命令行参数
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{dataDir: string, port: number|null, openBrowser: boolean}}
 */
export function parseArgs(args) {
  let dataDir = "./agent-society-data";
  let port = null;
  let openBrowser = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      const portStr = args[++i];
      const parsed = parseInt(portStr, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
        port = parsed;
      }
    } else if (arg === "--no-browser") {
      openBrowser = false;
    } else if (!arg.startsWith("-")) {
      dataDir = arg;
    }
  }

  return { dataDir, port, openBrowser };
}

/**
 * 获取打开浏览器的命令
 * @param {string} platform - process.platform
 * @returns {string} 打开浏览器的命令
 */
export function getBrowserCommand(platform) {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "start";
    default:
      return "xdg-open";
  }
}


/**
 * 打开浏览器
 * @param {string} url - 要打开的 URL
 * @returns {Promise<void>}
 */
export async function openBrowserUrl(url, log = console) {
  const cmd = getBrowserCommand(process.platform);

  return new Promise((resolve) => {
    // Windows 的 start 命令需要特殊处理
    const fullCmd = process.platform === "win32"
      ? `${cmd} "" "${url}"`
      : `${cmd} "${url}"`;

    exec(fullCmd, (error) => {
      if (error) {
        void log.warn("无法自动打开浏览器", { error: error?.message, stack: error?.stack, name: error?.name, code: error?.code });
        void log.info("请手动打开浏览器", { url });
      }
      resolve();
    });
  });
}


/**
 * 检测端口是否被占用
 * @param {number} port - 要检测的端口
 * @returns {Promise<boolean>} - true 表示端口被占用
 */
function checkPortInUse(port, log = console) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err) => {
      // @ts-ignore
      if (err.code === "EACCES" || err.code === "EADDRINUSE") {
        resolve(true); // 端口被占用
      } else {
        void log.error("检测端口时发生错误", { port, error: err?.message ?? String(err), stack: err?.stack, name: err?.name, code: err?.code });
        resolve(true); // 其他错误
      }
    });
    
    server.once("listening", () => {
      server.close();
      resolve(false); // 端口可用
    });
    
    server.listen(port, "127.0.0.1");
  });
}

/**
 * 主启动函数
 */
export async function main() {
  const args = process.argv.slice(2);
  const { dataDir, port: cliPort, openBrowser } = parseArgs(args);
  
  // 解析绝对路径
  const absoluteDataDir = path.resolve(dataDir);
  process.env.AGENT_SOCIETY_DATA_DIR = absoluteDataDir;

  // 1. 创建 Config 服务实例
  const configService = new Config("config");
  
  // 2. 加载配置文件
  const config = await configService.loadApp({ dataDir: absoluteDataDir });

  // 2.1 创建日志记录器（基于已加载的日志配置）
  const logger = new Logger(normalizeLoggingConfig(config.logging));
  const log = logger.forModule("startup");

  // 3. 命令行参数覆盖配置文件，默认 3000
  const port = cliPort ?? config.httpPort ?? 3000;

  // 4. 检测端口占用
  const isPortInUse = await checkPortInUse(port, log);
  void log.info(`检测端口 ${port} 占用情况: ${isPortInUse ? "已占用" : "可用"}`);
  // 如果端口被占用，说明服务器已在运行，只打开浏览器
  if (isPortInUse) {
    if (openBrowser) {
      const serverUrl = `http://localhost:${port}/web/`;
      void log.info(`端口 ${port} 已被占用，服务器可能已在运行`);
      void log.info(`正在打开浏览器: ${serverUrl}`);
      await openBrowserUrl(serverUrl, log);
    } else {
      void log.info(`端口 ${port} 已被占用，服务器可能已在运行`);
    }
    process.exit(0);
  }

  void log.info("╔════════════════════════════════════════════════════════════╗");
  void log.info("║           Agent Society Server                             ║");
  void log.info("╚════════════════════════════════════════════════════════════╝");
  void log.info("");
  void log.info(`数据目录: ${absoluteDataDir}`);
  void log.info(`HTTP 端口: ${port}`);
  void log.info("");

  // 确保数据目录存在
  if (!existsSync(absoluteDataDir)) {
    void log.info(`创建数据目录: ${absoluteDataDir}`);
    await mkdir(absoluteDataDir, { recursive: true });
  }

  try {
    // 4. 创建 AgentSociety，传递 Config 服务实例和已加载的配置
    const society = new AgentSociety({
      configService,  // 传递 Config 服务实例（单例）
      config,         // 传递已加载的配置对象
      dataDir: absoluteDataDir,
      enableHttp: true,
      httpPort: port
    });

    await society.init();

    const serverUrl = `http://localhost:${port}/web/`;
    void log.info(`服务器已启动: ${serverUrl}`);
    void log.info("");
    void log.info("按 Ctrl+C 停止服务器");
    void log.info("");

    // 自动打开浏览器
    if (openBrowser) {
      void log.info("正在打开浏览器...");
      await openBrowserUrl(serverUrl, log);
    }

  } catch (error) {
    const message = error?.message ?? String(error);

    void log.error("启动失败", { message, stack: error?.stack, name: error?.name, code: error?.code });
    process.exit(1);
  }
}

const isMain = typeof import.meta.main === "boolean"
  ? import.meta.main
  : process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("启动错误:", err);
    process.exit(1);
  });
}
