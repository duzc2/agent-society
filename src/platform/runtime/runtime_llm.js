import { formatMessageForAgent } from "../utils/message/message_formatter.js";
import { formatTaskBrief } from "../utils/message/task_brief.js";

/**
 * RuntimeLlm: LLM 交互模块
 *
 * 职责：
 * - 上下文构建 (buildSystemPromptForAgent, formatMessageForLlm)
 * - 发送者信息 (getSenderInfo)
 * - 中断控制 (abort)
 *
 * 【架构说明】
 * 本模块原有的 LLM 调用逻辑 (handleWithLlm/doLlmProcessing) 已被新的架构取代。
 * 现在的 LLM 调用由 ComputeScheduler + TurnEngine 负责：
 * - ComputeScheduler._startLlm 直接调用 llmClient.chat
 * - TurnEngine 管理对话上下文
 *
 * 本模块目前主要提供辅助方法，被 TurnEngine 和其他模块调用。
 *
 * Requirements: 3.2, 7.1, 7.2
 */
export class RuntimeLlm {
  /**
   * @param {any} runtime - Runtime 实例
   */
  constructor(runtime) {
    this.runtime = runtime;
  }

  /**
   * 生成当前智能体的 system prompt（包含工具调用规则）。
   * @param {any} ctx - 智能体上下文
   * @param {any} [llmClient] - 可选的 LlmClient 实例，用于判断是否支持工具调用
   * @returns {Promise<string>}
   */
  async buildSystemPromptForAgent(ctx, llmClient) {
    const agentId = ctx.agent?.id ?? "";
    this.runtime._state.setAgentComputePhase(agentId, "正在构建系统提示词...");

    const supportsToolCalling = llmClient ? this._checkToolCallingSupport(llmClient) : true;

    // 不支持工具调用的模型只发送岗位提示词和姓名。
    // 这里明确不走 composePrompt，也不注入组织、任务、运行时、联系人、技能、记忆、附录等其他内容。
    if (!supportsToolCalling) {
      return this._buildPlainPromptForNonToolModel(ctx);
    }

    const toolRules = ctx.systemToolRules ? "\n\n" + ctx.systemToolRules : "";
    const parentAgentId = this.runtime._agentMetaById.get(agentId)?.parentAgentId ?? null;
    const runtimeInfo = `\n\n【运行时信息】\nagentId=${agentId}\nparentAgentId=${parentAgentId ?? ""}`;

    // 获取模块注入的系统提示词
    const modulePromptAppendix = this.runtime.getSystemPromptAppendix();

    if (ctx.agent?.id === "root") {
      const rootPrompt = this._stripEmbeddedToolGroupsInfo(ctx.agent?.rolePrompt ?? "");
      // Inject tool-group instructions only when the target model can actually call tools.
      const toolGroupsInfo = this.formatToolGroupsInfo();
      return rootPrompt + runtimeInfo + toolGroupsInfo + modulePromptAppendix;
    }

    const base = ctx.systemBasePrompt ?? "";
    const orgPromptRaw = this._resolveOrgPromptForAgent(ctx.agent);
    const orgPromptSection =
      typeof orgPromptRaw === "string" && orgPromptRaw.trim()
        ? `【组织架构】\n${orgPromptRaw}`
        : "";
    const role = ctx.agent?.rolePrompt ?? "";
    const roleWithOrg = orgPromptSection ? `${orgPromptSection}\n\n${role}` : role;

    // 智能体姓名信息
    const agentName = ctx.agent?.name;
    const nameSection = agentName ? `【你的姓名】${agentName}\n\n` : "";

    // 获取并格式化 TaskBrief（Requirements 1.5）
    const taskBrief = this.runtime._agentTaskBriefs.get(agentId);
    const taskBriefText = taskBrief ? "\n\n" + formatTaskBrief(taskBrief) : "";


    // Workspace 描述依赖工具能力。
    // 当模型不支持工具调用时，不注入工作空间说明，避免给模型发送无法利用的环境描述。
    const workspacePrompt = (ctx.systemWorkspacePrompt ?? "");
    const composed = ctx.tools.composePrompt({
      base,
      composeTemplate: ctx.systemComposeTemplate ?? "{{BASE}}\n{{ROLE}}\n{{TASK}}",
      rolePrompt: roleWithOrg,
      taskText: "",
      workspace: workspacePrompt
    });
    let finalPrompt = composed + "\n\n" + nameSection + runtimeInfo + taskBriefText + toolRules + modulePromptAppendix;

    // 加载技能提示词
    // 【安全】仅当岗位拥有 skill 工具组时注入——否则提示词会指示 LLM 调用
    // 执行端已拒绝的技能工具（load_skill_detail 等），导致反复调用被拒
    let skillPrompt = "";
    if (this.runtime.isToolAvailableForAgent(agentId, "load_skill_detail")) {
      skillPrompt = await this.runtime.skillsService.buildAgentSkillPrompt(agentId);
    }
    if (skillPrompt.trim()) {
      finalPrompt += "\n\n" + skillPrompt.trim();
    }

    // 追加智能体自定义的 system prompt 内容
    const agent = ctx.agent;
    const appendixItems = Array.isArray(agent?.systemPromptAppendix)
      ? agent.systemPromptAppendix
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : typeof agent?.systemPromptAppendix === "string" && agent.systemPromptAppendix.trim()
        ? [agent.systemPromptAppendix.trim()]
        : [];
    if (appendixItems.length > 0) {
      finalPrompt += "\n\n" + appendixItems.join("\n\n");
    }

    return finalPrompt;
  }

