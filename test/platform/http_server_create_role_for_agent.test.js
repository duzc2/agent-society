import { Hono } from 'hono';
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerAgentRoutes } from "../../src/platform/services/http/http_server/agents.js";
import { makeTestLogger } from "../helpers/test_logger.js";

/**
 * 创建测试用的 Hono app 并注册智能体路由。
 * @param {object} runtime 运行时桩对象
 * @returns {{ app: import('hono').Hono }}
 */
function createTestApp(runtime) {
  const app = new Hono();
  const log = makeTestLogger("HTTPServer");
  const society = { runtime };
  const moduleLoader = null;
  registerAgentRoutes({ app, log, society, moduleLoader });
  return { app };
}

describe("POST /api/agent/:agentId/roles (ex: HTTPServer._handleCreateRoleForAgent)", () => {
  it("should create a child role and inherit the creator orgPrompt", async () => {
    const createRoleCalls = [];
    const runtime = {
      org: {
        getAgent(agentId) {
          if (agentId === "agent-a") {
            return { id: "agent-a", roleId: "parent-role", status: "active" };
          }
          return null;
        },
        getRole(roleId) {
          if (roleId === "parent-role") {
            return { id: "parent-role", name: "Parent Role", orgPrompt: "parent org prompt" };
          }
          return null;
        },
        findRoleByName() {
          return null;
        },
        async createRole(input) {
          createRoleCalls.push(input);
          return {
            id: "role-new",
            name: input.name,
            rolePrompt: input.rolePrompt,
            orgPrompt: input.orgPrompt,
            createdBy: input.createdBy,
            createdAt: "2026-03-24T00:00:00.000Z",
            llmServiceId: input.llmServiceId,
            toolGroups: null
          };
        }
      },
      modelSelector: {
        async selectService(prompt) {
          return { serviceId: prompt === "handle testing" ? "svc-test" : null };
        }
      },
      serviceRegistry: {
        hasServices() {
          return true;
        }
      }
    };

    const { app } = createTestApp(runtime);
    const res = await app.request('/api/agent/agent-a/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: "QA Role",
        rolePrompt: "handle testing"
      })
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.reused, false);
    assert.strictEqual(createRoleCalls.length, 1);
    assert.deepStrictEqual(createRoleCalls[0], {
      name: "QA Role",
      rolePrompt: "handle testing",
      orgPrompt: "parent org prompt",
      createdBy: "agent-a",
      llmServiceId: "svc-test"
    });
  });

  it("should reject role names already used by another creator", async () => {
    let createRoleCalled = false;
    const runtime = {
      org: {
        getAgent() {
          return { id: "agent-a", roleId: "parent-role", status: "active" };
        },
        getRole() {
          return { id: "parent-role", name: "Parent Role", orgPrompt: null };
        },
        findRoleByName() {
          return {
            id: "role-existing",
            name: "QA Role",
            createdBy: "agent-b",
            status: "active"
          };
        },
        async createRole() {
          createRoleCalled = true;
          return null;
        }
      },
      serviceRegistry: {
        hasServices() {
          return false;
        }
      }
    };

    const { app } = createTestApp(runtime);
    const res = await app.request('/api/agent/agent-a/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: "QA Role",
        rolePrompt: "handle testing"
      })
    });

    const body = await res.json();
    assert.strictEqual(res.status, 409);
    assert.strictEqual(body.error, "role_name_conflict");
    assert.strictEqual(createRoleCalled, false);
  });
});
