import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GroupRegistry } from "../../../../src/platform/services/group_chat/group_registry.js";
import { GroupMessageStore } from "../../../../src/platform/services/group_chat/group_message_store.js";
import { GroupChatService } from "../../../../src/platform/services/group_chat/group_chat_service.js";
import { makeTestLogger, testLoggerRoot } from "../../../helpers/test_logger.js";

/**
 * 群归档与退群成员记录 — 数据层与服务序列化测试
 */

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "group-registry-test-"));
});

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

function makeRegistry() {
  return new GroupRegistry({
    dataDir: path.join(tmpDir, "state"),
    logger: makeTestLogger("GroupRegistry")
  });
}

describe("GroupRegistry — 退群记录与归档", () => {
  it("removeMembers 应留存 exitedMembers 记录（含 reason 与 leftAt）", async () => {
    const reg = makeRegistry();
    const group = await reg.create({ name: "测试群", members: ["a1", "a2", "a3"] });

    await reg.removeMembers(group.id, ["a2"], "left");

    const updated = reg.get(group.id);
    assert.deepStrictEqual(updated.members, ["a1", "a3"], "members 仅剩活跃成员");
    assert.strictEqual(updated.exitedMembers.length, 1);
    assert.strictEqual(updated.exitedMembers[0].id, "a2");
    assert.strictEqual(updated.exitedMembers[0].reason, "left");
    assert.ok(updated.exitedMembers[0].leftAt, "应记录退出时间");
  });

  it("removeMembers 终止原因应留存 reason=terminated", async () => {
    const reg = makeRegistry();
    const group = await reg.create({ name: "测试群", members: ["a1", "a2", "a3"] });

    await reg.removeMembers(group.id, ["a1"], "terminated");

    assert.strictEqual(reg.get(group.id).exitedMembers[0].reason, "terminated");
  });

  it("addMembers 重新邀请已退出成员应清除其退出记录", async () => {
    const reg = makeRegistry();
    const group = await reg.create({ name: "测试群", members: ["a1", "a2", "a3"] });

    await reg.removeMembers(group.id, ["a2"], "left");
    await reg.addMembers(group.id, ["a2"]);

    const updated = reg.get(group.id);
    assert.deepStrictEqual(updated.members.sort(), ["a1", "a2", "a3"]);
    assert.strictEqual(updated.exitedMembers.length, 0, "重新入群应清除退出记录");
  });

  it("archive 应保留 members 与 exitedMembers，仅改 status", async () => {
    const reg = makeRegistry();
    const group = await reg.create({ name: "测试群", members: ["a1", "a2", "a3"] });
    await reg.removeMembers(group.id, ["a3"], "left");

    await reg.archive(group.id);

    const archived = reg.get(group.id);
    assert.strictEqual(archived.status, "archived");
    assert.deepStrictEqual(archived.members, ["a1", "a2"], "archive 保留活跃成员");
    assert.strictEqual(archived.exitedMembers.length, 1, "archive 保留退出记录");
    assert.deepStrictEqual(reg.list("active"), [], "active 列表排除归档群");
    assert.strictEqual(reg.list().length, 1, "list() 返回全部（含归档）");
  });

  it("重启加载（重新实例化）后 exitedMembers 与 archived 状态应恢复", async () => {
    const reg = makeRegistry();
    const group = await reg.create({ name: "持久化群", members: ["a1", "a2", "a3"] });
    await reg.removeMembers(group.id, ["a3"], "left");
    await reg.archive(group.id);

    const reloaded = makeRegistry();
    await reloaded.load();
    const restored = reloaded.get(group.id);

    assert.strictEqual(restored.status, "archived");
    assert.strictEqual(restored.exitedMembers.length, 1);
    assert.strictEqual(restored.exitedMembers[0].reason, "left");
  });
});

