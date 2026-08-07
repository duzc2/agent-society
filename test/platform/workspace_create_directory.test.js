import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/platform/services/workspace/workspace.js";
import { makeTestLogger } from "../helpers/test_logger.js";

let testRootDir = "";

/**
 * 创建测试用工作区实例。
 * 每个用例都使用独立临时目录，避免全局元数据相互污染。
 *
 * @returns {Workspace}
 */
function createWorkspace() {
  return new Workspace("workspace-a", testRootDir, {
    dataDir: testRootDir,
    logger: makeTestLogger("Workspace")
  });
}

beforeEach(async () => {
  testRootDir = await mkdtemp(path.join(os.tmpdir(), "agent-society-workspace-"));
});

afterEach(async () => {
  if (testRootDir) {
    await rm(testRootDir, { recursive: true, force: true });
  }
});

describe("Workspace.createDirectory", () => {
  it("should persist empty directory metadata and expose it in tree", async () => {
    const workspace = createWorkspace();

    const createResult = await workspace.createDirectory("docs/notes", {
      operator: "user",
      messageId: "test-create-directory"
    });

    const meta = await workspace._readGlobalMeta();
    const tree = await workspace.getTree();

    assert.deepStrictEqual(createResult, {
      ok: true,
      path: "docs/notes",
      existed: false
    });
    assert.notStrictEqual(meta.directories["docs"], undefined);
    assert.notStrictEqual(meta.directories["docs/notes"], undefined);
    assert.ok(tree.includes("docs"));
    assert.ok(tree.includes("docs/notes"));
  });
});
