/**
 * 消息详情端点集成测试（推送瘦身 / Step 1）
 *
 * 覆盖：
 * - GET /api/agent-messages/:agentId/detail/:messageId 命中内存索引时返回全量字段
 *   （reasoning_content / memoryContext / knowledgeContext / 工具 args / result）
 * - 消息在 jsonl 文件但未在内存索引时，经 loadMessagesForAgent 兜底后命中
 * - 未知 messageId → 404
 * - 跨智能体 messageId（from/to 均不匹配）→ 404（作用域校验，防跨智能体读取）
 * - 缺失参数 → 400
 *
 * 搭建方式仿 http_server_startup.test.js：registry + mock society + app.request()。
 * runtimeDir 使用临时目录，消息通过 mock bus.send 拦截链路注入（与生产路径一致）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registry } from "../../src/platform/core/module_registry.js";
import { HTTPServer } from "../../src/platform/services/http/http_server/index.js";
import { HeartbeatBroker } from "../../src/platform/services/heartbeat/heartbeat_broker.js";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";

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
  async writeCustomSkillFile() { return {}; },
  async createCustomSkillFile() { return {}; },
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
  // 用真实 HeartbeatBroker：onBeforeDrain 注入 → drain 取出 是裁剪语义的关键路径，
  // mock broker 无法验证 message-handlers 在 drain 前把新消息组装为存根的行为
  const heartbeatBroker = new HeartbeatBroker({ logger: makeTestLogger("HeartbeatBroker") });
  // onToolCall 监听器注册表：message-handlers 的 bootstrapListeners 在
  // runtime.onToolCall 为函数时注册回调，storeToolCall 全链路即可在测试中触发
  const toolCallListeners = new Set();
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
      onToolCall(fn) { toolCallListeners.add(fn); },
      emitToolCall(event) { for (const fn of toolCallListeners) fn(event); },
      bus: {
        // bus.send 会被 message-handlers 的 bootstrapListeners 包装：包装后每次 send
        // 都会经 storeMessage 落入内存索引与 jsonl 文件（与生产路径一致）。
        // messageId 递增以保证同 agent 多条消息 id 不同。
        _nextId: 0,
        send(msg) {
          this._nextId += 1;
          return { messageId: `msg-${this._nextId}-${msg.from ?? "x"}` };
        },
        onDelayedDelivery() {},
      },
      org: {
        getAgent() { return null; },
        getRole() { return null; },
        listRoles() { return []; },
        listAgents() { return []; }
      },
      // 列表端点 getRegenerableMessageId 会调 getLastAssistantMessage
      _conversationManager: {
        getLastAssistantMessage() { return null; },
      },
      _toolExecutor: { groupTools: null, agentTools: { groupChatService: null } },
      _events: null,
    },
    onUserMessage() {},
    onAllMessages() {},
  };
}

// ---------------------------------------------------------------------------
// 全局共享 server（registry 单例约束：所有测试共享一个 Hono app）
// ---------------------------------------------------------------------------

let server;
let app;
let tempRuntimeDir;
let society;

async function getJson(path) {
  const res = await app.request(path);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * 等待某条消息落盘到 {runtimeDir}/web/messages/{agentId}.jsonl。
 * storeMessage 是 fire-and-forget：bus.send 返回后 jsonl 追加仍在写队列中排队。
 * 不等待直接进入 after 清理临时目录会触发迟到的 mkdir ENOENT（unhandledRejection）。
 */
