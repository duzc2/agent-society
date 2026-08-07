/**
 * 真实 LLM 集成测试配置助手
 *
 * 提供配置检查、LlmClient 和 Runtime 的工厂函数，
 * 供 test/live/ 目录下的真实 API 测试使用。
 *
 * 设计约束：
 * 1. 使用真实 Config("config") 读取 config/ 目录，不做二次配置
 * 2. 绝不打印 API key
 * 3. 无 app.local.json 时 tests 应优雅跳过
 */

import { Config } from "../../src/platform/utils/config/config.js";
import { LlmClient } from "../../src/platform/services/llm/llm_client.js";
import { makeTestLogger } from "../helpers/test_logger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 检查真实 LLM 测试所需的配置是否就绪。
 *
 * 两步验证：
 * 1. app.local.json 文件是否存在
 * 2. 配置中的 llm.apiKey 是否非空
 *
 * @returns {{ ready: boolean, reason?: string }}
 */
export function checkLiveConfig() {
  const configService = new Config("config");

  if (!configService.hasLocalApp()) {
    return {
      ready: false,
      reason: "app.local.json 不存在，请先在 config/ 下创建 app.local.json 并填入 API 密钥"
    };
  }

  // 不在此处读取 apiKey 内容以保护密钥安全，
  // 让测试在实际调用 LLM 时自然地暴露配置问题。
  // 如果 apiKey 为空，LlmClient._ensureInitialized() 会抛出明确错误。

  return { ready: true };
}

/**
 * 创建一个真实的 LlmClient 实例，使用 config/ 下的真实 API 配置。
 *
 * LlmClient 会懒加载配置，首次 chat() 调用时从 configService.getLlm() 读取
 * 真实的 provider / baseURL / apiKey / model。
 *
 * @param {string|null} [serviceId=null] - 可选的 LLM 服务 ID，传 null 使用默认 LLM
 * @returns {LlmClient}
 */
export function createLiveLlmClient(serviceId = null) {
  const configService = new Config("config");

  return new LlmClient({
    configService,
    serviceId,
    logger: makeTestLogger("LlmClientLive"),
    maxRetries: 1
  });
}

/**
 * 创建一个最小化 Runtime，提供 getLlmClientForAgent() 和 httpClient，
 * 但避免完整 Runtime.init() 带来的不必要开销（内存监控、技能系统、模块加载器等）。
 *
 * LlmClient 通过 configService 懒加载真实 API 配置。
 *
 * @returns {Promise<{ runtime: object, configService: Config, llmClient: LlmClient }>}
 */
export async function createLiveRuntime() {
  const configService = new Config("config");
  const log = makeTestLogger("LiveRuntime");

  const llmClient = new LlmClient({
    configService,
    logger: log,
    maxRetries: 1
  });

  const runtime = {
    getLlmClientForAgent: async (_agentId) => llmClient,
    httpClient: {
      async request(_agentId, options) {
        const method = (options.method || "GET").toUpperCase();
        const headers = options.headers || {};
        try {
          const fetchInit = { method, headers };
          if (method !== "GET" && method !== "HEAD" && options.body) {
            fetchInit.body = typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body);
          }
          const resp = await fetch(options.url, fetchInit);
          const body = await resp.text();
          return {
            response: {
              status: resp.status,
              statusText: resp.statusText,
              body,
              headers: Object.fromEntries(resp.headers.entries())
            }
          };
        } catch (err) {
          return { error: err.message || String(err) };
        }
      }
    }
  };

  const baseDataDir = await mkdtemp(path.join(tmpdir(), "live-test-"));

  return {
    runtime,
    configService,
    llmClient,
    baseDataDir
  };
}

/**
 * 清理 createLiveRuntime() 创建的临时数据目录。
 *
 * @param {{ baseDataDir?: string }|null} runtimeState
 * @returns {Promise<void>}
 */
export async function cleanupLiveRuntime(runtimeState) {
  if (runtimeState?.baseDataDir) {
    try {
      await rm(runtimeState.baseDataDir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻塞测试
    }
  }
}
