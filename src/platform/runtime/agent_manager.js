/**
 * 智能体管理器模块
 * 
 * 本模块负责智能体的生命周期管理，是 Runtime 的子模块之一。
 * 
 * 【设计初衷】
 * 智能体是系统的核心执行单元，需要统一管理其创建、注册、状态跟踪和终止。
 * 将这些功能集中到一个模块，便于维护智能体的一致性和完整性。
 * 
 * 【主要功能】
 * 1. 创建和注册智能体实例
 * 2. 管理智能体的父子关系
 * 3. 跟踪智能体的活动状态
 * 4. 终止智能体（包括级联终止子智能体）
 * 5. 从持久化状态恢复智能体
 * 
 * 【智能体生命周期】
 * 1. 创建：通过 spawnAgent/spawnAgentAs 创建
 * 2. 注册：registerAgentInstance 注册到运行时
 * 3. 活动：处理消息，更新活动时间
 * 4. 终止：terminateAgent 终止并清理资源
 * 
 * 【与其他模块的关系】
 * - 被 ToolExecutor 调用来处理 spawn_agent_with_task、delete_agent 等工具
 * - 使用 Runtime 的 org 管理组织状态
 * - 使用 Runtime 的 bus 发送消息
 * - 使用 Runtime 的 workspaceManager 管理工作空间
 * 
 * @module runtime/agent_manager
 */

import { getErrorMessage } from "../utils/error_utils.js";
import { Agent } from "../../agents/agent.js";
import { buildOrgTree } from "../services/http/http_server/agents.js";
import { getWorkspaceManager } from "../services/workspace/workspace_manager.js";
import { registry } from "../core/module_registry.js";

/**
 * 智能体管理器类
 * 
 * 负责智能体的完整生命周期管理。
 */
export class AgentManager {
  /**
   * 创建智能体管理器实例
   * 
   * @param {object} runtime - Runtime 实例引用
   */
  constructor(runtime) {
    /** @type {object} Runtime 实例引用 */
    this.runtime = runtime;
    this._nameGenerationChain = Promise.resolve();
    /** @type {number|null} 上次发布的 org_tree 消息 ID */
    this._orgTreeMessageId = null;
    this._orgTreePublishingInited = false;

    // 监听运行时 computeStatus / computePhase 变更，自动推送 org_tree
    const state = runtime._state;
    if (state) {
      state.addComputeStatusListener(() => this._publishOrgTree());
      state._onComputePhaseChange = () => this._publishOrgTree();
    }
    registry.provide({ findWorkspaceIdForAgent: (id)=>this.findWorkspaceIdForAgent(id) });
  }

