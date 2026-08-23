/**
 * Remote → localcmd 桥接测试
 *
 * 架构：remote 只做通信桥——SSH channel 包装成"进程样对象"交给 localcmd 的
 * ProcessManager 统一管理（日志、解码、live 状态、历史、终止）。
 *
 * 测试方式：mock.module("ssh2") 注入假 Client/Stream（MockClient 静态登记实例，
 * 供测试取回 exec 打开的流）；init 真实 localcmd + remote 模块；mockRuntime 提供
 * _toolExecutor（remote init 时 hook 它，localcmd 工具转发到真实 localcmd 模块，
 * 模拟真实 ToolExecutor 的分发）。经 hooked executeToolCall 发起 localcmd_spawn，
 * 验证全链路：进程进 localcmd live 表与历史 → 日志经解码器落盘 → close 后 completed；
 * read_output/kill 不被拦截走原函数；删映射 → killByAgent；localcmd 未加载 → 优雅报错。
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";

import { makeTestLogger } from "../../helpers/test_logger.js";
import { makeFakeConfigService } from "../../helpers/fake_config_service.js";

const CONF_A = { host: "192.168.0.27", port: 22, username: "dtw", password: "453453", enabled: true };

/** 假 SSH 流：EventEmitter + stderr 子流 + signal/close/write（ssh2 ClientChannel 语义子集） */
class MockStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this._closed = false;
    this.signalCalls = [];
  }

  signal(sig) { this.signalCalls.push(sig); }

  close() {
    if (!this._closed) {
      this._closed = true;
      this.emit("close", 0, null); // ssh2 语义：close(code, signal)
    }
  }

  write() {}
}

/** 假 SSH Client：connect 后微任务 ready；exec 立即回调 MockStream；静态登记实例供测试取流 */
class MockClient extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.streams = [];
    this._closed = false;
    MockClient.instances.push(this);
  }

  connect() {
    queueMicrotask(() => {
      if (!this._closed) this.emit("ready");
    });
  }

  exec(cmd, cb) {
    const stream = new MockStream();
    this.streams.push(stream);
    cb(null, stream);
  }

  end() {
    this._closed = true;
    this.emit("close");
  }
}

