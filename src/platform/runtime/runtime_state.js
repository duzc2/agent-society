/**
 * Runtime 状态管理模块
 *
 * 职责：
 * - 管理智能体注册表
 * - 跟踪智能体运算状态
 * - 管理对话历史
 * - 管理任务工作空间映射
 * - 提供状态锁机制
 *
 * 设计原则：
 * - 单一职责：只负责状态的存储和访问
 * - 低耦合：通过接口与其他模块交互
 * - 高内聚：所有状态管理逻辑集中在此模块
 */

import { registry } from "../core/module_registry.js";

/**
 * RuntimeState 类
 * 封装 Runtime 的所有状态管理逻辑
 */
export class RuntimeState {
  /**
   * 构造函数
   * @param {object} [options] - 配置选项
   * @param {{info?: Function, warn?: Function, error?: Function, debug?: Function}} [options.logger] - 日志记录器
   * @param {Function} [options.onComputePhaseChange] - 运算阶段变更回调
   */
  constructor(options) {
    const opts = options ?? {};
    this.log = opts.logger ?? null;
    this._onComputePhaseChange = opts.onComputePhaseChange ?? null;

    // 运算状态变更监听器集合（支持多个模块同时订阅）
    this._computeStatusListeners = new Set();

    // 智能体注册表（公开访问以保持向后兼容）
    this._agents = new Map();
    this._agentMetaById = new Map();

    // 运算状态跟踪（公开访问以保持向后兼容）
    this._agentComputeStatus = new Map(); // agentId -> 'idle' | 'waiting_llm' | 'processing' | 'stopping' | 'stopped' | 'terminating'
    this._agentComputePhase = new Map(); // agentId -> string|null 当前运算阶段描述
    this._activeProcessingAgents = new Set(); // 正在处理消息的智能体集合（用于并发控制）

    // 对话历史（由 ConversationManager 管理，这里只保存引用）（公开访问以保持向后兼容）
    this._conversations = new Map();

    // 任务工作空间映射（公开访问以保持向后兼容）
    this._taskWorkspaces = new Map(); // taskId -> workspacePath
    this._agentTaskBriefs = new Map(); // agentId -> TaskBrief

    // 状态锁（公开访问以保持向后兼容）
    this._stateLocks = new Map(); // agentId -> Promise 队列
  }

  // ==================== 智能体注册表管理 ====================

  /**
   * 注册智能体实例
   * @param {object} agent - 智能体实例
   */
  registerAgent(agent) {
    this._agents.set(agent.id, agent);
  }

  /**
   * 获取智能体实例
   * @param {string} agentId - 智能体ID
   * @returns {object|undefined} 智能体实例
   */
  getAgent(agentId) {
    return this._agents.get(agentId);
  }

  /**
   * 检查智能体是否存在
   * @param {string} agentId - 智能体ID
   * @returns {boolean}
   */
  hasAgent(agentId) {
    return this._agents.has(agentId);
  }

  /**
   * 获取所有智能体ID
   * @returns {IterableIterator<string>}
   */
  getAllAgentIds() {
    return this._agents.keys();
  }

  /**
   * 获取智能体数量
   * @returns {number}
   */
  getAgentCount() {
    return this._agents.size;
  }

  /**
   * 获取所有智能体实例
   * @returns {Array<object>}
   */
  getAllAgents() {
    return Array.from(this._agents.values());
  }

  /**
   * 设置智能体元数据
   * @param {string} agentId - 智能体ID
   * @param {object} meta - 元数据
   */
  setAgentMeta(agentId, meta) {
    this._agentMetaById.set(agentId, meta);
  }

  /**
   * 获取智能体元数据
   * @param {string} agentId - 智能体ID
   * @returns {object|undefined}
   */
  getAgentMeta(agentId) {
    return this._agentMetaById.get(agentId);
  }

  // ==================== 运算状态管理 ====================

  /**
   * 注册运算状态变更监听器。
   * @param {(agentId: string, status: string) => void} cb
   */
  addComputeStatusListener(cb) {
    if (typeof cb === "function") {
      this._computeStatusListeners.add(cb);
    }
  }

  /**
   * 移除运算状态变更监听器。
   * @param {(agentId: string, status: string) => void} cb
   */
  removeComputeStatusListener(cb) {
    this._computeStatusListeners.delete(cb);
  }

  /**
   * 设置智能体运算状态
   * @param {string} agentId - 智能体ID
   * @param {'idle'|'waiting_llm'|'processing'|'stopping'|'stopped'|'terminating'} status - 运算状态
   */
  setAgentComputeStatus(agentId, status) {
    if (!agentId) return;
    this._agentComputeStatus.set(agentId, status);

    // 触发所有运算状态变更监听器
    if (this._computeStatusListeners.size > 0) {
      for (const listener of this._computeStatusListeners) {
        try {
          listener(agentId, status);
        } catch (err) {
          void this.log.warn("运算状态变更监听器执行失败", {
            agentId,
            status,
            error: err?.message ?? String(err),
            stack: err?.stack,
            name: err?.name,
            code: err?.code
          });
        }
      }
    }
  }

