/**
 * LocalFile 模块 — 组织级配置测试
 *
 * 覆盖：
 *   - ConfigManager.getEffectiveFolders（继承+覆盖+新增）
 *   - ConfigManager.getEffectiveLogRetentionDays
 *   - ConfigManager org CRUD 方法
 *   - ConfigManager 惰性清理
 *   - ConfigManager 持久化
 *   - ConfigManager 边界与异常
 *   - PermissionManager orgId 参数
 *   - 向后兼容
 */

import { describe, it, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { makeTestLogger, testLoggerRoot } from "../helpers/test_logger.js";
import { ConfigManager } from "../../modules/localfile/config_manager.js";
import { PermissionManager } from "../../modules/localfile/permission_manager.js";
import localfileModule from "../../modules/localfile/index.js";

// =============================================================================
// 辅助：创建模拟 configService
// =============================================================================

function makeConfigService(initialData = {}) {
  const store = new Map();
  const defaultsMap = new Map();

  function _merge(defaults, data) {
    return { ...defaults, ...data };
  }

  return {
    registerModuleConfig(moduleName, defaults) {
      defaultsMap.set(moduleName, defaults ?? {});
      const existing = store.get(moduleName);
      if (!existing) {
        store.set(moduleName, { ...defaults });
      }
    },
    async getModuleConfig(moduleName) {
      const defaults = defaultsMap.get(moduleName) ?? {};
      const data = store.get(moduleName) ?? {};
      return _merge(defaults, data);
    },
    async saveModuleConfig(moduleName, partialConfig) {
      const defaults = defaultsMap.get(moduleName) ?? {};
      const current = store.get(moduleName) ?? { ...defaults };
      store.set(moduleName, { ...current, ...partialConfig });
      return store.get(moduleName);
    },
    // 用于测试：直接设置存储数据
    _setData(moduleName, data) {
      store.set(moduleName, { ...data });
    },
    _getData(moduleName) {
      return store.get(moduleName) ?? null;
    },
  };
}

// =============================================================================
// 辅助：创建测试文件夹
// =============================================================================

let testDirs = [];

async function makeTestDir() {
  const dir = path.join(os.tmpdir(), `localfile_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

// =============================================================================
// 1.1 ConfigManager — getEffectiveFolders
// =============================================================================

describe("ConfigManager - getEffectiveFolders", () => {
  let configService;
  const log = makeTestLogger("localfile-test");

  async function makeCm(data) {
    configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    return cm;
  }

  beforeEach(() => {
    configService = null;
  });

  it("返回全局文件夹当 orgId 为 null", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "desc" }], logRetentionDays: 30 });
    const result = cm.getEffectiveFolders(null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "f1");
    assert.strictEqual(result[0].path, dir);
  });

  it("返回全局文件夹当 orgId 为 undefined", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 });
    const result = cm.getEffectiveFolders(undefined);
    assert.strictEqual(result.length, 1);
  });

  it("返回全局文件夹当 orgId 为空字符串", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 });
    const result = cm.getEffectiveFolders("");
    assert.strictEqual(result.length, 1);
  });

  it("返回全局文件夹当 org 无 orgConfig 条目", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "global" }], logRetentionDays: 30 });
    const result = cm.getEffectiveFolders("org_not_exists");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "f1");
  });

  it("返回全局文件夹当 org 的 orgConfig.folders 是空数组", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: true, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [], logRetentionDays: 30 } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "f1");
  });

  it("覆盖：org 中有与全局相同路径的 folder → 两个条目标记 overridden+org_override", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, read: true }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    // 全局条目标记 overridden，保留原始值
    assert.strictEqual(result[0].id, "f1");
    assert.strictEqual(result[0]._source, "overridden");
    assert.strictEqual(result[0].read, false);
    // org 条目标记 org_override
    assert.strictEqual(result[1].id, "f2");
    assert.strictEqual(result[1]._source, "org_override");
    assert.strictEqual(result[1].read, true);
    // 各条目保留各自完整字段
    assert.strictEqual(result[0].write, false);
    assert.strictEqual(result[0].description, "global");
  });

  it("覆盖：org 中有与全局相同路径的 folder → 两个条目标记 overridden+org_override (write)", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, write: true }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]._source, "overridden");
    assert.strictEqual(result[1]._source, "org_override");
    assert.strictEqual(result[1].write, true);
  });

  it("覆盖：org 覆盖 description（按路径匹配，两条独立）", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: true, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, description: "org desc" }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]._source, "overridden");
    assert.strictEqual(result[0].description, "global");
    assert.strictEqual(result[1]._source, "org_override");
    assert.strictEqual(result[1].description, "org desc");
  });

  it("覆盖：同时覆盖多个字段（按路径匹配，两条独立）", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, read: true, write: true, description: "org" }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]._source, "overridden");
    assert.strictEqual(result[1]._source, "org_override");
    assert.strictEqual(result[1].read, true);
    assert.strictEqual(result[1].write, true);
    assert.strictEqual(result[1].description, "org");
  });

  it("新增：org 中有全局不存在的 id → 追加到结果末尾", async () => {
    const dir = await makeTestDir();
    const dir2 = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir, read: true, write: false, description: "global" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir2, read: false, write: true, description: "org only" }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, "f1");
    assert.strictEqual(result[1].id, "f2");
    assert.strictEqual(result[1].path, dir2);
  });

  it("混合：同时有覆盖和新增 → 按路径返回独立条目", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const dir3 = await makeTestDir();
    const cm = await makeCm({
      folders: [
        { id: "f1", path: dir1, read: true, write: false, description: "a" },
        { id: "f2", path: dir2, read: false, write: false, description: "b" },
      ],
      logRetentionDays: 30,
      orgConfigs: {
        "org1": {
          folders: [
            { id: "f4", path: dir2, write: true, description: "override b" },
            { id: "f3", path: dir3, read: true, write: true, description: "new c" },
          ]
        }
      }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 4);
    // global f1（无匹配）
    assert.strictEqual(result[0].id, "f1");
    assert.strictEqual(result[0]._source, "global");
    assert.strictEqual(result[0].read, true);
    // global f2（被覆盖）
    assert.strictEqual(result[1].id, "f2");
    assert.strictEqual(result[1]._source, "overridden");
    assert.strictEqual(result[1].write, false);
    // org f4（覆盖 global f2）
    assert.strictEqual(result[2].id, "f4");
    assert.strictEqual(result[2]._source, "org_override");
    assert.strictEqual(result[2].write, true);
    assert.strictEqual(result[2].description, "override b");
    // org 新增 f3
    assert.strictEqual(result[3].id, "f3");
    assert.strictEqual(result[3]._source, "org");
    assert.strictEqual(result[3].path, dir3);
  });

  it("返回的是副本（修改返回值不污染 ConfigManager 内部状态）", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 });
    const result = cm.getEffectiveFolders(null);
    result[0].read = false;
    result[0].path = "/hacked";
    const result2 = cm.getEffectiveFolders(null);
    assert.strictEqual(result2[0].read, true);
    assert.strictEqual(result2[0].path, dir);
  });

  it("多次调用返回一致结果（幂等）", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({ folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 });
    const r1 = cm.getEffectiveFolders(null);
    const r2 = cm.getEffectiveFolders(null);
    assert.strictEqual(r1.length, r2.length);
    assert.strictEqual(r1[0].id, r2[0].id);
    assert.strictEqual(r1[0].read, r2[0].read);
  });

  it("全局 folders 为空，仅有 org 新增 → 仅返回 org 新增", async () => {
    const dir = await makeTestDir();
    const cm = await makeCm({
      folders: [],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f1", path: dir, read: true, write: false, description: "o" }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "f1");
  });

  it("org 覆盖了所有全局 folder → 全部按路径标记 overridden+org_override", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const cm = await makeCm({
      folders: [
        { id: "f1", path: dir1, read: true, write: false, description: "a" },
        { id: "f2", path: dir2, read: false, write: false, description: "b" },
      ],
      logRetentionDays: 30,
      orgConfigs: {
        "org1": {
          folders: [
            { id: "f3", path: dir1, read: false },
            { id: "f4", path: dir2, write: true },
          ]
        }
      }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 4);
    assert.strictEqual(result[0]._source, "overridden");
    assert.strictEqual(result[0].read, true);   // global 原始值保持
    assert.strictEqual(result[1]._source, "overridden");
    assert.strictEqual(result[2]._source, "org_override");
    assert.strictEqual(result[2].read, false);  // org 覆盖值
    assert.strictEqual(result[3]._source, "org_override");
    assert.strictEqual(result[3].write, true);  // org 覆盖值
  });

  it("org 中 folder 路径在全局中不存在 → 不匹配为覆盖，作为新增 (_source=org)", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const cm = await makeCm({
      folders: [{ id: "f1", path: dir1, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir2, read: false, write: true, description: "o" }] } }
    });
    const result = cm.getEffectiveFolders("org1");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]._source, "global");
    assert.strictEqual(result[1].id, "f2");
    assert.strictEqual(result[1]._source, "org");
  });
});

// =============================================================================
// 1.2 ConfigManager — getEffectiveLogRetentionDays
// =============================================================================

describe("ConfigManager - getEffectiveLogRetentionDays", () => {
  let configService;
  const log = makeTestLogger("localfile-test");

  async function makeCm(data) {
    configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    return cm;
  }

  beforeEach(() => {
    configService = null;
  });

  it("orgId 为 null → 返回全局 logRetentionDays", async () => {
    const cm = await makeCm({ folders: [], logRetentionDays: 60 });
    assert.strictEqual(cm.getEffectiveLogRetentionDays(null), 60);
  });

  it("org 无 orgConfig → 返回全局", async () => {
    const cm = await makeCm({ folders: [], logRetentionDays: 90 });
    assert.strictEqual(cm.getEffectiveLogRetentionDays("org_none"), 90);
  });

  it("org 有 orgConfig 但无 logRetentionDays 字段 → 返回全局", async () => {
    const cm = await makeCm({
      folders: [],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [] } }
    });
    assert.strictEqual(cm.getEffectiveLogRetentionDays("org1"), 30);
  });

  it("org 有 orgConfig.logRetentionDays → 返回 org 的值", async () => {
    const cm = await makeCm({
      folders: [],
      logRetentionDays: 30,
      orgConfigs: { "org1": { logRetentionDays: 7 } }
    });
    assert.strictEqual(cm.getEffectiveLogRetentionDays("org1"), 7);
  });
});

// =============================================================================
// 1.3 ConfigManager — addFolderToOrg
// =============================================================================

describe("ConfigManager - addFolderToOrg", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("org 未存在 → 自动创建 orgConfig 条目并添加 folder", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    assert.strictEqual(result.ok, true);
    assert.ok(result.folder, "应有 folder 返回值");
    assert.strictEqual(result.folder.path, dir);
    assert.strictEqual(result.folder.read, true);
    assert.strictEqual(result.folder.write, false);
  });

  it("org 已存在 → 追加 folder 到已有列表", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir1, read: true, write: false });
    const result = await cm.addFolderToOrg("org1", { path: dir2, read: false, write: true });
    assert.strictEqual(result.ok, true);
    const effective = cm.getEffectiveFolders("org1");
    assert.strictEqual(effective.length, 2);
  });

  it("folder 无 id → 自动生成 UUID", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    assert.strictEqual(result.ok, true);
    assert.ok(result.folder.id, "应有自动生成的 id");
    assert.ok(typeof result.folder.id === "string" && result.folder.id.length > 0, "id 应为非空字符串");
  });

  it("路径已存在（同 org 内相同 path）→ 返回 error: path_already_exists", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await cm.addFolderToOrg("org1", { path: dir, read: false, write: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "path_already_exists");
  });

  it("路径不可访问 → 返回 error: path_not_accessible", async () => {
    const result = await cm.addFolderToOrg("org1", { path: "/nonexistent/path/12345", read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "path_not_accessible");
  });

  it("路径为空字符串 → 返回 error: invalid_path", async () => {
    const result = await cm.addFolderToOrg("org1", { path: "", read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("path 不是字符串 → 返回 error: invalid_path", async () => {
    const result = await cm.addFolderToOrg("org1", { path: 123, read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("folderConfig 为 null → 返回 error: invalid_path", async () => {
    const result = await cm.addFolderToOrg("org1", null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("folderConfig 缺少 path → 返回 error: invalid_path", async () => {
    const result = await cm.addFolderToOrg("org1", { read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("默认 read/write 为 false（未提供时）", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg("org1", { path: dir });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.read, false);
    assert.strictEqual(result.folder.write, false);
  });

  it("默认 description 为空字符串", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg("org1", { path: dir });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.description, "");
  });
});

// =============================================================================
// ConfigManager — updateFolderInOrg
// =============================================================================

describe("ConfigManager - updateFolderInOrg", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("更新 org 中存在的 folder 的字段", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir, read: false, write: false, description: "old" });
    const folderId = addResult.folder.id;
    const updateResult = await cm.updateFolderInOrg("org1", folderId, { read: true, description: "new" });
    assert.strictEqual(updateResult.ok, true);
    assert.strictEqual(updateResult.folder.read, true);
    assert.strictEqual(updateResult.folder.description, "new");
    // write 未被修改
    assert.strictEqual(updateResult.folder.write, false);
  });

  it("只更新提供的字段（不覆盖未提供的字段）", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir, read: true, write: true, description: "desc" });
    const folderId = addResult.folder.id;
    const updateResult = await cm.updateFolderInOrg("org1", folderId, {});
    assert.strictEqual(updateResult.ok, true);
    assert.strictEqual(updateResult.folder.read, true);
    assert.strictEqual(updateResult.folder.write, true);
    assert.strictEqual(updateResult.folder.description, "desc");
  });

  it("folder 不存在 → 返回 error: folder_not_found", async () => {
    const result = await cm.updateFolderInOrg("org1", "nonexistent", { read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("org 不存在 → 返回 error: folder_not_found", async () => {
    const result = await cm.updateFolderInOrg("org_nonexistent", "any", { read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("更新 read 为 boolean 值（含 truthy/falsy 转换）", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const folderId = addResult.folder.id;
    // truthy 转换
    const r1 = await cm.updateFolderInOrg("org1", folderId, { read: 1 });
    assert.strictEqual(r1.folder.read, true);
    // falsy 转换
    const r2 = await cm.updateFolderInOrg("org1", folderId, { read: 0 });
    assert.strictEqual(r2.folder.read, false);
  });

  it("更新 write 为 boolean 值", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir, read: false, write: false });
    const folderId = addResult.folder.id;
    const r = await cm.updateFolderInOrg("org1", folderId, { write: "yes" });
    assert.strictEqual(r.folder.write, true);
  });

  it("更新 description 为字符串", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir });
    const folderId = addResult.folder.id;
    const r = await cm.updateFolderInOrg("org1", folderId, { description: "updated desc" });
    assert.strictEqual(r.folder.description, "updated desc");
  });
});

// =============================================================================
// ConfigManager — removeFolderFromOrg
// =============================================================================

describe("ConfigManager - removeFolderFromOrg", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("移除 org 中存在的 folder → 返回 ok", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const folderId = addResult.folder.id;
    const result = await cm.removeFolderFromOrg("org1", folderId);
    assert.strictEqual(result.ok, true);
  });

  it("移除后 getEffectiveFolders 恢复为全局版本", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    // 重建 CM 以加载预置数据
    configService._setData("localfile", {
      folders: [{ id: "gf1", path: dir2, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f1", path: dir1, read: true, write: false }] } }
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    await cm2.removeFolderFromOrg("org1", "f1");
    const effective = cm2.getEffectiveFolders("org1");
    assert.strictEqual(effective.length, 1);
    assert.strictEqual(effective[0].id, "gf1");
  });

  it("folder 不存在 → 返回 error: folder_not_found", async () => {
    const result = await cm.removeFolderFromOrg("org1", "nonexistent");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("org 不存在 → 返回 error: folder_not_found", async () => {
    const result = await cm.removeFolderFromOrg("org_nonexistent", "any");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });
});

// =============================================================================
// ConfigManager — setLogRetentionDaysForOrg
// =============================================================================

describe("ConfigManager - setLogRetentionDaysForOrg", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("设置 org 日志保留天数 → 成功", async () => {
    const result = await cm.setLogRetentionDaysForOrg("org1", 7);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(cm.getEffectiveLogRetentionDays("org1"), 7);
  });

  it("org 不存在 → 自动创建 orgConfig 条目", async () => {
    const result = await cm.setLogRetentionDaysForOrg("new_org", 14);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(cm.getEffectiveLogRetentionDays("new_org"), 14);
  });

  it("days < 1 → 返回 error: invalid_days", async () => {
    const result = await cm.setLogRetentionDaysForOrg("org1", 0);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_days");
  });

  it("days 非数字 → 返回 error: invalid_days", async () => {
    const result = await cm.setLogRetentionDaysForOrg("org1", "abc");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_days");
  });

  it("days 为 NaN → 返回 error: invalid_days", async () => {
    const result = await cm.setLogRetentionDaysForOrg("org1", NaN);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_days");
  });
});

// =============================================================================
// 1.4 ConfigManager — 惰性清理方法
// =============================================================================

describe("ConfigManager - getAllOrgConfigs / removeOrgConfig", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("getAllOrgConfigs 无 org 配置 → 返回空数组", async () => {
    const result = cm.getAllOrgConfigs();
    assert.strictEqual(result.length, 0);
  });

  it("getAllOrgConfigs 返回所有 orgId + config", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    await cm.setLogRetentionDaysForOrg("org2", 7);
    const result = cm.getAllOrgConfigs();
    assert.strictEqual(result.length, 2);
    const org1 = result.find(r => r.orgId === "org1");
    assert.ok(org1, "应包含 org1");
    assert.ok(org1.config.folders, "org1 应有 folders");
    const org2 = result.find(r => r.orgId === "org2");
    assert.ok(org2, "应包含 org2");
    assert.strictEqual(org2.config.logRetentionDays, 7);
  });

  it("removeOrgConfig 移除指定 org → org 从 getAllOrgConfigs 中消失", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await cm.removeOrgConfig("org1");
    assert.strictEqual(result.ok, true);
    const all = cm.getAllOrgConfigs();
    assert.strictEqual(all.length, 0);
  });

  it("removeOrgConfig 移除后 → getEffectiveFolders 返回全局", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    configService._setData("localfile", {
      folders: [{ id: "gf1", path: dir1, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f1", path: dir2, read: true, write: false }] } }
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    await cm2.removeOrgConfig("org1");
    const effective = cm2.getEffectiveFolders("org1");
    assert.strictEqual(effective.length, 1);
    assert.strictEqual(effective[0].id, "gf1");
  });

  it("removeOrgConfig 不存在的 orgId → 正常返回 ok（幂等）", async () => {
    const result = await cm.removeOrgConfig("never_existed");
    assert.strictEqual(result.ok, true);
  });

  it("getAllOrgConfigs 返回的是快照副本（不随后续操作变化）", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const snapshot = cm.getAllOrgConfigs();
    assert.strictEqual(snapshot.length, 1);
    // 修改快照
    snapshot[0].config = { hacked: true };
    // 再次获取不应受影响
    const snapshot2 = cm.getAllOrgConfigs();
    assert.strictEqual(snapshot2[0].config.hacked, undefined);
  });
});

// =============================================================================
// 1.5 ConfigManager — 持久化
// =============================================================================

describe("ConfigManager - 持久化 (_persist)", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("_persist 保存数据包含 orgConfigs", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const saved = configService._getData("localfile");
    assert.ok(saved.orgConfigs, "应包含 orgConfigs");
    assert.ok(saved.orgConfigs.org1, "应包含 org1");
    assert.ok(saved.orgConfigs.org1.folders, "org1 应有 folders");
  });

  it("init 从 configService 正确加载 orgConfigs", async () => {
    const dir = await makeTestDir();
    configService._setData("localfile", {
      folders: [],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }] } }
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    const effective = cm2.getEffectiveFolders("org1");
    assert.strictEqual(effective.length, 1);
    assert.strictEqual(effective[0].id, "f1");
  });

  it("旧配置（无 orgConfigs 字段）→ 正确初始化为空 Map，不报错", async () => {
    configService._setData("localfile", {
      folders: [{ id: "f1", path: await makeTestDir(), read: true, write: false, description: "" }],
      logRetentionDays: 30
      // 没有 orgConfigs
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    const all = cm2.getAllOrgConfigs();
    assert.strictEqual(all.length, 0);
    // 全局功能仍正常
    const effective = cm2.getEffectiveFolders(null);
    assert.strictEqual(effective.length, 1);
  });

  it("org 配置中有无效 folder → init 时过滤掉", async () => {
    const dir = await makeTestDir();
    configService._setData("localfile", {
      folders: [],
      logRetentionDays: 30,
      orgConfigs: {
        "org1": {
          folders: [
            { id: "good", path: dir, read: true, write: false },
            { id: "bad", path: "" },  // 无效
            null,  // 无效
            { id: "no_path" },  // 无效
          ]
        }
      }
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    const effective = cm2.getEffectiveFolders("org1");
    assert.strictEqual(effective.length, 1);
    assert.strictEqual(effective[0].id, "good");
  });

  it("orgConfigs 不是普通对象时 → 安全降级为空 Map", async () => {
    configService._setData("localfile", {
      folders: [],
      logRetentionDays: 30,
      orgConfigs: "not an object"
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    const all = cm2.getAllOrgConfigs();
    assert.strictEqual(all.length, 0);
  });

  it("多 org 配置 → 正确加载和持久化", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    configService._setData("localfile", {
      folders: [{ id: "g1", path: dir1, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: {
        "org1": { folders: [{ id: "o1", path: dir2, read: true, write: true, description: "" }] },
        "org2": { logRetentionDays: 14 }
      }
    });
    const cm2 = new ConfigManager({ configService, log });
    await cm2.init();
    const effective1 = cm2.getEffectiveFolders("org1");
    assert.strictEqual(effective1.length, 2);  // global + org1
    assert.strictEqual(cm2.getEffectiveLogRetentionDays("org2"), 14);
    assert.strictEqual(cm2.getEffectiveLogRetentionDays("org1"), 30);  // 未设置，继承全局
  });
});

// =============================================================================
// 1.6 ConfigManager — 边界与异常
// =============================================================================

describe("ConfigManager - 边界与异常", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("orgId 为超长字符串 → 正常处理", async () => {
    const longId = "x".repeat(1000);
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg(longId, { path: dir, read: true, write: false });
    assert.strictEqual(result.ok, true);
    const effective = cm.getEffectiveFolders(longId);
    assert.strictEqual(effective.length, 1);
  });

  it("orgId 包含特殊字符 → 正常处理", async () => {
    const specialId = "org/with:special@chars!";
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg(specialId, { path: dir, read: true, write: false });
    assert.strictEqual(result.ok, true);
    const effective = cm.getEffectiveFolders(specialId);
    assert.strictEqual(effective.length, 1);
  });

  it("folder path 包含 Unicode → 正常处理", async () => {
    const dir = await makeTestDir();
    const unicodePath = path.join(dir, "中文文件夹");
    await fsp.mkdir(unicodePath, { recursive: true });
    const result = await cm.addFolderToOrg("org1", { path: unicodePath, read: true, write: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.path, unicodePath);
  });

  it("folder description 包含特殊字符 → 正常处理", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolderToOrg("org1", { path: dir, read: true, write: false, description: "<script>alert('xss')</script>" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.description, "<script>alert('xss')</script>");
  });

  it("持久化失败（_persist 抛异常）→ addFolderToOrg 等返回 error", async () => {
    // 创建一个会抛异常的 configService
    const badConfigService = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badConfigService, log });
    await badCm.init();
    const dir = await makeTestDir();
    const result = await badCm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("并发安全性：快速连续操作同一 org 不丢数据", async () => {
    const operations = [];
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const dir3 = await makeTestDir();
    operations.push(cm.addFolderToOrg("org1", { path: dir1, read: true, write: false }));
    operations.push(cm.addFolderToOrg("org1", { path: dir3, read: false, write: true }));
    // dir2 稍等一会确保不同路径
    operations.push(cm.addFolderToOrg("org2", { path: dir2, read: true, write: true }));
    const results = await Promise.all(operations);
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(results[1].ok, true);
    assert.strictEqual(results[2].ok, true);
    // org1 应有 2 个 folder（即使并发）
    const effective = cm.getEffectiveFolders("org1");
    assert.ok(effective.length >= 2, `org1 应有至少 2 个 folder，实际 ${effective.length}`);
  });
});

// =============================================================================
// 1.6b ConfigManager — 全局方法错误路径（覆盖 error return 和 catch block）
// =============================================================================

describe("ConfigManager - 全局方法错误路径", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("addFolder 空路径 → error: invalid_path", async () => {
    const result = await cm.addFolder({ path: "", read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("addFolder 非字符串路径 → error: invalid_path", async () => {
    const result = await cm.addFolder({ path: 123, read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("addFolder 重复路径 → error: path_already_exists", async () => {
    const dir = await makeTestDir();
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await cm.addFolder({ path: dir, read: false, write: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "path_already_exists");
  });

  it("addFolder 不存在路径 → error: path_not_accessible", async () => {
    const result = await cm.addFolder({ path: "/nonexistent/path/99999", read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "path_not_accessible");
  });

  it("addFolder 持久化失败 → error: save_failed", async () => {
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const dir = await makeTestDir();
    const result = await badCm.addFolder({ path: dir, read: true, write: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("updateFolder 不存在 → error: folder_not_found", async () => {
    const result = await cm.updateFolder("nonexistent_id", { read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("updateFolder 持久化失败 → error: save_failed", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolder({ path: dir, read: true, write: false });
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [{ id: addResult.folder.id, path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.updateFolder(addResult.folder.id, { read: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("removeFolder 不存在 → error: folder_not_found", async () => {
    const result = await cm.removeFolder("nonexistent_id");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("removeFolder 持久化失败 → error: save_failed", async () => {
    const dir = await makeTestDir();
    const addResult = await cm.addFolder({ path: dir, read: true, write: false });
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [{ id: addResult.folder.id, path: dir, read: true, write: false, description: "" }], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.removeFolder(addResult.folder.id);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("setLogRetentionDays 无效天数 → error: invalid_days", async () => {
    const r1 = await cm.setLogRetentionDays(0);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "invalid_days");
    const r2 = await cm.setLogRetentionDays("abc");
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error, "invalid_days");
    const r3 = await cm.setLogRetentionDays(-5);
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.error, "invalid_days");
  });

  it("setLogRetentionDays 持久化失败 → error: save_failed", async () => {
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.setLogRetentionDays(7);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });
});

// =============================================================================
// 1.6c ConfigManager — 组织方法错误路径
// =============================================================================

describe("ConfigManager - 组织方法错误路径", () => {
  let configService;
  let cm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
  });

  it("updateFolderInOrg 文件夹不存在(org 存在) → error: folder_not_found", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await cm.updateFolderInOrg("org1", "nonexistent-folder-id", { read: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("updateFolderInOrg 持久化失败 → error: save_failed", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() {
        return {
          folders: [],
          logRetentionDays: 30,
          orgConfigs: { "org1": { folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }] } }
        };
      },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.updateFolderInOrg("org1", "f1", { read: false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("removeFolderFromOrg 文件夹不存在(org 存在) → error: folder_not_found", async () => {
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await cm.removeFolderFromOrg("org1", "nonexistent-folder-id");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "folder_not_found");
  });

  it("removeFolderFromOrg 持久化失败 → error: save_failed", async () => {
    const dir = await makeTestDir();
    configService._setData("localfile", {
      folders: [],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }] } }
    });
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() {
        return {
          folders: [],
          logRetentionDays: 30,
          orgConfigs: { "org1": { folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }] } }
        };
      },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.removeFolderFromOrg("org1", "f1");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("setLogRetentionDaysForOrg 持久化失败 → error: save_failed", async () => {
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() { return { folders: [], logRetentionDays: 30 }; },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.setLogRetentionDaysForOrg("org1", 7);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });

  it("removeOrgConfig 持久化失败 → error: save_failed", async () => {
    const badCs = {
      registerModuleConfig: () => {},
      async getModuleConfig() {
        return { folders: [], logRetentionDays: 30, orgConfigs: { "org1": { folders: [] } } };
      },
      async saveModuleConfig() { throw new Error("persist error"); },
    };
    const badCm = new ConfigManager({ configService: badCs, log });
    await badCm.init();
    const result = await badCm.removeOrgConfig("org1");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "save_failed");
  });
});

// =============================================================================
// 1.7 PermissionManager — orgId 参数
// =============================================================================

describe("PermissionManager - checkReadPermission with orgId", () => {
  const log = makeTestLogger("localfile-test");

  async function makeCmPm(data) {
    const configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    return { cm, pm, configService };
  }

  it("orgId=null → 使用全局 folders", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await pm.checkReadPermission(testFile, null);
    assert.strictEqual(result.allowed, true);
  });

  it("orgId 有效 → 使用 org effective folders", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await pm.checkReadPermission(testFile, "org1");
    assert.strictEqual(result.allowed, true);
  });

  it("org 覆盖全局 folder 为可读（路径匹配）→ 最长路径优先允许读取", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    const { pm } = await makeCmPm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, read: true }] } }
    });
    const result = await pm.checkReadPermission(testFile, "org1");
    // 同路径下 org_override 优先级 > overridden，read=true 生效
    assert.strictEqual(result.allowed, true);
  });

  it("org 覆盖全局 folder 为不可读（路径匹配）→ 最长路径优先拒绝读取", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    const { pm } = await makeCmPm({
      folders: [{ id: "f1", path: dir, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, read: false }] } }
    });
    const result = await pm.checkReadPermission(testFile, "org1");
    // 同路径下 org_override 优先级 > overridden，read=false 生效
    assert.strictEqual(result.allowed, false);
  });

  it("org 独有 folder(可读) → 允许读取", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const result = await pm.checkReadPermission(testFile, "org1");
    assert.strictEqual(result.allowed, true);
  });

  it("org 独有 folder(不可读) → 拒绝读取", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolderToOrg("org1", { path: dir, read: false, write: false });
    const result = await pm.checkReadPermission(testFile, "org1");
    assert.strictEqual(result.allowed, false);
  });

  it("路径不在任何授权 folder 内 → 拒绝", async () => {
    const { pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const result = await pm.checkReadPermission("/some/random/path", "org1");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "access_denied");
  });

  it("无效路径 → 拒绝", async () => {
    const { pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const result = await pm.checkReadPermission(null, "org1");
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "invalid_path");
  });

  it("路径遍历攻击 → 拒绝", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const attackPath = path.join(dir, "..", "..", "etc", "passwd");
    const result = await pm.checkReadPermission(attackPath, "org1");
    assert.strictEqual(result.allowed, false);
  });
});

describe("PermissionManager - checkWritePermission with orgId", () => {
  const log = makeTestLogger("localfile-test");

  async function makeCmPm(data) {
    const configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    return { cm, pm };
  }

  it("orgId=null → 使用全局 folders", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await cm.addFolder({ path: dir, read: false, write: true });
    const result = await pm.checkWritePermission(testFile, null);
    assert.strictEqual(result.allowed, true);
  });

  it("org 覆盖全局 folder 为可写（路径匹配）→ 最长路径优先允许写入", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    const { pm } = await makeCmPm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, write: true }] } }
    });
    const result = await pm.checkWritePermission(testFile, "org1");
    // 同路径下 org_override 优先级 > overridden，write=true 生效
    assert.strictEqual(result.allowed, true);
  });

  it("org 覆盖全局 folder 为不可写（路径匹配）→ 最长路径优先拒绝写入", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    const { pm } = await makeCmPm({
      folders: [{ id: "f1", path: dir, read: false, write: true, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, write: false }] } }
    });
    const result = await pm.checkWritePermission(testFile, "org1");
    // 同路径下 org_override 优先级 > overridden，write=false 生效
    assert.strictEqual(result.allowed, false);
  });

  it("org 独有 folder(可写) → 允许写入", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await cm.addFolderToOrg("org1", { path: dir, read: false, write: true });
    const result = await pm.checkWritePermission(testFile, "org1");
    assert.strictEqual(result.allowed, true);
  });
});

describe("PermissionManager - getPermissionInfo with orgId", () => {
  const log = makeTestLogger("localfile-test");

  async function makeCmPm(data) {
    const configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    return { cm, pm };
  }

  it("正确返回 org 作用域下的 canRead/canWrite", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolderToOrg("org1", { path: dir, read: true, write: false });
    const info = await pm.getPermissionInfo(testFile, "org1");
    assert.strictEqual(info.canRead, true);
    assert.strictEqual(info.canWrite, false);
    assert.ok(info.folder);
  });

  it("org 覆盖后权限正确反映（路径匹配 + 最长路径优先）", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    const { pm } = await makeCmPm({
      folders: [{ id: "f1", path: dir, read: false, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "f2", path: dir, read: true, write: true }] } }
    });
    const info = await pm.getPermissionInfo(testFile, "org1");
    // 同路径下 org_override 优先级 > overridden，以 org 的权限为准
    assert.strictEqual(info.canRead, true);
    assert.strictEqual(info.canWrite, true);
  });

  it("全局+org+新增均有 → 正确匹配最近路径", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const testFile = path.join(dir2, "sub", "test.txt");
    await fsp.mkdir(path.join(dir2, "sub"), { recursive: true });
    await fsp.writeFile(testFile, "hello");
    // 全局有一个宽泛的 dir1 (read=true)，org 新增一个更深的 dir2 (write=true)
    const { cm, pm } = await makeCmPm({
      folders: [{ id: "g1", path: dir1, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "o1", path: dir2, read: false, write: true }] } }
    });
    const info = await pm.getPermissionInfo(testFile, "org1");
    assert.strictEqual(info.canWrite, true);
  });
});

describe("PermissionManager - getAuthorizedFolders with orgId", () => {
  const log = makeTestLogger("localfile-test");

  async function makeCmPm(data) {
    const configService = makeConfigService();
    if (data) {
      configService._setData("localfile", { ...data });
    }
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    return { cm, pm };
  }

  it("orgId=null → 返回全局 folders", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await pm.getAuthorizedFolders(null);
    assert.strictEqual(result.length, 1);
  });

  it("orgId 有效 → 返回 effective folders（合并后）", async () => {
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    const { cm, pm } = await makeCmPm({
      folders: [{ id: "g1", path: dir1, read: true, write: false, description: "" }],
      logRetentionDays: 30,
      orgConfigs: { "org1": { folders: [{ id: "o1", path: dir2, read: false, write: true }] } }
    });
    const result = await pm.getAuthorizedFolders("org1");
    assert.strictEqual(result.length, 2);
  });

  it("返回的是副本", async () => {
    const { cm, pm } = await makeCmPm({ folders: [], logRetentionDays: 30 });
    const dir = await makeTestDir();
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await pm.getAuthorizedFolders(null);
    result[0].read = false;
    const result2 = await pm.getAuthorizedFolders(null);
    assert.strictEqual(result2[0].read, true);
  });
});

// =============================================================================
// 1.7b PermissionManager — 其他方法覆盖（getRelativePath, pathExists, isDirectory, checkListPermission）
// =============================================================================

describe("PermissionManager - checkListPermission", () => {
  const log = makeTestLogger("localfile-test");

  it("checkListPermission 代理到 checkReadPermission", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir = await makeTestDir();
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await pm.checkListPermission(dir);
    assert.strictEqual(result.allowed, true);
  });

  it("checkListPermission 导出拒绝", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = await pm.checkListPermission("/no/access", "org1");
    assert.strictEqual(result.allowed, false);
  });
});

describe("PermissionManager - getPermissionInfo 边界", () => {
  const log = makeTestLogger("localfile-test");

  it("getPermissionInfo null 路径 → canRead/canWrite 均为 false", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const info = await pm.getPermissionInfo(null);
    assert.strictEqual(info.canRead, false);
    assert.strictEqual(info.canWrite, false);
  });
});

describe("PermissionManager - getRelativePath", () => {
  const log = makeTestLogger("localfile-test");

  it("getRelativePath 计算出相对路径", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir = await makeTestDir();
    const subDir = path.join(dir, "sub");
    await fsp.mkdir(subDir, { recursive: true });
    await cm.addFolder({ path: dir, read: true, write: false });
    const rel = pm.getRelativePath(subDir, cm.getFolders()[0].id);
    assert.strictEqual(rel, "sub");
  });

  it("getRelativePath folder 不存在 → null", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = pm.getRelativePath("/some/path", "nonexistent");
    assert.strictEqual(result, null);
  });

  it("getRelativePath 路径不在 folder 内 → null", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir1 = await makeTestDir();
    const dir2 = await makeTestDir();
    await cm.addFolder({ path: dir1, read: true, write: false });
    const result = pm.getRelativePath(dir2, cm.getFolders()[0].id);
    assert.strictEqual(result, null);
  });
});

describe("PermissionManager - pathExists / isDirectory", () => {
  const log = makeTestLogger("localfile-test");

  it("pathExists null 路径 → false", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = await pm.pathExists(null);
    assert.strictEqual(result, false);
  });

  it("pathExists 不存在路径 → false", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = await pm.pathExists("/nonexistent/path/xyz");
    assert.strictEqual(result, false);
  });

  it("pathExists 存在路径 → true", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir = await makeTestDir();
    const result = await pm.pathExists(dir);
    assert.strictEqual(result, true);
  });

  it("isDirectory 目录 → true", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir = await makeTestDir();
    const result = await pm.isDirectory(dir);
    assert.strictEqual(result, true);
  });

  it("isDirectory 文件 → false", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const dir = await makeTestDir();
    const file = path.join(dir, "test.txt");
    await fsp.writeFile(file, "hello");
    const result = await pm.isDirectory(file);
    assert.strictEqual(result, false);
  });

  it("isDirectory null 路径 → false", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = await pm.isDirectory(null);
    assert.strictEqual(result, false);
  });
});

describe("PermissionManager - checkWritePermission 边界", () => {
  const log = makeTestLogger("localfile-test");

  it("checkWritePermission 无效路径 → error: invalid_path", async () => {
    const configService = makeConfigService();
    const cm = new ConfigManager({ configService, log });
    await cm.init();
    const pm = new PermissionManager({ configManager: cm, log });
    const result = await pm.checkWritePermission(null);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "invalid_path");
  });
});

describe("PermissionManager - catch blocks", () => {
  const log = makeTestLogger("localfile-test");

  it("checkReadPermission 内部异常 → error: check_failed", async () => {
    const mockCm = { getEffectiveFolders: () => { throw new Error("boom"); } };
    const pm = new PermissionManager({ configManager: mockCm, log });
    const dir = await makeTestDir();
    const result = await pm.checkReadPermission(path.join(dir, "test.txt"));
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "check_failed");
  });

  it("checkWritePermission 内部异常 → error: check_failed", async () => {
    const mockCm = { getEffectiveFolders: () => { throw new Error("boom"); } };
    const pm = new PermissionManager({ configManager: mockCm, log });
    const dir = await makeTestDir();
    const result = await pm.checkWritePermission(path.join(dir, "test.txt"));
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.error, "check_failed");
  });
});

// =============================================================================
// HTTP Handler — GET /orgs
// =============================================================================

describe("HTTP Handler - GET /orgs", () => {
  let configService;
  let handler;
  let tempDataDir;
  let mockOrg;

  beforeEach(async () => {
    tempDataDir = path.join(os.tmpdir(), `localfile_http_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    testDirs.push(tempDataDir);

    configService = makeConfigService();

    mockOrg = {
      listAgents: () => [],
      getOrgName: (_id) => null,
    };

    const mockRuntime = {
      loggerRoot: testLoggerRoot,
      configService,
      org: mockOrg,
      dataDir: tempDataDir,
    };

    // Shutdown first in case previous test left module in dirty state
    try { await localfileModule.shutdown(); } catch {}

    await localfileModule.init(mockRuntime);
    handler = localfileModule.getHttpHandler();
  });

  afterEach(async () => {
    try { await localfileModule.shutdown(); } catch {}
  });

  function makeReq(method = "GET", url = "/api/modules/localfile/orgs") {
    return { method, url };
  }

  it("空组织列表 → ok + 空数组", async () => {
    mockOrg.listAgents = () => [];
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.orgs, []);
  });

  it("有 root 子智能体 → 返回正确列表", async () => {
    mockOrg.listAgents = () => [
      { id: "org1", parentAgentId: "root", status: "active", name: "组织1" },
      { id: "org2", parentAgentId: "root", status: "active", name: "组织2" },
    ];
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.orgs.length, 2);
    assert.strictEqual(result.orgs[0].orgId, "org1");
    assert.strictEqual(result.orgs[0].orgName, "组织1");
    assert.strictEqual(result.orgs[0].hasConfig, false);
    assert.strictEqual(result.orgs[1].orgId, "org2");
  });

  it("跳过已删除/deleted", async () => {
    mockOrg.listAgents = () => [
      { id: "org1", parentAgentId: "root", status: "active", name: "正常" },
      { id: "org2", parentAgentId: "root", status: "deleted", name: "已删除" },
    ];
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.orgs.length, 1);
    assert.strictEqual(result.orgs[0].orgId, "org1");
  });

  it("跳过非 root 子智能体（孙子智能体不是组织）", async () => {
    mockOrg.listAgents = () => [
      { id: "org1", parentAgentId: "root", status: "active", name: "组织" },
      { id: "agent1", parentAgentId: "org1", status: "active", name: "子智能体" },
    ];
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.orgs.length, 1);
    assert.strictEqual(result.orgs[0].orgId, "org1");
  });

  it("orgName 回退逻辑（getOrgName → name → id）", async () => {
    mockOrg.listAgents = () => [
      { id: "org1", parentAgentId: "root", status: "active" },    // no name field
      { id: "org2", parentAgentId: "root", status: "active", name: "命名组织" },
      { id: "org3", parentAgentId: "root", status: "active", name: "被覆盖" },
    ];
    mockOrg.getOrgName = (id) => {
      if (id === "org3") return "自定义名称";
      return null;
    };
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.orgs[0].orgName, "org1");     // fallback to id
    assert.strictEqual(result.orgs[1].orgName, "命名组织");  // fallback to name
    assert.strictEqual(result.orgs[2].orgName, "自定义名称"); // getOrgName wins
  });

  it("runtime.org 为 null → error（shutdown 后模块）", async () => {
    await localfileModule.shutdown();
    const handler2 = localfileModule.getHttpHandler();
    const result = await handler2(makeReq(), null, ["orgs"]);
    // After shutdown, runtime is null, so the handler returns module_not_initialized
    assert.strictEqual(result.ok, undefined);
    assert.ok(result.error, "应有 error");
  });

  it("listAgents 抛异常 → error", async () => {
    mockOrg.listAgents = () => { throw new Error("org load failure"); };
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, undefined);
    assert.strictEqual(result.error, "list_orgs_failed");
  });

  it("listAgents 返回非数组 → 空 orgs", async () => {
    mockOrg.listAgents = () => "not an array";
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.orgs, []);
  });

  it("hasConfig 字段正确反映配置状态", async () => {
    mockOrg.listAgents = () => [
      { id: "org_configured", parentAgentId: "root", status: "active", name: "已配" },
    ];
    // 通过调用 org-configs API 先给某个 org 添加配置
    const addResult = await handler(
      makeReq("POST", "/api/modules/localfile/org-configs/org_configured/folders"),
      null,
      ["org-configs", "org_configured", "folders"],
      { path: tempDataDir, read: true, write: false }
    );
    assert.strictEqual(addResult.ok, true, "addFolderToOrg 应成功");

    // 重新获取 orgs 列表，验证 hasConfig 和 folderCount
    const result = await handler(makeReq(), null, ["orgs"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.orgs.length, 1);
    assert.strictEqual(result.orgs[0].hasConfig, true);
    assert.strictEqual(result.orgs[0].folderCount, 1);
  });
});