  /**
   * Build a plain-text system prompt for models without tool-calling support.
   *
   * Constraints:
   * 1. The role prompt must stay at the beginning of the system prompt.
   * 2. Keep the required plain-text sections: agent name, org prompt, appendix.
   * 3. Do not inject tool-dependent context such as composePrompt, runtime info, tool rules, or workspace prompt.
   *
   * @param {any} ctx - Agent context
   * @returns {Promise<string>}
   * @private
   */
  async _buildPlainPromptForNonToolModel(ctx) {
    const agent = ctx?.agent ?? null;
    const rawRolePrompt = agent?.rolePrompt ?? "";
    const rolePrompt = agent?.id === "root"
      ? this._stripEmbeddedToolGroupsInfo(rawRolePrompt)
      : rawRolePrompt;
    const trimmedRolePrompt = typeof rolePrompt === "string" ? rolePrompt.trim() : "";
    const agentName = typeof agent?.name === "string" ? agent.name.trim() : "";
    const orgPromptRaw = this._resolveOrgPromptForAgent(agent);
    const trimmedOrgPrompt = typeof orgPromptRaw === "string" ? orgPromptRaw.trim() : "";
    const appendixItems = Array.isArray(agent?.systemPromptAppendix)
      ? agent.systemPromptAppendix
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : typeof agent?.systemPromptAppendix === "string" && agent.systemPromptAppendix.trim()
        ? [agent.systemPromptAppendix.trim()]
        : [];
    const promptSections = [];

    // Keep the role prompt at the start for non-tool models.
    if (trimmedRolePrompt) {
      promptSections.push(trimmedRolePrompt);
    }

    // Keep the agent name after the role prompt so identity does not override the role.
    if (agentName) {
      promptSections.push(`【你的姓名】${agentName}`);
    }

    // Preserve the organization prompt, but place it after the role prompt.
    if (trimmedOrgPrompt) {
      promptSections.push(`【组织架构】\n${trimmedOrgPrompt}`);
    }else{
      this.runtime.log.info('[RuntimeLlm] 未找到组织架构', { orgPromptRaw });
    }

    // Preserve the agent-level appendix for the plain-text system prompt.
    if (appendixItems.length > 0) {
      promptSections.push(...appendixItems);
    }

    return promptSections.join("\n\n");
  }

  /**
   * 解析智能体当前可用的组织架构提示词。
   *
   * 规则：
   * 1. 先读取当前智能体所属岗位的 orgPrompt。
   * 2. 如果当前岗位的 orgPrompt 为空字符串或仅包含空白，则沿父智能体链继续向上查找父岗位。
   * 3. 查找到 root 为止；如果整条链路都没有非空 orgPrompt，则返回 null。
   *
   * @param {any} agent - 当前智能体
   * @returns {string|null}
   * @private
   */
  _resolveOrgPromptForAgent(agent) {
    if (!agent || typeof agent !== "object") {
      return null;
    }

    let currentAgentId = typeof agent.id === "string" ? agent.id : null;
    let currentRoleId = typeof agent.roleId === "string" ? agent.roleId : null;
    const visitedAgentIds = new Set();

    while (currentRoleId) {
      const roleRecord = this.runtime.org?.getRole?.(currentRoleId) ?? null;
      const orgPromptRaw = roleRecord?.orgPrompt ?? null;
      if (typeof orgPromptRaw === "string" && orgPromptRaw.trim()) {
        return orgPromptRaw;
      }

      if (!currentAgentId || currentAgentId === "root" || visitedAgentIds.has(currentAgentId)) {
        return null;
      }
      visitedAgentIds.add(currentAgentId);

      const parentAgentId = this._getParentAgentIdForOrgPromptLookup(currentAgentId);
      if (!parentAgentId || parentAgentId === "root") {
        return null;
      }

      const parentMeta = this._getAgentMetaForOrgPromptLookup(parentAgentId);
      if (!parentMeta?.roleId) {
        return null;
      }

      currentAgentId = parentAgentId;
      currentRoleId = parentMeta.roleId;
    }

    return null;
  }

