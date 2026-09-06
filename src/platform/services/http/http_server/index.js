import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getMimeTypeFromExtension } from "../../../utils/content/content_type_utils.js";
import { openPathInFileManager } from "../../../utils/process/open_in_file_manager.js";
import {
  readJsonBody, sendJson
} from "./utilities.js";


// files.js static file serving now fully handled by Hono serveStatic middleware

import {
  _handleModuleApi
} from "./module-api.js";

// heartbeat routes now auto-registered via registry.declare()
import "./heartbeat.js";

import "./config.js";
import { getErrorMessage } from "../../../utils/error_utils.js";


// message-handlers routes now auto-registered via registry.declare()
import "./message-handlers.js";

import { registry } from "../../../core/module_registry.js";

// 副作用导入：触发 skills.js 中的 registry.declare() 注册模块声明
import "./skills.js";

// org-templates routes now auto-registered via registry.declare()
import "./org-templates.js";
// workspace routes now auto-registered via workspace_manager.js registry.declare()
import "../../../services/workspace/workspace_manager.js";
// 副作用导入：触发工作区文件访问门面服务的 registry.declare() 注册模块声明
import "../../../services/workspace/file_access/workspace_file_access_service.js";
// 工作区文件访问管理 HTTP 路由
import "../../../services/workspace/file_access/routes.js";
// save-eval-script routes now auto-registered from modules/ui_page/
import "../../../../../modules/ui_page/save-eval-script.js";

// agent routes now auto-registered via registry.declare()
import "./agents.js";
// role routes now auto-registered via registry.declare()
import "./roles.js";
// knowledge-tree routes now auto-registered via registry.declare()
import "./knowledge_tree.js";
// mood routes now auto-registered via registry.declare()
import "./mood_routes.js";
// group-chat service auto-registered via registry.declare() (must import before routes)
import "../../group_chat/group_chat_service.js";
// group-chat routes now auto-registered via registry.declare()
import "../../group_chat/group_routes.js";
// proc-messaging routes now auto-registered via registry.declare()（服务器进程消息协议，P4）
import "../../../services/proc_messaging/proc_message_routes.js";
import "../../../services/proc_messaging/proc_message_channel_routes.js";
// proc HTTP bridge routes（网页页面 ⇄ 服务器进程桥接：页面经框架端口 fetch 进程，进程零端口）
import "../../../services/proc_messaging/proc_http_bridge_routes.js";

/**
 * HTTP服务器组件：提供REST API接口与Agent Society交互。
 * 
 * 端点：
 * - POST /api/submit - 提交需求给根智能体
 * - POST /api/send - 发送消息到指定智能体
 * - GET /api/messages/:taskId - 查询任务消息（按taskId）
 * - GET /api/roles - 列出所有岗位及智能体数量（含 toolGroups）
 * - GET /api/tool-groups - 获取所有可用工具组列表
 * - POST /api/role/:roleId/tool-groups - 更新岗位工具组配置
 * - POST /api/role/:roleId/agents - 在指定岗位下创建智能体
 * - GET /api/agent-messages/:agentId - 查询智能体消息（按agentId）
 * - GET /api/agent/:agentId/system-prompt - 获取智能体的完整 system prompt
 * - GET /api/agent/:agentId/system-prompt-appendix - 获取智能体 systemPromptAppendix 条目
 * - PUT /api/agent/:agentId/system-prompt-appendix - 更新智能体 systemPromptAppendix 条目
 * - GET /api/org/role-tree - 获取岗位从属关系树结构
 * - POST /api/agent/:agentId/roles - 为指定智能体创建子岗位
 * - POST /api/agent/:agentId/custom-name - 设置智能体自定义名称
 * - GET /api/agent-custom-names - 获取所有智能体自定义名称
 * - POST /api/role/:roleId/prompt - 更新岗位职责提示词
 * - GET /api/config/status - 获取配置状态
 * - GET /api/config/llm - 获取 LLM 配置
 * - POST /api/config/llm - 保存 LLM 配置
 * - GET /api/config/llm-services - 获取 LLM 服务列表配置
 * - POST /api/config/llm-services - 添加 LLM 服务
 * - POST /api/config/llm-services/:serviceId - 更新 LLM 服务
 * - DELETE /api/config/llm-services/:serviceId - 删除 LLM 服务
 * - GET /api/workspaces - 获取工作空间列表
 * - GET /api/workspaces/:workspaceId - 获取工作空间文件列表
 * - GET /api/workspaces/:workspaceId/file?path=xxx - 获取工作空间文件元数据
 * - POST /api/workspaces/:workspaceId/directory - 创建工作空间目录
 * - GET /api/workspaces/:workspaceId/meta - 获取工作空间元信息
 * - GET /web/* - 静态文件服务
 * - GET /workspace-files/:workspaceId/:filePath - 工作空间文件服务
 * - ANY /api/proc-http/:procName/* - 网页页面 ⇄ 服务器进程 HTTP 桥接（页面经框架端口 fetch 进程，进程零端口）
 */