// 清理临时目录
after(async () => {
  for (const dir of testDirs) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
  }
});

// =============================================================================
// 1.8 向后兼容
// =============================================================================

describe("向后兼容", () => {
  let configService;
  let cm;
  let pm;
  const log = makeTestLogger("localfile-test");

  beforeEach(async () => {
    configService = makeConfigService();
    cm = new ConfigManager({ configService, log });
    await cm.init();
    pm = new PermissionManager({ configManager: cm, log });
  });

  it("getFolders() 仍返回全局 folders", async () => {
    const dir = await makeTestDir();
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = cm.getFolders();
    assert.strictEqual(result.length, 1);
  });

  it("getFolder(id) 仍查全局", async () => {
    const dir = await makeTestDir();
    const added = (await cm.addFolder({ path: dir, read: true, write: false })).folder;
    const result = cm.getFolder(added.id);
    assert.ok(result);
    assert.strictEqual(result.id, added.id);
  });

  it("addFolder(config) 仍操作全局", async () => {
    const dir = await makeTestDir();
    const result = await cm.addFolder({ path: dir, read: true, write: false });
    assert.strictEqual(result.ok, true);
    assert.ok(result.folder);
  });

  it("updateFolder(id, updates) 仍操作全局（read）", async () => {
    const dir = await makeTestDir();
    const added = (await cm.addFolder({ path: dir, read: true, write: false, description: "initial" })).folder;
    const result = await cm.updateFolder(added.id, { read: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.read, false);
  });

  it("updateFolder(id, updates) 仍操作全局（write, description）", async () => {
    const dir = await makeTestDir();
    const added = (await cm.addFolder({ path: dir, read: true, write: false, description: "" })).folder;
    const result = await cm.updateFolder(added.id, { write: true, description: "updated" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.folder.write, true);
    assert.strictEqual(result.folder.description, "updated");
  });

  it("removeFolder(id) 仍操作全局", async () => {
    const dir = await makeTestDir();
    const added = (await cm.addFolder({ path: dir, read: true, write: false })).folder;
    const result = await cm.removeFolder(added.id);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(cm.getFolders().length, 0);
  });

  it("setLogRetentionDays(days) 仍操作全局", async () => {
    const result = await cm.setLogRetentionDays(90);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(cm.getLogRetentionDays(), 90);
  });

  it("PermissionManager.checkReadPermission(path) 不传 orgId 仍用全局", async () => {
    const dir = await makeTestDir();
    const testFile = path.join(dir, "test.txt");
    await fsp.writeFile(testFile, "hello");
    await cm.addFolder({ path: dir, read: true, write: false });
    const result = await pm.checkReadPermission(testFile);  // 不传 orgId
    assert.strictEqual(result.allowed, true);
  });
});