  /**
   * 创建并注册智能体实例
   * 
   * 【创建流程】
   * 1. 验证 parentAgentId 参数
   * 2. 在组织中创建智能体记录
   * 3. 获取岗位信息和行为工厂
   * 4. 创建 Agent 实例
   * 5. 注册到运行时
   * 6. 为 root 的直接子智能体分配工作空间
   * 
   * @param {object} input - 创建参数
   * @param {string} input.roleId - 岗位ID
   * @param {string} input.parentAgentId - 父智能体ID（必填）
   * @param {string} [input.name] - 智能体名称（可选）
   * @param {object} [input.taskBrief] - 任务委托书（可选）
   * @returns {Promise<Agent>} 创建的智能体实例
   * @throws {Error} 如果 parentAgentId 缺失
   */
  async spawnAgent(input) {
    const runtime = this.runtime;
    
    // 验证 parentAgentId
    if (
      !input ||
      typeof input.parentAgentId !== "string" ||
      input.parentAgentId.length === 0 ||
      input.parentAgentId === "null" ||
      input.parentAgentId === "undefined"
    ) {
      throw new Error("parentAgentId_required");
    }

    if (typeof input.roleId !== "string" || !input.roleId.trim()) {
      throw new Error("roleId_required");
    }

    if (!runtime.org?.getRole?.(input.roleId)) {
      throw new Error("role_not_found");
    }
    
    const role = runtime.org.getRole(input.roleId);
    const roleName = role?.name ?? "unknown";

    // 如果调用者提供了姓名，则使用提供的；否则尝试生成姓名
    /** @type {string} */
    let name = typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : await this._generateNameForRole({ roleName });

    // 检查名称唯一性（显式指定名称时）
    if (name && typeof input.name === "string" && input.name.trim()) {
      const agents = runtime.org.listAgents();
      const duplicate = agents.some(a => a.status !== "deleted" && a.name === name);
      if (duplicate) {
        throw new Error(`duplicate_name: 名称"${name}"已被其他智能体使用，请使用不同的名称`);
      }
    }

    // 在组织中创建智能体记录（包含姓名）
    const meta = await runtime.org.createAgent({ ...input, name });

    // 姓名生成失败时，直接用智能体 ID 作为姓名
    if (!name) {
      name = meta.id;
      void runtime.log.warn("随机姓名生成失败，使用智能体 ID 作为姓名", {
        agentId: meta.id,
        roleName
      });
    }

    const behaviorFactory = runtime._behaviorRegistry.get(roleName);
    const behavior = behaviorFactory
      ? behaviorFactory(runtime._buildAgentContext())
      : async () => {};
    
    // 创建智能体实例
    const agent = new Agent({
      id: meta.id,
      roleId: meta.roleId,
      roleName,
      rolePrompt: role?.rolePrompt ?? "",
      behavior,
      name
    });
    
    // 注册智能体
    this.registerAgentInstance(agent);
    runtime._agentMetaById.set(agent.id, { 
      id: meta.id, 
      roleId: meta.roleId, 
      parentAgentId: meta.parentAgentId ?? null 
    });
    
    if (input?.taskBrief && typeof input.taskBrief === "object") {
      /** @type {{setAgentTaskBrief?: (agentId: string, taskBrief: object) => void}} */
      const state = runtime._state;
      state?.setAgentTaskBrief?.(agent.id, input.taskBrief);
    }
    
    // 初始化活动时间
    runtime._agentLastActivityTime.set(agent.id, Date.now());
    
    // 【新增】初始化智能体记忆（懒加载，不阻塞创建流程）
    // 【关键】使用 .catch() 防止 getOrCreateMemory 失败时产生未处理的 Promise 拒绝
    void runtime.agentMemoryManager?.getOrCreateMemory(agent.id).catch((err) => {
      runtime.log.error('[AgentManager] 初始化智能体记忆失败', {
        agentId: agent.id,
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
    });
    
    // 工作空间处理：只有 root 的直接子智能体需要分配工作空间
    if (input.parentAgentId === "root") {
      const workspaceId = agent.id;
      // 触发工作空间分配
      await getWorkspaceManager().createWorkspace(workspaceId);
      void runtime.log.info("为智能体分配工作空间", {
        agentId: agent.id,
        workspaceId
      });
    }
    
    void runtime.log.info("创建智能体实例", {
      id: agent.id,
      roleId: agent.roleId,
      roleName: agent.roleName,
      parentAgentId: meta.parentAgentId ?? null,
      name: meta?.name ?? null
    });
    
    // 记录生命周期事件
    void this.logLifecycleEvent("agent_created", {
      agentId: agent.id,
      roleId: agent.roleId,
      roleName: agent.roleName,
      parentAgentId: meta.parentAgentId ?? null,
      name: meta?.name ?? null
    });
    
    return agent;
  }

  /**
   * 生成一个不重名的人名，用于新智能体的元数据初始化。
   * 如果本地模型可用，使用 LLM 生成人名；否则使用简单的随机命名方案。
   * @param {{roleName:string}} input
   * @returns {Promise<string|null>}
   */
  async _generateNameForRole({ roleName }) {
    const runtime = this.runtime;
    const logPrefix = "[NameGeneration]";
    
    void runtime.log.info(`${logPrefix} 开始生成智能体姓名`, {
      roleName,
      timestamp: Date.now()
    });
    
    // 使用随机命名方案
    return this._generateRandomName({ roleName });
  }

  /**
   * 使用简单的随机方案生成中文名（本地模型不可用时使用）
   * @param {{roleName:string}} input
   * @returns {string|null}
   */
  _generateRandomName({ roleName }) {
    const runtime = this.runtime;
    const logPrefix = "[NameGeneration]";
    
    // 常见姓氏
    const surnames = [
      "王", "李", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴",
      "徐", "孙", "马", "朱", "胡", "郭", "林", "何", "高", "罗",
      "郑", "梁", "谢", "宋", "唐", "许", "韩", "冯", "邓", "曹",
      "彭", "曾", "肖", "田", "董", "袁", "潘", "于", "蒋", "蔡"
    ];
    
    // 常见名字用字
    const nameChars = [
      "伟", "芳", "娜", "敏", "静", "强", "磊", "洋", "勇", "军",
      "杰", "娟", "艳", "丽", "涛", "明", "超", "秀英", "华", "鹏",
      "飞", "婷", "宇", "慧", "鑫", "欣", "雨", "晨", "辰", "然",
      "涵", "轩", "昊", "瑞", "嘉", "怡", "琪", "梓", "涵", "诺",
      "文", "武", "志", "建", "国", "家", "天", "地", "人", "和"
    ];
    
    // 获取已存在的名字
    const existing = new Set(["root", "user"]);
    const agents = runtime?.org?.listAgents?.() ?? [];
    for (const a of agents) {
      if (a && a.status !== "deleted") {
        if (typeof a.name === "string" && a.name.trim()) {
          existing.add(a.name.trim());
        }
      }
    }
    
    // 尝试生成不重复的名字
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      const surname = surnames[Math.floor(Math.random() * surnames.length)];
      // 60% 概率生成两字名，40% 概率生成三字名
      const isTwoChar = Math.random() < 0.6;
      let name;
      if (isTwoChar) {
        const char = nameChars[Math.floor(Math.random() * nameChars.length)];
        name = surname + char;
      } else {
        const char1 = nameChars[Math.floor(Math.random() * nameChars.length)];
        const char2 = nameChars[Math.floor(Math.random() * nameChars.length)];
        name = surname + char1 + char2;
      }
      
      if (!existing.has(name)) {
        void runtime.log.info(`${logPrefix} 随机名字生成成功`, {
          roleName,
          generatedName: name,
          attempt: i + 1
        });
        return name;
      }
    }
    
    void runtime.log.warn(`${logPrefix} 随机名字生成失败，尝试次数耗尽`, {
      roleName,
      maxAttempts,
      callStack: new Error("调用栈捕获").stack
    });
    return null;
  }

  _sanitizeHumanName(raw) {
    const runtime = this.runtime;
    const logPrefix = "[NameGeneration]";
    
    const s = typeof raw === "string" ? raw : String(raw ?? "");
    void runtime.log.info(`${logPrefix} 开始清理名字`, {
      rawInput: raw,
      rawType: typeof raw
    });
    
    const firstLine = s.split(/\r?\n/)[0] ?? "";
    const trimmed = firstLine.trim();
    const unquoted = trimmed.replace(/^["'""''']+|["'""''']+$/g, "").trim();
    const noPunct = unquoted.replace(/[，。,\.!！?？;；:：\s]/g, "");
    const result = noPunct.trim() || null;
    
    void runtime.log.info(`${logPrefix} 名字清理步骤`, {
      step1_firstLine: firstLine,
      step2_trimmed: trimmed,
      step3_unquoted: unquoted,
      step4_noPunct: noPunct,
      finalResult: result
    });
    
    return result;
  }

  _isValidChineseHumanName(name) {
    const runtime = this.runtime;
    const logPrefix = "[NameGeneration]";
    
    if (typeof name !== "string") {
      void runtime.log.info(`${logPrefix} 名字验证：类型不符`, {
        name,
        type: typeof name
      });
      return false;
    }
    
    const s = name.trim();
    if (s.length < 2 || s.length > 4) {
      void runtime.log.info(`${logPrefix} 名字验证：长度不符`, {
        name: s,
        length: s.length
      });
      return false;
    }
    
    // 允许纯中文（2-4字）或纯英文大小写（2-4字母）
    const isChinese = /^[\u4e00-\u9fff]+$/.test(s);
    const isEnglish = /^[a-zA-Z]+$/.test(s);
    const isValid = isChinese || isEnglish;
    
    if (!isValid) {
      void runtime.log.info(`${logPrefix} 名字验证：非纯中文或纯英文字符`, {
        name: s,
        charCodes: s.split("").map(c => c.charCodeAt(0).toString(16))
      });
    }
    
    return isValid;
  }

  /**
   * 检查生成的名字与岗位名称是否有相同文字
   * 只要有任何相同的文字，就认为是相似的
   * @param {string} name - 生成的名字
   * @param {string} roleName - 岗位名称
   * @returns {{tooSimilar: boolean, reason: string|null}}
   */
  _checkNameRoleSimilarity(name, roleName) {
    if (!name || !roleName) {
      return { tooSimilar: false, reason: null };
    }

    const n = name.trim();
    const r = roleName.trim();

    // 只要名字中有任何一个字符出现在岗位名称中，就拒绝
    const nameChars = [...n];
    const roleChars = [...r];
    const commonChars = nameChars.filter(char => roleChars.includes(char));
    
    if (commonChars.length > 0) {
      return { tooSimilar: true, reason: `包含相同文字：${commonChars.join(", ")}` };
    }

    return { tooSimilar: false, reason: null };
  }

  /**
   * 以调用者身份创建子智能体
   * 
   * parentAgentId 由系统自动填充为调用者的 ID。
   * 
   * @param {string} callerAgentId - 调用者智能体ID
   * @param {object} input - 创建参数
   * @param {string} input.roleId - 岗位ID
   * @param {string} [input.name] - 智能体名称（可选）
   * @param {object} [input.taskBrief] - 任务委托书（可选）
   * @param {string} [input.parentAgentId] - 父智能体ID（可选，会被 callerAgentId 覆盖）
   * @returns {Promise<Agent>} 创建的智能体实例
   * @throws {Error} 如果 parentAgentId 与调用者不匹配
   */
  async spawnAgentAs(callerAgentId, input) {
    /** @type {string|undefined|null} */
    const rawParent = input?.parentAgentId;
    const missingParent = rawParent === null || rawParent === undefined || rawParent === "" || rawParent === "null" || rawParent === "undefined";
    
    if (!missingParent && String(rawParent) !== String(callerAgentId)) {
      throw new Error("invalid_parentAgentId");
    }
    
    return await this.spawnAgent({ 
      roleId: input.roleId, 
      parentAgentId: callerAgentId,
      name: input?.name,
      taskBrief: input?.taskBrief
    });
  }

  /**
   * 注册智能体实例到运行时
   * 
   * @param {Agent} agent - 智能体实例
   */
  registerAgentInstance(agent) {
    this.runtime._agents.set(agent.id, agent);
  }

  /**
   * 列出所有已注册的智能体实例
   * 
   * @returns {{id: string, roleId: string, roleName: string}[]} 智能体信息数组
   */
  listAgentInstances() {
    return Array.from(this.runtime._agents.values()).map((a) => ({
      id: a.id,
      roleId: a.roleId,
      roleName: a.roleName
    }));
  }

  /**
   * 获取智能体状态信息
   * 
   * @param {string} agentId - 智能体ID
   * @returns {object|null} 智能体状态，不存在则返回 null
   */
  getAgentStatus(agentId) {
    const runtime = this.runtime;
    const agent = runtime._agents.get(agentId);
    if (!agent) {
      return null;
    }
    
    const meta = runtime._agentMetaById.get(agentId);
    const queueDepth = runtime.bus.getQueueDepth(agentId);
    const conversation = runtime._conversations.get(agentId);
    const conversationLength = conversation ? conversation.length : 0;
    
    return {
      id: agent.id,
      roleId: agent.roleId,
      roleName: agent.roleName,
      parentAgentId: meta?.parentAgentId ?? null,
      status: "active",
      queueDepth,
      conversationLength
    };
  }

  /**
   * 终止智能体
   * 
   * 【终止流程】
   * 1. 验证调用者权限（只能终止自己的子智能体）
   * 2. 收集所有需要终止的智能体（包括级联终止的后代）
   * 3. 处理待处理消息
   * 4. 清理运行时状态
   * 5. 持久化终止事件
   * 
   * @param {object} ctx - 执行上下文
   * @param {object} args - 终止参数
   * @param {string} args.agentId - 要终止的智能体ID
   * @param {string} [args.reason] - 终止原因
   * @returns {Promise<{ok?: boolean, terminatedAgentId?: string, error?: string, agentId?: string, message?: string}>}
   */
  async terminateAgent(ctx, args) {
    const runtime = this.runtime;
    const callerId = ctx.agent?.id ?? null;
    const targetId = args?.agentId;

    if (!callerId) {
      return { error: "missing_caller_agent" };
    }

    if (!targetId || typeof targetId !== "string") {
      return { error: "missing_agent_id" };
    }

    // 验证目标智能体是否存在
    if (!runtime._agents.has(targetId)) {
      void runtime.log.warn("delete_agent 目标智能体不存在", { callerId, targetId });
      return { error: "agent_not_found", agentId: targetId, ok: false };
    }

    // 验证是否为子智能体
    const targetMeta = runtime._agentMetaById.get(targetId);
    if (!targetMeta || targetMeta.parentAgentId !== callerId) {
      void runtime.log.warn("delete_agent 权限验证失败：非子智能体", {
        callerId,
        targetId,
        targetParentAgentId: targetMeta?.parentAgentId ?? null
      });
      return { error: "not_child_agent", message: "只能删除自己创建的子智能体", ok: false };
    }

    void runtime.log.info("开始终止智能体", { callerId, targetId, reason: args.reason ?? null });

    // 收集所有需要终止的智能体
    const agentsToTerminate = this.collectDescendantAgents(targetId);
    agentsToTerminate.unshift(targetId);

    // 【关键】先关闭 AgentMemory（必须在删除文件之前）
    for (const agentId of agentsToTerminate) {
      await runtime.agentMemoryManager?.closeMemory(agentId);
    }

    // 【关键】标记智能体为正在终止，防止后续操作触发记忆更新
    for (const agentId of agentsToTerminate) {
      const agent = runtime._agents.get(agentId);
      if (agent) {
        agent._isTerminating = true;
      }
    }

    // 【关键】清理 TurnEngine 中的回合状态
    for (const agentId of agentsToTerminate) {
      runtime._turnEngine?.clearAgent?.(agentId);
    }

    // 处理待处理消息
    for (const agentId of agentsToTerminate) {
      await this._drainAgentQueue(agentId);
    }

    // 清理运行时状态（从子到父的顺序）
    for (const agentId of agentsToTerminate.reverse()) {
      runtime._state._agentComputeStatus.delete(agentId);
      runtime._state._agentComputePhase.delete(agentId);
      runtime._agents.delete(agentId);
      runtime._conversations.delete(agentId);
      void runtime._conversationManager?.deletePersistedConversation?.(agentId);
      runtime._agentMetaById.delete(agentId);
      runtime._agentTaskBriefs.delete(agentId);
      runtime._agentLastActivityTime.delete(agentId);
      runtime._idleWarningEmitted?.delete(agentId);
    }

    // 持久化终止事件
    await runtime.org.recordTermination(targetId, callerId, args.reason);

    void runtime.log.info("智能体终止完成", { callerId, targetId });
    
    // 记录生命周期事件
    void this.logLifecycleEvent("agent_terminated", {
      agentId: targetId,
      terminatedBy: callerId,
      reason: args.reason ?? null
    });

    return { ok: true, terminatedAgentId: targetId };
  }

  /**
   * 通过心跳推送最新的组织树（org_tree 消息）。
   * 记住上次的 messageId，更新时先清理旧消息再广播新消息。
   */
  _publishOrgTree() {
    const broker = this.runtime.heartbeatBroker;
    const org = this.runtime.org;
    if (!broker || !org) return;

    if (this._orgTreeMessageId !== null) {
      broker.clearMessage(this._orgTreeMessageId);
    }
    const treeData = buildOrgTree(org, this.runtime);
    this._orgTreeMessageId = broker.broadcast('org_tree', treeData);
  }

  /**
   * 从组织状态恢复智能体实例
   *
   * 在服务器重启后调用，确保之前创建的智能体能够继续处理消息。
   * 首次调用时还会初始化 org_tree 心跳推送监听。
   *
   * @returns {Promise<void>}
   */
  async restoreAgentsFromOrg() {
    const runtime = this.runtime;
    const agentMetas = runtime.org.listAgents();
    let restoredCount = 0;
    let skippedCount = 0;

    for (const meta of agentMetas) {
      // 跳过已终止的智能体
      if (meta.status === "deleted") {
        skippedCount++;
        continue;
      }

      // 跳过已经注册的智能体
      if (runtime._agents.has(meta.id)) {
        continue;
      }

      // 获取岗位信息
      const role = runtime.org.getRole(meta.roleId);
      if (!role) {
        void runtime.log.warn("恢复智能体失败：岗位不存在", { agentId: meta.id, roleId: meta.roleId });
        skippedCount++;
        continue;
      }
      if (role.status === "deleted") {
        void runtime.log.warn("恢复智能体失败：岗位已删除", { agentId: meta.id, roleId: meta.roleId, roleName: role.name });
        skippedCount++;
        continue;
      }

      // 创建智能体实例
      const roleName = role.name ?? "unknown";
      const behaviorFactory = runtime._behaviorRegistry.get(roleName);
      const behavior = behaviorFactory
        ? behaviorFactory(runtime._buildAgentContext())
        : async () => {};

      const agent = new Agent({
        id: meta.id,
        roleId: meta.roleId,
        roleName,
        rolePrompt: role.rolePrompt ?? "",
        behavior,
        name: meta.name ?? null,
        systemPromptAppendix: meta.systemPromptAppendix ?? [],
        lastMemoryMessageId: meta.lastMemoryMessageId ?? null,
        todoList: meta.todoList ?? [],
        autoReplyConfig: meta.autoReplyConfig ?? null
      });

      this.registerAgentInstance(agent);
      runtime._agentMetaById.set(agent.id, {
        id: meta.id,
        roleId: meta.roleId,
        parentAgentId: meta.parentAgentId ?? null
      });
      runtime._agentLastActivityTime.set(agent.id, Date.now());

      // 为 root 的直接子智能体重建工作空间对象
      if (meta.parentAgentId === "root") {
        await getWorkspaceManager().getWorkspace(agent.id);
      }

      restoredCount++;

      void runtime.log.debug("恢复智能体实例", {
        id: agent.id,
        roleId: agent.roleId,
        roleName: agent.roleName,
        parentAgentId: meta.parentAgentId ?? null
      });
    }

    if (restoredCount > 0 || skippedCount > 0) {
      void runtime.log.info("智能体恢复完成", {
        restored: restoredCount,
        skipped: skippedCount,
        total: runtime._agents.size
      });
    }

    // 首次恢复后，初始化 org_tree 心跳推送（监听 org 数据变更 + 初始发布）
    if (!this._orgTreePublishingInited) {
      this._orgTreePublishingInited = true;
      // 监听组织数据变更：任何 role/agent CRUD 都触发 org_tree 重推
      runtime.org.onDataChange(() => {
        this._publishOrgTree();
      });
      // 初始发布
      this._publishOrgTree();
    }
  }

  /**
   * 通过祖先链查找智能体的工作空间ID
   * 
   * @param {string} agentId - 智能体ID
   * @returns {string|null} 工作空间ID
   */
  findWorkspaceIdForAgent(agentId) {
    const runtime = this.runtime;
    let currentAgentId = agentId;
    
    while (currentAgentId && currentAgentId !== "user") {
      if (getWorkspaceManager().checkWorkspaceExists(currentAgentId)) {
        return currentAgentId;
      }
      
      const meta = runtime._agentMetaById.get(currentAgentId);
      if (!meta || !meta.parentAgentId) {
        break;
      }
      currentAgentId = meta.parentAgentId;
    }
    
    return null;
  }

  /**
   * 获取智能体所属的 taskId
   * 
   * @param {string} agentId - 智能体ID
   * @returns {string|null} taskId
   */
  /**
   * 确保 agentId → taskId 反向索引与 _rootTaskAgentByTaskId 同步。
   * 延迟重建：仅在索引缺失或容量不一致时重建一次（此后 O(1) 查找）。
   */
  _ensureAgentIdToTaskIdIndex() {
    const rt = this.runtime;
    if (rt._agentIdToTaskId.size !== rt._rootTaskAgentByTaskId.size) {
      rt._agentIdToTaskId.clear();
      for (const [taskId, agentInfo] of rt._rootTaskAgentByTaskId.entries()) {
        rt._agentIdToTaskId.set(agentInfo.id, taskId);
      }
    }
  }

  /**
   * 获取智能体对应的任务 ID（O(1) 反向索引 + O(L) 父链追溯）。
   * @param {string} agentId - 智能体ID
   * @returns {string|null} taskId
   */
  getAgentTaskId(agentId) {
    const runtime = this.runtime;

    if (agentId === "root" || agentId === "user") {
      return null;
    }

    this._ensureAgentIdToTaskIdIndex();

    // O(1) 反向索引直接查找
    const taskId = runtime._agentIdToTaskId.get(agentId);
    if (taskId) return taskId;

    // 追溯父链（每步 O(1) 查找 _agentMetaById + _agentIdToTaskId）
    let currentId = agentId;
    const visited = new Set();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const parentTaskId = runtime._agentIdToTaskId.get(currentId);
      if (parentTaskId) return parentTaskId;

      const meta = runtime._agentMetaById.get(currentId);
      if (!meta || !meta.parentAgentId || meta.parentAgentId === "root") {
        break;
      }
      currentId = meta.parentAgentId;
    }

    return null;
  }

