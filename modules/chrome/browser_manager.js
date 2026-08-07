/**
 * 浏览器管理器
 * 负责 Chrome 浏览器实例的启动、关闭和生命周期管理。
 * 每个智能体对应一个浏览器实例，自动管理。
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * 延迟指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @typedef {object} BrowserInstance
 * @property {string} agentId - 所属智能体ID
 * @property {import('puppeteer-core').Browser} browser - Puppeteer Browser 对象
 * @property {string} createdAt - 创建时间 ISO 字符串
 * @property {string} status - 状态: 'running' | 'closed'
 * @property {{server?: string, username?: string, password?: string}|null} proxy - 代理配置
 * @property {string|null} userDataDir - 用户数据目录路径
 * @property {number} tabCount - 当前标签页数量
 */

export class BrowserManager {
  /**
   * @param {{log: any, config: object, lifecycleRegistry: any}} options
   */
  constructor(options) {
    this.log = options.log;
    this.config = options.config;
    this._lifecycleRegistry = options.lifecycleRegistry;
    /** @type {Map<string, BrowserInstance>} */
    this._browsers = new Map(); // key: agentId
  }

  /**
   * 查找 Chrome 可执行文件路径
   * @returns {string}
   */
  _findChromePath() {
    const platform = process.platform;
    
    if (platform === "win32") {
      const paths = [
        process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["PROGRAMFILES"] + "\\Google\\Chrome\\Application\\chrome.exe",
        process.env["LOCALAPPDATA"] + "\\Google\\Chrome\\Application\\chrome.exe"
      ];
      for (const p of paths) {
        if (p && existsSync(p)) return p;
      }
    } else if (platform === "darwin") {
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    } else {
      // Linux
      const paths = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
      ];
      for (const p of paths) {
        if (existsSync(p)) return p;
      }
    }
    