  /**
   * 获取组织架构提示词查找所需的智能体元数据。
   *
   * 优先读取运行时内存中的元数据；如果运行时元数据缺失，再回退到持久化组织数据或智能体实例。
   *
   * @param {string} agentId - 智能体 ID
   * @returns {{id?:string, roleId?:string|null, parentAgentId?:string|null}|null}
   * @private
   */
  _getAgentMetaForOrgPromptLookup(agentId) {
    if (typeof agentId !== "string" || !agentId) {
      return null;
    }

    return this.runtime._agentMetaById.get(agentId)
      ?? this.runtime.org.getAgent(agentId)
      ?? this.runtime._agents.get(agentId)
      ?? null;
  }

  /**
   * 获取指定智能体在组织架构提示词查找链路中的父智能体 ID。
   *
   * @param {string} agentId - 智能体 ID
   * @returns {string|null}
   * @private
   */
  _getParentAgentIdForOrgPromptLookup(agentId) {
    const meta = this._getAgentMetaForOrgPromptLookup(agentId);
    return typeof meta?.parentAgentId === "string" && meta.parentAgentId
      ? meta.parentAgentId
      : null;
  }

  /**
   * 构建记忆上下文。
   * @param {string} agentId - 智能体 ID
   * @param {string|null} [queryText] - 用于召回记忆的查询文本
   * @returns {Promise<string|null>} 格式化后的记忆上下文，没有记忆时返回 null
   */
  async _buildMemoryContext(agentId, queryText = null) {
    if (!agentId) return null;

    // 【关键】记忆功能已启用时，getOrCreateMemory 失败会抛出异常，不会静默返回 null
    const memory = await this.runtime.agentMemoryManager?.getOrCreateMemory(agentId);

    if (!memory) return null;

    const config = this.runtime.agentMemoryManager?.config;

    try {
      // recall() 自动使用 ContextManager 中的最近对话作为查询基础
      const recallOptions = {
        limit: config?.recall?.limit ?? 5,
        minConfidence: config?.recall?.minConfidence ?? 0.7
      };
      if (typeof queryText === "string" && queryText.trim()) {
        recallOptions.query = queryText.trim();
      }
      this.runtime.log.info('[RuntimeLlm] 开始 recall 记忆', { agentId, recallOptions });

      // 【关键】recall 失败会抛出异常，由外层 catch 捕获并记录完整错误信息
      const memories = await memory.recall(recallOptions);

      this.runtime.log.info('[RuntimeLlm] recall 结果', { agentId, memoryCount: memories?.length ?? 0 });

      if (!memories || memories.length === 0) return null;

      const lines = memories.map((m, i) => {
        const confidence = Math.round(m.confidence * 100);
        const content = m.type === 'text'
          ? m.content
          : `[附件: ${m.content}]`;
        // 截断过长内容
        const truncated = content.length > 400
          ? content.slice(0, 400) + '...'
          : content;
        return `${i + 1}. [相关度: ${confidence}%] ${truncated}`;
      });

      return "\n\n【相关记忆】\n" + lines.join('\n');
    } catch (err) {
      // 【关键】记忆检索失败，记录完整错误信息以便排查
      this.runtime.log.error('[RuntimeLlm] 构建记忆上下文失败', {
        agentId,
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code,
        cause: err?.cause?.message || err?.cause
      });
      return null;
    }
  }