  /**
   * 记录智能体生命周期事件。
   * @param {"agent_created"|"agent_terminated"|"agent_message_received"|"agent_message_sent"} eventType
   * @param {{agentId:string, roleId?:string, roleName?:string, parentAgentId?:string, messageId?:string, from?:string, to?:string, taskId?:string, reason?:string, terminatedBy?:string, name?:string}} data
   */
  logLifecycleEvent(eventType, data) {
    const messages = {
      agent_created: "智能体创建",
      agent_terminated: "智能体终止",
      agent_message_received: "智能体收到消息",
      agent_message_sent: "智能体发送消息"
    };
    const message = messages[eventType] ?? eventType;
    void this.runtime.loggerRoot.writeStructured({
      timestamp: new Date().toISOString(),
      level: "info",
      module: "lifecycle",
      message,
      eventType,
      data
    });
  }

  /**
   * 收集指定智能体的所有后代智能体ID
   * 
   * @param {string} parentId - 父智能体ID
   * @returns {string[]} 后代智能体ID数组
   */
  collectDescendantAgents(parentId) {
    const runtime = this.runtime;
    const descendants = [];
    
    for (const [agentId, meta] of runtime._agentMetaById) {
      if (meta.parentAgentId === parentId) {
        descendants.push(agentId);
        const grandchildren = this.collectDescendantAgents(agentId);
        descendants.push(...grandchildren);
      }
    }
    
    return descendants;
  }

