/**
 * LocalCmd 模块 — GET /policies API 测试
 *
 * 覆盖：
 *   - orgName 字段的回退链：getOrgName() → agent.name → orgId
 *   - name 字段（agent name）
 *   - defaults 返回
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { makeTestLogger, testLoggerRoot } from "../../helpers/test_logger.js";
import localcmdModule from "../../../modules/localcmd/index.js";

describe("GET /policies — orgName 字段", () => {
  let handler;
  let tempDataDir;
  let mockOrg;

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `localcmd_http_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });

    mockOrg = {
      _agents: new Map(),
      _orgNames: new Map(),
      getAgent(agentId) {
        return this._agents.get(agentId) ?? null;
      },
      getOrgName(agentId) {
        return this._orgNames.get(agentId) ?? null;
      },
    };

    const mockRuntime = {
      loggerRoot: testLoggerRoot,
      org: mockOrg,
      dataDir: tempDataDir,
      registerSystemPromptProvider: () => {},
    };

    try { await localcmdModule.shutdown(); } catch {}

    await localcmdModule.init(mockRuntime);
    handler = localcmdModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await localcmdModule.shutdown(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  function makeReq(method = "GET") {
    return { method, url: "/api/modules/localcmd/policies" };
  }

  it("空策略 → 返回空 orgs 和默认 defaults", async () => {
    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.orgs, {});
    assert.ok(Array.isArray(result.defaults.whitelist), "defaults.whitelist 应为数组");
    assert.ok(Array.isArray(result.defaults.blacklist), "defaults.blacklist 应为数组");
  });

  it("有自定义组织名 → orgName = getOrgName 的值，name = agent 的 name", async () => {
    mockOrg._agents.set("org1", { id: "org1", name: "张三", status: "active" });
    mockOrg._orgNames.set("org1", "AI Platform Team");

    // 先创建一个 org 策略
    await handler(
      makeReq("POST"),
      null,
      ["policies", "org1"],
      { whitelist: [{ type: "glob", pattern: "node" }], blacklist: [] }
    );

    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);
    assert.ok(result.orgs["org1"], "org1 策略应存在");
    assert.strictEqual(result.orgs["org1"].name, "张三");
    assert.strictEqual(result.orgs["org1"].orgName, "AI Platform Team");
  });

  it("无自定义组织名 → orgName 回退到 agent.name", async () => {
    mockOrg._agents.set("org2", { id: "org2", name: "李四", status: "active" });
    // 不设置 _orgNames — 模拟无自定义组织名

    await handler(
      makeReq("POST"),
      null,
      ["policies", "org2"],
      { whitelist: [], blacklist: [{ type: "glob", pattern: "rm" }] }
    );

    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);
    assert.ok(result.orgs["org2"], "org2 策略应存在");
    assert.strictEqual(result.orgs["org2"].name, "李四");
    assert.strictEqual(result.orgs["org2"].orgName, "李四", "getOrgName 为 null 时应回退到 agent.name");
  });

  it("无 agent name 也无 org name → orgName 回退到 orgId", async () => {
    mockOrg._agents.set("org3", { id: "org3", name: null, status: "active" });
    // 不设置 _orgNames

    await handler(
      makeReq("POST"),
      null,
      ["policies", "org3"],
      { whitelist: [], blacklist: [] }
    );

    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);
    assert.ok(result.orgs["org3"], "org3 策略应存在");
    assert.strictEqual(result.orgs["org3"].name, null);
    assert.strictEqual(result.orgs["org3"].orgName, "org3", "全无时应回退到 orgId");
  });

  it("多个组织策略混合 → 每个 orgName 回退链独立正确", async () => {
    // org_a: 有自定义 org name
    mockOrg._agents.set("org_a", { id: "org_a", name: "负责人A", status: "active" });
    mockOrg._orgNames.set("org_a", "团队A");
    await handler(makeReq("POST"), null, ["policies", "org_a"],
      { whitelist: [], blacklist: [] });

    // org_b: 仅有 agent name
    mockOrg._agents.set("org_b", { id: "org_b", name: "负责人B", status: "active" });
    await handler(makeReq("POST"), null, ["policies", "org_b"],
      { whitelist: [], blacklist: [] });

    // org_c: 仅有 orgId
    mockOrg._agents.set("org_c", { id: "org_c", name: null, status: "active" });
    await handler(makeReq("POST"), null, ["policies", "org_c"],
      { whitelist: [], blacklist: [] });

    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);

    // org_a: orgName = "团队A", name = "负责人A"
    assert.strictEqual(result.orgs["org_a"].orgName, "团队A");
    assert.strictEqual(result.orgs["org_a"].name, "负责人A");

    // org_b: orgName = "负责人B"（回退），name = "负责人B"
    assert.strictEqual(result.orgs["org_b"].orgName, "负责人B");
    assert.strictEqual(result.orgs["org_b"].name, "负责人B");

    // org_c: orgName = "org_c"（回退到 orgId），name = null
    assert.strictEqual(result.orgs["org_c"].orgName, "org_c");
    assert.strictEqual(result.orgs["org_c"].name, null);
  });

  it("org 不在 _agents 中 → agent 为 null，orgName 回退到 orgId", async () => {
    // policyStore 中有 org，但 runtime.org 中不存在对应 agent
    await handler(
      makeReq("POST"),
      null,
      ["policies", "missing_org"],
      { whitelist: [], blacklist: [] }
    );

    const result = await handler(makeReq(), null, ["policies"]);
    assert.strictEqual(result.ok, true);
    assert.ok(result.orgs["missing_org"], "org 策略应存在");
    assert.strictEqual(result.orgs["missing_org"].name, null);
    assert.strictEqual(result.orgs["missing_org"].orgName, "missing_org",
      "agent 不存在时 orgName 应回退到 orgId");
  });
});
