/**
 * SandboxManager 单元测试
 * 测试沙箱进程的 spawn / readOutput / getStatus / kill 及安全逃逸
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";
import fs from "node:fs";

import { SandboxManager } from "../../../modules/sandbox/sandbox_manager.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("SandboxManager", () => {
  /** @type {SandboxManager} */
  let sm;
  /** @type {string} */
  let testDataDir;
  /** @type {string} */
  let testWorkspace;

  beforeEach(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    testDataDir = path.join(PROJECT_ROOT, "test", ".tmp", `sandbox_test_${suffix}`);
    testWorkspace = path.join(testDataDir, "workspace");
    await fsp.mkdir(testWorkspace, { recursive: true });

    sm = new SandboxManager({
      log: makeTestLogger("SB-Test"),
      dataDir: testDataDir,
    });
  });

  afterEach(async () => {
    await sm.killAll();
    sm.destroy();
    try { await fsp.rm(testDataDir, { recursive: true, force: true }); } catch {}
  });

  // 辅助函数：等待沙箱完成
  async function waitForCompletion(processId, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = sm.getStatus(processId);
      if (!s.ok) return s;
      if (s.status !== "running") return s;
      await new Promise(r => setTimeout(r, 100));
    }
    return sm.getStatus(processId);
  }

  // 辅助函数：读取全部输出
  async function readAllOutput(processId, maxIter = 20) {
    let all = "";
    let offset = 0;
    for (let i = 0; i < maxIter; i++) {
      const result = await sm.readOutput(processId, offset);
      if (!result.ok) return result;
      all += result.content;
      if (!result.hasMore) break;
      offset = result.nextOffset;
      await new Promise(r => setTimeout(r, 50));
    }
    return { ok: true, content: all };
  }

  describe("spawn / readOutput / getStatus / kill", () => {
    it("执行 console.log('hello') 应输出 'hello' 并 exit code 0", async () => {
      const result = await sm.spawn("console.log('hello');", testWorkspace);
      assert.ok(result.ok, `spawn failed: ${result.error}`);
      assert.ok(result.processId);

      const status = await waitForCompletion(result.processId);
      assert.ok(status.ok);
      assert.strictEqual(status.status, "completed");
      assert.strictEqual(status.exitCode, 0);

      const output = await readAllOutput(result.processId);
      assert.ok(output.ok);
      assert.ok(output.content.includes("hello"));
    });

    it("throw new Error('boom') 应 exit code 1 且 stderr 含 'boom'", async () => {
      const result = await sm.spawn("throw new Error('boom');", testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.ok(status.ok);
      assert.strictEqual(status.exitCode, 1);

      const output = await readAllOutput(result.processId);
      assert.ok(output.ok);
      assert.ok(output.content.includes("boom"));
    });

    it("process.exit(42) 应 exit code 42", async () => {
      const result = await sm.spawn("process.exit(42);", testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.ok(status.ok);
      assert.strictEqual(status.exitCode, 42);
    });

    it("sandbox_kill 应成功终止 while(true){} 死循环", async () => {
      const result = await sm.spawn("while(true){}", testWorkspace);
      assert.ok(result.ok);

      await new Promise(r => setTimeout(r, 500));

      let status = sm.getStatus(result.processId);
      assert.ok(status.ok);
      assert.strictEqual(status.status, "running");

      const killResult = sm.kill(result.processId);
      assert.ok(killResult.ok);

      const finalStatus = await waitForCompletion(result.processId, 5000);
      assert.ok(["killed", "error", "completed"].includes(finalStatus.status),
        `Expected killed/error/completed, got ${finalStatus.status}`);
    });

    it("getStatus 对不存在的 processId 返回 error", () => {
      const result = sm.getStatus("nonexistent-id");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, "process_not_found");
    });

    it("kill 对不存在的 processId 返回 error", () => {
      const result = sm.kill("nonexistent-id");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, "process_not_found");
    });
  });

  describe("安全逃逸测试", () => {
    it("读取工作区外的文件应产生 ERR_ACCESS_DENIED", async () => {
      const sysPath = process.platform === "win32"
        ? "C:/Windows/System32/drivers/etc/hosts"
        : "/etc/hosts";

      const code = `import { readFileSync } from 'node:fs';\ntry {\n  console.log(readFileSync('${sysPath.replace(/\\/g, "\\\\")}', 'utf8'));\n} catch(e) {\n  console.log(e.message);\n}`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      const output = await readAllOutput(result.processId);

      const hasAccessDenied =
        output.content.includes("ERR_ACCESS_DENIED") ||
        output.content.includes("Access to this API has been restricted") ||
        output.content.includes("permission") ||
        status.exitCode !== 0;
      assert.ok(hasAccessDenied, `Expected access denied but got: ${output.content.substring(0, 500)}`);
    });

    it("访问网络应产生 ERR_ACCESS_DENIED", async () => {
      const code = `import http from 'node:http';\ntry {\n  http.get('http://example.com', (res) => {\n    console.log('connected');\n  });\n} catch(e) {\n  console.log(e.message);\n}`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId, 10000);
      const output = await readAllOutput(result.processId);

      assert.ok(!output.content.includes("connected"),
        "Network should be blocked but got 'connected'");

      const hasDenied =
        output.content.includes("ERR_ACCESS_DENIED") ||
        output.content.includes("Access to this API has been restricted") ||
        output.content.includes("permission");
      assert.ok(hasDenied, `Expected access denied error but got: ${output.content.substring(0, 300)}`);
    });

    it("创建子进程应产生 ERR_ACCESS_DENIED", async () => {
      const code = `import cp from 'node:child_process';\ntry {\n  cp.exec('echo hello', (err, stdout) => {\n    console.log(stdout);\n  });\n} catch(e) {\n  console.log(e.message);\n}`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId, 5000);
      const output = await readAllOutput(result.processId);

      assert.ok(!output.content.includes("hello"),
        "Child process should be blocked but got output");
    });
  });

  describe("工作区文件读写", () => {
    it("应能读工作区内的文件", async () => {
      const testFile = path.join(testWorkspace, "data.txt");
      await fsp.writeFile(testFile, "workspace-data", "utf8");

      const code = `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('data.txt', 'utf8'));`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.strictEqual(status.exitCode, 0);

      const output = await readAllOutput(result.processId);
      assert.ok(output.content.includes("workspace-data"));
    });

    it("应能写工作区内的文件", async () => {
      const code = `import { writeFileSync } from 'node:fs';\nwriteFileSync('output.txt', 'sandbox-wrote-this');\nconsole.log('done');`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.strictEqual(status.exitCode, 0);

      const written = await fsp.readFile(path.join(testWorkspace, "output.txt"), "utf8");
      assert.strictEqual(written, "sandbox-wrote-this");
    });

    it("应能以 ESM import 方式导入工作区内的 .mjs 文件", async () => {
      const moduleFile = path.join(testWorkspace, "helper.mjs");
      await fsp.writeFile(moduleFile, "export function greet() { return 'hello from module'; }\n", "utf8");

      const code = `import { greet } from './helper.mjs';\nconsole.log(greet());`;
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.strictEqual(status.exitCode, 0);

      const output = await readAllOutput(result.processId);
      assert.ok(output.content.includes("hello from module"));
    });
  });

  describe("超长代码", () => {
    it("超过 30KB 的代码应自动切换为文件执行", async () => {
      const padding = "// " + "x".repeat(33 * 1024) + "\n";
      const code = padding + "console.log('long-code-ok');";

      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      const status = await waitForCompletion(result.processId);
      assert.strictEqual(status.exitCode, 0);

      const output = await readAllOutput(result.processId);
      assert.ok(output.content.includes("long-code-ok"));
    });
  });

  describe("并发隔离", () => {
    it("多个沙箱应能并行运行且互不干扰", async () => {
      const r1 = await sm.spawn("setTimeout(() => console.log('p1'), 200);", testWorkspace);
      const r2 = await sm.spawn("setTimeout(() => console.log('p2'), 200);", testWorkspace);
      assert.ok(r1.ok);
      assert.ok(r2.ok);
      assert.notStrictEqual(r1.processId, r2.processId);

      await Promise.all([
        waitForCompletion(r1.processId),
        waitForCompletion(r2.processId),
      ]);

      const out1 = await readAllOutput(r1.processId);
      const out2 = await readAllOutput(r2.processId);
      assert.ok(out1.content.includes("p1"));
      assert.ok(out2.content.includes("p2"));
    });
  });

  describe("seek 读取（offset/window/nextOffset）", () => {
    it("offset 读取应返回正确的 nextOffset 和 hasMore", async () => {
      const code = "console.log('A'.repeat(3000));\nconsole.log('B'.repeat(3000));";
      const result = await sm.spawn(code, testWorkspace);
      assert.ok(result.ok);

      await waitForCompletion(result.processId);

      const r1 = await sm.readOutput(result.processId, 0, 1000);
      assert.ok(r1.ok);
      assert.ok(r1.content.length > 0);
      assert.strictEqual(r1.offset, 0);
      assert.ok(r1.nextOffset > 0);
      assert.strictEqual(r1.hasMore, true);

      const r2 = await sm.readOutput(result.processId, r1.nextOffset, 1000);
      assert.ok(r2.ok);
      assert.strictEqual(r2.offset, r1.nextOffset);
    });
  });
});
