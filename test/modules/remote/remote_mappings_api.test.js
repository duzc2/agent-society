/**
 * Remote 模块 — /mappings 与 /agents HTTP API 测试
 *
 * 回归 bug：POST 保存/删除成功时不返回全量 mappings，
 * 前端据此把列表清空后只塞回刚操作的一个 agent（"只显示最后一个"症状）。
 * /agents 回归：数据源必须为 org（提供名称/岗位/组织信息），
 * 否则界面只能回退显示 agent ID。
 *
 * 模板：test/modules/localcmd/policies_api.test.js
 * （直接 import 模块 → init(mockRuntime) → getHttpHandler() → 调 handler 断言返回值）
 * 本测试不触发任何 SSH 连接，无需 mock ssh2。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { testLoggerRoot } from "../../helpers/test_logger.js";
import { makeFakeConfigService } from "../../helpers/fake_config_service.js";
import remoteModule from "../../../modules/remote/index.js";

const CONF_A = { host: "192.168.0.27", port: 22, username: "dtw", password: "453453", enabled: true };
const CONF_B = { host: "10.0.0.8", port: 22, username: "root", enabled: true };

/**
 * 内存版 org 桩 — 与 test/modules/localcmd/policies_api.test.js 的 mockOrg 同构，
 * 额外支持沿 parentAgentId 链解析组织归属（resolveOrgContext）。
 */
function makeMockOrg() {
  const state = {
    agents: new Map(),
    roles: new Map(),
    orgNames: new Map(),
  };
  return {
    _state: state,
    listAgents() {
      return Array.from(state.agents.values());
    },
    listRoles() {
      return Array.from(state.roles.values());
    },
    getAgent(agentId) {
      return state.agents.get(agentId) ?? null;
    },
    getRole(roleId) {
      return state.roles.get(roleId) ?? null;
    },
    getOrgName(agentId) {
      return state.orgNames.get(agentId) ?? null;
    },
  };
}

