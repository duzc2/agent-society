import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GroupRegistry } from "../../../../src/platform/services/group_chat/group_registry.js";
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