/** 等待轮询条件成立（支持同步/异步条件函数） */
async function waitFor(fn, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe("Remote → localcmd 桥接（localcmd_spawn 统一进程管理）", () => {
  let localcmdModule;
  let remoteModule;
  let tempDataDir;
  let mockRuntime;
  /** 转发到原函数的工具调用记录（验证不再被拦截的工具确实走原路径） */
  let forwardedCalls;

  before(async () => {
    await mock.module("ssh2", { namedExports: { Client: MockClient } });
    // 动态 import 必须在 mock.module 之后，使 mock 拦截生效
    localcmdModule = (await import("../../../modules/localcmd/index.js")).default;
    remoteModule = (await import("../../../modules/remote/index.js")).default;
  });

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `remote_bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(tempDataDir, { recursive: true });
    MockClient.instances = [];
    forwardedCalls = [];

    mockRuntime = {
      loggerRoot: { forModule: (n) => makeTestLogger(n) },
      configService: makeFakeConfigService(),
      dataDir: tempDataDir,
      bus: { send: async () => ({ messageId: "m1" }) },
      lifecycleRegistry: { register: () => {}, unregister: async () => {} },
      org: {
        listAgents: () => [],
        listRoles: () => [],
        getAgent: () => null,
        getRole: () => null,
        getOrgName: () => null,
      },
      findWorkspaceIdForAgent: () => null,
      moduleLoader: { getModule: (name) => (name === "localcmd" ? localcmdModule : null) },
      // 模拟真实 ToolExecutor：localcmd 工具分发到真实 localcmd 模块，其余未知
      _toolExecutor: {
        executeToolCall: async (ctx, toolName, args) => {
          forwardedCalls.push({ toolName, args });
          if (toolName.startsWith("localcmd_")) {
            return localcmdModule.executeToolCall(ctx, toolName, args);
          }
          return { error: "unknown_tool", toolName };
        },
      },
    };

    // 模块级单例：先清理再 init，避免测试间污染；顺序与真实环境一致（localcmd 先于 remote）
    try { await remoteModule.shutdown(); } catch {}
    try { await localcmdModule.shutdown(); } catch {}
    await localcmdModule.init(mockRuntime);
    await remoteModule.init(mockRuntime);

    // 为 agent-1 配置 remote 映射（走真实 POST /mappings 路径）
    const handler = remoteModule.getHttpHandler();
    const saveRes = await handler(
      { method: "POST", url: "/api/modules/remote/mappings" },
      null,
      ["mappings"],
      { agentId: "agent-1", config: CONF_A }
    );
    assert.strictEqual(saveRes.ok, true, "映射保存应成功");
  });

  afterEach(async () => {
    try { await remoteModule.shutdown(); } catch {}
    try { await localcmdModule.shutdown(); } catch {}
    try { await fsp.rm(tempDataDir, { recursive: true, force: true }); } catch {}
  });

  /** 经 hooked toolExecutor 发起工具调用（真实拦截路径） */
  function callTool(agentId, toolName, args) {
    return mockRuntime._toolExecutor.executeToolCall({ agent: { id: agentId }, runtime: mockRuntime }, toolName, args);
  }

  /** 经 localcmd history HTTP 路由查列表 */
  async function listHistory(agentId) {
    const handler = localcmdModule.getHttpHandler();
    return handler(
      { method: "GET", url: `/api/modules/localcmd/history?agentId=${agentId}` },
      null,
      ["history"]
    );
  }

  /** 经 localcmd history HTTP 路由读日志 */
  async function readLog(processId, offset = 0) {
    const handler = localcmdModule.getHttpHandler();
    return handler(
      { method: "GET", url: `/api/modules/localcmd/history/${processId}/output?offset=${offset}&window=65536` },
      null,
      ["history", processId, "output"]
    );
  }

  it("localcmd_spawn 桥接全链路：live running → 日志解码落盘 → close 后 completed", async () => {
    const result = await callTool("agent-1", "localcmd_spawn", { command: "uname", args: ["-a"] });
    assert.strictEqual(result.ok, true, `spawn 应成功: ${JSON.stringify(result)}`);
    const processId = result.processId;

    // 进程已进入 localcmd：历史列表显示 running（live 覆盖）
    const list1 = await listHistory("agent-1");
    assert.strictEqual(list1.total, 1);
    assert.strictEqual(list1.items[0].processId, processId);
    assert.strictEqual(list1.items[0].status, "running");
    assert.strictEqual(list1.items[0].command, "uname -a");

    // 经 SSH channel 推送输出（中文按多字节边界切分，验证解码器生效）
    const stream = MockClient.instances[0].streams[0];
    const text = "远程主机信息：Linux";
    const buf = Buffer.from(text, "utf8");
    stream.emit("data", buf.subarray(0, 5));
    stream.emit("data", buf.subarray(5));
    stream.stderr.emit("data", Buffer.from("警告：磁盘空间不足", "utf8"));

    // 日志经 localcmd 写入文件并可从 history 路由读回。
    // 每个 data 事件各产生一行 [STDOUT] 前缀（现有行为），断言两个片段均解码正确
    await waitFor(async () => (await readLog(processId)).content.includes("磁盘空间不足"));
    const output = await readLog(processId);
    assert.ok(output.content.includes("[STDOUT] 远"), `第一段应解码为"远"（跨 chunk 边界安全）: ${JSON.stringify(output.content.slice(0, 300))}`);
    assert.ok(output.content.includes("[STDOUT] 程主机信息：Linux"), `第二段应解码为"程主机信息：Linux": ${JSON.stringify(output.content.slice(0, 300))}`);
    assert.ok(output.content.includes("[STDERR] 警告：磁盘空间不足"), "stderr 应带前缀落盘");
    assert.ok(!output.content.includes("�"), "不应有 U+FFFD");

    // channel 关闭 → 状态收敛 completed
    stream.close();
    await waitFor(async () => (await listHistory("agent-1")).items[0].status === "completed");

    const list2 = await listHistory("agent-1");
    assert.strictEqual(list2.items[0].status, "completed");
    assert.strictEqual(list2.items[0].exitCode, 0);
  });

  it("read_output / kill 不再被拦截：走原函数且 localcmd 正常处理该 processId", async () => {
    const spawnRes = await callTool("agent-1", "localcmd_spawn", { command: "sleep", args: ["100"] });
    assert.strictEqual(spawnRes.ok, true);
    const processId = spawnRes.processId;

    const stream = MockClient.instances[0].streams[0];
    stream.emit("data", Buffer.from("counting...\n", "utf8"));

    // read_output 不被拦截 → 记录到 forwardedCalls 且由真实 localcmd 处理。
    // 写入流异步冲刷，轮询等待内容可见（智能体侧 read_output 本就是轮询式增量读取）
    let readRes;
    const readFlushed = await waitFor(async () => {
      readRes = await callTool("agent-1", "localcmd_read_output", { processId });
      return readRes.ok && readRes.content.includes("counting...");
    }, 5000);
    assert.ok(readFlushed, `应读到日志内容: ${JSON.stringify(readRes)}`);
    assert.ok(readRes.content.includes("counting..."), `应读到日志内容: ${JSON.stringify(readRes.content.slice(0, 200))}`);
    assert.ok(forwardedCalls.some((c) => c.toolName === "localcmd_read_output"), "read_output 应转发到原函数");

    // kill 不被拦截 → localcmd 正常终止（adapter.kill 收到 SIGTERM，channel 被 close）
    const killRes = await callTool("agent-1", "localcmd_kill", { processId });
    assert.strictEqual(killRes.ok, true, `kill 应成功: ${JSON.stringify(killRes)}`);
    assert.ok(forwardedCalls.some((c) => c.toolName === "localcmd_kill"), "kill 应转发到原函数");
    assert.deepStrictEqual(stream.signalCalls, ["SIGTERM"], "adapter.kill 应先发 SIGTERM");

    await waitFor(async () => (await listHistory("agent-1")).items[0].status === "killed");
    const list = await listHistory("agent-1");
    assert.strictEqual(list.items[0].status, "killed");
  });

  it("删除映射 → localcmd killByAgent 终止该 agent 的运行中进程", async () => {
    const spawnRes = await callTool("agent-1", "localcmd_spawn", { command: "sleep", args: ["100"] });
    assert.strictEqual(spawnRes.ok, true);

    // 删除映射（走真实 POST config=null 路径）
    const handler = remoteModule.getHttpHandler();
    const delRes = await handler(
      { method: "POST", url: "/api/modules/remote/mappings" },
      null,
      ["mappings"],
      { agentId: "agent-1", config: null }
    );
    assert.strictEqual(delRes.ok, true);

    await waitFor(async () => (await listHistory("agent-1")).items[0].status === "killed");
    const list = await listHistory("agent-1");
    assert.strictEqual(list.items[0].status, "killed", "删映射后该 agent 的远程进程应被终止");
  });

  it("localcmd 未加载 → spawn 返回 localcmd_unavailable，不崩溃", async () => {
    mockRuntime.moduleLoader = { getModule: () => null };

    const result = await callTool("agent-1", "localcmd_spawn", { command: "uname" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "localcmd_unavailable");
  });
});