describe("GroupMessageStore — 缓存未加载时 append 不得清空历史", () => {
  it("重启后（新实例、缓存为空）append 应保留既有历史", async () => {
    const messagesDir = path.join(tmpDir, "messages");
    const mkMsg = (text) => ({
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      kind: "group",
      groupId: "g1",
      from: "a1",
      payload: { text },
      createdAt: new Date().toISOString().replace("T", " ").slice(0, 19)
    });

    // 第一次会话：写入两条消息
    const store1 = new GroupMessageStore({ messagesDir, logger: makeTestLogger("GMS") });
    await store1.init();
    await store1.append("g1", mkMsg("第一条"));
    await store1.append("g1", mkMsg("第二条"));

    // 模拟重启：新实例，缓存与 _loaded 均为空
    const store2 = new GroupMessageStore({ messagesDir, logger: makeTestLogger("GMS") });
    await store2.init();
    await store2.append("g1", mkMsg("第三条"));

    const reloaded = await store2.loadMessages("g1");
    assert.strictEqual(reloaded.length, 3, "重启后 append 必须保留既有历史");
    assert.deepStrictEqual(
      reloaded.map(m => m.payload.text),
      ["第一条", "第二条", "第三条"]
    );
  });
});

describe("GroupChatService — 启动对账（旧数据处理）", () => {
  function makeService({ agentStatusMap }) {
    return new GroupChatService({
      bus: { send: () => ({ messageId: "m" }) },
      heartbeatBroker: { broadcast() {} },
      org: {
        getAgent: (id) => agentStatusMap.get(id) ?? null,
        getRole: () => null
      },
      runtimeEvents: { onAgentTerminated() {} },
      runtimeLlm: { registerMessageFormatter() {} },
      logRoot: testLoggerRoot,
      dataDir: path.join(tmpDir, "data"),
      runtimeDir: path.join(tmpDir, "runtime")
    });
  }

  it("已删除智能体退群（留存记录）+ 不足 3 人解散；archived 群不受影响", async () => {
    // 预置群数据（与服务同 dataDir 构造路径）
    const reg = new GroupRegistry({
      dataDir: path.join(tmpDir, "data", "runtime", "state"),
      logger: makeTestLogger("GroupRegistry")
    });
    const groupA = await reg.create({ name: "群A", members: ["dead1", "alive1", "alive2"] });
    const groupB = await reg.create({ name: "群B", members: ["alive1", "alive2"] });
    const groupC = await reg.create({ name: "群C", members: ["dead2", "alive1", "alive2", "alive3"] });
    await reg.archive(groupC.id);

    const agentStatusMap = new Map([
      ["dead1", { name: "已删1", status: "terminated" }],
      ["dead2", { name: "已删2", status: "terminated" }],
      ["alive1", { name: "活跃1", status: "active" }],
      ["alive2", { name: "活跃2", status: "active" }],
      ["alive3", { name: "活跃3", status: "active" }]
    ]);

    const svc = makeService({ agentStatusMap });
    await svc.init();

    // 从磁盘重新加载（服务持有独立 registry 实例，断言用最新持久化状态）
    await reg.load();

    // 群 A：dead1 退群（留存 terminated 记录）→ 剩 2 人 → 解散归档
    const a = reg.get(groupA.id);
    assert.strictEqual(a.status, "archived");
    assert.deepStrictEqual(a.members.sort(), ["alive1", "alive2"]);
    assert.strictEqual(a.exitedMembers.length, 1);
    assert.strictEqual(a.exitedMembers[0].id, "dead1");
    assert.strictEqual(a.exitedMembers[0].reason, "terminated");

    // 群 B：本来就 2 人 → 解散归档
    assert.strictEqual(reg.get(groupB.id).status, "archived");

    // 群 C：archived 不受检查——成员与退出记录都不动
    const c = reg.get(groupC.id);
    assert.strictEqual(c.status, "archived");
    assert.deepStrictEqual(c.members.sort(), ["alive1", "alive2", "alive3", "dead2"]);
    assert.strictEqual(c.exitedMembers.length, 0);

    // 群历史留档：A 有退群 + 解散系统消息；B 有解散消息；C 无新增消息
    const msgsA = await svc.messageStore.loadMessages(groupA.id);
    const textsA = msgsA.map(m => m.payload.text);
    assert.ok(textsA.some(t => t.includes("已删1 已离线，自动退出群聊")), "A 应有退群系统消息");
    assert.ok(textsA.some(t => t.includes("群聊成员不足 3 人，已自动解散")), "A 应有解散系统消息");

    const msgsB = await svc.messageStore.loadMessages(groupB.id);
    assert.ok(msgsB.some(m => m.payload.text.includes("群聊成员不足 3 人，已自动解散")), "B 应有解散系统消息");

    const msgsC = await svc.messageStore.loadMessages(groupC.id);
    assert.strictEqual(msgsC.length, 0, "archived 群不应被写入任何对账消息");
  });

  it("活跃智能体不应被误清理；对账幂等（重复执行无变化）", async () => {
    const reg = new GroupRegistry({
      dataDir: path.join(tmpDir, "data", "runtime", "state"),
      logger: makeTestLogger("GroupRegistry")
    });
    const group = await reg.create({ name: "群", members: ["alive1", "alive2", "alive3"] });

    const svc = makeService({
      agentStatusMap: new Map([
        ["alive1", { name: "活跃1", status: "active" }],
        ["alive2", { name: "活跃2", status: "active" }],
        ["alive3", { name: "活跃3", status: "active" }]
      ])
    });
    await svc.init();

    // 从磁盘重新加载（服务持有独立 registry 实例，断言用最新持久化状态）
    await reg.load();

    const afterFirst = reg.get(group.id);
    assert.strictEqual(afterFirst.status, "active", "3 个活跃成员不应解散");
    assert.deepStrictEqual(afterFirst.members.sort(), ["alive1", "alive2", "alive3"]);
    assert.strictEqual(afterFirst.exitedMembers.length, 0);

    // 重复对账：幂等
    await svc._reconcileGroupsOnStartup();
    await reg.load();
    const afterSecond = reg.get(group.id);
    assert.strictEqual(afterSecond.status, "active");
    assert.strictEqual(afterSecond.exitedMembers.length, 0);
  });
});

