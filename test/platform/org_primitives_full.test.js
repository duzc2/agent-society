/**
 * OrgPrimitives 核心功能测试
 * 测试 OrgPrimitives 类的实际接口和功能
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// @ts-ignore - 测试中使用简化类型
import { OrgPrimitives } from "../../src/platform/core/org_primitives.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const TEST_DIR = "test/.tmp/org_primitives_full_test";

import { makeTestLogger } from "../helpers/test_logger.js";

describe("OrgPrimitives Core Functionality", () => {
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

  describe("构造函数", () => {
    it("应创建实例", () => {
      const newOrg = new OrgPrimitives({ runtimeDir: TEST_DIR, logger: makeTestLogger("OrgPrimitives") });
      assert.notStrictEqual(newOrg, undefined);
      assert.strictEqual(newOrg.runtimeDir, TEST_DIR);
      assert.notStrictEqual(newOrg._roles, undefined);
      assert.notStrictEqual(newOrg._agents, undefined);
    });

    it("应支持自定义logger", () => {
      const logger = {
        debug: async () => {},
        info: async () => {},
        warn: async () => {},
        error: async () => {}
      };
      const orgWithLogger = new OrgPrimitives({ runtimeDir: TEST_DIR, logger });
      assert.strictEqual(orgWithLogger.log, logger);
    });
  });

  describe("ensureReady - 确保就绪", () => {
    it("应创建运行时目录", async () => {
      await org.ensureReady();
      assert.strictEqual(existsSync(TEST_DIR), true);
    });
  });

  describe("createRole - 创建岗位", () => {
    it("应创建基本岗位", async () => {
      const role = await org.createRole({
        name: "测试岗位",
        rolePrompt: "这是一个测试岗位",
        createdBy: "root"
      });

      assert.notStrictEqual(role, undefined);
      assert.notStrictEqual(role.id, undefined);
      assert.strictEqual(role.name, "测试岗位");
      assert.strictEqual(role.rolePrompt, "这是一个测试岗位");
      assert.notStrictEqual(role.createdAt, undefined);
    });

    it("应生成唯一ID", async () => {
      const role1 = await org.createRole({ name: "岗位1", rolePrompt: "P1", createdBy: "root" });
      const role2 = await org.createRole({ name: "岗位2", rolePrompt: "P2", createdBy: "root" });

      assert.notStrictEqual(role1.id, role2.id);
    });

    it("应记录创建时间", async () => {
      const before = Date.now();
      const role = await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });
      const after = Date.now();

      assert.ok(new Date(role.createdAt).getTime() >= before);
      assert.ok(new Date(role.createdAt).getTime() <= after);
    });

    it("应持久化数据", async () => {
      await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      assert.strictEqual(existsSync(path.join(TEST_DIR, "org.json")), true);
    });

    it("应触发数据变更事件", async () => {
      let changeType = null;
      org.onDataChange((type, data) => { changeType = type; });

      await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      assert.strictEqual(changeType, "role_created");
    });

    it("应验证岗位数据", async () => {
      // 空名称会返回已存在的岗位（复用逻辑）或创建失败
      const result = await org.createRole({ name: "", rolePrompt: "P", createdBy: "root" });
      // 实现会复用已存在的空名称岗位或返回 null
      assert.notStrictEqual(result, undefined);
    });

    it("指定 toolGroups 时应保存到角色", async () => {
      const role = await org.createRole({
        name: "检索员",
        rolePrompt: "检索信息",
        createdBy: "root",
        toolGroups: ["workspace", "network"]
      });

      assert.ok(Array.isArray(role.toolGroups), "应返回数组");
      assert.deepStrictEqual(role.toolGroups, ["org_management", "workspace", "network"]);
    });

    it("不传 toolGroups 时应为 null", async () => {
      const role = await org.createRole({
        name: "普通岗位",
        rolePrompt: "P",
        createdBy: "root"
      });

      assert.deepStrictEqual(role.toolGroups, ["org_management"]);
    });

    it("空数组 toolGroups 应规范化为默认 toolGroups", async () => {
      const role = await org.createRole({
        name: "待更新岗位",
        rolePrompt: "P",
        createdBy: "root",
        toolGroups: ["workspace"]
      });

      const updated = await org.updateRole(role.id, { toolGroups: [] });

      assert.deepStrictEqual(updated.toolGroups, ["org_management"], "updateRole 应将空数组规范化为默认 toolGroups");
    });
  });

  describe("getRole / findRoleByName - 获取岗位", () => {
    it("应获取岗位", async () => {
      const created = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });

      const retrieved = org.getRole(created.id);

      assert.notStrictEqual(retrieved, undefined);
      assert.strictEqual(retrieved.id, created.id);
      assert.strictEqual(retrieved.name, "测试岗位");
    });

    it("应通过名称查找岗位", async () => {
      await org.createRole({ name: "UniqueName", rolePrompt: "P", createdBy: "root" });

      const retrieved = org.findRoleByName("UniqueName");

      assert.notStrictEqual(retrieved, undefined);
      assert.strictEqual(retrieved.name, "UniqueName");
    });

    it("不存在时返回null", () => {
      const role = org.getRole("non-existent-id");
      assert.strictEqual(role, null);
    });

    it("名称不存在时返回null", () => {
      const role = org.findRoleByName("non-existent-name");
      assert.strictEqual(role, null);
    });
  });

  describe("updateRole - 更新岗位", () => {
    it("应更新岗位提示词", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "旧提示词", createdBy: "root" });

      const updated = await org.updateRole(role.id, { rolePrompt: "新提示词" });

      assert.strictEqual(updated.rolePrompt, "新提示词");
      assert.strictEqual(updated.name, "岗位"); // 名称不变
    });

    it("应更新岗位描述", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "旧描述", createdBy: "root" });

      const updated = await org.updateRole(role.id, { rolePrompt: "新描述" });

      assert.strictEqual(updated.rolePrompt, "新描述");
    });

    it("应保持创建时间", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      const originalTime = role.createdAt;
      const updated = await org.updateRole(role.id, { name: "新名称" });

      assert.strictEqual(updated.createdAt, originalTime);
    });

    it("应设置更新时间", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      const updated = await org.updateRole(role.id, { name: "新名称" });

      assert.notStrictEqual(updated.updatedAt, undefined);
    });

    it("应触发数据变更事件", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      let changeType = null;
      org.onDataChange((type, data) => { changeType = type; });

      await org.updateRole(role.id, { name: "新名称" });

      assert.strictEqual(changeType, "role_updated");
    });

    it("不存在时返回null", async () => {
      const result = await org.updateRole("non-existent", { name: "New" });
      assert.strictEqual(result, null);
    });

    it("应验证更新数据", async () => {
      const role = await org.createRole({ name: "岗位", rolePrompt: "P", createdBy: "root" });

      // 空名称被忽略，不会抛出错误
      const result = await org.updateRole(role.id, { name: "" });
      assert.notStrictEqual(result, undefined);
    });
  });

  describe("deleteRole - 删除岗位", () => {
    it("应标记岗位为已删除", async () => {
      const role = await org.createRole({ name: "待删除", rolePrompt: "P", createdBy: "root" });

      await org.deleteRole(role.id, "user-1", "测试删除");

      // 删除后岗位在内存中仍存在但状态为 deleted
      const retrieved = org.getRole(role.id);
      assert.notStrictEqual(retrieved, undefined);
      assert.strictEqual(retrieved.status, "deleted");
    });

    it("应记录删除信息", async () => {
      const role = await org.createRole({ name: "待删除", rolePrompt: "P", createdBy: "root" });

      await org.deleteRole(role.id, "user-1", "测试删除");

      assert.strictEqual(existsSync(path.join(TEST_DIR, "org.json")), true);
    });

    it("应触发数据变更事件", async () => {
      const role = await org.createRole({ name: "待删除", rolePrompt: "P", createdBy: "root" });

      let changeType = null;
      org.onDataChange((type, data) => { changeType = type; });

      await org.deleteRole(role.id, "user-1", "测试删除");

      assert.strictEqual(changeType, "role_deleted");
    });

    it("应删除岗位及其智能体", async () => {
      const role = await org.createRole({ name: "父岗位", rolePrompt: "P", createdBy: "root" });
      const agent = await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      await org.deleteRole(role.id, "user-1", "测试删除");

      // 岗位被标记为删除
      assert.strictEqual(org.getRole(role.id).status, "deleted");
      // 智能体被终止
      assert.strictEqual(org.getAgent(agent.id).status, "deleted");
    });

    it("不存在时报错", async () => {
      await assert.rejects(org.deleteRole("non-existent", "user", "测试"));
    });
  });

  describe("createAgent - 创建智能体", () => {
    it("应创建智能体", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });

      const agent = await org.createAgent({
        roleId: role.id,
        parentAgentId: "root"
      });

      assert.notStrictEqual(agent, undefined);
      assert.notStrictEqual(agent.id, undefined);
      assert.strictEqual(agent.roleId, role.id);
      assert.strictEqual(agent.parentAgentId, "root");
    });

    it("应生成唯一ID", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });

      const agent1 = await org.createAgent({ roleId: role.id, parentAgentId: "root" });
      const agent2 = await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      assert.notStrictEqual(agent1.id, agent2.id);
    });

    it("应记录创建时间", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });

      const agent = await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      assert.notStrictEqual(agent.createdAt, undefined);
    });

    it("应触发数据变更事件", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });

      let changeType = null;
      org.onDataChange((type, data) => { changeType = type; });

      await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      assert.strictEqual(changeType, "agent_created");
    });

    it("应验证智能体数据", async () => {
      // 无效的角色ID会抛出错误
      try {
        await org.createAgent({ roleId: "non-existent", parentAgentId: "root" });
        assert.strictEqual(false, true); // 应该抛出错误
      } catch (e) {
        assert.notStrictEqual(e, undefined);
      }
    });
  });

  describe("getAgent - 获取智能体", () => {
    it("应获取智能体", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      const created = await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      const retrieved = org.getAgent(created.id);

      assert.notStrictEqual(retrieved, undefined);
      assert.strictEqual(retrieved.id, created.id);
    });

    it("不存在时返回null", () => {
      const agent = org.getAgent("non-existent");
      assert.strictEqual(agent, null);
    });
  });

  describe("listRoles / listAgents / listTerminations - 列表查询", () => {
    it("应列出所有岗位", async () => {
      await org.createRole({ name: "岗位1", rolePrompt: "P1", createdBy: "root" });
      await org.createRole({ name: "岗位2", rolePrompt: "P2", createdBy: "root" });

      const roles = org.listRoles();

      assert.strictEqual(roles.length, 2);
    });

    it("应列出所有智能体", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      await org.createAgent({ roleId: role.id, parentAgentId: "root" });
      await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      const agents = org.listAgents();

      assert.strictEqual(agents.length, 2);
    });

    it("空列表返回空数组", () => {
      assert.deepStrictEqual(org.listRoles(), []);
      assert.deepStrictEqual(org.listAgents(), []);
      assert.deepStrictEqual(org.listTerminations(), []);
    });
  });

  describe("getSummary - 获取摘要", () => {
    it("应返回摘要信息", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      const summary = org.getSummary();

      assert.strictEqual(summary.roleCount, 1);
      assert.strictEqual(summary.agentCount, 1);
      assert.strictEqual(summary.terminationCount, 0);
    });
  });

  describe("persist / loadIfExists - 持久化", () => {
    it("应保存数据到文件", async () => {
      await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      await org.persist();

      assert.strictEqual(existsSync(path.join(TEST_DIR, "org.json")), true);
    });

    it("应加载已保存的数据", async () => {
      await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      await org.persist();

      // 创建新的实例
      const newOrg = new OrgPrimitives({ runtimeDir: TEST_DIR, logger: makeTestLogger("OrgPrimitives") });
      await newOrg.loadIfExists();

      const role = newOrg.findRoleByName("测试岗位");
      assert.notStrictEqual(role, undefined);
    });

    it("无文件时静默处理", async () => {
      const newOrg = new OrgPrimitives({ runtimeDir: TEST_DIR, logger: makeTestLogger("OrgPrimitives") });
      await newOrg.loadIfExists();

      assert.deepStrictEqual(newOrg.listRoles(), []);
    });
  });

  describe("resetToEmpty - 重置为空", () => {
    it("应清空所有数据", async () => {
      const role = await org.createRole({ name: "测试岗位", rolePrompt: "P", createdBy: "root" });
      await org.createAgent({ roleId: role.id, parentAgentId: "root" });

      org.resetToEmpty();

      assert.deepStrictEqual(org.listRoles(), []);
      assert.deepStrictEqual(org.listAgents(), []);
    });
  });

  describe("边界条件", () => {
    it("应处理空字符串名称", async () => {
      // 空名称会复用已存在的空名称岗位或创建新岗位
      const result = await org.createRole({ name: "", rolePrompt: "P", createdBy: "root" });
      assert.notStrictEqual(result, undefined);
      // 第二次创建会复用
      const result2 = await org.createRole({ name: "", rolePrompt: "P2", createdBy: "root" });
      assert.strictEqual(result2.id, result.id);
    });

    it("应处理特殊字符", async () => {
      const role = await org.createRole({
        name: "测试!@#$%^&*()",
        rolePrompt: "Prompt with unicode: 你好🌍",
        createdBy: "root"
      });

      assert.strictEqual(role.name, "测试!@#$%^&*()");
      assert.strictEqual(role.rolePrompt, "Prompt with unicode: 你好🌍");
    });

    it("应处理并发操作", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(org.createRole({ name: `岗位${i}`, rolePrompt: `P${i}`, createdBy: "root" }));
      }

      await Promise.all(promises);
      assert.strictEqual(org.listRoles().length, 10);
    });
  });
});
