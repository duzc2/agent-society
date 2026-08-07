import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/platform/services/workspace/workspace.js";
import { makeTestLogger } from "../helpers/test_logger.js";

let testRootDir = "";

/**
 * 创建测试工作区。
 * 每个用例使用独立临时目录，避免目录删除测试互相污染。
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
  testRootDir = await mkdtemp(path.join(os.tmpdir(), "agent-society-workspace-delete-"));
});

afterEach(async () => {
  if (testRootDir) {
    await rm(testRootDir, { recursive: true, force: true });
  }
});

describe("Workspace.deleteDirectory", () => {
  it("should remove directory entries and nested files from workspace metadata", async () => {
    const workspace = createWorkspace();
    await workspace.writeFile("docs/spec/readme.md", "# test", {
      operator: "user",
      messageId: "write-readme"
    });
    await workspace.createDirectory("docs/empty", {
      operator: "user",
      messageId: "create-empty-directory"
    });

    const result = await workspace.deleteDirectory("docs", {
      operator: "user",
      messageId: "delete-docs"
    });

    const meta = await workspace._readGlobalMeta();
    const tree = await workspace.getTree();
    const fileHistory = await workspace.getFileHistory("docs/spec/readme.md");

    assert.deepStrictEqual(result, {
      ok: true,
      path: "docs",
      deletedFiles: 1,
      deletedDirectories: 3
    });
    assert.strictEqual(meta.files["docs/spec/readme.md"], undefined);
    assert.strictEqual(meta.directories["docs"], undefined);
    assert.strictEqual(meta.directories["docs/spec"], undefined);
    assert.strictEqual(meta.directories["docs/empty"], undefined);
    assert.deepStrictEqual(tree, []);
    assert.strictEqual(fileHistory[fileHistory.length - 1].action, "delete");
  });
});