export class HTTPServer {

  /**
   * @param {{port?:number, society?:any, logger?:any, runtimeDir?:string, configService?:any, workspacesDir?:string, openPathInFileManager?: Function}} options
   */
  constructor(options = {}) {
    this.port = options.port ?? 3000;
    this.society = options.society ?? null;
    this.log = options.logger ;
    this._server = null;
    this._isRunning = false;
    this._runtimeDir = options.runtimeDir ?? null;
    
    // 自定义名称存储
    this._customNames = new Map(); // agentId -> customName
    
    // 配置服务
    this._configService = options.configService ?? null;
    
    // LLM 连接状态跟踪
    this._llmStatus = "unknown"; // "connected" | "disconnected" | "error" | "unknown"
    this._llmLastError = null;

    this._openPathInFileManager = options.openPathInFileManager ?? openPathInFileManager;
  }

  /**
   * 设置配置服务。
   * @param {any} configService - ConfigService 实例
   */
  setConfigService(configService) {
    this._configService = configService;
  }

  /**
   * 设置运行时对象。
   * @param {any} runtime - Runtime 实例
   */
  setRuntime(runtime) {
    this._runtime = runtime;
  }

  /**
   * 设置 LLM 连接状态。
   * @param {"connected"|"disconnected"|"error"} status - 连接状态
   * @param {string|null} error - 错误消息（仅当 status 为 "error" 时）
   */
  setLlmStatus(status, error = null) {
    this._llmStatus = status;
    this._llmLastError = error;
    void this.log.debug("LLM 状态更新", { status, error });
  }

  /**
   * 设置运行时数据目录。
   * workspaceManager 现在由 workspace_manager.js 的 registry.declare 统一管理，不再由 HTTPServer 自行创建。
   * @param {string} runtimeDir
   */
  setRuntimeDir(runtimeDir) {
    this._runtimeDir = runtimeDir;
  }


  /**
   * 获取自定义名称存储文件路径。
   * @returns {string|null}
   */
  _getCustomNamesFilePath() {
    if (!this._runtimeDir) return null;
    return path.join(this._runtimeDir, "web", "custom-names.json");
  }

  /**
   * 加载自定义名称配置。
   * @returns {Promise<void>}
   */
  async _loadCustomNames() {
    const filePath = this._getCustomNamesFilePath();
    if (!filePath) return;

    try {
      if (!existsSync(filePath)) {
        return;
      }
      const content = await readFile(filePath, "utf8");
      const data = JSON.parse(content);
      this._customNames.clear();
      for (const [agentId, customName] of Object.entries(data)) {
        if (customName && typeof customName === "string") {
          this._customNames.set(agentId, customName);
        }
      }
      void this.log.debug("加载自定义名称", { count: this._customNames.size });
    } catch (err) {
      void this.log.warn("加载自定义名称失败", { error: err.message, stack: err.stack });
    }
  }

  /**
   * 保存自定义名称配置。
   * @returns {Promise<void>}
   */
  async _saveCustomNames() {
    const filePath = this._getCustomNamesFilePath();
    if (!filePath) return;

    try {
      // 确保目录存在
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true });