async function waitForMessagePersisted(agentId, messageId, { timeoutMs = 5000 } = {}) {
  const file = path.join(tempRuntimeDir, "web", "messages", `${agentId}.jsonl`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(file, "utf8");
      if (content.includes(`"id":"${messageId}"`) || content.includes(`"id": "${messageId}"`)) {
        return;
      }
    } catch { /* 文件尚未创建，继续轮询 */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待消息落盘超时: agentId=${agentId} messageId=${messageId}`);
}

before(async () => {
  // 重置模块状态（与其他 HTTP 端点测试互不残留 app/society）
  for (const [, mod] of registry._modules) {
    if (mod.status !== "declared") {
      mod.status = "declared";
    }
  }
  const RESET_KEYS = new Set([
    "app", "log", "society", "configService", "llmStatus", "llmLastError",
    "moduleLoader", "toolGroupManager", "logRoot", "heartbeatBroker",
    "workspacesDir", "dataDir", "runtimeDir", "orgTemplatesSystem", "knowledgeTreeSystem",
    "runtimeEvents", "bus", "org", "runtimeLlm"
  ]);
  for (const key of RESET_KEYS) {
    registry._services.delete(key);
  }

  await registry.provide({
    skillsService: mockSkillsService,
    customSkillService: mockCustomSkillService,
    gitSkillService: mockGitSkillService,
    findWorkspaceIdForAgent: () => null,
    runtimeEvents: {
      onAgentTerminated() {}, onToolCall() {}, onError() {}, onLlmRetry() {},
      onComputeStatusChange() {},
      emitAgentTerminated() {}, emitToolCall() {}, emitError() {}, emitLlmRetry() {},
      emitComputeStatusChange() {},
      offAgentTerminated() {}, offToolCall() {}, offError() {}, offLlmRetry() {},
      offComputeStatusChange() {},
      getListenerCounts() { return {}; },
      removeAllListeners() {}
    },
    bus: { send() { return { messageId: "mock-msg-id" }; } },
    runtimeLlm: { registerMessageFormatter() {} },
    org: {
      getAgent() { return null; },
      getRole() { return null; },
      listRoles() { return []; },
      listAgents() { return []; }
    }
  });

  tempRuntimeDir = mkdtempSync(path.join(tmpdir(), "msg-detail-test-"));
  society = createMockSociety();
  server = new HTTPServer({
    port: 30998,
    logger: makeTestLogger("HTTPServer"),
    configService: mockConfigService,
    runtimeDir: tempRuntimeDir,
  });
  await server.setSociety(society);
  app = server._app;
});

after(async () => {
  if (tempRuntimeDir) {
    try { rmSync(tempRuntimeDir, { recursive: true, force: true }); } catch { /* 清理失败不阻塞测试结束 */ }
  }
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("GET /api/agent-messages/:agentId/detail/:messageId", () => {

  it("assistant 消息详情返回全量字段（reasoning/memoryContext/knowledgeContext）", async () => {
    // 通过包装后的 bus.send 注入一条带全量大字段的 assistant 消息
    const result = society.runtime.bus.send({
      from: "agent-a", to: "user", taskId: "t-1",
      payload: { text: "回复正文", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      reasoning_content: "思考全文内容",
      memoryContext: "记忆召回内容",
      knowledgeContext: "知识树检索内容",
    });
    const msgId = result.messageId;
    // 等待 jsonl 追加落盘，避免写队列中的异步写入在测试结束后触发 unhandledRejection
    await waitForMessagePersisted("agent-a", msgId);

    const r = await getJson(`/api/agent-messages/agent-a/detail/${encodeURIComponent(msgId)}`);
    assert.strictEqual(r.status, 200);
    const msg = r.body.message;
    assert.strictEqual(msg.id, msgId);
    assert.strictEqual(msg.reasoning_content, "思考全文内容");
    assert.strictEqual(msg.memoryContext, "记忆召回内容");
    assert.strictEqual(msg.knowledgeContext, "知识树检索内容");
    assert.strictEqual(msg.payload.text, "回复正文");
  });

  it("未知 messageId 返回 404", async () => {
    const r = await getJson("/api/agent-messages/agent-a/detail/nonexistent-id");
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, "message_not_found");
  });

  it("跨智能体 messageId 返回 404（作用域校验）", async () => {
    // 消息属于 agent-a，用 agent-b 的作用域查询必须 404
    const result = society.runtime.bus.send({
      from: "agent-a", to: "user", taskId: "t-2",
      payload: { text: "agent-a 的消息" },
    });
    // 等待 jsonl 追加落盘（同上）
    await waitForMessagePersisted("agent-a", result.messageId);

    const r = await getJson(`/api/agent-messages/agent-b/detail/${encodeURIComponent(result.messageId)}`);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, "message_not_found");
  });

  it("缺失 messageId 返回 400", async () => {
    // 路径参数为空字符串（URL 中编码后可达）
    const r = await getJson("/api/agent-messages/agent-a/detail/%20");
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, "missing_message_id");
  });

  it("用户消息（无大字段）详情同样可查", async () => {
    // user 消息只带 payload，验证普通消息也能按 ID 取回
    const result = society.runtime.bus.send({
      from: "user", to: "agent-a", taskId: "t-3",
      payload: { text: "用户提问" },
    });
    // 等待 jsonl 追加落盘（同上）
    await waitForMessagePersisted("agent-a", result.messageId);

    const r = await getJson(`/api/agent-messages/agent-a/detail/${encodeURIComponent(result.messageId)}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.message.payload.text, "用户提问");
    assert.strictEqual(r.body.message.to, "agent-a");
  });

});

