/**
 * ProcessManager 输出编码测试
 *
 * 背景：cmd 等系统命令在中文 Windows 下输出 GBK 字节，现代程序（Node、Python 3 等）
 * 输出 UTF-8。AdaptiveStreamDecoder 按内容自动判定，候选列表固定为 UTF-8 → GBK，
 * 不依赖本地机器设置（不读取 chcp 代码页），任何系统上行为一致。需保证：
 * 1. UTF-8 多字节字符跨 chunk 边界不产生 U+FFFD 乱码（残尾携带）；
 * 2. GBK 字节在任何系统上都回退 GBK 解码（不依赖本地代码页）；
 * 3. GBK 双字节字符跨 chunk 边界不丢前导字节（前导携带）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";
import iconv from "iconv-lite";

import { ProcessManager, AdaptiveStreamDecoder } from "../../../modules/localcmd/process_manager.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const testLog = makeTestLogger("Enc-Test");

/** 把 Buffer 按切点列表依次喂给解码器，返回全部输出拼接（含 end 冲刷） */
function decodeWithSplits(buf, splits) {
  const d = new AdaptiveStreamDecoder(testLog);
  let out = "";
  let start = 0;
  for (const pos of [...splits, buf.length]) {
    out += d.write(buf.subarray(start, pos));
    start = pos;
  }
  out += d.end();
  return out;
}

/** 生成 1..n-1 的所有单字节切点 */
function everyByteSplit(buf) {
  const splits = [];
  for (let i = 1; i < buf.length; i++) splits.push(i);
  return splits;
}

describe("AdaptiveStreamDecoder — 编码检测与跨 chunk 边界", () => {
  it("UTF-8 中文单块解码为原文", () => {
    const buf = Buffer.from("你好世界", "utf8");
    assert.strictEqual(decodeWithSplits(buf, []), "你好世界");
  });

  it("UTF-8 三字节中文按每个字节切分，拼接无乱码", () => {
    const buf = Buffer.from("你好世界", "utf8");
    assert.strictEqual(decodeWithSplits(buf, everyByteSplit(buf)), "你好世界");
  });

  it("UTF-8 四字节 emoji 按每个字节切分，拼接无乱码", () => {
    const buf = Buffer.from("😀🎉测试", "utf8");
    assert.strictEqual(decodeWithSplits(buf, everyByteSplit(buf)), "😀🎉测试");
  });

  it("GBK 字节单块回退 GBK 解码", () => {
    const buf = iconv.encode("你好妈妈", "cp936");
    assert.strictEqual(decodeWithSplits(buf, []), "你好妈妈");
  });

  it("GBK 双字节字符按每个字节切分，前导字节跨 chunk 携带", () => {
    const buf = iconv.encode("你好", "cp936");
    assert.strictEqual(decodeWithSplits(buf, everyByteSplit(buf)), "你好");
  });

  it("ASCII 与 GBK 混合分块，两种编码都正确", () => {
    const ascii = Buffer.from("prefix: ", "ascii");
    const gbk = iconv.encode("目录列表", "cp936");
    const buf = Buffer.concat([ascii, gbk]);
    assert.strictEqual(decodeWithSplits(buf, [ascii.length]), "prefix: 目录列表");
  });

  it("合法输出的 U+FFFD 字符不误触发 GBK 回退", () => {
    // 原实现用"解码结果包含 U+FFFD"判断回退，会把程序合法输出的 U+FFFD 误判为 GBK
    const buf = Buffer.from("a�b", "utf8");
    assert.strictEqual(decodeWithSplits(buf, []), "a�b");
  });

  it("流结束残尾 UTF-8 字节按 U+FFFD 冲刷（流被截断）", () => {
    const full = Buffer.from("你", "utf8"); // E4 BD A0
    const d = new AdaptiveStreamDecoder(testLog);
    assert.strictEqual(d.write(full.subarray(0, 2)), "");
    assert.strictEqual(d.end(), "�");
  });

  it("流结束残尾 GBK 前导字节冲刷不抛错", () => {
    const full = iconv.encode("你", "cp936"); // C4 E3
    const d = new AdaptiveStreamDecoder(testLog);
    assert.strictEqual(d.write(full.subarray(0, 1)), "");
    const flushed = d.end();
    assert.strictEqual(typeof flushed, "string");
    assert.ok(flushed.length > 0);
  });

  it("全续字节 GBK 流（0x81 0xA2 重复）不会无界缓冲", () => {
    // 0x81 0xA2 均为 UTF-8 续字节范围，残尾携带上限 3 字节，超限必须触发回退
    const d = new AdaptiveStreamDecoder(testLog);
    let out = "";
    out += d.write(Buffer.from("81a2", "hex"));
    assert.strictEqual(out, "", "首块不足判定，应静默等待");
    out += d.write(Buffer.from("81a2", "hex"));
    out += d.end();
    assert.strictEqual(out, iconv.decode(Buffer.from("81a281a2", "hex"), "cp936"));
  });

  it("GBK 回退与本地代码页无关（解码器无系统设置输入）", () => {
    // 解码器构造不接收任何系统编码参数——UTF-8 → GBK 候选列表固定，
    // 在任何操作系统、任何代码页环境下行为一致
    const buf = iconv.encode("你好", "cp936");
    assert.strictEqual(decodeWithSplits(buf, []), "你好");
  });

  it("空 chunk 与空 end 返回空串", () => {
    const d = new AdaptiveStreamDecoder(testLog);
    assert.strictEqual(d.write(Buffer.alloc(0)), "");
    assert.strictEqual(d.end(), "");
  });
});

