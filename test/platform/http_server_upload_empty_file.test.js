import { describe, it } from "node:test";
import assert from "node:assert";
import { registry } from "../../src/platform/core/module_registry.js";
import "../../src/platform/services/workspace/workspace_manager.js";

// 完整的工作空间路由集成测试见 http_server_workspace_routes.test.js

describe("Workspace routes - upload", () => {
  it("workspace-manager module should be declared in registry", () => {
    const mod = registry._modules.get("workspace-manager");
    assert.notStrictEqual(mod, undefined);
  });
});
