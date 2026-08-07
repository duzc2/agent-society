/**
 * 子进程工具模块
 * 
 * 提供跨平台的子进程创建和管理功能。
 * 支持后台静默运行，IO 流监听。
 * 
 * @module utils/process/subprocess
 */

import { spawn, execSync } from "node:child_process";
import process from "node:process";

/**
 * 跨平台子进程创建选项
 * @typedef {Object} SubprocessOptions
 * @property {string} [cwd] - 工作目录
 * @property {Object} [env] - 环境变量
 * @property {boolean} [detached] - 是否分离进程
 * @property {boolean} [shell] - 是否在 shell 中运行
 */

/**
 * 子进程结果
 * @typedef {Object} SubprocessResult
 * @property {import('node:child_process').ChildProcess} process - 子进程对象
 * @property {Promise<number>} exitPromise - 进程退出 Promise，resolve 退出码
 */

/**
 * 根据平台构建 venv 激活命令
 * @param {string} venvPath - 虚拟环境路径（相对于项目根目录）
 * @param {string} platform - 平台标识
 * @returns {string} 激活命令
 */
export function buildVenvActivateCommand(venvPath, platform) {
  const normalizedPath = venvPath.replace(/\//g, platform === "win32" ? "\\" : "/");
  
  if (platform === "win32") {
    // Windows 优先使用 cmd.exe 的激活脚本
    return `${normalizedPath}\\Scripts\\activate.bat`;
  } else {
    // Unix-like
    return `source ${normalizedPath}/bin/activate`;
  }
}

/**
 * 构建完整的启动命令
 * @param {string} venvPath - 虚拟环境路径
 * @param {string} modulesPath - llm-modules 路径
 * @param {string} platform - 平台标识
 * @returns {{command: string, args: string[]}} 命令和参数
 */
export function buildLaunchCommand(venvPath, modulesPath, platform) {
  const activateCmd = buildVenvActivateCommand(venvPath, platform);
  
  // 使用 && 串联命令：激活 -> 安装 -> 启动
  // 注意：modulesPath 是相对于 cwd 的，所以 python 命令直接用即可
  const commandChain = platform === "win32"
    ? `${activateCmd} && python install_deps.py && python start.py`
    : `${activateCmd} && python install_deps.py && python start.py`;
  
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", commandChain]
    };
  } else {
    return {
      command: "bash",
      args: ["-c", commandChain]
    };
  }
}

/**
 * 创建后台子进程
 * @param {string} command - 命令
 * @param {string[]} args - 参数
 * @param {SubprocessOptions} options - 选项
 * @returns {SubprocessResult} 子进程结果
 */
export function createSubprocess(command, args, options = {}) {
  const { cwd, env = process.env, detached = false, shell = false } = options;

  // 设置 Python IO 编码为 UTF-8，避免 Windows 默认 GBK 编码问题
  // 同时设置 PYTHONUNBUFFERED 确保日志及时输出
  const envWithEncoding = {
    ...env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1"
  };

  const child = spawn(command, args, {
    cwd,
    env: envWithEncoding,
    detached,
    shell,
    // Windows 隐藏窗口
    windowsHide: true,
    // 标准 IO 管道，方便监听
    stdio: ["ignore", "pipe", "pipe"]
  });

  // 自动排泄 stdout/stderr 管道，防止子进程因管道缓冲区满（64KB）而阻塞
  // 同时收集输出供调用方读取
  let stdout = "";
  let stderr = "";

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    // 防止未处理的 stream error 导致进程崩溃
    child.stdout.on("error", () => {});
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stderr.on("error", () => {});
  }

  // 创建退出 Promise
  const exitPromise = new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });

    child.on("error", (err) => {
      reject(err);
    });
  });

  return {
    process: child,
    exitPromise,
    /** 获取已收集的 stdout 内容 */
    getStdout: () => stdout,
    /** 获取已收集的 stderr 内容 */
    getStderr: () => stderr,
  };
}

/**
 * 终止子进程（跨平台）
 * 
 * Windows 策略：
 * 1. 优先使用 taskkill /T /F 终止整个进程树
 * 2. 如果失败，尝试直接 kill
 * 
 * Unix 策略：
 * 1. 先发送 SIGTERM
 * 2. 超时后发送 SIGKILL
 * 
 * @param {import('node:child_process').ChildProcess} childProcess - 子进程
 * @param {number} timeout - 等待超时（毫秒）
 * @returns {Promise<void>}
 */
export async function killSubprocess(childProcess, timeout = 5000) {
  if (!childProcess || childProcess.killed) {
    return;
  }
  
  return new Promise((resolve) => {
    let resolved = false;
    
    // 监听进程退出
    const onExit = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    
    childProcess.on("exit", onExit);
    childProcess.on("close", onExit);
    
    if (process.platform === "win32") {
      // Windows: 使用 taskkill /T /F 强制终止整个进程树
      import("node:child_process").then(({ exec }) => {
        const pid = childProcess.pid;
        if (!pid) {
          onExit();
          return;
        }
        
        // /T - 终止进程树（包括所有子进程）
        // /F - 强制终止
        exec(`taskkill /pid ${pid} /T /F`, (err) => {
          if (err) {
            // taskkill 失败，尝试直接 kill
            try {
              childProcess.kill("SIGTERM");
            } catch {
              // ignore
            }
          }
          // 无论成功与否，等待一段时间后 resolve
          setTimeout(onExit, 500);
        });
        
        // 超时保险
        setTimeout(() => {
          if (!resolved) {
            try {
              childProcess.kill("SIGKILL");
            } catch {
              // ignore
            }
            onExit();
          }
        }, timeout);
      });
    } else {
      // Unix: 先发送 SIGTERM
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      
      // 超时后发送 SIGKILL
      setTimeout(() => {
        if (!resolved) {
          try {
            childProcess.kill("SIGKILL");
          } catch {
            // ignore
          }
          onExit();
        }
      }, timeout);
    }
  });
}

/**
 * 同步终止子进程（用于 exit 事件等同步上下文）
 * 
 * 注意：此函数会阻塞直到命令完成或超时
 * 
 * @param {number} pid - 进程 PID
 * @param {number} timeout - 超时（毫秒）
 */
export function killSubprocessSync(pid, timeout = 3000) {
  if (!pid) {
    return;
  }
  
  if (process.platform === "win32") {
    try {
      // 强制终止整个进程树
      execSync(`taskkill /pid ${pid} /T /F`, { 
        timeout: timeout,
        windowsHide: true 
      });
    } catch {
      // 命令失败（可能进程已退出），忽略错误
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");  // 负号表示进程组
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}
