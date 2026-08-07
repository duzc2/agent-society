import { randomUUID } from "node:crypto";
import path from "node:path";
import { Agent } from "../../agents/agent.js";
import { Runtime } from "./runtime.js";
import { HTTPServer } from "../services/http/http_server.js";
import { Config } from "../utils/config/config.js";
import { getErrorMessage } from "../utils/error_utils.js";
import { AutoReplyManager } from "../runtime/auto_reply.js";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";


/**
 * 面向"用户"的系统入口：隐藏运行时与根智能体的构建细节。
 * 用户只需要：
 * 1) 提交自然语言需求给根智能体；
 * 2) 通过用户端点智能体发送消息到指定智能体，并接收异步回传。
 */
export class AgentSociety {
  /**
   * @param {{config?:object, configService?:Config, maxSteps?:number, httpPort?:number, enableHttp?:boolean, shutdownTimeoutMs?:number, dataDir?:string}} [options]
   */
  constructor(options = {}) {
    // 要求传入 Config 服务实例
    if (!options.configService) {
      throw new Error("AgentSociety 构造函数必须传入 configService 参数");
    }
    
    this._configService = options.configService;
    
    // 将 Config 服务传递给 Runtime
    this.runtime = new Runtime({
      ...options,
      configService: this._configService
    });
    
    this._dataDir = options.dataDir ?? null;
    this._userInbox = [];
    this._userMessageListeners = new Set();
    this.log = this.runtime.loggerRoot.forModule("society");
    this._rootPrompt = null;
    this._httpPort = options.httpPort ?? 3000;
    this._enableHttp = options.enableHttp ?? false;
    this._httpServer = null;
    this._shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30000;
    this._autoReplyManager = null;
  }

  /**
   * 初始化系统：加载配置、初始化平台能力，并创建根智能体与用户端点。
   * @returns {Promise<void>}
   */
  async init() {
    await this.log.info("系统初始化开始");
    await this.runtime.init();
    this.log = this.runtime.loggerRoot.forModule("society");
    this._rootPrompt = await this.runtime.prompts.loadSystemPromptFile("root.txt");
    
    this._registerUserEndpointAgent();
    this._registerRootAgent();
    
    // 启动HTTP服务器（如果启用）
    if (this._enableHttp) {
      await this._startHttpServer();
    }
    
    // 设置优雅关闭处理
    this.runtime.setupGracefulShutdown({
      httpServer: this._httpServer,
      shutdownTimeoutMs: this._shutdownTimeoutMs ?? 30000
    });
    
    // 启动自动回复管理器
    this._autoReplyManager = new AutoReplyManager(this.runtime);
    this._autoReplyManager.start();

    void this.runtime.startProcessing();
    void this.log.info("系统初始化完成");
  }

  /**
   * 提交自然语言需求描述给根智能体，由根智能体自组织创建组织并启动执行。
   * @param {string} text
   * @param {{workspacePath?: string}} [options] - 可选参数
   * @returns {Promise<{taskId:string, workspacePath?:string}|{error:string}>}
   */
  async submitRequirement(text, options = {}) {
    const taskId = randomUUID();
    void this.log.info("提交需求", { taskId, length: String(text ?? "").length, workspacePath: options.workspacePath ?? null });
    
    // 如果指定了工作空间，绑定到任务
    if (options.workspacePath) {
      const bindResult = await getWorkspaceManager().bindWorkspace(
        taskId, 
        options.workspacePath
      );
      if (!bindResult.ok) {
        void this.log.error("工作空间绑定失败", { taskId, error: bindResult.error, stack: bindResult.error?.stack });
        return { error: bindResult.error };
      }
      void this.log.info("工作空间绑定成功", { taskId, workspacePath: options.workspacePath });
    }
    
    await this.sendTextToAgent("root", String(text ?? ""), { taskId });
    void this.log.info("需求处理结束", { taskId });
    
    const result = { taskId };
    if (options.workspacePath) {
      result.workspacePath = options.workspacePath;
    }
    return result;
  }