  /**
   * 获取智能体运算状态
   * @param {string} agentId - 智能体ID
   * @returns {'idle'|'waiting_llm'|'processing'|'stopping'|'stopped'|'terminating'} 运算状态
   */
  getAgentComputeStatus(agentId) {
    return this._agentComputeStatus.get(agentId) ?? 'idle';
  }

  // ==================== 运算阶段管理 ====================

  /**
   * 设置智能体当前运算阶段（用于前端展示更细致的进度信息）。
   * @param {string} agentId - 智能体ID
   * @param {string|null} phase - 运算阶段描述，如 "正在生成回复..."，"正在执行工具: search_file"，null 表示清除
   */
  setAgentComputePhase(agentId, phase) {
    if (!agentId) return;
    if (phase === null || phase === undefined) {
      this._agentComputePhase.delete(agentId);
    } else {
      this._agentComputePhase.set(agentId, String(phase));
    }
    // 触发阶段变更回调
    if (this._onComputePhaseChange) {
      this._onComputePhaseChange(agentId, phase);
    }
  }

  /**
   * 获取智能体当前运算阶段。
   * @param {string} agentId - 智能体ID
   * @returns {string|null}
   */
  getAgentComputePhase(agentId) {
    return this._agentComputePhase.get(agentId) ?? null;
  }

  /**
   * 获取所有智能体的运算状态
   * @returns {Object.<string, string>} 智能体ID到运算状态的映射
   */
  getAllAgentComputeStatus() {
    return Object.fromEntries(this._agentComputeStatus);
  }

  /**
   * 标记智能体为活跃处理中
   * @param {string} agentId - 智能体ID
   */
  markAgentAsActivelyProcessing(agentId) {
    this._activeProcessingAgents.add(agentId);
  }

  /**
   * 取消智能体的活跃处理标记
   * @param {string} agentId - 智能体ID
   */
  unmarkAgentAsActivelyProcessing(agentId) {
    this._activeProcessingAgents.delete(agentId);
  }

  /**
   * 检查智能体是否正在活跃处理消息
   * @param {string} agentId - 智能体ID
   * @returns {boolean}
   */
  isAgentActivelyProcessing(agentId) {
    return this._activeProcessingAgents.has(agentId);
  }

  /**
   * 获取活跃处理智能体的数量
   * @returns {number}
   */
  getActiveProcessingCount() {
    return this._activeProcessingAgents.size;
  }

  /**
   * 获取所有活跃处理的智能体ID
   * @returns {Array<string>}
   */
  getActiveProcessingAgents() {
    return Array.from(this._activeProcessingAgents);
  }

  // ==================== 对话历史管理 ====================

  /**
   * 获取对话历史引用（由 ConversationManager 管理）
   * @returns {Map<string, Array>}
   */
  getConversations() {
    return this._conversations;
  }

  /**
   * 获取指定智能体的对话历史
   * @param {string} agentId - 智能体ID
   * @returns {Array|undefined}
   */
  getConversation(agentId) {
    return this._conversations.get(agentId);
  }

  // ==================== 任务工作空间映射 ====================

  /**
   * 设置任务工作空间
   * @param {string} taskId - 任务ID
   * @param {string} workspacePath - 工作空间路径
   */
  setTaskWorkspace(taskId, workspacePath) {
    this._taskWorkspaces.set(taskId, workspacePath);
  }

  /**
   * 获取任务工作空间
   * @param {string} taskId - 任务ID
   * @returns {string|undefined}
   */
  getTaskWorkspace(taskId) {
    return this._taskWorkspaces.get(taskId);
  }

  /**
   * 设置智能体的任务委托书
   * @param {string} agentId - 智能体ID
   * @param {object} taskBrief - 任务委托书
   */
  setAgentTaskBrief(agentId, taskBrief) {
    this._agentTaskBriefs.set(agentId, taskBrief);
  }

  /**
   * 获取智能体的任务委托书
   * @param {string} agentId - 智能体ID
   * @returns {object|undefined}
   */
  getAgentTaskBrief(agentId) {
    return this._agentTaskBriefs.get(agentId);
  }

  // ==================== 状态锁管理 ====================

  /**
   * 获取智能体状态锁（用于原子性操作）
   * 使用 Promise 队列实现简单的互斥锁机制
   * 
   * @param {string} agentId - 智能体ID
   * @returns {Promise<Function>} 返回释放锁的函数
   */
  async acquireLock(agentId) {
    if (!this._stateLocks.has(agentId)) {
      this._stateLocks.set(agentId, Promise.resolve());
    }
    const currentLock = this._stateLocks.get(agentId);
    let releaseFn;
    const newLock = new Promise(resolve => { releaseFn = resolve; });
    this._stateLocks.set(agentId, currentLock.then(() => newLock));
    await currentLock;
    return releaseFn;
  }

  /**
   * 释放智能体状态锁
   * @param {Function} releaseFn - 释放函数
   */
  releaseLock(releaseFn) {
    if (releaseFn) releaseFn();
  }
}

/**
 * 将 RuntimeState 实例注册到 ModuleRegistry。
 * 由 runtime.js 构造函数在创建 this._state 后调用。
 * @param {RuntimeState} instance
 */
export function provideToRegistry(instance) {
  registry.provide({ llmConversations: { getConversation: (id) => instance.getConversation(id) } });
}
