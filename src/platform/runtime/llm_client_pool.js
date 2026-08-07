/**
 * LlmClientPoolManager - LLM 客户端池管理器
 *
 * 职责：管理 LlmClient 实例池，按 serviceId 缓存和获取客户端。
 *
 * @module runtime/llm_client_pool
 */

import { LlmClient } from "../services/llm/llm_client.js";
import { getErrorMessage } from "../utils/error_utils.js";
import { registry } from "../core/module_registry.js";

export class LlmClientPoolManager {
  constructor(runtime) {
    this.runtime = runtime;
    /** @type {Map<string, LlmClient>} */
    this._pool = new Map();
  }

  /**
   * 获取指定 LLM 服务的客户端实例。
   * 如果服务不存在或未配置，返回 null。
   * @param {string} serviceId - LLM 服务 ID
   * @returns {Promise<LlmClient|null>} LlmClient 实例，如果服务不存在则返回 null
   */
  async getClientForService(serviceId) {
    if (!serviceId) {
      return null;
    }

    // 检查池中是否已有客户端（LlmClient 会自己从 configService 读取最新配置）
    const cached = this._pool.get(serviceId);
    if (cached) {
      return cached;
    }

    // 创建新的 LlmClient 实例（传递 configService 引用）
    try {
      const client = new LlmClient({
        configService: this.runtime._configService,
        serviceId: serviceId,
        logger: this.runtime.loggerRoot.forModule(`llm_${serviceId}`),
        retryCoordinator: this.runtime._retryCoordinator,
        onRetry: (event) => {
          if (event.agentId && event.attempt != null) {
            this.runtime._state.setAgentComputePhase(event.agentId, `正在重试 LLM 调用（第 ${event.attempt} 次）...`);
          }
          this.runtime._emitLlmRetry(event);
        }
      });

      // 存入池中
      this._pool.set(serviceId, client);

      void this.runtime.log.info("创建 LlmClient 实例", {
        serviceId,
      });

      return client;
    } catch (err) {
      const message = getErrorMessage(err);
      void this.runtime.log.error("创建 LlmClient 失败", {
        serviceId,
        error: message,
        stack: err?.stack,
        name: err?.name,
        code: err?.code
      });
      return null;
    }
  }

  /**
   * 获取智能体应使用的 LlmClient。
   * 根据智能体岗位的 llmServiceId 获取对应的 LlmClient，如果未指定或服务不可用则使用默认 LlmClient。
   * @param {string} agentId - 智能体ID
   * @returns {Promise<LlmClient|null>} LlmClient 实例
   */
  async getClientForAgent(agentId) {
    if (!agentId) {
      return this.runtime.llm;
    }

    // 获取智能体的岗位信息
    const agent = this.runtime._agents.get(agentId);
    if (!agent) {
      return this.runtime.llm;
    }

    const role = this.runtime.org.getRole(agent.roleId);
    if (!role || !role.llmServiceId) {
      // 岗位未指定 llmServiceId，使用默认 LlmClient
      return this.runtime.llm;
    }

    // 尝试获取指定服务的 LlmClient
    const serviceClient = await this.getClientForService(role.llmServiceId);
    if (serviceClient) {
      return serviceClient;
    }

    // 服务不可用，回退到默认 LlmClient
    void this.runtime.log.warn("岗位指定的 LLM 服务不可用，使用默认 LlmClient", {
      agentId,
      roleId: agent.roleId,
      llmServiceId: role.llmServiceId
    });
    return this.runtime.llm;
  }

  /**
   * 获取智能体使用的 LLM 服务 ID
   * @param {string} agentId - 智能体ID
   * @returns {string|null} LLM 服务 ID，如果使用默认服务则返回 null
   */
  getServiceIdForAgent(agentId) {
    if (!agentId) {
      return null;
    }

    const agent = this.runtime._agents.get(agentId);
    if (!agent) {
      return null;
    }

    const role = this.runtime.org.getRole(agent.roleId);
    if (!role || !role.llmServiceId) {
      return null;
    }

    // 检查服务是否存在
    if (this.runtime.serviceRegistry.getServiceById(role.llmServiceId)) {
      return role.llmServiceId;
    }

    return null;
  }
}

/**
 * 将 LlmClientPoolManager 实例注册到 ModuleRegistry。
 * 由 runtime.js 构造函数在创建 this._llmClientPool 后调用。
 * @param {LlmClientPoolManager} instance
 */
export function provideToRegistry(instance) {
  registry.provide({ agentLlmClients: { getClientForAgent: (id) => instance.getClientForAgent(id), getClientForService: (id) => instance.getClientForService(id) } });
}
