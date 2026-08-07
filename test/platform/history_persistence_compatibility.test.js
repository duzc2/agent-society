import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationManager } from "../../src/platform/services/conversation/conversation_manager.js";
import { makeTestLogger } from "../helpers/test_logger.js";

const tempDirs = [];

async function createTempRuntimeDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-society-history-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("History persistence compatibility", () => {
  it("ConversationManager should load legacy array conversation files", async () => {
    const runtimeDir = await createTempRuntimeDir();
    const conversationsDir = path.join(runtimeDir, "conversations");
    await mkdir(conversationsDir, { recursive: true });

    // Legacy format: plain array with system message at the front
    await writeFile(
      path.join(conversationsDir, "agent-1.json"),
      JSON.stringify([
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "first assistant", reasoning_content: "thoughts" }
      ]),
      "utf8"
    );

    const manager = new ConversationManager({
      conversationsDir,
      conversations: new Map(),
      logger: makeTestLogger("HistoryPersistence")
    });

    const result = manager.loadConversationSync("agent-1");
    const conversation = manager.getConversation("agent-1");

    // _normalizePersistedConversationData strips leading system messages
    // for backward compatibility, so 3 messages become 2
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.loaded, true);
    assert.strictEqual(conversation?.length, 2);
    assert.strictEqual(conversation?.[0]?.content, "first user");
    assert.strictEqual(typeof conversation?.[1]?.id, "string");
  });

  it("ConversationManager should load new format conversation files", async () => {
    const runtimeDir = await createTempRuntimeDir();
    const conversationsDir = path.join(runtimeDir, "conversations");
    await mkdir(conversationsDir, { recursive: true });

    // New format: object with messages array
    await writeFile(
      path.join(conversationsDir, "agent-1.json"),
      JSON.stringify({
        updatedAt: "2026-03-23T10:00:00.000Z",
        messages: [
          { id: "sys-1", role: "system", content: "SYSTEM" },
          { id: "user-1", role: "user", content: "first user" },
          { id: "assistant-1", role: "assistant", content: "first assistant", reasoning_content: "thoughts" }
        ]
      }),
      "utf8"
    );

    const manager = new ConversationManager({
      conversationsDir,
      conversations: new Map(),
      logger: makeTestLogger("HistoryPersistence")
    });

    const result = manager.loadConversationSync("agent-1");
    const conversation = manager.getConversation("agent-1");

    // System message should be stripped, leaving 2 non-system messages
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.loaded, true);
    assert.strictEqual(conversation?.length, 2);
    assert.strictEqual(conversation?.[0]?.role, "user");
    assert.strictEqual(conversation?.[0]?.content, "first user");
    assert.strictEqual(conversation?.[1]?.role, "assistant");
    assert.strictEqual(conversation?.[1]?.reasoning_content, "thoughts");
  });

  it("ConversationManager should handle usage fields from snapshots", async () => {
    const runtimeDir = await createTempRuntimeDir();
    const conversationsDir = path.join(runtimeDir, "conversations");
    await mkdir(conversationsDir, { recursive: true });

    await writeFile(
      path.join(conversationsDir, "agent-1.json"),
      JSON.stringify({
        updatedAt: "2026-03-23T10:00:00.000Z",
        messages: [
          { id: "user-1", role: "user", content: "first user" },
          { id: "assistant-1", role: "assistant", content: "first assistant", reasoning_content: "thoughts", _usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }
        ]
      }),
      "utf8"
    );

    const manager = new ConversationManager({
      conversationsDir,
      conversations: new Map(),
      logger: makeTestLogger("HistoryPersistence")
    });

    const result = manager.loadConversationSync("agent-1");
    const conversation = manager.getConversation("agent-1");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.loaded, true);
    assert.strictEqual(conversation?.length, 2);
    assert.strictEqual(conversation?.[1]?.reasoning_content, "thoughts");
    assert.deepStrictEqual(conversation?.[1]?._usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });
});