  /**
   * 从知识树检索相关上下文
   * @param {string|null} agentId
   * @param {string|null} queryText
   * @returns {Promise<string|null>}
   * @private
   */
  async _buildKnowledgeContext(agentId, queryText = null) {
    if (!agentId) return null;
    const query = typeof queryText === "string" ? queryText.trim() : null;
    try {
      this.runtime.log.info("[RuntimeLlm] 知识树检索请求", {
        agentId,
        queryPreview: query?.slice(0, 80) ?? "(无查询)",
      });
      const context = await this.runtime.knowledgeTree.getKnowledgeContext(agentId, query);
      if (context) {
        this.runtime.log.info("[RuntimeLlm] 知识树检索命中", {
          agentId,
          contextPreview: context.slice(0, 150),
        });
      }
      return context ?? null;
    } catch (err) {
      this.runtime.log.warn("[RuntimeLlm] 知识树上下文获取失败", {
        agentId,
        queryPreview: query?.substring(0, 200) ?? null,
        // 技术信息
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return null;
    }
  }

  /**
   * 从当前消息中提取记忆召回查询文本。
   *
   * 设计约束：
   * 1. recall 不能依赖 hmemory 运行时上下文，因为重启后上下文可能为空。
   * 2. 优先使用用户或智能体消息正文，避免把格式化头部和回复提示作为查询噪音。
   * 3. 附件消息保留文件名信息，便于召回与文件相关的记忆。
   *
   * @param {any} message - 运行时消息对象
   * @param {string} [fallbackText] - 没有正文时的兜底文本
   * @returns {string|null}
   * @private
   */
  _buildMemoryRecallQuery(message, fallbackText = "") {
    const payload = message?.payload;
    let queryText = "";

    if (typeof payload === "string") {
      queryText = payload;
    } else if (payload && typeof payload === "object") {
      const primaryText = payload.text ?? payload.content ?? "";
      if (typeof primaryText === "string") {
        queryText = primaryText;
      } else if (primaryText !== null && primaryText !== undefined) {
        try {
          queryText = JSON.stringify(primaryText);
        } catch {
          queryText = String(primaryText);
        }
      }

      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        const attachmentText = payload.attachments
          .map((attachment) => attachment?.filename || attachment?.path || "")
          .filter((item) => typeof item === "string" && item.trim())
          .join("\n");
        if (attachmentText) {
          queryText = queryText
            ? `${queryText}\n${attachmentText}`
            : attachmentText;
        }
      }
    }

    if (!queryText.trim() && typeof fallbackText === "string" && fallbackText.trim()) {
      queryText = fallbackText;
    }

    return queryText.trim() ? queryText.trim() : null;
  }

  /**
   * 中断指定智能体的 LLM 调用。
   * @param {string} agentId - 智能体 ID
   * @returns {Promise<boolean>} 是否成功中断
   */
  async abort(agentId) {
    const llmClient = await this.runtime.getLlmClientForAgent(agentId);
    if (!llmClient) {
      return false;
    }
    return llmClient.abort(agentId);
  }

  /**
   * 格式化消息以供 LLM 使用。
   * 只负责消息内容格式化，不注入 memory/knowledge/contextStatus。
   * 这些注入现在由 ComputeScheduler 在 LLM 调用前临时完成。
   * @param {any} ctx - 智能体上下文
   * @param {any} message - 消息对象
   * @returns {Promise<string|any[]>}
   */
  async formatMessageForLlm(ctx, message) {
    const isRoot = ctx?.agent?.id === "root";

    // root 智能体使用原有格式（需要看到 taskId）
    if (isRoot) {
      const payloadRaw = message?.payload;
      let payloadText =
        payloadRaw?.text ??
        payloadRaw?.content ??
        (typeof payloadRaw === "string" ? payloadRaw : null);

      // 等待 Promise
      if (payloadText && typeof payloadText === 'object' && typeof payloadText.then === 'function') {
        payloadText = await payloadText;
      }

      const payload = payloadText ?? JSON.stringify(payloadRaw ?? {}, null, 2);

      return `from=${message?.from ?? ""}\nto=${message?.to ?? ""}\ntaskId=${message?.taskId ?? ""}\npayload=${payload}`;
    }

    // 非 root 智能体使用新的消息格式化器
    const senderId = message?.from ?? 'unknown';
    const senderInfo = this.getSenderInfo(senderId);
    let textContent = formatMessageForAgent(message, senderInfo);

    // 等待 Promise
    /** @type {any} */
    const tc = textContent;
    if (tc && typeof tc === 'object' && 'then' in tc && typeof tc.then === 'function') {
      textContent = await tc;
    }
    // 确保 textContent 不为 null 或 undefined
    textContent = textContent ?? '';

    // 如果没有附件，直接返回文本内容
    const attachments = message?.payload?.attachments;
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      return textContent;
    }

    // 尝试通过内容路由器处理多模态内容
    try {
      const parts = [{ type: 'text', text: textContent }];
      let hasMultimodal = false;
      const agentId = ctx?.agent?.id;

      // 获取智能体关联的 LLM 服务 ID 和工作区 ID
      const llmClient = agentId ? await this.runtime.getLlmClientForAgent(agentId) : null;
      const serviceId = llmClient?.serviceId || null;
      const workspaceId = agentId ? this.runtime._agentManager.findWorkspaceIdForAgent(agentId) : null;

      for (const att of attachments) {
        if (att.path) {
          const routed = await this.runtime.contentRouter.routeFileContent(att.path, serviceId, workspaceId);
          if (routed.contentType === 'multimodal' && Array.isArray(routed.content)) {
            // 提取多模态部分（如 image_url）
            const multimodalParts = routed.content.filter(p => p.type !== 'text');
            if (multimodalParts.length > 0) {
              parts.push(...multimodalParts);
              hasMultimodal = true;
            }
          }
        }
      }

      if (hasMultimodal) {
        return parts;
      }
      return textContent;
    } catch (error) {
      void this.runtime.log.error("格式化多模态消息时出错", {
        // 业务信息：哪个 agent 的什么消息格式化失败
        agentId: ctx?.agent?.id ?? null,
        messageId: message?.id ?? null,
        // 触发参数：消息和附件的具体内容
        messageRole: message?.role ?? null,
        textContentPreview: typeof textContent === 'string' ? textContent.substring(0, 500) : String(textContent).substring(0, 500),
        attachmentCount: attachments?.length ?? 0,
        attachmentPaths: attachments?.map(a => a.path).filter(Boolean) ?? [],
        serviceId,
        workspaceId,
        // 技术信息：异常详情
        error: error.message,
        stack: error.stack,
        name: error?.name,
        code: error?.code
      });
      return textContent;
    }
  }