describe("ProcessManager — 子进程输出编码集成", () => {
  let pm;
  let testDataDir;

  /** 等待进程完成（状态不为 'running'） */
  async function waitForCompletion(processId, maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const proc = pm.getProcess(processId);
      if (proc && proc.status !== "running") return proc;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pm.getProcess(processId);
  }

  beforeEach(async () => {
    testDataDir = path.join(
      PROJECT_ROOT, "test", ".tmp",
      `pm_enc_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    await fsp.mkdir(testDataDir, { recursive: true });

    pm = new ProcessManager({
      log: makeTestLogger("PM-Enc-Test"),
      runtime: {
        lifecycleRegistry: {
          register: () => {},
          unregister: async () => {},
        },
        procMessageHub: {
          getPort: () => 0,
          registerSpawn: () => ({ ok: true }),
        },
      },
      dataDir: testDataDir,
    });
  });

  afterEach(async () => {
    await pm.killAll();
    try {
      await fsp.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("UTF-8 中文输出经真实 spawn 写入文件无乱码", async () => {
    const result = await pm.spawn(process.execPath, [
      "-e",
      "process.stdout.write('你好 UTF-8 测试')"
    ]);
    assert.strictEqual(result.ok, true);

    const proc = await waitForCompletion(result.processId);
    assert.strictEqual(proc.status, "completed");
    // 等待写入流把最后字节冲刷到磁盘
    await new Promise((r) => setTimeout(r, 200));

    const output = await pm.readOutput(result.processId);
    assert.strictEqual(output.ok, true);
    assert.ok(
      output.content.includes("你好 UTF-8 测试"),
      `输出应包含原文，实际: ${JSON.stringify(output.content.slice(0, 200))}`
    );
  });

  it("GBK 输出经回退解码写入文件无乱码（跨平台，不依赖本地代码页）", async () => {
    // c4e3bac3c2e8c2e8 = GBK 编码的"你好妈妈"。
    // 本测试在所有平台运行：回退目标固定为 GBK，与 chcp/系统区域设置无关。
    const result = await pm.spawn(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from('c4e3bac3c2e8c2e8','hex'))"
    ]);
    assert.strictEqual(result.ok, true);

    const proc = await waitForCompletion(result.processId);
    assert.strictEqual(proc.status, "completed");
    await new Promise((r) => setTimeout(r, 200));

    const output = await pm.readOutput(result.processId);
    assert.strictEqual(output.ok, true);
    assert.ok(
      output.content.includes("你好妈妈"),
      `输出应包含解码后的中文，实际: ${JSON.stringify(output.content.slice(0, 200))}`
    );
    assert.ok(
      !output.content.includes("�"),
      "解码结果不应包含 U+FFFD 替换字符"
    );
  });
});