  /**
   * 用户向指定智能体发送一条文本消息（不阻塞）。
   * 消息直接发送到目标智能体，不经过用户端点的队列。
   * @param {string} agentId
   * @param {string|Promise<string>|{text:string|Promise<string>, attachments?:any[]}} text
   * @param {{taskId?:string}} [options]
   * @returns {Promise<{taskId:string, to:string, messageId:string}|{error:string}>}
   */
  async sendTextToAgent(agentId, text, options = {}) {
    const toAgentId = String(agentId ?? "").trim();
    if (!toAgentId) {
      return { error: "目标智能体ID不能为空" };
    }
    // 验证目标智能体ID不能是"user"
    if (toAgentId === "user") {
      void this.log.warn("用户尝试发送消息到user端点", { toAgentId });
      return { error: "不能向用户端点发送消息，请指定其他智能体ID" };
    }

    // 禁止向已删除的智能体发送消息
    if (toAgentId !== "root") {
      const targetMeta = this.runtime.org?.getAgent?.(toAgentId) ?? null;
      if (targetMeta && targetMeta.status === "deleted") {
        void this.log.warn("用户尝试发送消息到已删除的智能体", { toAgentId });
        return { error: "目标智能体已被删除，无法发送消息" };
      }
    }
    const taskId = options?.taskId ?? randomUUID();
    
    // 如果 text 是 Promise，等待其解决
    /** @type {string|{text:string|Promise<string>, attachments?:any[]}|Promise<string>} */
    let resolvedText = text;
    // @ts-ignore - 类型判断在运行时进行
    if (text !== null && typeof text === 'object' && typeof text.then === 'function') {
      try {
        // @ts-ignore - 此时 text 是 Promise
        resolvedText = await text;
      } catch (err) {
        void this.log.error("sendTextToAgent 接收到的 Promise 被拒绝", { toAgentId, taskId, error: err?.message, stack: err?.stack, name: err?.name, code: err?.code });
        return { error: `promise_rejected: ${err?.message ?? String(err)}` };
      }
    }
    
    // 构建 payload：支持字符串或带附件的对象
    /** @type {{text:string, attachments?:any[]}} */
    let payload;
    if (typeof resolvedText === 'object' && resolvedText !== null) {
      // 已经是对象格式（带 attachments），直接使用
      // @ts-ignore - 类型判断在运行时进行
      payload = resolvedText;
      // 检查内部 text 字段是否为 Promise
      // @ts-ignore - payload.text 可能为 Promise
      if (payload.text !== null && typeof payload.text === 'object' && typeof payload.text?.then === 'function') {
        try {
          // @ts-ignore - 此时 payload.text 是 Promise
          payload.text = await payload.text;
        } catch (err) {
          void this.log.error("payload.text Promise 被拒绝", { toAgentId, taskId, error: err?.message, stack: err?.stack, name: err?.name, code: err?.code });
          payload.text = "[Error: Promise rejected]";
        }
      }
    } else {
      // 纯文本格式
      payload = { text: String(resolvedText ?? "") };
    }
    
    // 直接发送到目标智能体，from="user"
    const sendResult = this.runtime.bus.send({
      to: toAgentId,
      from: "user",
      taskId,
      payload
    });
    if (sendResult?.rejected) {
      return { error: sendResult.reason ?? "message_rejected" };
    }

    // 立即设置智能体状态为 processing，确保前端不会看到 idle。
    // 调度器是单线程的，可能在调用 _startLlm 为其他智能体做 LLM 初始化时
    // 阻塞整个循环，导致消息虽然已入队但状态未更新。
    // 这里提前设置状态，让用户从发送消息的那一刻起就看到"处理中"。
    this.runtime._state.setAgentComputeStatus(toAgentId, "processing");
    this.runtime._state.setAgentComputePhase(toAgentId, "正在准备...");

    void this.log.info("用户消息已发送", { toAgentId, taskId, hasAttachments: !!(payload.attachments?.length) });
    return {
      taskId,
      to: toAgentId,
      messageId: sendResult?.messageId ?? ""
    };
  }

  /**
   * 为用户注册一个消息回调（接收组织对用户的异步消息）。
   * @param {(message:any)=>void} handler
   * @returns {()=>void} unsubscribe
   */
  onUserMessage(handler) {
    this._userMessageListeners.add(handler);
    return () => this._userMessageListeners.delete(handler);
  }

  /**
   * 等待用户端点收到满足条件的消息。
   * @param {(message:any)=>boolean} predicate
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<any|null>}
   */
  async waitForUserMessage(predicate, options = {}) {
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 0;
    const existingIndex = this._userInbox.findIndex((m) => predicate(m));
    if (existingIndex >= 0) return this._userInbox[existingIndex];

    return await new Promise((resolve) => {
      let done = false;
      const unsub = this.onUserMessage((m) => {
        if (done) return;
        if (!predicate(m)) return;
        done = true;
        unsub();
        resolve(m);
      });

      if (timeoutMs > 0) {
        setTimeout(() => {
          if (done) return;
          done = true;
          unsub();
          resolve(null);
        }, timeoutMs);
      }
    });
  }


