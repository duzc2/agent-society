/**
 * CustomSkillService 测试。
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillsRepository } from "../../../../../src/platform/services/skills/skills_repository.js";
import { CustomSkillService } from "../../../../../src/platform/services/skills/custom/custom_skill_service.js";

const tempDirs = [];

/**
 * 创建测试用服务。
 * @returns {Promise<any>}
 */
async function createFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "custom-skill-"));
  tempDirs.push(rootDir);
  const skillsRepository = new SkillsRepository({ rootDir });
  await skillsRepository.initialize();
  const service = new CustomSkillService({ rootDir, skillsRepository });
  await service.initialize();
  return { rootDir, skillsRepository, service };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("CustomSkillService", () => {
  it("空白创建时应该生成 SKILL.md 并写入索引", async () => {
    const fixture = await createFixture();

    const result = await fixture.service.createCustomSkill({ displayName: "测试技能" });
    const record = await fixture.skillsRepository.getSkill(result.skill.skillId);
    const skillMdPath = path.join(fixture.rootDir, "custom", result.skill.customSkillId, "SKILL.md");
    const skillMd = await readFile(skillMdPath, "utf8");

    assert.strictEqual(record?.sourceType, "custom");
    assert.strictEqual(record?.displayName, "测试技能");
    assert.ok(skillMd.includes("name: 测试技能"));
  });

  it("写文件时应该按路径创建并可再次读取", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.createCustomSkill({ displayName: "写文件技能" });

    await fixture.service.writeCustomSkillFile(result.skill.skillId, "docs/readme.md", "hello world");
    const file = await fixture.service.readCustomSkillFile(result.skill.skillId, "docs/readme.md");

    assert.strictEqual(file?.content, "hello world");
    const tree = await fixture.service.getCustomSkillTree(result.skill.skillId);
    assert.ok(JSON.stringify(tree).includes("docs/readme.md"));
  });

  it("重命名文件时应该迁移路径并保留内容", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.createCustomSkill({ displayName: "重命名技能" });

    await fixture.service.writeCustomSkillFile(result.skill.skillId, "docs/readme.md", "rename me");
    await fixture.service.renameCustomSkillEntry(result.skill.skillId, "docs/readme.md", "docs/guide.md");

    const oldFile = await fixture.service.readCustomSkillFile(result.skill.skillId, "docs/readme.md");
    const newFile = await fixture.service.readCustomSkillFile(result.skill.skillId, "docs/guide.md");

    assert.strictEqual(oldFile, null);
    assert.strictEqual(newFile?.content, "rename me");
  });
});
