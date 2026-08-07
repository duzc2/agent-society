import { describe, it } from "node:test";
import assert from "node:assert";

import { SkillsScriptRunner } from "../../../../src/platform/services/skills/skills_script_runner.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

describe("SkillsScriptRunner", () => {
  it("应该把运行时前缀参数拼接到技能脚本命令前", async () => {
    const scriptPath = "C:/skills/demo/scripts/run.js";
    const repository = {
      resolveSkillScript: async () => ({
        absolutePath: scriptPath
      })
    };
    const runtimeResolver = {
      resolveScriptCommand: async () => ({
        runtime: "javascript",
        command: "C:/Runtime/node.exe",
        argsPrefix: ["--experimental-strip-types"],
        engine: "node",
        scriptFormat: "typescript",
        message: null
      })
    };
    const runner = new SkillsScriptRunner({
      repository,
      runtimeResolver,
      logger: makeTestLogger("Skills")
    });

    let capturedOptions = null;
    runner._runProcess = async (options) => {
      capturedOptions = options;
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    const result = await runner.runSkillScript({
      skillId: "modelscope:skill:@demo/test",
      scriptPath: "scripts/run.ts",
      args: ["alpha", "beta"]
    });

    assert.deepStrictEqual(capturedOptions, {
      command: "C:/Runtime/node.exe",
      args: ["--experimental-strip-types", scriptPath, "alpha", "beta"],
      cwd: "C:/skills/demo/scripts"
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.runtime, "javascript");
  });

  it("应该把运行时解析阶段的友好错误继续向上抛出", async () => {
    const runner = new SkillsScriptRunner({
      repository: {
        resolveSkillScript: async () => ({
          absolutePath: "C:/skills/demo/scripts/run.ts"
        })
      },
      runtimeResolver: {
        resolveScriptCommand: async () => ({
          runtime: null,
          command: null,
          argsPrefix: [],
          engine: "node",
          scriptFormat: "typescript",
          message: "当前启动环境不支持直接执行 TypeScript 技能脚本"
        })
      },
      logger: makeTestLogger("Skills")
    });

    try {
      await runner.runSkillScript({
        skillId: "modelscope:skill:@demo/test",
        scriptPath: "scripts/run.ts"
      });
      throw new Error("expected_runner_to_throw");
    } catch (err) {
      assert.ok(err.message.includes("TypeScript"));
    }
  });
});
