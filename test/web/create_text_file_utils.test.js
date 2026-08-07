import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCreateFileName,
  hasWorkspaceEntryNameConflict,
  validateCreateFileBaseName
} from "../../web/v3/src/components/artifacts/createTextFileUtils.ts";

describe("createTextFileUtils", () => {
  it("should build filename with the selected extension", () => {
    assert.strictEqual(buildCreateFileName("notes", "md"), "notes.md");
    assert.strictEqual(buildCreateFileName("script", ".js"), "script.js");
  });

  it("should reject invalid base names for Windows workspace files", () => {
    assert.strictEqual(validateCreateFileBaseName(""), "请输入文件名");
    assert.ok(validateCreateFileBaseName("demo/child").includes("不能包含"));
    assert.strictEqual(validateCreateFileBaseName("demo."), "文件名末尾不能是点或空格");
    assert.strictEqual(validateCreateFileBaseName("valid_name"), "");
  });

  it("should detect duplicate names case-insensitively", () => {
    assert.strictEqual(hasWorkspaceEntryNameConflict(["Readme.md", "docs"], "readme.md"), true);
    assert.strictEqual(hasWorkspaceEntryNameConflict(["Readme.md", "docs"], "DOCS"), true);
    assert.strictEqual(hasWorkspaceEntryNameConflict(["Readme.md", "docs"], "notes.txt"), false);
  });
});
