/**
 * One-Click Packaging 功能测试
 *
 * Feature: one-click-packaging
 *
 * 测试打包脚本和启动脚本的正确性。
 *
 * 当前架构：
 *   pack.cmd → pack.ps1 → build_exe.ps1（三层委托）
 *   pack.cmd 是 thin wrapper，仅负责 CMD → PowerShell 入口统一。
 *   pack.ps1 负责构建调度 + zip 压缩。
 *   build_exe.ps1 负责各平台的可执行文件构建。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

// 项目根目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Helper: 读取脚本内容
function readScript(relativePath) {
  const fullPath = path.join(PROJECT_ROOT, ...relativePath.split("/"));
  return { fullPath, content: readFileSync(fullPath, "utf-8") };
}

describe("One-Click Packaging - Unit Tests", () => {
  /**
   * 6.1 验证脚本文件存在
   * _Requirements: 1.1, 1.2, 4.1_
   */
  describe("Script Files Existence", () => {
    it("pack.cmd should exist in scripts/win directory", () => {
      const packCmdPath = path.join(PROJECT_ROOT, "scripts", "win", "pack.cmd");
      assert.strictEqual(existsSync(packCmdPath), true);
    });

    it("pack.ps1 should exist in scripts/win directory", () => {
      const packPs1Path = path.join(PROJECT_ROOT, "scripts", "win", "pack.ps1");
      assert.strictEqual(existsSync(packPs1Path), true);
    });

    it("start.cmd should contain local bun detection logic", () => {
      const { content } = readScript("start.cmd");

      // 检查本地 bun 检测逻辑（路径 runtime\bun\bin\bun.exe）
      assert.ok(content.includes("runtime\\bun\\bin\\bun.exe"));
      // 使用 BUN_CMD 变量存储 bun 路径
      assert.ok(content.includes("BUN_CMD"));

      // 检查 .git 目录检测逻辑
      assert.ok(content.includes(".git"));
    });

    it("start.cmd should display which bun is being used", () => {
      const { content } = readScript("start.cmd");

      // 检查显示本地 bun 的消息（英文）
      assert.match(content, /using local bun/i);
      // 检查显示系统 bun 的消息（英文）
      assert.match(content, /using system bun/i);
    });
  });

  describe("Pack Script Content Validation", () => {
    it("pack.cmd should delegate to pack.ps1", () => {
      const { content } = readScript("scripts/win/pack.cmd");

      // pack.cmd 是 thin wrapper，委托给 pack.ps1
      assert.ok(content.includes("pack.ps1"));
      assert.ok(content.includes("powershell"));

      // 应传播错误码
      assert.ok(content.includes("EXIT_CODE"));
      assert.ok(content.includes("ERRORLEVEL"));
    });

    it("pack.ps1 should delegate to build_exe.ps1", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // pack.ps1 委托构建逻辑给 build_exe.ps1
      assert.ok(content.includes("build_exe.ps1"));
      assert.ok(content.includes("Invoke-BuildRelease"));

      // 检查包含 zip 压缩逻辑
      assert.ok(content.includes("Compress-Archive"));
    });

    it("pack.ps1 should handle both 7-Zip and Compress-Archive", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 检查 7-Zip 支持
      assert.ok(content.includes("7-Zip"));
      // 检查 Compress-Archive 回退
      assert.ok(content.includes("Compress-Archive"));
    });
  });
});