describe("Remote /mappings HTTP API", () => {
  let handler;
  let tempDataDir;
  let mockRuntime;
  let mockOrg;

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `remote_mappings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });

    const configService = makeFakeConfigService();
    mockOrg = makeMockOrg();
    mockRuntime = {
      loggerRoot: testLoggerRoot,
      configService,
      dataDir: tempDataDir,
      org: mockOrg,
      _agents: new Map(),
    };

    // 模块级单例：先清理再 init，避免测试间污染
    try { await remoteModule.shutdown(); } catch {}
    await remoteModule.init(mockRuntime);
    handler = remoteModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await remoteModule.shutdown(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/remote/mappings" };
  }

  it("GET 空映射 → ok + 空 mappings", async () => {
    const result = await handler(makeReq(), null, ["mappings"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.mappings, {});
  });

  it("POST 保存 → 响应含全量 mappings（核心回归：原响应缺 mappings 字段）", async () => {
    const result = await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: CONF_A });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.mappings, { "agent-1": CONF_A });
  });

  it("连续保存两个 agent → 第二次响应仍含两个（多智能体捆绑不丢，直接对应 bug 症状）", async () => {
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: CONF_A });
    const second = await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-2", config: CONF_B });
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(second.mappings, { "agent-1": CONF_A, "agent-2": CONF_B });
  });

  it("POST 删除 → 响应只剩其余映射（回归：删除不清空）", async () => {
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: CONF_A });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-2", config: CONF_B });
    const deleted = await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: null });
    assert.strictEqual(deleted.ok, true);
    assert.deepStrictEqual(deleted.mappings, { "agent-2": CONF_B });
  });

  it("GET 与 POST 后状态一致（经 fake configService 持久化往返）", async () => {
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: CONF_A });
    const getResult = await handler(makeReq(), null, ["mappings"]);
    assert.deepStrictEqual(getResult.mappings, { "agent-1": CONF_A });
  });

  it("缺少 agentId → missing_agent_id", async () => {
    const result = await handler(makeReq("POST"), null, ["mappings"], { config: CONF_A });
    assert.strictEqual(result.error, "missing_agent_id");
  });

  it("configService 不可用 → config_service_unavailable", async () => {
    mockRuntime.configService = null;
    const result = await handler(makeReq("POST"), null, ["mappings"], { agentId: "agent-1", config: CONF_A });
    assert.strictEqual(result.error, "config_service_unavailable");
  });

  it("子智能体继承父级绑定 → GET 返回 inherited 包含子 agent", async () => {
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "root", status: "active", name: "张梓" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "NPU验证员" });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: CONF_A });

    const result = await handler(makeReq(), null, ["mappings"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.inherited["child-1"], { sourceAgentId: "parent-1", config: CONF_A });
  });

  it("多层继承 → 沿父链找到根级绑定", async () => {
    mockOrg._state.agents.set("grand-1", { id: "grand-1", roleId: "role-g", parentAgentId: "root", status: "active", name: "祖父" });
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "grand-1", status: "active", name: "父" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "子" });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "grand-1", config: CONF_A });

    const result = await handler(makeReq(), null, ["mappings"]);
    assert.deepStrictEqual(result.inherited["child-1"], { sourceAgentId: "grand-1", config: CONF_A });
  });

  it("自己显式绑定的 agent 不出现在 inherited", async () => {
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "root", status: "active", name: "张梓" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "NPU验证员" });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: CONF_A });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "child-1", config: CONF_B });

    const result = await handler(makeReq(), null, ["mappings"]);
    assert.strictEqual(result.mappings["child-1"], CONF_B);
    assert.ok(!("child-1" in result.inherited), "显式绑定的子级不应出现在 inherited");
  });

  it("删除父级映射 → 子级继承消失", async () => {
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "root", status: "active", name: "张梓" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "NPU验证员" });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: CONF_A });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: null });

    const result = await handler(makeReq(), null, ["mappings"]);
    assert.ok(!("child-1" in result.inherited), "父级解绑后子级继承应消失");
  });

  it("父级启用状态变更 → 子级继承跟随（禁用不继承）", async () => {
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "root", status: "active", name: "张梓" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "NPU验证员" });
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: CONF_A });

    // 禁用父级
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: { ...CONF_A, enabled: false } });
    const disabled = await handler(makeReq(), null, ["mappings"]);
    assert.ok(!("child-1" in disabled.inherited), "父级禁用后子级不应继承");

    // 重新启用
    await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: { ...CONF_A, enabled: true } });
    const enabled = await handler(makeReq(), null, ["mappings"]);
    assert.deepStrictEqual(enabled.inherited["child-1"], { sourceAgentId: "parent-1", config: { ...CONF_A, enabled: true } });
  });

  it("POST 保存响应含 inherited（父级保存后子级立即继承）", async () => {
    mockOrg._state.agents.set("parent-1", { id: "parent-1", roleId: "role-p", parentAgentId: "root", status: "active", name: "张梓" });
    mockOrg._state.agents.set("child-1", { id: "child-1", roleId: "role-c", parentAgentId: "parent-1", status: "active", name: "NPU验证员" });

    const result = await handler(makeReq("POST"), null, ["mappings"], { agentId: "parent-1", config: CONF_A });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.inherited["child-1"], { sourceAgentId: "parent-1", config: CONF_A });
  });
});

describe("Remote /agents HTTP API", () => {
  let handler;
  let tempDataDir;
  let mockRuntime;
  let mockOrg;

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `remote_agents_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });

    const configService = makeFakeConfigService();
    mockOrg = makeMockOrg();
    mockRuntime = {
      loggerRoot: testLoggerRoot,
      configService,
      dataDir: tempDataDir,
      org: mockOrg,
      _agents: new Map(),
    };

    try { await remoteModule.shutdown(); } catch {}
    await remoteModule.init(mockRuntime);
    handler = remoteModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await remoteModule.shutdown(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/remote/agents" };
  }

  it("空 org → ok + 空 agents 列表", async () => {
    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.agents, []);
  });

  it("agent 有自定义名与组织名 → name=自定义名，orgName/orgManagerName 为自己", async () => {
    mockOrg._state.roles.set("role-1", { id: "role-1", name: "数据分析师" });
    mockOrg._state.agents.set("agent-1", { id: "agent-1", roleId: "role-1", parentAgentId: "root", status: "active", name: "张三" });
    mockOrg._state.orgNames.set("agent-1", "AI 平台组");

    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agents.length, 1);
    const agent = result.agents[0];
    assert.strictEqual(agent.id, "agent-1");
    assert.strictEqual(agent.name, "张三", "自定义名优先");
    assert.strictEqual(agent.customName, "张三");
    assert.strictEqual(agent.roleName, "数据分析师");
    assert.strictEqual(agent.orgName, "AI 平台组");
    assert.strictEqual(agent.orgManagerName, "张三", "自己设置了组织名则管理者即自己");
  });

  it("agent 无自定义名 → name 回退到岗位名", async () => {
    mockOrg._state.roles.set("role-1", { id: "role-1", name: "数据分析师" });
    mockOrg._state.agents.set("agent-1", { id: "agent-1", roleId: "role-1", parentAgentId: "root", status: "active", name: null });

    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agents[0].name, "数据分析师");
    assert.strictEqual(result.agents[0].orgName, null);
  });

  it("agent 未设置组织名、父级设置了 → 沿 parentAgentId 链找到组织信息", async () => {
    mockOrg._state.roles.set("role-head", { id: "role-head", name: "组织主管" });
    mockOrg._state.roles.set("role-member", { id: "role-member", name: "组员" });
    mockOrg._state.agents.set("manager-1", { id: "manager-1", roleId: "role-head", parentAgentId: "root", status: "active", name: "李四" });
    mockOrg._state.agents.set("member-1", { id: "member-1", roleId: "role-member", parentAgentId: "manager-1", status: "active", name: null });
    mockOrg._state.orgNames.set("manager-1", "运维组");

    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agents.length, 2);
    const member = result.agents.find((a) => a.id === "member-1");
    assert.strictEqual(member.orgName, "运维组", "组织名取父级节点的");
    assert.strictEqual(member.orgManagerName, "李四", "管理者为设置了组织名的父节点");
  });

  it("链路无任何组织名 → orgName 与 orgManagerName 均为 null（如实暴露，不崩溃）", async () => {
    mockOrg._state.roles.set("role-1", { id: "role-1", name: "数据分析师" });
    mockOrg._state.agents.set("agent-1", { id: "agent-1", roleId: "role-1", parentAgentId: "root", status: "active", name: null });

    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agents[0].orgName, null);
    assert.strictEqual(result.agents[0].orgManagerName, null, "无组织节点时管理者不存在");
  });

  it("org 缺失（runtime.org 为 undefined）→ ok + 空列表（与旧行为一致）", async () => {
    mockRuntime.org = undefined;
    const result = await handler(makeReq(), null, ["agents"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.agents, []);
  });
});