  /**
   * 构建临时上下文（memory），不持久化到 conv。
   * 返回的 memoryContext 由 ComputeScheduler 在 LLM 调用前临时注入 messages 副本。
   * @param {any} ctx - 智能体上下文
   * @param {any} message - 入站消息对象（用于提取记忆召回查询文本）
   * @returns {Promise<string|null>} 格式化后的记忆上下文，没有记忆时返回 null
   */
  async buildEphemeralContexts(ctx, message) {
    const agentId = ctx?.agent?.id;
    if (!agentId) return null;

    const role = this.runtime.org?.getRole?.(ctx?.agent?.roleId);
    if (agentId === "root" || role?.agentMemoryEnabled === false) return null;

    this.runtime._state.setAgentComputePhase(agentId, "正在检索记忆...");
    const textContent = typeof message?.payload?.text === 'string'
      ? message.payload.text
      : (typeof message?.payload === 'string' ? message.payload : "");
    const memoryRecallQuery = this._buildMemoryRecallQuery(message, textContent);
    const memoryContext = await this._buildMemoryContext(agentId, memoryRecallQuery);
    this.runtime._state.setAgentComputePhase(agentId, "正在准备...");
    return memoryContext;
  }

  /**
   * 将临时记忆/知识上下文作为独立 user 消息插入最后一条 user 消息之前。
   * 传入的 messages 是 conv 的副本，因此新增的消息不会持久化到 conv，
   * 下一轮自然不存在，无需特殊清理。
   * @param {any[]} messages - 消息数组（conv 的副本）
   * @param {string|null} memoryContext - 格式化后的记忆/知识文本
   * @returns {{ messages: any[], injectionIndex: number }} 增强后的消息副本和注入位置
   */
  appendEphemeralToMessages(messages, memoryContext) {
    if (!memoryContext) return { messages, injectionIndex: -1 };
    if (!Array.isArray(messages) || messages.length === 0) return { messages, injectionIndex: -1 };

    // 找到最后一条 user 消息
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) return { messages, injectionIndex: -1 };

    // 在最后一条 user 消息之前插入独立的记忆上下文消息
    const enhanced = messages.slice();
    enhanced.splice(lastUserIndex, 0, { role: "user", content: memoryContext.trimStart() });