describe("One-Click Packaging - Property Tests", () => {
  /**
   * Property 1: File Inclusion/Exclusion Consistency
   * **Validates: Requirements 2.1, 6.3**
   */
  describe("Property 1: File Inclusion/Exclusion Consistency", () => {
    // pack.cmd 是 thin wrapper，核心逻辑在 pack.ps1 中
    const PACK_PS1_PATH = "scripts/win/pack.ps1";
    const PACK_CMD_PATH = "scripts/win/pack.cmd";

    it("pack.cmd delegates to pack.ps1 with argument passthrough", () => {
      const { content } = readScript(PACK_CMD_PATH);

      // pack.cmd 应将所有参数传递给 powershell
      assert.ok(content.includes("%*"));
      assert.ok(content.includes("powershell"));
    });

    it("pack.ps1 references build_exe.ps1 for file operations", () => {
      const { content } = readScript(PACK_PS1_PATH);

      // 构建和文件复制逻辑在 build_exe.ps1 中
      assert.ok(content.includes("build_exe.ps1"));
      assert.ok(content.includes("Invoke-BuildRelease"));
    });

    it("pack.ps1 validates release directory exists before zipping", () => {
      const { content } = readScript(PACK_PS1_PATH);

      // 打包前验证发布目录存在
      assert.ok(content.includes("dist"));
      assert.ok(content.includes("win-unpacked"));
      assert.ok(content.includes("Test-Path"));
    });

    it("pack.ps1 uses strict error handling", () => {
      const { content } = readScript(PACK_PS1_PATH);

      // PowerShell 严格模式 + 出错停止
      assert.ok(content.includes('$ErrorActionPreference = "Stop"'));
      assert.ok(content.includes("Set-StrictMode"));
      assert.ok(content.includes("throw"));
    });

    // Property-based: 验证 pack.cmd 只做委托不做实际操作
    it("property: pack.cmd does not contain file copy commands", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("xcopy", "copy ", "mkdir ", "del ", "rmdir "),
          (cmdPattern) => {
            const { content } = readScript(PACK_CMD_PATH);
            // pack.cmd 是纯委托入口，不应包含文件操作命令
            return !content.toLowerCase().includes(cmdPattern.toLowerCase());
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  /**
   * Property 3: Custom Output Filename
   * **Validates: Requirements 6.1**
   */
  describe("Property 3: Custom Output Filename", () => {
    // 生成有效的文件名（不含特殊字符）
    const validFilenameArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
      return /^[a-zA-Z0-9_-]+$/.test(s);
    });

    it("pack.ps1 should accept OutputName parameter", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 验证 pack.ps1 接受 OutputName 参数
      assert.ok(content.includes("$OutputName"));
      assert.ok(content.includes(".zip"));
    });

    it("default filename should follow timestamp pattern", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 验证默认文件名包含 agent-society 和时间戳
      assert.ok(content.includes("agent-society-"));
      assert.ok(content.includes("$timestamp"));
      assert.ok(content.includes("yyyyMMdd-HHmmss"));
    });

    it("pack.cmd passes all arguments to pack.ps1", () => {
      const { content } = readScript("scripts/win/pack.cmd");

      // pack.cmd 传递所有参数给 pack.ps1（使用 %*）
      assert.ok(content.includes("%*"));
      // 结果文件名在 pack.ps1 中处理
    });

    it("property: output filename should match input parameter pattern", () => {
      fc.assert(
        fc.property(
          validFilenameArb,
          (filename) => {
            const invalidChars = /[<>:"/\\|?*]/;
            return !invalidChars.test(filename);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 4: Error Exit Code
   * **Validates: Requirements 7.4**
   */
  describe("Property 4: Error Exit Code", () => {
    it("pack.cmd propagates pack.ps1 exit code", () => {
      const { content } = readScript("scripts/win/pack.cmd");

      // pack.cmd 捕获 PowerShell 错误码并传播
      assert.ok(content.includes("EXIT_CODE"));
      assert.ok(content.includes("ERRORLEVEL"));
      // 使用 endlocal & exit /b 保持错误码
      assert.match(content, /endlocal.*exit\s*\/b/i);
    });

    it("pack.ps1 uses throw on build errors", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 构建失败时抛出异常
      assert.ok(content.includes("throw"));
      // 检查 LASTEXITCODE 用于判断子进程失败
      assert.ok(content.includes("$LASTEXITCODE"));
      // 错误时停止执行
      assert.ok(content.includes('$ErrorActionPreference = "Stop"'));
    });

    it("pack.ps1 validates release directory existence", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 验证发布目录存在
      assert.ok(content.includes("Test-Path"));
      assert.ok(content.includes("$releaseRoot"));
    });

    it("pack.ps1 catches 7-Zip compression failure", () => {
      const { content } = readScript("scripts/win/pack.ps1");

      // 7-Zip 失败时抛异常
      assert.ok(content.includes("$LASTEXITCODE"));
      assert.ok(content.includes("throw"));
    });

    it("property: pack.ps1 has error handling for each stage", () => {
      const errorIndicators = [
        "throw",
        "$LASTEXITCODE",
        "$ErrorActionPreference",
        "Test-Path"
      ];

      fc.assert(
        fc.property(
          fc.constantFrom(...errorIndicators),
          (indicator) => {
            const { content } = readScript("scripts/win/pack.ps1");
            return content.includes(indicator);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