  /**
   * 注册一个本地"用户端点智能体"，用于接收组织内智能体发给用户的异步消息。
   * 用户端点只处理 to="user" 的消息（来自组织内智能体），不再处理用户发送的消息转发。
   * @returns {void}
   */
  _registerUserEndpointAgent() {
    const userEndpoint = new Agent({
      id: "user",
      roleId: "user",
      roleName: "user",
      rolePrompt: "",
      behavior: async (ctx, message) => {
        // 用户端点只接收来自组织内智能体的消息（to="user"）
        // 不再处理 from="user" to="user" 的转发逻辑，因为用户消息现在直接发送到目标智能体
        
        const from = String(message?.from ?? "");
        const taskId = String(message?.taskId ?? "");
        const payload = message?.payload ?? null;
        
        // 记录到用户收件箱
        this._userInbox.push(message);
        
        const payloadText = payload && typeof payload === "object" && "text" in payload ? payload.text : null;
        const out = payloadText === null || payloadText === undefined ? JSON.stringify(payload, null, 2) : String(payloadText);

        // 增强日志：显示消息内容
        void this.log.info("用户端点收到消息", { 
          agentId: "user", 
          messageId: message?.id ?? null, 
          from, 
          taskId, 
          payload,
          payloadPreview: out.length > 200 ? out.substring(0, 200) + "..." : out
        });
        process.stdout.write(`[user] from=${from} taskId=${taskId}\n${out}\n`);

        // 通知所有注册的消息监听器
        for (const h of this._userMessageListeners) {
          try {
            h(message);
          } catch (err) {
            void this.log.warn("用户消息监听器执行失败", {
              error: err?.message,
              stack: err?.stack,
              name: err?.name,
              code: err?.code,
            });
          }
        }
      }
    });
    this.runtime.registerAgentInstance(userEndpoint);
  }

  /**
   * 在系统初始化阶段创建根智能体（Root），并将其行为绑定到 LLM 工具调用循环。
   * @returns {void}
   */
  _registerRootAgent() {
    const rootPrompt = this._rootPrompt ?? "";

    this.runtime.registerRoleBehavior("root", () => async () => {});

    const rootAgent = new Agent({
      id: "root",
      roleId: "root",
      roleName: "root",
      rolePrompt: rootPrompt,
      // 从行为注册表中获取行为
      behavior: this.runtime._behaviorRegistry.get("root")(this.runtime._buildAgentContext())
    });
    this.runtime.registerAgentInstance(rootAgent);
  }

  /**
   * 启动HTTP服务器。
   * 如果启动失败，抛出异常（由调用者决定是否退出程序）。
   * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
   */
  async _startHttpServer() {
    try {
      this._httpServer = new HTTPServer({
        port: this._httpPort,
        logger: this.runtime.loggerRoot.forModule("http")
      });

      // 必须在 setSociety 之前注入 configService、runtime 和 runtimeDir，
      // 否则 registry.provide() 会将 null 注入路由处理器，导致运行时崩溃。
      this._httpServer.setConfigService(this._configService);
      this._httpServer.setRuntime(this.runtime);

      if (this.runtime.config?.runtimeDir) {
        this._httpServer.setRuntimeDir(this.runtime.config.runtimeDir);
        void this.log.info("HTTP服务器消息持久化目录已设置", { runtimeDir: this.runtime.config.runtimeDir });
      } else {
        void this.log.warn("HTTP服务器消息持久化目录未设置，消息将不会持久化", {
          configKeys: Object.keys(this.runtime.config ?? {}),
          dataDir: this.runtime.dataDir ?? null
        });
      }

      await this._httpServer.setSociety(this);
      
      const result = await this._httpServer.start();
      
      if (result.ok) {
        void this.log.info("HTTP服务器启动成功", { port: result.port });
        return result;
      } else {
        // HTTP服务器启动失败，抛出异常
        void this.log.error("HTTP服务器启动失败", { error: result.error, port: this._httpPort, stack: result.error?.stack });
        this._httpServer = null;
        throw new Error(`HTTP服务器启动失败: ${result.error}`);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      void this.log.error("HTTP服务器启动异常", { error: message, stack: err?.stack });
      this._httpServer = null;
      // 重新抛出异常，让调用者处理
      throw err;
    }
  }

  /**
   * 停止HTTP服务器。
   * @returns {Promise<{ok:boolean}>}
   */
  async stopHttpServer() {
    if (this._httpServer) {
      const result = await this._httpServer.stop();
      this._httpServer = null;
      return result;
    }
    return { ok: true };
  }

  /**
   * 获取HTTP服务器实例。
   * @returns {HTTPServer|null}
   */
  getHttpServer() {
    return this._httpServer;
  }

  /**
   * 检查HTTP服务器是否正在运行。
   * @returns {boolean}
   */
  isHttpServerRunning() {
    return this._httpServer?.isRunning() ?? false;
  }

  /**
   * 手动触发优雅关闭。
   * @returns {Promise<{ok:boolean, pendingMessages:number, activeAgents:number, shutdownDuration:number}>}
   */
  async shutdown() {
    void this.log.info("开始系统关闭");
    if (this._autoReplyManager) {
      this._autoReplyManager.stop();
    }
    return await this.runtime.shutdown({ signal: "MANUAL" });
  }

  /**
   * 检查系统是否正在关闭中。
   * @returns {boolean}
   */
  isShuttingDown() {
    return this.runtime.isShuttingDown();
  }
}