    return "chrome"; // 回退到 PATH 中的 chrome
  }

  /**
   * 获取或创建指定智能体的浏览器实例
   * 如果该智能体还没有浏览器，则自动启动一个（使用配置文件设置）
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean, browserId: string, createdAt: string, isNew: boolean} | {error: string, message: string}>}
   */
  async getOrCreateBrowser(agentId) {
    // 检查是否已有浏览器实例
    const existing = this._browsers.get(agentId);
    if (existing && existing.status === "running") {
      return {
        ok: true,
        browserId: agentId, // 使用 agentId 作为 browserId
        createdAt: existing.createdAt,
        isNew: false
      };
    }

    // 启动新浏览器（使用配置文件设置）
    return await this._launchBrowser(agentId);
  }

  /**
   * 启动新的浏览器实例（内部方法）
   * 使用配置文件中的 headless 设置
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean, browserId: string, createdAt: string, isNew: boolean} | {error: string, message: string}>}
   * @private
   */
  async _launchBrowser(agentId) {
    const headless = this.config.headless ?? true;
    const defaultProxy = this.config.proxy ?? {};

    this.log.debug("[_launchBrowser] 配置检查", { 
      agentId, 
      configHeadless: this.config.headless,
      finalHeadless: headless
    });
    const chromePath = this._findChromePath();

    // 构建 Chrome 用户数据目录路径（从配置获取）
    let userDataDir = null;
    if (this.config.dataDir) {
      userDataDir = path.resolve(this.config.dataDir, "agents", agentId, "chrome");
      if (!existsSync(userDataDir)) {
        mkdirSync(userDataDir, { recursive: true });
      }
    }

    this.log.info("启动浏览器", { agentId, headless, chromePath, userDataDir });

    try {
      // 构建启动参数
      const args = [
        "--start-maximized"  // 启动时最大化窗口
      ];

      // 添加代理配置（enabled 未设置时，按 server 是否为空判断）
      const proxyEnabled = defaultProxy.enabled ?? (!!defaultProxy.server);
      if (proxyEnabled && defaultProxy.server) {
        args.push(`--proxy-server=${defaultProxy.server}`);
        this.log.info("使用代理服务器", { server: defaultProxy.server });
      }

      const launchOptions = {
        headless: /** @type {boolean} */(headless ? true : false),
        executablePath: chromePath,
        args
      };

      if (userDataDir) {
        launchOptions.userDataDir = userDataDir;
      }

      const browser = await puppeteer.launch(launchOptions);

      // 如果有代理认证信息，设置认证
      const proxyEnabledForAuth = defaultProxy.enabled ?? (!!defaultProxy.server);
      if (proxyEnabledForAuth && defaultProxy.server && defaultProxy.username && defaultProxy.password) {
        const pages = await browser.pages();
        for (const page of pages) {
          await page.authenticate({
            username: defaultProxy.username,
            password: defaultProxy.password
          });
        }
        this.log.info("已设置代理认证");
      }

      const instance = {
        agentId,
        browser,
        createdAt: new Date().toISOString(),
        status: "running",
        proxy: ((defaultProxy.enabled ?? (!!defaultProxy.server)) && defaultProxy.server) ? defaultProxy : null,
        userDataDir,
        tabCount: 0
      };

      this._browsers.set(agentId, instance);

      // 监听浏览器断开连接
      browser.on("disconnected", async () => {
        await this._handleBrowserDisconnected(agentId);
      });

      // 注册到生命周期注册表
      const resourceId = `chrome:${agentId}`;
      try {
        this._lifecycleRegistry.register({
          id: resourceId,
          type: 'chrome',
          ownerAgentId: agentId,
          cleanup: () => browser.close()
        });
      } catch (e) {
        this.log.warn("浏览器生命周期注册失败", { agentId, error: e?.message, stack: e?.stack });
      }

      this.log.info("浏览器启动成功", { agentId });

      return {
        ok: true,
        browserId: agentId,
        createdAt: instance.createdAt,
        isNew: true
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      this.log.error("浏览器启动失败", { agentId, error: message, stack: err?.stack });
      return {
        error: "browser_launch_failed",
        message
      };
    }
  }

  /**
   * 处理浏览器断开连接
   * @param {string} agentId - 智能体ID
   * @private
   */
  async _handleBrowserDisconnected(agentId) {
    const instance = this._browsers.get(agentId);
    if (!instance) return;

    // 获取进程 PID 并等待其完全退出
    const browserProcess = instance.browser?.process();
    const pid = browserProcess?.pid;
    
    if (pid) {
      await this._waitForProcessExit(pid, 3000);
    } else {
      await delay(500);
    }

    // 注意：不删除用户数据目录，保留浏览器数据（cookies、localStorage 等）
    // 用户数据目录应在智能体被删除时才清理

    this._browsers.delete(agentId);

    // 从生命周期注册表注销
    try {
      await this._lifecycleRegistry.unregister(`chrome:${agentId}`);
    } catch (e) {
      this.log.debug("浏览器生命周期注销（断开），正常", { agentId });
    }

    this.log.info("浏览器已断开连接", { agentId });
  }

  /**
   * 更新标签页计数
   * @param {string} agentId - 智能体ID
   * @param {number} delta - 变化量（+1 或 -1）
   * @returns {number} 更新后的标签页数量
   */
  updateTabCount(agentId, delta) {
    const instance = this._browsers.get(agentId);
    if (!instance) return 0;

    instance.tabCount = Math.max(0, (instance.tabCount || 0) + delta);
    return instance.tabCount;
  }

  /**
   * 获取标签页数量
   * @param {string} agentId - 智能体ID
   * @returns {number}
   */
  getTabCount(agentId) {
    const instance = this._browsers.get(agentId);
    return instance?.tabCount ?? 0;
  }

  /**
   * 关闭指定的浏览器实例
   * 确保 Chrome 进程被完全终止，释放 userDataDir 占用
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean} | {error: string, message: string}>}
   */
  async close(agentId) {
    const instance = this._browsers.get(agentId);
    
    if (!instance) {
      return { error: "browser_not_found", message: `智能体 ${agentId} 没有运行中的浏览器` };
    }

    this.log.info("关闭浏览器", { agentId });

    try {
      // 获取 Chrome 进程 PID（如果可用）
      const browserProcess = instance.browser?.process();
      const pid = browserProcess?.pid;

      if (instance.status === "running") {
        // 先尝试优雅关闭
        await instance.browser.close();
      }
      instance.status = "closed";
      
      // 等待 Chrome 进程完全退出
      if (pid) {
        await this._waitForProcessExit(pid, 3000); // 最多等待3秒
      } else {
        // 没有 PID，使用固定延迟
        await delay(500);
      }
      
      // 注意：不删除用户数据目录，保留浏览器数据（cookies、localStorage 等）
      // 用户数据目录应在智能体被删除时才清理
      
      this._browsers.delete(agentId);

      // 从生命周期注册表注销
      try {
        await this._lifecycleRegistry.unregister(`chrome:${agentId}`);
      } catch (e) {
        this.log.debug("浏览器生命周期注销，正常", { agentId });
      }

      this.log.info("浏览器已关闭", { agentId });
      return { ok: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      this.log.error("浏览器关闭失败", { agentId, error: message });
      this._browsers.delete(agentId);
      return { error: "browser_close_failed", message };
    }
  }

  /**
   * 等待 Chrome 进程完全退出
   * @param {number} pid - 进程 ID
   * @param {number} timeoutMs - 最大等待时间（毫秒）
   * @private
   */
  async _waitForProcessExit(pid, timeoutMs = 3000) {
    // 防止重复：正在等待同一 PID 时跳过
    this._waitingPids = this._waitingPids || new Set();
    if (this._waitingPids.has(pid)) return;
    this._waitingPids.add(pid);

    try {
      const checkInterval = 100; // 每 100ms 检查一次
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        if (!this._isProcessRunning(pid)) {
          this.log.debug("Chrome 进程已退出", { pid });
          return;
        }
        await delay(checkInterval);
      }

      // 进程仍未退出，尝试强制终止
      this.log.warn("Chrome 进程未正常退出，尝试强制终止", { pid });
      this._killProcess(pid);
    } finally {
      this._waitingPids.delete(pid);
    }
  }

  /**
   * 检查进程是否仍在运行
   * @param {number} pid - 进程 ID
   * @returns {boolean}
   * @private
   */
  _isProcessRunning(pid) {
    try {
      // Windows: 使用 tasklist 检查进程
      if (process.platform === "win32") {
        try {
          execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { stdio: "pipe" });
          return true; // 命令成功执行，说明进程存在
        } catch {
          return false; // 命令失败，进程不存在
        }
      } else {
        // Unix: 使用 kill -0 检查进程
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

  /**
   * 强制终止进程
   * @param {number} pid - 进程 ID
   * @private
   */
  _killProcess(pid) {
    try {
      if (process.platform === "win32") {
        // Windows: 使用 taskkill
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { stdio: "pipe" });
          this.log.info("已强制终止 Chrome 进程", { pid });
        } catch (err) {
          this.log.warn("强制终止进程失败", { pid, error: err?.message });
        }
      } else {
        // Unix: 使用 kill -9
        try {
          process.kill(pid, "SIGKILL");
          this.log.info("已强制终止 Chrome 进程", { pid });
        } catch (err) {
          this.log.warn("强制终止进程失败", { pid, error: err?.message });
        }
      }
    } catch (err) {
      this.log.warn("终止进程时出错", { pid, error: err?.message });
    }
  }

  /**
   * 关闭所有浏览器实例
   * @returns {Promise<void>}
   */
  async closeAll() {
    this.log.info("关闭所有浏览器", { count: this._browsers.size });
    
    const closePromises = [];
    for (const [agentId] of this._browsers) {
      closePromises.push(this.close(agentId));
    }
    
    await Promise.allSettled(closePromises);
    this._browsers.clear();
  }

  /**
   * 获取浏览器实例
   * @param {string} agentId - 智能体ID
   * @returns {BrowserInstance|null}
   */
  getBrowser(agentId) {
    return this._browsers.get(agentId) ?? null;
  }

  /**
   * 获取 Puppeteer Browser 对象
   * @param {string} agentId - 智能体ID
   * @returns {import('puppeteer-core').Browser|null}
   */
  getPuppeteerBrowser(agentId) {
    const instance = this._browsers.get(agentId);
    return instance?.browser ?? null;
  }

  /**
   * 列出所有浏览器实例
   * @returns {Array<{id: string, agentId: string, createdAt: string, status: string, tabCount: number}>}
   */
  listBrowsers() {
    const list = [];
    for (const [agentId, instance] of this._browsers) {
      list.push({
        id: agentId, // 前端需要 id 字段
        agentId,
        createdAt: instance.createdAt,
        status: instance.status,
        tabCount: instance.tabCount
      });
    }
    return list;
  }

  /**
   * 获取浏览器数量
   * @returns {number}
   */
  getBrowserCount() {
    return this._browsers.size;
  }

  /**
   * 清理指定智能体的用户数据目录
   * 应在智能体被删除时调用
   * @param {string} agentId - 智能体ID
   * @returns {Promise<{ok: boolean} | {error: string, message: string}>}
   */
  async cleanupAgentData(agentId) {
    // 如果浏览器还在运行，先关闭
    const instance = this._browsers.get(agentId);
    if (instance) {
      const closeResult = await this.close(agentId);
      if (closeResult.error) {
        return closeResult;
      }
    }

    // 删除用户数据目录
    if (this.config.dataDir) {
      const userDataDir = path.resolve(this.config.dataDir, "agents", agentId, "chrome");
      if (existsSync(userDataDir)) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
          this.log.info("已清理智能体用户数据目录", { agentId, userDataDir });
        } catch (err) {
          const message = err?.message ?? String(err);
          this.log.error("清理智能体数据失败", { agentId, userDataDir, error: message });
          return { error: "cleanup_failed", message };
        }
      }
    }

    return { ok: true };
  }
}
