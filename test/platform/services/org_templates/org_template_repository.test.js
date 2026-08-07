/**
 * OrgTemplateRepository 单元测试
 *
 * 测试内容：
 * 1. 单层模式（无 userBaseDir）— 向后兼容
 * 2. 双层模式：
 *    - listOrgNames 合并两目录并去重
 *    - readInfo/readOrg 优先读用户层
 *    - writeInfo/writeOrg 写用户层
 *    - createTemplate 创建在用户层，检查与默认层重名
 *    - deleteTemplate：仅默认层拒绝，仅用户层真删，两层都有的删用户层
 * 3. ENOENT 容错
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { promises as fs } from "node:fs";
import { OrgTemplateRepository } from "../../../../src/platform/services/org_templates/org_template_repository.js";
import { makeTestLogger } from "../../../helpers/test_logger.js";

const TEST_DIR = path.resolve("test/.tmp/org_template_repository_test");

function repo(options = {}) {
  return new OrgTemplateRepository({
    baseDir: options.baseDir ?? path.join(TEST_DIR, "org"),
    userBaseDir: options.userBaseDir ?? null,
    logger: makeTestLogger("OrgTemplateRepo")
  });
}

async function mkTemplate(base, orgName, info = "", org = "") {
  const dir = path.join(base, orgName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "info.md"), info, "utf8");
  await fs.writeFile(path.join(dir, "org.md"), org, "utf8");
}

describe("OrgTemplateRepository", () => {

  // ── 单层模式 ──

  describe("单层模式（无 userBaseDir）", () => {
    let r;
    const baseDir = path.join(TEST_DIR, "single");

    beforeEach(async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
      await fs.mkdir(baseDir, { recursive: true });
      r = repo({ baseDir, userBaseDir: null });
    });

    afterEach(async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
    });

    it("listOrgNames 列出空目录返回 []", async () => {
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, []);
    });

    it("listOrgNames 列出目录名", async () => {
      await mkTemplate(baseDir, "my-org");
      await mkTemplate(baseDir, "test_org");
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["my-org", "test_org"]);
    });

    it("listOrgNames 跳过非法目录名", async () => {
      await mkTemplate(baseDir, "valid");
      await fs.mkdir(path.join(baseDir, "has spaces"));
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["valid"]);
    });

    it("readInfo 读取info.md", async () => {
      await mkTemplate(baseDir, "dev", "My Dev Template", "org content");
      const info = await r.readInfo("dev");
      assert.strictEqual(info, "My Dev Template");
    });

    it("readInfo 不存在的模板抛 ENOENT", async () => {
      await assert.rejects(() => r.readInfo("nonexistent"), { code: "ENOENT" });
    });

    it("readOrg 读取org.md", async () => {
      await mkTemplate(baseDir, "dev", "Info", "Org Body");
      const org = await r.readOrg("dev");
      assert.strictEqual(org, "Org Body");
    });

    it("writeInfo 写入info.md", async () => {
      await r.writeInfo("dev", "Updated info");
      const info = await fs.readFile(path.join(baseDir, "dev", "info.md"), "utf8");
      assert.strictEqual(info, "Updated info");
    });

    it("writeOrg 写入org.md", async () => {
      await r.writeOrg("dev", "Updated org");
      const org = await fs.readFile(path.join(baseDir, "dev", "org.md"), "utf8");
      assert.strictEqual(org, "Updated org");
    });

    it("createTemplate 创建新模板", async () => {
      const result = await r.createTemplate("new-org");
      assert.ok(result.ok);
      assert.strictEqual(result.orgName, "new-org");
      const names = await r.listOrgNames();
      assert.ok(names.includes("new-org"));
    });

    it("createTemplate 重复创建抛 EEXIST", async () => {
      await r.createTemplate("dup");
      await assert.rejects(() => r.createTemplate("dup"), { code: "EEXIST" });
    });

    it("deleteTemplate 删除模板", async () => {
      await r.createTemplate("to-delete");
      await r.deleteTemplate("to-delete");
      const names = await r.listOrgNames();
      assert.ok(!names.includes("to-delete"));
    });

    it("deleteTemplate 不存在的模板抛 ENOENT", async () => {
      await assert.rejects(() => r.deleteTemplate("nonexistent"), { code: "ENOENT" });
    });

    it("renameTemplate 重命名模板", async () => {
      await r.createTemplate("old");
      const result = await r.renameTemplate("old", "new");
      assert.ok(result.ok);
      assert.strictEqual(result.orgName, "new");
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["new"]);
    });

    it("renameTemplate 同名不报错", async () => {
      await r.createTemplate("same");
      const result = await r.renameTemplate("same", "same");
      assert.ok(result.ok);
    });

    it("listTemplateInfos 返回info列表", async () => {
      await mkTemplate(baseDir, "a", "Info A");
      await mkTemplate(baseDir, "b", "Info B");
      const infos = await r.listTemplateInfos();
      assert.strictEqual(infos.length, 2);
      assert.strictEqual(infos[0].orgName, "a");
      assert.strictEqual(infos[0].infoMd, "Info A");
      assert.strictEqual(infos[1].orgName, "b");
      assert.strictEqual(infos[1].infoMd, "Info B");
    });

    it("listTemplateInfos 跳过无info.md的模板", async () => {
      // Create directory without info.md
      await fs.mkdir(path.join(baseDir, "no-info"), { recursive: true });
      await mkTemplate(baseDir, "with-info", "Info");
      const infos = await r.listTemplateInfos();
      assert.strictEqual(infos.length, 1);
      assert.strictEqual(infos[0].orgName, "with-info");
    });

    it("isValidOrgName 验证组织名", async () => {
      assert.ok(r.isValidOrgName("test-org"));
      assert.ok(r.isValidOrgName("test_org"));
      assert.ok(r.isValidOrgName("TestOrg123"));
      assert.ok(!r.isValidOrgName("test org"));
      assert.ok(!r.isValidOrgName("test@org"));
      assert.ok(!r.isValidOrgName(123));
      assert.ok(!r.isValidOrgName(null));
    });

    it("非法 orgName 抛 INVALID_ORG_NAME", async () => {
      await assert.rejects(() => r.readInfo("has space"), { code: "INVALID_ORG_NAME" });
      await assert.rejects(() => r.readOrg("has space"), { code: "INVALID_ORG_NAME" });
      await assert.rejects(() => r.writeInfo("has space", "x"), { code: "INVALID_ORG_NAME" });
      await assert.rejects(() => r.writeOrg("has space", "x"), { code: "INVALID_ORG_NAME" });
      await assert.rejects(() => r.createTemplate("has space"), { code: "INVALID_ORG_NAME" });
      await assert.rejects(() => r.deleteTemplate("has space"), { code: "INVALID_ORG_NAME" });
    });

    it("writeInfo 拒绝非字符串", async () => {
      await assert.rejects(() => r.writeInfo("dev", 123), { code: "INVALID_INPUT" });
    });

    it("writeOrg 拒绝非字符串", async () => {
      await assert.rejects(() => r.writeOrg("dev", null), { code: "INVALID_INPUT" });
    });

    it("ENOENT 目录不存在时 listOrgNames 返回 []", async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, []);
    });
  });

  // ── 双层模式 ──

  describe("双层模式（有 userBaseDir）", () => {
    let r;
    const defaultDir = path.join(TEST_DIR, "dual", "org");
    const userDir = path.join(TEST_DIR, "dual", "data", "org");

    beforeEach(async () => {
      await fs.rm(path.join(TEST_DIR, "dual"), { recursive: true, force: true });
      await fs.mkdir(defaultDir, { recursive: true });
      await fs.mkdir(userDir, { recursive: true });
      r = repo({ baseDir: defaultDir, userBaseDir: userDir });
    });

    afterEach(async () => {
      await fs.rm(path.join(TEST_DIR, "dual"), { recursive: true, force: true });
    });

    it("listOrgNames 合并两目录", async () => {
      await mkTemplate(defaultDir, "default-a", "Default A");
      await mkTemplate(userDir, "user-b", "User B");
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["default-a", "user-b"]);
    });

    it("listOrgNames 去重（用户层覆盖默认层）", async () => {
      await mkTemplate(defaultDir, "shared", "Default");
      await mkTemplate(userDir, "shared", "User");
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["shared"]);
    });

    it("listOrgNames 用户层目录不存在时容错", async () => {
      await fs.rm(userDir, { recursive: true, force: true });
      await mkTemplate(defaultDir, "a");
      const names = await r.listOrgNames();
      assert.deepStrictEqual(names, ["a"]);
    });

    it("readInfo 优先读用户层", async () => {
      await mkTemplate(defaultDir, "shared", "Default Info", "Default Org");
      await mkTemplate(userDir, "shared", "User Info", "User Org");
      const info = await r.readInfo("shared");
      assert.strictEqual(info, "User Info");
    });

    it("readInfo 用户层不存在时回退默认层", async () => {
      await mkTemplate(defaultDir, "only-default", "Default Info", "Default Org");
      const info = await r.readInfo("only-default");
      assert.strictEqual(info, "Default Info");
    });

    it("readOrg 优先读用户层", async () => {
      await mkTemplate(defaultDir, "shared", "DI", "DO");
      await mkTemplate(userDir, "shared", "UI", "UO");
      const org = await r.readOrg("shared");
      assert.strictEqual(org, "UO");
    });

    it("readOrg 用户层不存在时回退默认层", async () => {
      await mkTemplate(defaultDir, "only-default", "DI", "DO");
      const org = await r.readOrg("only-default");
      assert.strictEqual(org, "DO");
    });

    it("writeInfo 写到用户层", async () => {
      // Template only exists in default, write should go to user layer
      await mkTemplate(defaultDir, "mixed", "Old Info", "Old Org");
      await r.writeInfo("mixed", "New Info");
      // User layer should have the new content
      const userInfo = await fs.readFile(path.join(userDir, "mixed", "info.md"), "utf8");
      assert.strictEqual(userInfo, "New Info");
      // Default layer should be unchanged
      const defaultInfo = await fs.readFile(path.join(defaultDir, "mixed", "info.md"), "utf8");
      assert.strictEqual(defaultInfo, "Old Info");
    });

    it("writeOrg 写到用户层", async () => {
      await mkTemplate(defaultDir, "mixed", "OI", "OO");
      await r.writeOrg("mixed", "NO");
      const userOrg = await fs.readFile(path.join(userDir, "mixed", "org.md"), "utf8");
      assert.strictEqual(userOrg, "NO");
    });

    it("createTemplate 创建在用户层", async () => {
      const result = await r.createTemplate("new-user-org");
      assert.ok(result.ok);
      assert.strictEqual(result.orgName, "new-user-org");
      const names = await r.listOrgNames();
      assert.ok(names.includes("new-user-org"));
      // Verify it's in user layer
      const userStat = await fs.stat(path.join(userDir, "new-user-org"));
      assert.ok(userStat.isDirectory());
      // Should NOT be in default layer
      await assert.rejects(() => fs.stat(path.join(defaultDir, "new-user-org")), { code: "ENOENT" });
    });

    it("createTemplate 与默认层重名抛 EEXIST", async () => {
      await mkTemplate(defaultDir, "existing", "I", "O");
      await assert.rejects(() => r.createTemplate("existing"), { code: "EEXIST" });
    });

    it("createTemplate 用户层已有同名抛 EEXIST", async () => {
      await mkTemplate(userDir, "existing", "I", "O");
      await assert.rejects(() => r.createTemplate("existing"), { code: "EEXIST" });
    });

    it("deleteTemplate 仅默认层存在时拒绝", async () => {
      await mkTemplate(defaultDir, "builtin", "I", "O");
      await assert.rejects(() => r.deleteTemplate("builtin"), { code: "CANNOT_DELETE_BUILTIN" });
      // Default layer must remain intact
      const dirExists = await fs.stat(path.join(defaultDir, "builtin")).then(s => s.isDirectory()).catch(() => false);
      assert.ok(dirExists);
    });

    it("deleteTemplate 仅用户层存在时删除", async () => {
      await mkTemplate(userDir, "user-only", "I", "O");
      await r.deleteTemplate("user-only");
      const names = await r.listOrgNames();
      assert.ok(!names.includes("user-only"));
    });

    it("deleteTemplate 两层都有时删除用户层，默认模板重新出现", async () => {
      await mkTemplate(defaultDir, "customized", "Default Info", "Default Org");
      await mkTemplate(userDir, "customized", "User Info", "User Org");
      await r.deleteTemplate("customized");
      // After deletion, the default template should reappear
      const names = await r.listOrgNames();
      assert.ok(names.includes("customized"));
      const info = await r.readInfo("customized");
      assert.strictEqual(info, "Default Info");
    });

    it("deleteTemplate 不存在的模板抛 ENOENT", async () => {
      await assert.rejects(() => r.deleteTemplate("nonexistent"), { code: "ENOENT" });
    });

    it("renameTemplate 用户层模板可重命名", async () => {
      await mkTemplate(userDir, "old-name", "I", "O");
      const result = await r.renameTemplate("old-name", "new-name");
      assert.ok(result.ok);
      assert.strictEqual(result.orgName, "new-name");
      const names = await r.listOrgNames();
      assert.ok(names.includes("new-name"));
      assert.ok(!names.includes("old-name"));
    });

    it("renameTemplate 仅默认层模板拒绝", async () => {
      await mkTemplate(defaultDir, "builtin-rename", "I", "O");
      await assert.rejects(() => r.renameTemplate("builtin-rename", "new"), { code: "CANNOT_RENAME_BUILTIN" });
    });

    it("renameTemplate 同名不报错", async () => {
      await mkTemplate(userDir, "same", "I", "O");
      const result = await r.renameTemplate("same", "same");
      assert.ok(result.ok);
    });

    it("_resolveOrgDir 在双层模式下返回用户层路径", () => {
      const dir = r._resolveOrgDir("test-org");
      assert.strictEqual(dir, path.join(userDir, "test-org"));
    });

    it("_resolveOrgDir 在单层模式下返回默认层路径", () => {
      const single = repo({ baseDir: defaultDir, userBaseDir: null });
      const dir = single._resolveOrgDir("test-org");
      assert.strictEqual(dir, path.join(defaultDir, "test-org"));
    });

    it("listTemplateInfos 合并两层info", async () => {
      await mkTemplate(defaultDir, "def", "Default Info", "Default Org content");
      await mkTemplate(userDir, "usr", "User Info", "User Org content");
      const infos = await r.listTemplateInfos();
      assert.strictEqual(infos.length, 2);
      const names = infos.map(t => t.orgName).sort();
      assert.deepStrictEqual(names, ["def", "usr"]);
    });

    it("listTemplateInfos 同名时使用用户层info", async () => {
      await mkTemplate(defaultDir, "shared", "Default Info");
      await mkTemplate(userDir, "shared", "User Info");
      const infos = await r.listTemplateInfos();
      assert.strictEqual(infos.length, 1);
      assert.strictEqual(infos[0].orgName, "shared");
      assert.strictEqual(infos[0].infoMd, "User Info");
    });

    it("_readFile 两层都不存在文件时抛ENOENT", async () => {
      // User layer has dir but no info.md, default layer has no such org
      await fs.mkdir(path.join(userDir, "orphan"), { recursive: true });
      await assert.rejects(() => r._readFile("orphan", "info.md"), {
        code: "ENOENT",
      });
    });

    it("_readFile 仅默认层有文件时正确读取", async () => {
      // User layer has the dir but no org.md inside it
      await fs.mkdir(path.join(userDir, "partial"), { recursive: true });
      await mkTemplate(defaultDir, "partial", "DI", "DO");
      const org = await r._readFile("partial", "org.md");
      assert.strictEqual(org, "DO");
    });
  });
});
