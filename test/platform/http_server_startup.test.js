/**
 * HTTP Server 启动集成测试
 *
 * 验证完整的服务器启动流程：
 *   setSociety() -> registry.provide() -> registry.ensureReady() -> Hono app.request()
 *
 * 现有单元测试直接从模块文件导入 handler 并用 .call(server, ...) 调用，
 * 从未经过 registry 依赖注入和 Hono 路由注册链路，因此无法发现启动失败。
 * 本测试补齐这一缺口。
 *
 * 注意：registry 是全局单例，模块只在首次 provide 满足依赖时激活，
 * 后续创建的 HTTPServer 实例不会再触发模块 init。因此所有端点测试共享
 * 同一个服务器实例的 Hono app。
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { registry } from "../../src/platform/core/module_registry.js";
import { HTTPServer } from "../../src/platform/services/http/http_server/index.js";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
// 触发 broker.js 的 registry.declare() 以注册 UI 命令路由
import "../../modules/ui_page/broker.js";

// ---------------------------------------------------------------------------
// Mock 基础设施
// ---------------------------------------------------------------------------

const mockConfigService = {
  hasLocalApp() { return false; },
  maskApiKey(k) { return k ? k.slice(0, 4) + "***" : ""; },
  async getLlm() { return { llm: { provider: "openai", apiKey: "" }, source: "default" }; },
  validateLlm() { return { valid: true }; },
  async saveLlm() {},
  async getModules() { return { modules: {}, source: "default", mergedModules: {}, defaultModules: {} }; },
  async saveModules() {},
  registerModuleConfig() {},
  async getModuleConfig() { return {}; },
  async saveModuleConfig() { return {}; },
  async getAppSettings() { return { settings: {} }; },
  async saveAppSettings() {},
  async getServices() { return { services: [], source: "default" }; },
  validateService() { return { valid: true }; },
  async addService() { return {}; },
  async updateService() { return {}; },
  async deleteService() {},
  async getChatConfig() { return { fontSize: 14 }; },
  async saveChatConfig() {},
  _moduleConfigs: new Map(),
};

const mockSkillsService = {
  async listCatalog() { return []; },
  async getRuntimeInfo() { return {}; },
  async installSkill() { return {}; },
  async uninstallSkill() { return {}; },
  async getSkillOverview() { return null; },
  async getSkillContent() { return null; },
  async getRoleSkillBindingsView() { return { bindings: [] }; },
  async setRoleSkillBindings() { return {}; },
  async getAgentSkillBindingsView() { return { bindings: [] }; },
  async setAgentSkillBindings() { return {}; },
};

const mockCustomSkillService = {
  async listCustomSkills() { return []; },
  async createCustomSkill() { return {}; },
  async copySkillAsCustom() { return {}; },
  async getCustomSkill() { return null; },
  async deleteCustomSkill() { return false; },
  async getCustomSkillTree() { return null; },
  async readCustomSkillFile() { return null; },
  async createCustomSkillFile() { return {}; },
  async writeCustomSkillFile() { return {}; },
  async createCustomSkillFolder() { return {}; },
  async deleteCustomSkillEntry() { return {}; },
  async renameCustomSkillEntry() { return {}; },
  async setCustomSkillStatus() { return {}; },
  async _getCustomSkillRecord() { return null; },
  repository: { getSkillDir() { return "/mock/skills/test"; } },
};

const mockGitSkillService = {
  async listGitSkills() { return []; },
  async importFromGit() { return {}; },
  async getGitSkill() { return null; },
  async deleteGitSkill() { return false; },
  async updateGitSkill() { return {}; },
  async readGitSkillFile() { return null; },
  async setGitSkillStatus() { return {}; },
};

function createMockSociety() {
  const heartbeatBroker = {
    drain() { return []; },
    broadcast() {},
    clearMessage() {},
    onBeforeDrain() {},
    onDelayedDelivery() {},
  };

  const agentTools = { groupChatService: null };

  return {
    runtime: {
      moduleLoader: { getLoadedModules() { return []; }, getWebComponents() { return []; } },
      toolGroupManager: { listGroups() { return []; } },
      heartbeatBroker,
      loggerRoot: testLoggerRoot,
      orgTemplates: null,
      knowledgeTree: null,
      config: { workspacesDir: "/tmp/test-workspaces" },
      dataDir: "/tmp/test-data",
      bus: {
        send() { return { messageId: "msg-mock-1" }; },
        onDelayedDelivery() {},
      },
      org: {
        getAgent() { return null; },
        getRole() { return null; },
        listRoles() { return []; },
        listAgents() { return []; }
      },
      _toolExecutor: { groupTools: null, agentTools },
      _events: null,
    },
    onUserMessage() {},
    onAllMessages() {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getJson(app, path) {
  const res = await app.request(path);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function postJson(app, path, data) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 全局共享：一个 server 实例，setSociety 只调用一次
//   所有端点测试共用同一个 Hono app。
// ---------------------------------------------------------------------------

/** @type {HTTPServer} */
let server;
/** @type {import('hono').Hono} */
let app;