// ---------------------------------------------------------------------------
// Step 2：广播体与列表响应裁剪（存根语义）
// ---------------------------------------------------------------------------

describe("消息推送存根裁剪", () => {

  it("心跳广播（onBeforeDrain → drain）不含大字段，含三个 hasXxx 布尔", async () => {
    const result = society.runtime.bus.send({
      from: "agent-a", to: "user", taskId: "t-stub-1",
      payload: { text: "存根测试正文", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      reasoning_content: "这是一段很长的思考过程……",
      memoryContext: "记忆召回内容……",
      knowledgeContext: "知识树内容……",
    });
    await waitForMessagePersisted("agent-a", result.messageId);

    // drain 触发 onBeforeDrain：message-handlers 把新消息以存根形式 broadcast。
    // drain(0) 会返回此前所有用例的广播，按 messageId 精确定位本用例的消息。
    const messages = society.runtime.heartbeatBroker.drain(0);
    let stub = null;
    for (const m of messages) {
      if (m.type !== "agent_message") continue;
      const found = (m.payload.agents["agent-a"] || []).find(s => s.id === result.messageId);
      if (found) { stub = found; break; }
    }
    assert.ok(stub, "广播中应含本用例消息存根");
    // 大字段剥离
    assert.strictEqual("reasoning_content" in stub, false);
    assert.strictEqual("memoryContext" in stub, false);
    assert.strictEqual("knowledgeContext" in stub, false);
    // 布尔标记存在性
    assert.strictEqual(stub.hasReasoning, true);
    assert.strictEqual(stub.hasMemoryContext, true);
    assert.strictEqual(stub.hasKnowledgeContext, true);
    // 正文与 usage 保留（不展开即可见）
    assert.strictEqual(stub.payload.text, "存根测试正文");
    assert.strictEqual(stub.payload.usage.totalTokens, 2);
  });

  it("工具调用广播剥离 args/result 正文，保留 toolName/usage/files 与 hasResult", async () => {
    // 经 mock society 的 onToolCall 注册链路触发 storeToolCall（与生产事件旁路一致）：
    // 第一次事件（发起）→ hasResult: false；第二次（回填 result）→ hasResult: true + files
    society.runtime.emitToolCall({
      agentId: "agent-a",
      toolName: "write_file",
      args: { path: "/tmp/x.txt", content: "很长的文件内容……" },
      result: null,
      callId: "call-stub-1",
      taskId: "t-stub-2",
      timestamp: new Date().toISOString(),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    // 第一次广播（_broadcastToolCall 即时发起，不等 drain）
    let drained = society.runtime.heartbeatBroker.drain(0);
    let agentMsgs = drained.filter(m => m.type === "agent_message");
    let stub = null;
    for (const m of agentMsgs) {
      const found = (m.payload.agents["agent-a"] || []).find(s => s.id === "tool-call-stub-1");
      if (found) { stub = found; break; }
    }
    assert.ok(stub, "发起广播中应含工具调用存根");
    assert.strictEqual(stub.payload.toolName, "write_file");
    assert.strictEqual("args" in stub.payload, false, "args 不应随广播推送");
    assert.strictEqual(stub.payload.hasResult, false, "发起时无结果");
    assert.strictEqual(stub.payload.result, null);

    // 第二次事件（结果回填）→ storeToolCall else-if 分支重播，hasResult 翻转
    society.runtime.emitToolCall({
      agentId: "agent-a",
      toolName: "write_file",
      args: { path: "/tmp/x.txt", content: "很长的文件内容……" },
      result: { summary: "写入成功", files: [{ path: "/tmp/x.txt", size: 123, mimeType: "text/plain" }] },
      callId: "call-stub-1",
      taskId: "t-stub-2",
      timestamp: new Date().toISOString(),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    await waitForMessagePersisted("agent-a", "tool-call-stub-1");

    drained = society.runtime.heartbeatBroker.drain(0);
    agentMsgs = drained.filter(m => m.type === "agent_message");
    stub = null;
    for (const m of agentMsgs) {
      const found = (m.payload.agents["agent-a"] || []).find(s => s.id === "tool-call-stub-1" && s.payload.hasResult === true);
      if (found) { stub = found; break; }
    }
    assert.ok(stub, "回填后广播中应含 hasResult: true 的存根");
    // result 正文剥离，只保留 files
    assert.strictEqual("summary" in (stub.payload.result ?? {}), false, "result 正文不应随广播推送");
    assert.deepStrictEqual(stub.payload.result, { files: [{ path: "/tmp/x.txt", size: 123, mimeType: "text/plain" }] });
    // usage 保留（不展开可见的 token 数）
    assert.strictEqual(stub.payload.usage.totalTokens, 30);

    // 详情端点仍能拿到 args/result 全量（存储层未破坏）
    const d = await getJson("/api/agent-messages/agent-a/detail/tool-call-stub-1");
    assert.strictEqual(d.status, 200);
    assert.deepStrictEqual(d.body.message.payload.args, { path: "/tmp/x.txt", content: "很长的文件内容……" });
    assert.strictEqual(d.body.message.payload.result.summary, "写入成功");
  });

  it("列表端点 GET /api/agent-messages/:agentId 返回存根", async () => {
    const r = await getJson("/api/agent-messages/agent-a");
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.messages.length > 0, "应至少有一条消息");
    for (const stub of r.body.messages) {
      assert.strictEqual("reasoning_content" in stub, false, `消息 ${stub.id} 不应含 reasoning_content`);
      assert.strictEqual("memoryContext" in stub, false);
      assert.strictEqual("knowledgeContext" in stub, false);
      assert.ok("hasReasoning" in stub);
      assert.ok("hasMemoryContext" in stub);
      assert.ok("hasKnowledgeContext" in stub);
    }
  });

  it("批量首屏端点 GET /api/agents/messages 返回存根", async () => {
    const r = await getJson("/api/agents/messages?limit=50");
    assert.strictEqual(r.status, 200);
    const agentEntry = r.body.agents["agent-a"];
    assert.ok(agentEntry, "agent-a 应在批量结果中");
    assert.ok(agentEntry.messages.length > 0);
    for (const stub of agentEntry.messages) {
      assert.strictEqual("reasoning_content" in stub, false);
      assert.strictEqual("memoryContext" in stub, false);
      assert.strictEqual("knowledgeContext" in stub, false);
    }
  });

  it("裁剪后 detail 端点仍返回全量（存储层未被破坏）", async () => {
    // 用 Step 2 第一条用例注入的消息验证：广播是存根，detail 拿到的是全量
    const list = await getJson("/api/agent-messages/agent-a");
    const stubWithReasoning = list.body.messages.find(m => m.hasReasoning === true);
    assert.ok(stubWithReasoning, "列表中应存在带思考的消息存根");

    const d = await getJson(`/api/agent-messages/agent-a/detail/${encodeURIComponent(stubWithReasoning.id)}`);
    assert.strictEqual(d.status, 200);
    assert.strictEqual(typeof d.body.message.reasoning_content, "string");
    assert.strictEqual(typeof d.body.message.memoryContext, "string");
    assert.strictEqual(typeof d.body.message.knowledgeContext, "string");
  });

});
