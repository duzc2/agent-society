import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelScopeSkillsProvider } from "../../../../src/platform/services/skills/providers/modelscope_provider.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.join(__dirname, ".tmp_modelscope_provider");

describe("ModelScopeSkillsProvider", () => {
  beforeEach(async () => {
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("安装技能时应该复用运行时解析器返回的 JS 包执行命令", async () => {
    const packageDir = path.join(TEST_ROOT, "installed-skill");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "SKILL.md"), "# Demo Skill\n\n用于测试。\n", "utf8");

    const provider = new ModelScopeSkillsProvider({
      runtimeResolver: {
        resolvePackageCommand: async () => ({
          runtime: "javascript",
          command: "C:/Runtime/node.exe",
          argsPrefix: [
            "C:/Runtime/npm-cli.js",
            "exec",
            "--yes",
            "--package=skills@latest",
            "--",
            "skills"
          ],
          engine: "node",
          message: null
        })
      },
      logger: makeTestLogger("Skills")
    });

    let capturedCommand = null;
    provider._runProcess = async (command, args, cwd) => {
      capturedCommand = { command, args, cwd };
    };
    provider._findInstalledSkillDirectory = async () => packageDir;

    const installRequest = provider.normalizeInstallRequest({
      externalId: "@demo/test-skill"
    });
    const result = await provider.installToDirectory({
      request: installRequest,
      tempDir: TEST_ROOT
    });

    assert.deepStrictEqual(capturedCommand, {
      command: "C:/Runtime/node.exe",
      args: [
        "C:/Runtime/npm-cli.js",
        "exec",
        "--yes",
        "--package=skills@latest",
        "--",
        "skills",
        "add",
        "https://modelscope.cn/skills/@demo/test-skill",
        "-y"
      ],
      cwd: TEST_ROOT
    });
    assert.strictEqual(result.packageDir, packageDir);
    assert.strictEqual(result.catalogItem.externalId, "@demo/test-skill");
  });
});