describe("GroupChatService — _serializeGroup 归档与退出成员", () => {
  function makeService(agentStatusMap) {
    return new GroupChatService({
      bus: { send: () => ({ messageId: "m" }) },
      heartbeatBroker: { broadcast() {} },
      org: {
        getAgent: (id) => agentStatusMap.get(id) ?? null,
        getRole: () => null
      },
      runtimeEvents: { onAgentTerminated() {} },
      runtimeLlm: { registerMessageFormatter() {} },
      logRoot: testLoggerRoot,
      dataDir: path.join(tmpDir, "data"),
      runtimeDir: path.join(tmpDir, "runtime")
    });
  }

  it("base 序列化应包含 status 字段", () => {
    const svc = makeService(new Map());
    const out = svc._serializeGroup({
      id: "g1", name: "群", description: "", members: ["a1"],
      exitedMembers: [], createdAt: "", updatedAt: "",
      status: "archived", lastMessageAt: "", lastMessagePreview: ""
    });

    assert.strictEqual(out.status, "archived");
  });

  it("includeMembers 序列化应追加已退出成员（left/terminated 状态）", () => {
    const svc = makeService(new Map([
      ["a1", { name: "活跃1", status: "active" }],
      ["a2", { name: "退出者", status: "active" }],
      ["a3", { name: "被终止者", status: "terminated" }]
    ]));
    const out = svc._serializeGroup({
      id: "g1", name: "群", description: "", members: ["a1"],
      exitedMembers: [
        { id: "a2", leftAt: "2026-08-25 10:00:00", reason: "left" },
        { id: "a3", leftAt: "2026-08-25 11:00:00", reason: "terminated" }
      ],
      createdAt: "", updatedAt: "", status: "active",
      lastMessageAt: "", lastMessagePreview: ""
    }, { includeMembers: true });

    assert.strictEqual(out.members.length, 3, "活跃 + 退出者都应返回");
    assert.strictEqual(out.members[0].id, "a1");
    assert.strictEqual(out.members[0].status, "active");
    assert.deepStrictEqual(
      out.members.slice(1).map(m => ({ id: m.id, status: m.status })),
      [
        { id: "a2", status: "left" },
        { id: "a3", status: "terminated" }
      ]
    );
    assert.strictEqual(out.memberCount, 1, "memberCount 只计活跃成员");
  });
});
