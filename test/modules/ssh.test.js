import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sshModule from "../../modules/ssh/index.js";
import ConnectionManager from "../../modules/ssh/connection_manager.js";
import { ModuleLoader } from "../../src/platform/extensions/module_loader.js";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

describe("SSH Module - Tool Definitions", () => {
  it("getToolDefinitions should use OpenAI function tool schema", () => {
    const tools = sshModule.getToolDefinitions();
    assert.strictEqual(Array.isArray(tools), true);
    assert.ok(tools.length > 0);

    for (const tool of tools) {
      assert.strictEqual(tool.type, "function");
      assert.ok(Object.hasOwn(tool, "function"));
      assert.strictEqual(typeof tool.function?.name, "string");
    }
  });
});

describe("SSH Module - ModuleLoader Integration", () => {
  let loader = null;

  afterEach(async () => {
    if (loader) {
      await loader.shutdown();
      loader = null;
    }
  });

  it("ModuleLoader should register ssh tool names", async () => {
    loader = new ModuleLoader({ modulesDir: path.join(PROJECT_ROOT, "modules"), logger: makeTestLogger("SSH") });

    const runtime = {
      log: makeTestLogger("SSH"),
      loggerRoot: testLoggerRoot,
      config: { dataDir: path.join(PROJECT_ROOT, "test", ".tmp", "ssh_bun_test") },
      configService: {
        registerModuleConfig: () => {},
        getModuleConfig: async () => ({
          connectionTimeout: 50,
          maxConnections: 10,
          commandTimeout: 30000,
          idleTimeout: 300000,
          maxOutputSize: 10485760,
          hosts: {
            "host-a": {
              description: "A",
              host: "192.0.2.1",
              port: 22,
              username: "user",
              password: "secret"
            }
          }
        })
      },
      toolGroupManager: { registerGroup: () => ({ ok: true }) }
    };

    await loader.loadModules({ ssh: {} }, runtime);

    assert.strictEqual(loader.hasToolName("ssh_list_hosts"), true);
    assert.strictEqual(loader.hasToolName("ssh_shell_create"), true);
    assert.strictEqual(loader.hasToolName("ssh_upload"), true);
    assert.strictEqual(loader.hasToolName("ssh_download"), true);
  });

  it("ssh_list_hosts should not leak sensitive fields", async () => {
    loader = new ModuleLoader({ modulesDir: path.join(PROJECT_ROOT, "modules"), logger: makeTestLogger("SSH") });

    const runtime = {
      log: makeTestLogger("SSH"),
      loggerRoot: testLoggerRoot,
      config: { dataDir: path.join(PROJECT_ROOT, "test", ".tmp", "ssh_bun_test") },
      configService: {
        registerModuleConfig: () => {},
        getModuleConfig: async () => ({
          maxConnections: 10,
          connectionTimeout: 30000,
          commandTimeout: 30000,
          hosts: {
            "prod": {
              description: "生产",
              host: "10.0.0.1",
              port: 22,
              username: "root",
              password: "secret"
            }
          }
        })
      },
      toolGroupManager: { registerGroup: () => ({ ok: true }) }
    };

    await loader.loadModules({ ssh: {} }, runtime);

    const res = await loader.executeToolCall(null, "ssh_list_hosts", {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(Array.isArray(res.hosts), true);
    assert.deepStrictEqual(res.hosts[0], { hostName: "prod", description: "生产" });
  });
});

describe("ConnectionManager - Hosts Normalization", () => {
  it("should accept hosts as array and normalize to object", () => {
    const cm = new ConnectionManager(
      {
        hosts: [
          {
            name: "h1",
            description: "H1",
            host: "192.0.2.1",
            port: 22,
            username: "u",
            password: "p"
          }
        ]
      },
      makeTestLogger("SSH")
    );

    const res = cm.listHosts();
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.hosts, [{ hostName: "h1", description: "H1" }]);
  });
});