    // injectionIndex 是插入后记忆消息的位置（即原 lastUserIndex）
    return { messages: enhanced, injectionIndex: lastUserIndex };
  }

  /**
   * 获取发送者信息（用于消息格式化）
   * @param {string} senderId - 发送者ID
   * @returns {{role: string}|null}
   */
  getSenderInfo(senderId) {
    if (senderId === 'user') {
      return { role: 'user' };
    }
    if (senderId === 'root') {
      return { role: 'root' };
    }

    // 尝试从已注册的智能体获取角色信息
    const agent = this.runtime._agents.get(senderId);
    if (agent) {
      return { role: agent.roleName ?? 'unknown' };
    }

    // 尝试从智能体元数据获取
    const meta = this.runtime._agentMetaById.get(senderId);
    if (meta) {
      const role = this.runtime.org.getRole(meta.roleId);
      return { role: role?.name ?? 'unknown' };
    }

    return { role: 'unknown' };
  }

  /**
   * 格式化工具组信息，用于注入到系统提示词中。
   * @returns {string}
   * @private
   */
  formatToolGroupsInfo() {
    const groups = this.runtime.toolGroupManager.listGroups();
    if (!groups || groups.length === 0) {
      return "";
    }

    const lines = groups.map((g) => {
      const base = `- ${g.id}：${g.description}（${g.tools.join("、")}）`;
      const toolDefs = this.runtime.toolGroupManager.getToolDefinitions([g.id]);
      if (g.id !== "model_capability" || !Array.isArray(toolDefs) || toolDefs.length === 0) {
        return base;
      }
      const detailLines = toolDefs
        .map((toolDef) => this._formatToolParamSummary(toolDef))
        .filter(Boolean);
      if (detailLines.length === 0) {
        return base;
      }
      return `${base}\n  参数说明：\n${detailLines.join("\n")}`;
    });
    return `\n\n【可用工具组列表】\n${lines.join("\n")}`;
  }

  _formatToolParamSummary(toolDef) {
    const func = toolDef?.function;
    if (!func?.name) return "";
    const properties = func?.parameters?.properties;
    if (!properties || typeof properties !== "object") {
      return `  - ${func.name}：无参数定义`;
    }
    const paramKeys = Object.keys(properties);
    const requiredSet = new Set(Array.isArray(func?.parameters?.required) ? func.parameters.required : []);
    const paramsText = paramKeys
      .map((key) => {
        const keyText = requiredSet.has(key) ? `${key}(必填)` : key;
        const desc = typeof properties[key]?.description === "string" ? properties[key].description.trim() : "";
        return desc ? `${keyText}: ${desc}` : keyText;
      })
      .join("；");
    return `  - ${func.name}：${paramsText || "无参数"}`;
  }

  _stripEmbeddedToolGroupsInfo(promptText) {
    if (typeof promptText !== "string" || !promptText) return "";
    return promptText.replace(/\n{0,2}【可用工具组列表】[\s\S]*$/, "").trimEnd();
  }

  /**
   * 检查 LlmClient 是否支持工具调用。
   * @param {any} llmClient - LlmClient 实例
   * @returns {boolean} 是否支持工具调用
   * @private
   */
  _checkToolCallingSupport(llmClient) {
    if (!llmClient) return true;
    try {
      // LlmClient 内部存储配置的是 _clientConfig
      const config = llmClient._clientConfig ?? llmClient.config;
      void this.runtime.log.info("[RuntimeLlm] _checkToolCallingSupport 调试", {
        hasClientConfig: !!llmClient._clientConfig,
        hasConfig: !!llmClient.config,
        configKeys: config ? Object.keys(config) : [],
        config: config
      });
      if (!config) return true;
      const outputCapabilities = Array.isArray(config?.capabilities?.output)
        ? config.capabilities.output
        : null;
      if (outputCapabilities) {
        return outputCapabilities.includes("tool_calling");
      }
      const capabilityTags = Array.isArray(config?.capabilityTags) ? config.capabilityTags : null;
      if (capabilityTags) {
        return capabilityTags.includes("tool_calling");
      }
      return true;
    } catch (err) {
      this.runtime.log.error("[RuntimeLlm] 检查工具调用支持失败", {
        serviceId: llmClient?.serviceId ?? null,
        modelFamily: llmClient?._clientConfig?.modelFamily ?? null,
        // 技术信息
        error: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return false;
    }
  }
}
