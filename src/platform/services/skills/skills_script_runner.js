import { spawn } from "node:child_process";
import path from "node:path";

/**
 * 技能脚本执行器。
 *
 * 责任：
 * 1. 只执行 Skill 包内 scripts 目录下的脚本。
 * 2. JS/TS 统一走系统启动时的同一 JavaScript 运行时。
 * 3. Python 统一走配置或工程内虚拟环境解析结果。
 */
export class SkillsScriptRunner {
  /**
   * @param {{repository:any, runtimeResolver:any, logger?:any}} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.runtimeResolver = options.runtimeResolver;
    this.log = options.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
  }

  /**
   * 执行技能脚本。
   * @param {{skillId:string, scriptPath:string, args?:string[]}} options
   * @returns {Promise<{ok:boolean, runtime:string|null, exitCode:number, stdout:string, stderr:string}>}
   */
  async runSkillScript(options) {
    const scriptPath = options.scriptPath.startsWith("scripts/")
      ? options.scriptPath
      : `scripts/${options.scriptPath}`;
    const resolved = await this.repository.resolveSkillScript(options.skillId, scriptPath);
    if (!resolved) {
      throw new Error("skill_script_not_found");
    }

    const commandInfo = await this.runtimeResolver.resolveScriptCommand(resolved.absolutePath);
    if (!commandInfo.runtime || !commandInfo.command) {
      throw new Error(commandInfo.message || "unsupported_skill_script_runtime");
    }

    const args = Array.isArray(options.args)
      ? options.args.map((item) => String(item)).filter(arg =>
          arg.length <= 1000 && !/^[\s\-_~!#$%^&*+=|\\:;"'<>,.?\/`]+$/.test(arg)
        )
      : [];
    const result = await this._runProcess({
      command: commandInfo.command,
      args: [...(commandInfo.argsPrefix ?? []), resolved.absolutePath, ...args],
      cwd: options.cwd ?? path.dirname(resolved.absolutePath)
    });

    return {
      ok: result.exitCode === 0,
      runtime: commandInfo.runtime,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * 执行子进程。
   * @param {{command:string, args:string[], cwd:string}} options
   * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
   */
  async _runProcess(options) {
    return await new Promise((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk ?? "");
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk ?? "");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          exitCode: Number.isFinite(code) ? code : -1,
          stdout,
          stderr
        });
      });
    });
  }
}