      const data = Object.fromEntries(this._customNames);
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
      void this.log.debug("保存自定义名称", { count: this._customNames.size });
    } catch (err) {
      void this.log.error("保存自定义名称失败", { error: err.message, stack: err.stack });
      throw err;
    }
  }

  /**
   * 设置智能体自定义名称。
   * @param {string} agentId - 智能体ID
   * @param {string} customName - 自定义名称（空字符串表示清除）
   * @returns {Promise<void>}
   */
  async setCustomName(agentId, customName) {
    if (customName && typeof customName === "string" && customName.trim()) {
      this._customNames.set(agentId, customName.trim());
    } else {
      this._customNames.delete(agentId);
    }
    await this._saveCustomNames();
  }

  /**
   * 获取智能体自定义名称。
   * @param {string} agentId - 智能体ID
   * @returns {string|null} 自定义名称，如果没有则返回null
   */
  getCustomName(agentId) {
    return this._customNames.get(agentId) || null;
  }


  /**
   * 获取所有自定义名称。
   * @returns {object} agentId -> customName 映射
   */
  getAllCustomNames() {
    return Object.fromEntries(this._customNames);
  }









  /**
   * 设置关联的AgentSociety实例。
   * @param {any} society
   */
  async setSociety(society) {
    this.society = society;

    // 监听错误事件 → 通过心跳推送给所有客户端
    if (society.runtime && typeof society.runtime.onError === "function") {
      society.runtime.onError((event) => {
        const broker = society.runtime.heartbeatBroker;
        if (broker) {
          broker.broadcast('error_event', event);
        }
      });
    }

    // 监听 LLM 重试事件 → 通过心跳推送给所有客户端
    if (society.runtime && typeof society.runtime.onLlmRetry === "function") {
      society.runtime.onLlmRetry((event) => {
        const broker = society.runtime.heartbeatBroker;
        if (broker) {
          broker.broadcast('retry_event', event);
        }
      });
    }

    // 初始化 Hono 应用基础设施
    this._setupHonoApp(society);

    // 向注册表提供 app 和 log 及各模块依赖，触发所有已声明的模块自动初始化
    // configService / llmStatus / llmLastError 通过 getter 传入，因为这些值在 setSociety 之后才被设置

    await registry.provide({
      app: this._app,
      log: this.log,
      society: this.society,
      configService: this._configService,
      llmStatus: this._llmStatus,
      llmLastError: this._llmLastError,
      moduleLoader: this.society?.runtime?.moduleLoader ?? null,
      toolGroupManager: this.society?.runtime?.toolGroupManager ?? null,
      logRoot: this.society?.runtime?.loggerRoot ?? null,
      heartbeatBroker: this.society?.runtime?.heartbeatBroker ?? null,
      bus: this.society?.runtime?.bus ?? null,
      org: this.society?.runtime?.org ?? null,
      workspacesDir: this.society?.runtime?.config?.workspacesDir ?? null,
      dataDir: this.society?.runtime?.dataDir ?? null,
      runtimeDir: this._runtimeDir,
      orgTemplatesSystem: this.society?.runtime?.orgTemplates ?? null,
      knowledgeTreeSystem: this.society?.runtime?.knowledgeTree ?? null
    });
    await registry.ensureReady();

    // 工具执行器延迟到首次调用时才读取 runtime.workspaceFileAccessService，
    // 因此这里只需在服务激活后挂载，供 FileTools / document 模块统一使用。
    const runtime = this.society?.runtime;
    if (runtime) {
      runtime.workspaceFileAccessService = registry.getService("workspaceFileAccessService");
      // 注入 DI 服务到 ToolExecutor 和 AgentTools（避免 registry.getService 调用）
      runtime._toolExecutor.groupTools = registry.getService("groupTools");
      runtime._toolExecutor.agentTools.groupChatService = registry.getService("groupChatService");
    }
  }


  /**
   * 初始化 Hono 应用基础设施。
   * 包含 CORS 中间件、静态文件服务。
   * @param {any} _society
   */
  _setupHonoApp(_society) {
    this._app = new Hono();

    // 全局 CORS 中间件
    this._app.use('*', cors());

    // 阻止访问系统内部目录 .versions
    this._app.use('*', async (c, next) => {
      const url = new URL(c.req.url);
      const segments = url.pathname.split('/');
      if (segments.includes('.versions')) {
        return c.text('Not Found', 404);
      }
      await next();
    });

    // 模块面板静态文件不缓存：改前端代码后浏览器刷新即可生效，避免旧版本残留
    this._app.use('/modules/*', async (c, next) => {
      await next();
      c.res.headers.set('Cache-Control', 'no-cache');
    });

    // 静态文件路由
    // @hono/node-server serveStatic 不会自动去除路由前缀，必须用 rewriteRequestPath 矫正路径
    this._app.get('/*', serveStatic({ root: './'}));
    this._app.get('/modules/*', serveStatic({ root: './modules', rewriteRequestPath: (p) => p.replace(/^\/modules/, '') }));
  }

  /**
   * 双分发请求处理：先尝试 Hono，未匹配则回退到旧 router。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async _handleRequestWithHono(req, res) {
    const urlStr = `http://127.0.0.1:${this.port}${req.url ?? '/'}`;
    const method = req.method?.toUpperCase() ?? 'GET';

    // 构建 Web Request headers
    const webHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (value != null) {
        if (Array.isArray(value)) {
          for (const v of value) webHeaders.append(key, v);
        } else {
          webHeaders.set(key, String(value));
        }
      }
    }

    // 对于非 GET/HEAD 请求，缓冲 body 供 Hono handler 读取。
    // 若 Hono 未匹配（404）需要回退，则通过 Readable.from 重建 stream 给旧 router。
    let bodyBuffer = null;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        bodyBuffer = Buffer.concat(chunks);
      } catch (err) {
        void this.log.error("读取请求 body 失败", {
          url: req.url,
          method: req.method,
          error: err?.message ?? String(err),
          stack: err?.stack
        });
        sendJson(res, 400, { error: "body_read_failed", message: err?.message ?? String(err) });
        return;
      }
    }

    const init = { method, headers: webHeaders };
    if (bodyBuffer && bodyBuffer.length > 0) {
      init.body = bodyBuffer;
    }
    const webReq = new Request(urlStr, init);

    try {
      const webRes = await this._app.fetch(webReq);

      // 如果 Hono 返回 404，检查是否是模块 API 回退
      if (webRes.status === 404) {
        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        const pathname = reqUrl.pathname;
        if (pathname.startsWith("/api/modules")) {
          if (bodyBuffer && bodyBuffer.length > 0) {
            _injectBodyToRequest(req, bodyBuffer);
          }
          try {
            await _handleModuleApi(req, res, method, pathname, this.society);
          } catch (err) {
            void this.log.error("处理模块 API 请求失败", { pathname, error: err.message, stack: err.stack });
            sendJson(res, 500, { error: "internal_error", message: err.message });
          }
        } else {
          sendJson(res, 404, { error: "not_found", path: pathname });
        }
        return;
      }

      // 发送 Hono 响应
      const resHeaders = {};
      webRes.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'transfer-encoding') {
          resHeaders[key] = value;
        }
      });
      res.writeHead(webRes.status, resHeaders);

      if (method !== 'HEAD' && webRes.status !== 204 && webRes.status !== 304) {
        const body = await webRes.arrayBuffer();
        res.end(Buffer.from(body));
      } else {
        res.end();
      }
    } catch (err) {
      void this.log.error("Hono 分发异常", {
        url: req.url,
        method: req.method,
        error: err?.message ?? String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });

      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
      const pathname = reqUrl.pathname;

      if (pathname.startsWith("/api/modules")) {
        if (bodyBuffer && bodyBuffer.length > 0) {
          _injectBodyToRequest(req, bodyBuffer);
        }
        try {
          await _handleModuleApi(req, res, method, pathname, this.society);
        } catch (moduleErr) {
          void this.log.error("模块 API 回退处理也失败", {
            url: req.url,
            method: req.method,
            error: moduleErr?.message ?? String(moduleErr),
            stack: moduleErr?.stack
          });
          try {
            sendJson(res, 500, { error: "internal_error", message: moduleErr?.message ?? String(moduleErr) });
          } catch (sendErr) {
            void this.log.error("发送错误响应失败", { error: sendErr?.message, stack: sendErr?.stack });
          }
        }
      } else {
        try {
          sendJson(res, 500, { error: "internal_error", message: err?.message ?? String(err) });
        } catch (sendErr) {
          void this.log.error("发送错误响应失败", { error: sendErr?.message, stack: sendErr?.stack });
        }
      }
    }
  }

  /**
   * 启动HTTP服务器。
   * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
   */
  async start() {
    if (this._isRunning) {
      return { ok: true, port: this.port };
    }

    // 加载自定义名称
    await this._loadCustomNames();

    return new Promise((resolve) => {
      try {
        this._server = createServer((req, res) => {
          this._handleRequestWithHono(req, res).catch(err => {
            void this.log.error("处理请求时发生异常", {
              // 业务信息：哪个请求触发了异常
              url: req.url,
              method: req.method,
              headers: {
                contentType: req.headers?.["content-type"],
                userAgent: req.headers?.["user-agent"]
              },
              // 技术信息：异常详情
              error: err?.message ?? String(err),
              stack: err?.stack ?? null,
              name: err?.name,
              code: err?.code
            });
            try {
              sendJson(res, 500, { error: "internal_error", message: err?.message ?? String(err) });
            } catch (sendErr) {
              void this.log.error("发送错误响应失败", {
                url: req.url,
                method: req.method,
                error: sendErr?.message ?? String(sendErr),
                stack: sendErr?.stack,
                name: sendErr?.name,
                code: sendErr?.code
              });
            }
          });
        });

        this._server.on("error", (err) => {
          const message = getErrorMessage(err);
          void this.log.error("HTTP服务器错误", { error: message, stack: err?.stack });
          resolve({ ok: false, error: message });
        });

        this._server.listen(this.port, "127.0.0.1", () => {
          this._isRunning = true;
          void this.log.info("HTTP服务器启动", { host: "127.0.0.1", port: this.port });
          resolve({ ok: true, port: this.port });
        });
      } catch (err) {
        const message = getErrorMessage(err);
        void this.log.error("HTTP服务器启动失败", { error: message, stack: err?.stack });
        resolve({ ok: false, error: message });
      }
    });
  }

  /**
   * 停止HTTP服务器。
   * @returns {Promise<{ok:boolean}>}
   */
  async stop() {
    if (!this._server || !this._isRunning) {
      return { ok: true };
    }

    return new Promise((resolve) => {
      this._server.close((err) => {
        this._isRunning = false;
        if (err) {
          const message = getErrorMessage(err);
          void this.log.error("HTTP服务器关闭错误", { error: message, stack: err?.stack });
          resolve({ ok: false, error: message });
        } else {
          void this.log.info("HTTP服务器已关闭");
          resolve({ ok: true });
        }
      });
    }).then(result => result);
  }

  /**
   * 检查服务器是否正在运行。
   * @returns {boolean}
   */
  isRunning() {
    return this._isRunning;
  }
  // _handleSubmit and _handleSend moved to agents.js Hono routes

  





  /**
   * 处理 GET /api/messages/:taskId - 查询任务消息。
   * @param {string} taskId
   * @param {import("node:http").ServerResponse} res
   */
  /**
   * 处理 GET /api/agent-messages/:agentId - 查询智能体消息。
   * 支持分页: limit, before, around
   * @param {import("node:http").IncomingMessage} req
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/agent-messages/:agentId/search - 搜索智能体消息。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/agent-conversation/:agentId - 获取智能体的对话历史（包含 reasoning_content）。
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   */
  /**
   * 处理更新消息。
   */
  

  /**
   * 处理“重新生成最后一条大模型回复”。
   * 约束：
   * 1. 只允许针对最后一条 assistant 回复；
   * 2. 只允许智能体处于 idle；
   * 3. 先截断会话，再复用现有调度器重新生成。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} agentId
   * @param {string} messageId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理生成回复：对用户最后一条消息生成回复（无需 assistant 消息 ID）。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理删除单条消息。
   */
  

  /**
   * 处理批量删除消息。
   * 【修复2 & 3】改进了删除逻辑（确保一致性）和添加了详细日志
   */
  

  // ==================== Config API Handlers ====================
  /**
   * 获取技能服务。
   * @returns {any|null}
   */
  

  /**
   * 获取自定义技能服务。
   * @returns {any|null}
   */
  

  /**
   * 获取 Git 技能服务。
   * @returns {any|null}
   */
  


  /**
   * 处理 GET /api/custom-skills - 获取自定义技能列表。
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 POST /api/custom-skills - 创建空白自定义技能。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/custom-skills/copy - 复制已有技能为自定义技能。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/custom-skills/:skillId - 获取自定义技能详情。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/custom-skills/:skillId/tree - 获取文件树。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/custom-skills/:skillId/file - 读取文件。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 POST /api/custom-skills/:skillId/file - 创建空文件。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 PUT /api/custom-skills/:skillId/file - 写入文件。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/custom-skills/:skillId/folder - 创建子文件夹。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 DELETE /api/custom-skills/:skillId/entry - 删除文件或文件夹。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/custom-skills/:skillId/entry/rename - 重命名文件或文件夹。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/custom-skills/:skillId/status - 更新启停状态。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/custom-skills/:skillId/open - 调用系统文件管理器打开技能目录。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 DELETE /api/custom-skills/:skillId - 删除技能。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/git-skills - 获取 git 导入技能列表。
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 POST /api/git-skills/import - 从 git 地址导入技能。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/git-skills/:id/update - 更新（pull）git 技能。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/git-skills/:id/file - 读取 git 技能文件内容。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 POST /api/git-skills/:id/status - 更新 git 技能启停状态。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/git-skills/:id - 获取 git 技能详情。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 DELETE /api/git-skills/:id - 删除 git 技能。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/skills - 获取技能浏览列表。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/skills/runtime - 获取技能运行时信息。
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 POST /api/skills/install - 安装技能。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 POST /api/skills/uninstall - 卸载技能。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/skills/:skillId - 获取技能总览。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/skills/:skillId/content - 获取技能详细内容。
   * @param {string} skillId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 GET /api/role/:roleId/skills - 获取岗位技能配置视图。
   * @param {string} roleId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 PUT /api/role/:roleId/skills - 更新岗位技能配置。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} roleId
   * @param {import("node:http").ServerResponse} res
   */
  

  /**
   * 处理 GET /api/agent/:agentId/skills - 获取智能体技能配置视图。
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  

  /**
   * 处理 PUT /api/agent/:agentId/skills - 更新智能体技能配置。
   * @param {import("node:http").IncomingMessage} req
   * @param {string} agentId
   * @param {import("node:http").ServerResponse} res
   */
}

/**
 * 将 body buffer 注入到已结束的 Node.js IncomingMessage stream 中。
 * 过渡期工具：Hono 消费 body 后若需回退到旧 router，用此函数重建 body 流。
 * @param {import("node:http").IncomingMessage} req
 * @param {Buffer} bodyBuffer
 */
function _injectBodyToRequest(req, bodyBuffer) {
  const bodyStream = Readable.from(bodyBuffer);
  const origOn = req.on.bind(req);
  req.on = function (event, listener) {
    if (event === 'data' || event === 'end') {
      bodyStream.on(event, listener);
      return this;
    }
    return origOn(event, listener);
  };
}

// All HTTP handlers are now registered via registry.declare() in their respective module files.
// _handleModuleApi is called directly from _handleRequestWithHono for module API fallback.
// _injectBodyToRequest is a transitional utility for re-injecting buffered body to Node.js streams.

