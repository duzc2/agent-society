/**
 * PolicyStore 测试 — 策略存储 v2
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fsp from "node:fs/promises";

import { PolicyStore } from "../../../modules/localcmd/policy_store.js";
import { makeTestLogger } from "../../helpers/test_logger.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

async function makeStoreDir() {
  const dir = path.join(
    PROJECT_ROOT, "test", ".tmp",
    `ps_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// ── 迁移 ──

describe("PolicyStore — 旧格式迁移", () => {
  let store;
  let dataDir;
  let log;

  beforeEach(async () => {
    dataDir = await makeStoreDir();
    log = makeTestLogger("PS-Migrate");
    store = new PolicyStore(dataDir, log);
  });

  afterEach(async () => {
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("旧字符串条目被迁移为 glob 对象并追加 *", async () => {
    await store.setDefaults({
      whitelist: [],
      blacklist: ["rm -rf", "python", "format"]
    });
    const defaults = store.get(null);
    assert.strictEqual(defaults.blacklist.length, 3);
    assert.strictEqual(defaults.blacklist[0].type, "glob");
    assert.strictEqual(defaults.blacklist[0].pattern, "rm -rf*");
    assert.strictEqual(defaults.blacklist[1].type, "glob");
    assert.strictEqual(defaults.blacklist[1].pattern, "python*");
    assert.strictEqual(defaults.blacklist[2].type, "glob");
    assert.strictEqual(defaults.blacklist[2].pattern, "format*");
  });

  it("新 PolicyEntry 对象原样保留", async () => {
    await store.setDefaults({
      whitelist: [{ type: "regex", pattern: "^echo\\s" }],
      blacklist: [{ type: "glob", pattern: "rm*" }]
    });
    const defaults = store.get(null);
    assert.strictEqual(defaults.whitelist[0].type, "regex");
    assert.strictEqual(defaults.whitelist[0].pattern, "^echo\\s");
    assert.strictEqual(defaults.blacklist[0].type, "glob");
    assert.strictEqual(defaults.blacklist[0].pattern, "rm*");
  });

  it("混合旧和新格式同时迁移", async () => {
    await store.setDefaults({
      whitelist: ["git"],
      blacklist: [{ type: "regex", pattern: "^sudo\\s" }, "shutdown"]
    });
    const defaults = store.get(null);
    assert.strictEqual(defaults.whitelist.length, 1);
    assert.strictEqual(defaults.whitelist[0].pattern, "git*");
    assert.strictEqual(defaults.blacklist.length, 2);
    assert.strictEqual(defaults.blacklist[0].type, "regex");
    assert.strictEqual(defaults.blacklist[0].pattern, "^sudo\\s");
    assert.strictEqual(defaults.blacklist[1].type, "glob");
    assert.strictEqual(defaults.blacklist[1].pattern, "shutdown*");
  });

  it("org 策略也走迁移", async () => {
    await store.set("org1", {
      whitelist: ["ls", "cat"],
      blacklist: ["rm"]
    });
    const policy = store.get("org1");
    assert.strictEqual(policy.whitelist[0].pattern, "ls*");
    assert.strictEqual(policy.whitelist[1].pattern, "cat*");
    assert.strictEqual(policy.blacklist[0].pattern, "rm*");
  });

  it("非数组参数返回空数组不报错", async () => {
    await store.setDefaults({ whitelist: null, blacklist: undefined });
    const defaults = store.get(null);
    assert.strictEqual(defaults.whitelist.length, 0);
    assert.strictEqual(defaults.blacklist.length, 0);
  });

  it("空字符串条目被过滤", async () => {
    await store.setDefaults({
      whitelist: ["", "git", ""],
      blacklist: []
    });
    const defaults = store.get(null);
    assert.strictEqual(defaults.whitelist.length, 1);
    assert.strictEqual(defaults.whitelist[0].pattern, "git*");
  });
});

// ── CRUD ──

describe("PolicyStore — CRUD 操作", () => {
  let store;
  let dataDir;

  beforeEach(async () => {
    dataDir = await makeStoreDir();
    store = new PolicyStore(dataDir);
  });

  afterEach(async () => {
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("get(null) 返回默认策略", () => {
    const defaults = store.get(null);
    assert.ok(Array.isArray(defaults.whitelist));
    assert.ok(Array.isArray(defaults.blacklist));
    assert.ok(defaults.blacklist.length > 0);
  });

  it("setDefaults 更新默认策略", async () => {
    await store.setDefaults({
      whitelist: [{ type: "glob", pattern: "go*" }],
      blacklist: [{ type: "glob", pattern: "bad*" }]
    });
    const d = store.get(null);
    assert.strictEqual(d.whitelist[0].type, "glob");
    assert.strictEqual(d.whitelist[0].pattern, "go*");
  });

  it("set/get — 组织独立策略", async () => {
    await store.set("orgA", {
      whitelist: [{ type: "regex", pattern: ".*" }],
      blacklist: []
    });
    const p = store.get("orgA");
    assert.strictEqual(p.whitelist.length, 1);
    assert.strictEqual(p.blacklist.length, 0);
  });

  it("remove — 删除组织策略回退默认", async () => {
    await store.set("orgB", {
      whitelist: [],
      blacklist: [{ type: "glob", pattern: "nuke*" }]
    });
    await store.remove("orgB");
    const p = store.get("orgB");
    // 删除后应回退到默认策略（不是空）
    assert.ok(p.blacklist.length > 0);
  });

  it("getAll 返回所有组织和默认策略", async () => {
    await store.set("orgX", {
      whitelist: [{ type: "glob", pattern: "x*" }],
      blacklist: []
    });
    const all = store.getAll();
    assert.ok(all.orgs.orgX);
    assert.ok(all.defaults.blacklist.length > 0);
  });
});

// ── 读写往返 ──

describe("PolicyStore — 读写往返", () => {
  let dataDir;

  afterEach(async () => {
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("保存→新实例加载，数据一致", async () => {
    dataDir = await makeStoreDir();
    const s1 = new PolicyStore(dataDir);
    await s1.setDefaults({
      whitelist: [{ type: "glob", pattern: "a*" }],
      blacklist: [{ type: "glob", pattern: "b*" }]
    });
    await s1.set("orgT", {
      whitelist: [{ type: "regex", pattern: "^t" }],
      blacklist: []
    });

    const s2 = new PolicyStore(dataDir);
    await s2.load();
    const d = s2.get(null);
    assert.strictEqual(d.whitelist.length, 1);
    assert.strictEqual(d.whitelist[0].pattern, "a*");
    const o = s2.get("orgT");
    assert.strictEqual(o.whitelist[0].type, "regex");
  });

  it("重设默认值后保存并重载正确", async () => {
    dataDir = await makeStoreDir();
    const s1 = new PolicyStore(dataDir);
    await s1.setDefaults({
      whitelist: [],
      blacklist: [{ type: "glob", pattern: "unique123*" }]
    });
    await s1.save();

    const s2 = new PolicyStore(dataDir);
    await s2.load();
    const d = s2.get(null);
    assert.strictEqual(d.blacklist[0].pattern, "unique123*");
  });

  it("删除组织后重新加载正确", async () => {
    dataDir = await makeStoreDir();
    const s1 = new PolicyStore(dataDir);
    await s1.set("toDelete", {
      whitelist: [{ type: "glob", pattern: "tmp*" }],
      blacklist: []
    });
    await s1.remove("toDelete");

    const s2 = new PolicyStore(dataDir);
    await s2.load();
    const all = s2.getAll();
    assert.strictEqual(all.orgs.toDelete, undefined);
  });
});

// ── 验证 ──

describe("PolicyStore — 条目验证", () => {
  let store;
  let dataDir;

  beforeEach(async () => {
    dataDir = await makeStoreDir();
    store = new PolicyStore(dataDir);
  });

  afterEach(async () => {
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("非法 type 被过滤", async () => {
    await store.setDefaults({
      whitelist: [],
      blacklist: [{ type: "invalid", pattern: "bad*" }, { type: "glob", pattern: "good*" }]
    });
    const d = store.get(null);
    assert.strictEqual(d.blacklist.length, 1);
    assert.strictEqual(d.blacklist[0].pattern, "good*");
  });

  it("空 pattern 被过滤", async () => {
    await store.setDefaults({
      whitelist: [{ type: "glob", pattern: "" }, { type: "glob", pattern: "   " }],
      blacklist: []
    });
    const d = store.get(null);
    assert.strictEqual(d.whitelist.length, 0);
  });

  it("null 条目被过滤", async () => {
    await store.setDefaults({
      whitelist: [],
      blacklist: [null, { type: "glob", pattern: "survive*" }, undefined]
    });
    const d = store.get(null);
    assert.strictEqual(d.blacklist.length, 1);
    assert.strictEqual(d.blacklist[0].pattern, "survive*");
  });
});

// ── 向后兼容 ──

describe("PolicyStore — 向后兼容", () => {
  let dataDir;

  afterEach(async () => {
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("旧格式 JSON 文件（字符串数组）加载后自动迁移", async () => {
    dataDir = await makeStoreDir();
    const stateDir = path.join(dataDir, "state");
    await fsp.mkdir(stateDir, { recursive: true });
    const oldData = {
      defaults: {
        whitelist: ["git", "npm"],
        blacklist: ["rm", "shutdown"]
      },
      orgs: {}
    };
    await fsp.writeFile(
      path.join(stateDir, "localcmd_cmdpolicy.json"),
      JSON.stringify(oldData, null, 2),
      "utf8"
    );

    const store = new PolicyStore(dataDir);
    await store.load();
    const d = store.get(null);
    assert.strictEqual(d.whitelist.length, 2);
    assert.strictEqual(d.whitelist[0].type, "glob");
    assert.strictEqual(d.whitelist[0].pattern, "git*");
    assert.strictEqual(d.blacklist[0].type, "glob");
    assert.strictEqual(d.blacklist[0].pattern, "rm*");
  });

  it("损坏的 JSON 文件加载不崩溃，回退到默认", async () => {
    dataDir = await makeStoreDir();
    const stateDir = path.join(dataDir, "state");
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(
      path.join(stateDir, "localcmd_cmdpolicy.json"),
      "{ broken json",
      "utf8"
    );

    const log = makeTestLogger("PS-Compat");
    const store = new PolicyStore(dataDir, log);
    await store.load();
    // 应回退到默认值
    const d = store.get(null);
    assert.ok(d.blacklist.length > 0);
  });
});
