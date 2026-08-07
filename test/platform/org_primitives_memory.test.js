/**
 * OrgPrimitives 记忆相关功能测试
 *
 * 测试内容：
 * 1. setAgentLastMemoryMessageId - 设置智能体最后记忆消息ID
 * 2. 持久化和加载 lastMemoryMessageId
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { OrgPrimitives } from "../../src/platform/core/org_primitives.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const TEST_DIR = "test/.tmp/org_primitives_memory_test";

import { makeTestLogger } from "../helpers/test_logger.js";

describe("OrgPrimitives Memory Functions", () => {
  let org;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });

    org = new OrgPrimitives({ runtimeDir: TEST_DIR, logger: makeTestLogger("OrgPrimitives") });
    await org.ensureReady();
  });

  afterEach(async () => {
    org = null;
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("setAgentLastMemoryMessageId", () => {
    beforeEach(async () => {
      // 先创建一个智能体
      await org.createRole({
        name: "测试岗位",
        rolePrompt: "测试",
        createdBy: "root"
      });

      await org.createAgent({
        roleId: org.listRoles()[0].id,
        parentAgentId: "root"
      });
    });

    it("应设置智能体的 lastMemoryMessageId", async () => {
      const agent = org.listAgents()[0];

      const result = await org.setAgentLastMemoryMessageId(agent.id, "msg-001");

      assert.notStrictEqual(result, undefined);
      assert.strictEqual(result.lastMemoryMessageId, "msg-001");
    });

    it("应更新已存在的 lastMemoryMessageId", async () => {
      const agent = org.listAgents()[0];

      await org.setAgentLastMemoryMessageId(agent.id, "msg-001");
      const result = await org.setAgentLastMemoryMessageId(agent.id, "msg-002");

      assert.strictEqual(result.lastMemoryMessageId, "msg-002");
    });

    it("空字符串应清除 lastMemoryMessageId", async () => {
      const agent = org.listAgents()[0];

      await org.setAgentLastMemoryMessageId(agent.id, "msg-001");
      const result = await org.setAgentLastMemoryMessageId(agent.id, "");

      assert.strictEqual(result.lastMemoryMessageId, undefined);
    });

    it("null 应清除 lastMemoryMessageId", async () => {
      const agent = org.listAgents()[0];

      await org.setAgentLastMemoryMessageId(agent.id, "msg-001");
      const result = await org.setAgentLastMemoryMessageId(agent.id, null);

      assert.strictEqual(result.lastMemoryMessageId, undefined);
    });

    it("无效 agentId 应抛出错误", async () => {
      await assert.rejects(org.setAgentLastMemoryMessageId(null, "msg-001"), /invalid_agentId/);

      await assert.rejects(org.setAgentLastMemoryMessageId("", "msg-001"), /invalid_agentId/);
    });

    it("不存在的智能体应返回 null", async () => {
      const result = await org.setAgentLastMemoryMessageId("non-existent", "msg-001");
      assert.strictEqual(result, null);
    });

    it("应持久化到 org.json", async () => {
      const agent = org.listAgents()[0];

      await org.setAgentLastMemoryMessageId(agent.id, "msg-persist-001");

      // 创建新的 OrgPrimitives 实例加载数据
      const org2 = new OrgPrimitives({ runtimeDir: TEST_DIR, logger: makeTestLogger("OrgPrimitives") });
      await org2.loadIfExists();

      const loadedAgent = org2.getAgent(agent.id);
      assert.strictEqual(loadedAgent.lastMemoryMessageId, "msg-persist-001");
    });

    it("应触发数据变更事件", async () => {
      const agent = org.listAgents()[0];
      /** @type {any} */
      let changeEvent = null;

      org.onDataChange((type, data) => {
        if (type === "agent_updated") {
          changeEvent = data;
        }
      });

      await org.setAgentLastMemoryMessageId(agent.id, "msg-event-001");

      assert.notStrictEqual(changeEvent, null);
      // @ts-ignore - 已检查非 null
      assert.strictEqual(changeEvent.id, agent.id);
      // @ts-ignore - 已检查非 null
      assert.strictEqual(changeEvent.lastMemoryMessageId, "msg-event-001");
    });
  });

  describe("createAgent - 包含 lastMemoryMessageId", () => {
    it("新创建的智能体不应有 lastMemoryMessageId", async () => {
      await org.createRole({ name: "岗位", rolePrompt: "测试", createdBy: "root" });
      const role = org.listRoles()[0];

      const agent = await org.createAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      assert.strictEqual(agent.lastMemoryMessageId, undefined);
    });
  });
});