before(async () => {
  // 重置模块状态：其他测试（如 e2e.test.js）可能已通过 registry.provide()
  // 激活了模块并留下了旧 app/skillsService 等，导致路由注册到错误的 app。
  for (const [, mod] of registry._modules) {
    if (mod.status !== "declared") {
      mod.status = "declared";
    }
  }
  // 清除 setSociety() 会重新提供的服务，避免旧 app 残留
  const RESET_KEYS = new Set([
    "app", "log", "society", "configService", "llmStatus", "llmLastError",
    "moduleLoader", "toolGroupManager", "logRoot", "heartbeatBroker",
    "workspacesDir", "dataDir", "runtimeDir", "orgTemplatesSystem", "knowledgeTreeSystem",
    "runtimeEvents", "bus", "org", "runtimeLlm"
  ]);
  for (const key of RESET_KEYS) {
    registry._services.delete(key);
  }

  // Step 1: 模拟 Runtime 已初始化 — 提供 setSociety() 不提供的服务
  await registry.provide({
    skillsService: mockSkillsService,
    customSkillService: mockCustomSkillService,
    gitSkillService: mockGitSkillService,
    findWorkspaceIdForAgent: () => null,
    runtimeEvents: {
      onAgentTerminated() {},
      onToolCall() {},
      onError() {},
      onLlmRetry() {},
      onComputeStatusChange() {},
      emitAgentTerminated() {},
      emitToolCall() {},
      emitError() {},
      emitLlmRetry() {},
      emitComputeStatusChange() {},
      offAgentTerminated() {},
      offToolCall() {},
      offError() {},
      offLlmRetry() {},
      offComputeStatusChange() {},
      getListenerCounts() { return {}; },
      removeAllListeners() {}
    },
    bus: {
      send() { return { messageId: "mock-msg-id" }; }
    },
    runtimeLlm: {
      registerMessageFormatter() {}
    },
    org: {
      getAgent() { return null; },
      getRole() { return null; },
      listRoles() { return []; },
      listAgents() { return []; }
    }
  });

  // Step 2: 创建 server 并调用 setSociety
  server = new HTTPServer({
    port: 30999,
    logger: makeTestLogger("HTTPServer"),
    configService: mockConfigService,
    runtimeDir: "/tmp/test-runtime",
  });

  await server.setSociety(createMockSociety());

  app = server._app;
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("HTTPServer startup integration", () => {

  // ===================== 生命周期 =====================

  it("setSociety should complete without throwing", () => {
    // beforeAll 已成功执行 setSociety，这里验证 app 存在
    assert.notStrictEqual(app, undefined);
    // 验证 _setupHonoApp 正确运行
    assert.strictEqual(typeof app.fetch, "function");
  });

  it("all declared modules should be 'active' after ensureReady", () => {
    // registry.ensureReady() 在 setSociety 最后被调用，不抛异常即为通过。
    // 再次验证模块状态。
    for (const [name, mod] of registry._modules) {
      assert.strictEqual(mod.status, "active");
    }
  });

  // ===================== Config 端点 =====================

  it("GET /api/config/status", async () => {
    const r = await getJson(app, "/api/config/status");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "hasLocalConfig"));
    assert.ok(Object.hasOwn(r.body, "llmStatus"));
  });

  it("GET /api/config/llm", async () => {
    const r = await getJson(app, "/api/config/llm");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "llm"));
    assert.ok(Object.hasOwn(r.body, "source"));
  });

  it("GET /api/config/modules", async () => {
    const r = await getJson(app, "/api/config/modules");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "modules"));
    assert.ok(Object.hasOwn(r.body, "catalog"));
  });

  it("GET /api/config/app-settings", async () => {
    const r = await getJson(app, "/api/config/app-settings");
    assert.strictEqual(r.status, 200);
  });

  it("GET /api/config/llm-services", async () => {
    const r = await getJson(app, "/api/config/llm-services");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "services"));
  });

  it("GET /api/config/chat", async () => {
    const r = await getJson(app, "/api/config/chat");
    assert.strictEqual(r.status, 200);
  });

  it("GET /api/tool-groups", async () => {
    const r = await getJson(app, "/api/tool-groups");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "toolGroups"));
  });

  // ===================== Skills 端点 =====================

  it("GET /api/skills", async () => {
    const r = await getJson(app, "/api/skills");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "skills"));
  });

  it("GET /api/custom-skills", async () => {
    const r = await getJson(app, "/api/custom-skills");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "skills"));
  });

  it("GET /api/git-skills", async () => {
    const r = await getJson(app, "/api/git-skills");
    assert.strictEqual(r.status, 200);
    assert.ok(Object.hasOwn(r.body, "skills"));
  });

  it("GET /api/skills/:skillId (not found -> 404)", async () => {
    const r = await getJson(app, "/api/skills/nonexistent-skill");
    assert.strictEqual(r.status, 404);
  });

  // ===================== Heartbeat / UI Commands =====================

  it("POST /api/heartbeat", async () => {
    const r = await postJson(app, "/api/heartbeat", { lastMessageId: 0 });
    assert.strictEqual(r.status, 200);
    // 无待推送消息时返回空对象
    assert.notStrictEqual(r.body, undefined);
  });

  it("POST /api/ui-commands/result (missing commandId -> 400)", async () => {
    const r = await postJson(app, "/api/ui-commands/result", {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "missing_command_id");
  });

  // ===================== Org Templates 端点 =====================
  // orgTemplatesSystem 为 null，checkTemplates 应返回 500

  it("GET /api/org-templates (system null -> 500)", async () => {
    const r = await getJson(app, "/api/org-templates");
    assert.strictEqual(r.status, 500);
  });

  // ===================== Knowledge Tree 端点 =====================
  // knowledgeTree 为 null

  it("GET /api/agents/:agentId/knowledge-tree (system null -> 500)", async () => {
    const r = await getJson(app, "/api/agents/test-agent/knowledge-tree");
    assert.strictEqual(r.status, 500);
  });

  // ===================== Module API 端点 =====================

  it("GET /api/modules (returns empty list)", async () => {
    const r = await getJson(app, "/api/modules");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(Array.isArray(r.body.modules), true);
  });

  // ===================== Workspace 端点 =====================
  // workspaceManager 现在由 workspace_manager.js 的 registry.declare 自行创建，
  // 通过 setSociety -> registry.provide({ workspacesDir }) 注入目录路径。
  // 路由注册的正确性可以间接验证：workspace-manager 模块已是 'active' 状态。

  it("workspace manager module is active", () => {
    const mod = registry._modules.get("workspace-manager");
    assert.notStrictEqual(mod, undefined);
    assert.strictEqual(mod.status, "active");
  });
});
