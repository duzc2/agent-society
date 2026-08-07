import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SkillsRuntimeResolver } from "../../../../src/platform/services/skills/skills_runtime_resolver.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.join(__dirname, ".tmp_skills_runtime_resolver");

/**
 * 创建技能运行时解析器。
 * @param {object} options
 * @returns {SkillsRuntimeResolver}
 */
function createResolver(options = {}) {
  return new SkillsRuntimeResolver({
    rootDir: TEST_ROOT,
    logger: makeTestLogger("Skills"),
    ...options
  });
}

describe("SkillsRuntimeResolver", () => {
  beforeEach(async () => {
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("应该为 Node 启动环境的 JS 技能脚本复用同一可执行文件", async () => {
    const nodePath = path.join(TEST_ROOT, "bin", "node.exe");
    const resolver = createResolver({
      startupExecPath: nodePath,
      startupRuntimeKind: "node",
      startupRuntimeVersion: "v25.4.0"
    });

    await resolver.initialize();
    const commandInfo = await resolver.resolveScriptCommand("scripts/run.js");

    assert.strictEqual(commandInfo.runtime, "javascript");
    assert.strictEqual(commandInfo.command, nodePath);
    assert.deepStrictEqual(commandInfo.argsPrefix, []);
    assert.strictEqual(commandInfo.engine, "node");
    assert.strictEqual(commandInfo.message, null);
  });

  it("应该为 Bun 启动环境的 JS 技能脚本复用同一可执行文件", async () => {
    const bunPath = path.join(TEST_ROOT, "bin", "bun.exe");
    const resolver = createResolver({
      startupExecPath: bunPath,
      startupRuntimeKind: "bun",
      startupRuntimeVersion: "1.3.10"
    });

    await resolver.initialize();
    const commandInfo = await resolver.resolveScriptCommand("scripts/run.mjs");

    assert.strictEqual(commandInfo.runtime, "javascript");
    assert.strictEqual(commandInfo.command, bunPath);
    assert.deepStrictEqual(commandInfo.argsPrefix, []);
    assert.strictEqual(commandInfo.engine, "bun");
    assert.strictEqual(commandInfo.message, null);
  });

  it("Node 运行时支持类型剥离时应该能执行 TypeScript 技能脚本", async () => {
    const nodePath = path.join(TEST_ROOT, "bin", "node.exe");
    const resolver = createResolver({
      startupExecPath: nodePath,
      startupRuntimeKind: "node",
      startupRuntimeVersion: "v25.4.0"
    });
    resolver._supportsNodeStripTypes = async () => true;

    await resolver.initialize();
    const commandInfo = await resolver.resolveScriptCommand("scripts/run.ts");

    assert.strictEqual(commandInfo.runtime, "javascript");
    assert.strictEqual(commandInfo.command, nodePath);
    assert.deepStrictEqual(commandInfo.argsPrefix, ["--experimental-strip-types"]);
    assert.strictEqual(commandInfo.engine, "node");
    assert.strictEqual(commandInfo.message, null);
  });

  it("Node 运行时不支持 TypeScript 时应该返回友好错误", async () => {
    const nodePath = path.join(TEST_ROOT, "bin", "node.exe");
    const resolver = createResolver({
      startupExecPath: nodePath,
      startupRuntimeKind: "node",
      startupRuntimeVersion: "v18.20.0"
    });
    resolver._supportsNodeStripTypes = async () => false;

    await resolver.initialize();
    const commandInfo = await resolver.resolveScriptCommand("scripts/run.ts");

    assert.strictEqual(commandInfo.runtime, null);
    assert.strictEqual(commandInfo.command, null);
    assert.strictEqual(commandInfo.engine, "node");
    assert.ok(commandInfo.message.includes("TypeScript"));
  });

  it("Node 启动环境应该使用同一可执行文件驱动 npm CLI 安装技能", async () => {
    const nodePath = path.join(TEST_ROOT, "bin", "node.exe");
    const npmCliPath = path.join(TEST_ROOT, "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npmCliPath), { recursive: true });
    await writeFile(npmCliPath, "console.log('npm cli');\n", "utf8");

    const resolver = createResolver({
      config: { npmCliPath },
      startupExecPath: nodePath,
      startupRuntimeKind: "node",
      startupRuntimeVersion: "v25.4.0"
    });

    await resolver.initialize();
    const commandInfo = await resolver.resolvePackageCommand({
      packageName: "skills@latest",
      binaryName: "skills"
    });

    assert.strictEqual(commandInfo.runtime, "javascript");
    assert.strictEqual(commandInfo.command, nodePath);
    assert.deepStrictEqual(commandInfo.argsPrefix, [
      npmCliPath,
      "exec",
      "--yes",
      "--package=skills@latest",
      "--",
      "skills"
    ]);
    assert.strictEqual(commandInfo.engine, "node");
    assert.strictEqual(commandInfo.message, null);
  });
});