  /**
   * 更新智能体的最后活动时间
   * 
   * @param {string} agentId - 智能体ID
   */
  updateAgentActivity(agentId) {
    this.runtime._agentLastActivityTime.set(agentId, Date.now());
    this.runtime._idleWarningEmitted.delete(agentId);
  }

  /**
   * 获取智能体的最后活动时间
   * 
   * @param {string} agentId - 智能体ID
   * @returns {number|null} 时间戳（毫秒）
   */
  getAgentLastActivityTime(agentId) {
    return this.runtime._agentLastActivityTime.get(agentId) ?? null;
  }

  /**
   * 获取智能体的空闲时长
   * 
   * @param {string} agentId - 智能体ID
   * @returns {number|null} 空闲时长（毫秒）
   */
  getAgentIdleTime(agentId) {
    const lastActivity = this.runtime._agentLastActivityTime.get(agentId);
    if (lastActivity === undefined) {
      return null;
    }
    return Date.now() - lastActivity;
  }

  /**
   * 检查所有智能体的空闲状态
   * 
   * @returns {{agentId: string, idleTimeMs: number}[]} 空闲超时的智能体列表
   */
  checkIdleAgents() {
    const runtime = this.runtime;
    const idleAgents = [];
    const now = Date.now();
    
    for (const agentId of runtime._agents.keys()) {
      const lastActivity = runtime._agentLastActivityTime.get(agentId);
      if (lastActivity === undefined) continue;
      
      const idleTimeMs = now - lastActivity;
      if (idleTimeMs > runtime.idleWarningMs) {
        idleAgents.push({ agentId, idleTimeMs });
        
        if (!runtime._idleWarningEmitted?.has(agentId)) {
          runtime._idleWarningEmitted?.add(agentId);
          void runtime.log.warn("智能体空闲超时", {
            agentId,
            idleTimeMs,
            idleWarningMs: runtime.idleWarningMs
          });
        }
      }
    }
    
    return idleAgents;
  }

  /**
   * 处理智能体队列中的待处理消息（终止前调用）
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<void>}
   * @private
   */
  async _drainAgentQueue(agentId) {
    const runtime = this.runtime;
    const agent = runtime._agents.get(agentId);
    if (!agent) return;

    let processedCount = 0;
    const maxDrainMessages = 100;

    while (processedCount < maxDrainMessages) {
      const msg = runtime.bus.receiveNext(agentId);
      if (!msg) break;

      processedCount += 1;
      void runtime.log.debug("终止前处理消息", {
        agentId,
        messageId: msg.id,
        from: msg.from,
        processedCount
      });

      try {
        await agent.onMessage(runtime._buildAgentContext(agent), msg);
      } catch (err) {
        const message = getErrorMessage(err);
        void runtime.log.error("终止前消息处理失败", {
          agentId,
          messageId: msg.id,
          from: msg.from,
          taskId: msg.taskId,
          message,
          stack: err?.stack,
          name: err?.name,
          code: err?.code
        });
      }
    }

    if (processedCount > 0) {
      void runtime.log.info("终止前消息处理完成", { agentId, processedCount });
    }
  }
}
