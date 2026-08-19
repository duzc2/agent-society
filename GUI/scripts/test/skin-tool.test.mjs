// skin-tool.mjs 单元测试。运行: cd GUI/scripts && node --test test/skin-tool.test.mjs
// (root npm test 的 glob `test/**/*.test.js` 不覆盖此目录;该命令已在 skins/README.md 记录)
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  resolveSkinDir,
  validateSkin,
  checkPreview,
  classifyRef,
  resolveExe,
  listSkins,
  main,
  usageText,
} from "../skin-tool.mjs";

// ---------- 工具 ----------

function tempRoots() {
  const base = mkdtempSync(path.join(os.tmpdir(), "skin-tool-test-"));
  const official = path.join(base, "skins");
  const user = path.join(base, "skins-user");
  mkdirSync(official, { recursive: true });
  mkdirSync(user, { recursive: true });
  return { official, user, base };
}

/// 生成合法 PNG(240x160 或指定尺寸)
function makePng(w = 240, h = 160) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h); // filter 0 + 全透明 RGBA
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeSkin(roots, source, folder, { json, html, assets = {}, preview = true } = {}) {
  const dir = path.join(roots[source], folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "skin.json"),
    json ?? JSON.stringify({ name: "测试皮肤", version: 1, width: 300, height: 112 }),
  );
  writeFileSync(path.join(dir, "index.html"), html ?? "<html><body></body></html>");
  if (preview) writeFileSync(path.join(dir, "preview.png"), makePng());
  for (const [rel, content] of Object.entries(assets)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// ---------- 参数解析 ----------

test("parseArgs 各形态", () => {
  assert.deepEqual(parseArgs([]), { mode: "help" });
  assert.deepEqual(parseArgs(["--help"]), { mode: "help" });
  assert.deepEqual(parseArgs(["check", "classic"]), { mode: "check", skin: "classic" });
  assert.deepEqual(parseArgs(["debug", "user:x"]), { mode: "debug", skin: "user:x" });
  assert.deepEqual(parseArgs(["list"]), { mode: "list" });
  assert.equal(parseArgs(["check"]), null);
  assert.equal(parseArgs(["bogus", "x"]), null);
  assert.ok(usageText().includes("check"));
});

// ---------- 键解析与同名皮肤 ----------

test("resolveSkinDir 同名皮肤两文件夹并存(裸名官方优先)", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "classic");
  makeSkin(roots, "user", "classic");
  assert.equal(resolveSkinDir(roots, "classic").source, "official");
  assert.equal(resolveSkinDir(roots, "user:classic").source, "user");
  assert.equal(resolveSkinDir(roots, "official:classic").source, "official");
  // 官方无、用户有 → 裸名回退用户
  const rootsNoOfficial = { official: path.join(roots.base, "skins-none"), user: roots.user };
  assert.equal(resolveSkinDir(rootsNoOfficial, "classic").source, "user");
  assert.equal(resolveSkinDir(roots, "nope").source, null);
  assert.equal(resolveSkinDir(roots, "bad/name").source, null);
});

// ---------- schema 校验 ----------

test("最小合法皮肤通过(缺省布尔)", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", { json: JSON.stringify({ name: "x", version: 1, width: 240, height: 88 }) });
  const res = validateSkin(roots, "s1");
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.warnings.length, 0);
});

test("全字段合法皮肤通过", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", {
    json: JSON.stringify({
      name: "x", version: 1, width: 300, height: 112,
      transparency: true, alwaysOnTop: false, shadow: true, resizable: true, skipTaskbar: false,
    }),
  });
  assert.equal(validateSkin(roots, "s1").ok, true);
});

test("schema 各非法分支", () => {
  const cases = [
    [JSON.stringify({ version: 1, width: 300, height: 112 }), "name"],
    [JSON.stringify({ name: "", version: 1, width: 300, height: 112 }), "name"],
    [JSON.stringify({ name: "x", width: 300, height: 112 }), "version"],
    [JSON.stringify({ name: "x", version: 2, width: 300, height: 112 }), "version"],
    [JSON.stringify({ name: "x", version: "1", width: 300, height: 112 }), "version"],
    [JSON.stringify({ name: "x", version: 1, height: 112 }), "width"],
    [JSON.stringify({ name: "x", version: 1, width: "300", height: 112 }), "width"],
    [JSON.stringify({ name: "x", version: 1, width: 4, height: 112 }), "width"],
    [JSON.stringify({ name: "x", version: 1, width: 2001, height: 112 }), "width"],
    [JSON.stringify({ name: "x", version: 1, width: 300, height: null }), "height"],
    [JSON.stringify({ name: "x", version: 1, width: 300, height: 112, transparency: "yes" }), "transparency"],
  ];
  for (const [json, field] of cases) {
    const roots = tempRoots();
    makeSkin(roots, "official", "s1", { json });
    const res = validateSkin(roots, "s1");
    assert.equal(res.ok, false, json);
    assert.ok(res.errors.some((e) => e.includes(field)), `${json} 应提及 ${field}: ${res.errors.join("; ")}`);
  }
});

test("边界 5 与 2000 合法", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", { json: JSON.stringify({ name: "x", version: 1, width: 5, height: 2000 }) });
  assert.equal(validateSkin(roots, "s1").ok, true);
});

test("未知字段仅警告", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", {
    json: JSON.stringify({ name: "x", version: 1, width: 300, height: 112, fancy: true }),
  });
  const res = validateSkin(roots, "s1");
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.includes("fancy")), res.warnings.join("; "));
});

test("hitRegion 合法(椭圆/路径)", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", {
    json: JSON.stringify({
      name: "x", version: 1, width: 200, height: 200,
      hitRegion: { shape: "ellipse", cx: 100, cy: 100, rx: 88, ry: 88 },
    }),
  });
  const res1 = validateSkin(roots, "s1");
  assert.equal(res1.ok, true, res1.errors.join("; "));
  assert.equal(res1.warnings.length, 0);
  makeSkin(roots, "official", "s2", {
    json: JSON.stringify({
      name: "x", version: 1, width: 200, height: 200,
      hitRegion: { shape: "path", d: "M 0 0 H 200 V 200 H 0 Z" },
    }),
  });
  assert.equal(validateSkin(roots, "s2").ok, true);
});

test("hitRegion 各非法分支", () => {
  const cases = [
    [5, "hitRegion 必须是对象"],
    [{}, "hitRegion.shape"],
    [{ shape: "rect" }, "hitRegion.shape"],
    [{ shape: "ellipse" }, "hitRegion.ellipse"],
    [{ shape: "ellipse", cx: 1, cy: 1, rx: 1 }, "hitRegion.ellipse"],
    [{ shape: "ellipse", cx: "a", cy: 1, rx: 1, ry: 1 }, "hitRegion.ellipse"],
    [{ shape: "ellipse", cx: 1, cy: 1, rx: -1, ry: 1 }, "必须为正数"],
    [{ shape: "ellipse", cx: 1, cy: 1, rx: 0, ry: 1 }, "必须为正数"],
    [{ shape: "path" }, "hitRegion.path"],
    [{ shape: "path", d: "" }, "hitRegion.path"],
    [{ shape: "path", d: "M 0 0 X 1" }, "非法字符"],
  ];
  for (const [hr, needle] of cases) {
    const roots = tempRoots();
    makeSkin(roots, "official", "s1", {
      json: JSON.stringify({ name: "x", version: 1, width: 200, height: 200, hitRegion: hr }),
    });
    const res = validateSkin(roots, "s1");
    assert.equal(res.ok, false, JSON.stringify(hr));
    assert.ok(
      res.errors.some((e) => e.includes(needle)),
      `${JSON.stringify(hr)} 应提及 ${needle}: ${res.errors.join("; ")}`,
    );
  }
});

test("hitRegion 未知子字段仅警告", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", {
    json: JSON.stringify({
      name: "x", version: 1, width: 200, height: 200,
      hitRegion: { shape: "ellipse", cx: 1, cy: 1, rx: 1, ry: 1, extra: true },
    }),
  });
  const res = validateSkin(roots, "s1");
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.includes("extra")), res.warnings.join("; "));
});

test("皮肤目录不存在 / skin.json 缺失或损坏 / 顶层非对象", () => {
  const roots = tempRoots();
  assert.equal(validateSkin(roots, "ghost").ok, false);
  makeSkin(roots, "official", "nojson", {});
  // 删除 skin.json
  // rmSync 已从顶部导入
  rmSync(path.join(roots.official, "nojson", "skin.json"));
  assert.ok(validateSkin(roots, "nojson").errors.some((e) => e.includes("skin.json")));
  makeSkin(roots, "official", "badjson", { json: "not json{" });
  assert.ok(validateSkin(roots, "badjson").errors.some((e) => e.includes("JSON 解析失败")));
  makeSkin(roots, "official", "arrjson", { json: "[1,2]" });
  assert.ok(validateSkin(roots, "arrjson").errors.some((e) => e.includes("对象")));
});

test("index.html 缺失", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1");
  // rmSync 已从顶部导入
  rmSync(path.join(roots.official, "s1", "index.html"));
  assert.ok(validateSkin(roots, "s1").errors.some((e) => e.includes("index.html")));
});

// ---------- preview 校验 ----------

test("preview.png 缺失/非 PNG/尺寸不符", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "noimg", { preview: false });
  assert.ok(validateSkin(roots, "noimg").errors.some((e) => e.includes("preview.png")));
  makeSkin(roots, "official", "notpng", { preview: true });
  writeFileSync(path.join(roots.official, "notpng", "preview.png"), "hello not a png");
  assert.ok(validateSkin(roots, "notpng").errors.some((e) => e.includes("魔数")));
  makeSkin(roots, "official", "badsize", { preview: true });
  writeFileSync(path.join(roots.official, "badsize", "preview.png"), makePng(100, 100));
  assert.ok(validateSkin(roots, "badsize").errors.some((e) => e.includes("240x160")));
  // checkPreview 直接调用
  const tmp = path.join(roots.base, "p.png");
  writeFileSync(tmp, makePng());
  assert.equal(checkPreview(tmp), null);
});

// ---------- 媒体引用扫描 ----------

test("媒体引用:存在/缺失/逃逸/绝对/远程", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "s1", {
    html: '<link rel="stylesheet" href="assets/style.css"><img src="img/bg.png">'
      + '<img src="https://example.com/x.png"><img src="data:image/png;base64,xx"><a href="#top">x</a>',
    assets: {
      "assets/style.css": "body { background: url('img/bg.png'); } @import 'extra.css';",
      "img/bg.png": "fake",
      "extra.css": "/* ok */",
    },
  });
  const res = validateSkin(roots, "s1");
  assert.equal(res.ok, true, res.errors.join("; "));

  makeSkin(roots, "official", "missing", {
    html: '<img src="nope.png">',
  });
  assert.ok(validateSkin(roots, "missing").errors.some((e) => e.includes("nope.png")));

  makeSkin(roots, "official", "escape", {
    html: '<img src="../secret.png">',
  });
  assert.ok(validateSkin(roots, "escape").errors.some((e) => e.includes("逃逸")));

  makeSkin(roots, "official", "absolute", {
    html: '<img src="/img/bg.png">',
  });
  assert.ok(validateSkin(roots, "absolute").errors.some((e) => e.includes("绝对路径")));

  makeSkin(roots, "official", "skinlit", {
    html: '<img src="skin://localhost/official/s1/x.png">',
  });
  assert.ok(validateSkin(roots, "skinlit").errors.some((e) => e.includes("skin://")));

  makeSkin(roots, "official", "backslash", {
    html: '<img src="img\\bg.png">',
  });
  assert.ok(validateSkin(roots, "backslash").errors.some((e) => e.includes("/")));

  // classifyRef 单元
  assert.equal(classifyRef("https://a/b.png").kind, "skip");
  assert.equal(classifyRef("data:image/png;base64,x").kind, "skip");
  assert.equal(classifyRef("#top").kind, "skip");
  assert.equal(classifyRef("a/b.png").kind, "check");
  assert.equal(classifyRef("a/b.png?v=2").file, "a/b.png");
});

// ---------- resolveExe ----------

test("resolveExe debug 优先 release 兜底", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "skin-tool-exe-"));
  const srcTauri = path.join(base, "src-tauri");
  // 两者皆无 → null
  assert.equal(resolveExe(srcTauri), null);
  // 只有 release
  const rel = path.join(srcTauri, "target", "release", "agent-society-launcher.exe");
  mkdirSync(path.dirname(rel), { recursive: true });
  writeFileSync(rel, "fake");
  assert.equal(resolveExe(srcTauri), rel);
  // 有 debug 优先
  const dbg = path.join(srcTauri, "target", "debug", "agent-society-launcher.exe");
  mkdirSync(path.dirname(dbg), { recursive: true });
  writeFileSync(dbg, "fake");
  assert.equal(resolveExe(srcTauri), dbg);
});

// ---------- list ----------

test("listSkins 汇总两个来源", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "classic", { json: JSON.stringify({ name: "经典卡片", version: 1, width: 300, height: 112 }) });
  makeSkin(roots, "user", "classic", { json: JSON.stringify({ name: "经典卡片(自定义)", version: 1, width: 300, height: 112 }) });
  makeSkin(roots, "official", "broken", { json: "not json{" });
  const rows = listSkins(roots);
  const classicOfficial = rows.find((r) => r.key === "official:classic");
  assert.equal(classicOfficial.name, "经典卡片");
  assert.equal(classicOfficial.valid, true);
  const classicUser = rows.find((r) => r.key === "user:classic");
  assert.equal(classicUser.name, "经典卡片(自定义)");
  const broken = rows.find((r) => r.key === "official:broken");
  assert.equal(broken.valid, false);
  assert.equal(broken.name, "broken"); // 无效时回退文件夹名
});

// ---------- main(注入依赖) ----------

function captureOut() {
  const lines = [];
  return { log: (...a) => lines.push(["log", a.join(" ")]), error: (...a) => lines.push(["err", a.join(" ")]), lines };
}

test("main check 合法/非法退出码", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "good");
  const okOut = captureOut();
  assert.equal(main(["check", "good"], { roots, out: okOut }), 0);
  const badOut = captureOut();
  assert.equal(main(["check", "ghost"], { roots, out: badOut }), 1);
  assert.ok(badOut.lines.some(([t, s]) => t === "err" && s.includes("皮肤不存在")));
});

test("main debug:缺 exe 自动构建后启动;构建失败/spawn 异常 → 1;有 exe 直接启动", () => {
  const roots = tempRoots();
  makeSkin(roots, "official", "good");
  // 模拟 detached 子进程对象:unref 被调用(工具退出后调试实例应继续存活)
  const fakeChild = () => ({ unref: () => { unrefCalls++; } });
  let unrefCalls = 0;

  // exe 缺失 → 自动 cargo build → 构建成功 → 用新探测到的 exe 启动
  const spawned = [];
  const built = [];
  let probe = 0;
  assert.equal(
    main(["debug", "good"], {
      roots,
      exeResolver: () => (++probe === 1 ? null : "fake.exe"),
      builder: (cmd, args) => { built.push({ cmd, args }); return { status: 0 }; },
      spawner: (cmd, args) => { spawned.push({ cmd, args }); return fakeChild(); },
      out: captureOut(),
    }),
    0,
  );
  assert.deepEqual(built, [{ cmd: "cargo", args: ["build"] }]);
  assert.deepEqual(spawned, [{ cmd: "fake.exe", args: ["--skin-debug", "good"] }]);
  assert.equal(unrefCalls, 1, "spawn 后必须 unref,工具退出时调试实例才能存活");

  // 构建失败 → 1 + 构建指引
  const outFail = captureOut();
  assert.equal(
    main(["debug", "good"], {
      roots,
      exeResolver: () => null,
      builder: () => ({ status: 1 }),
      spawner: () => { throw new Error("不应启动"); },
      out: outFail,
    }),
    1,
  );
  assert.ok(outFail.lines.some(([t, s]) => t === "err" && s.includes("cargo build")));

  // exe 存在 → 直接启动,不构建
  const spawned2 = [];
  const built2 = [];
  assert.equal(
    main(["debug", "good"], {
      roots,
      exeResolver: () => "fake.exe",
      builder: () => { built2.push(1); return { status: 0 }; },
      spawner: (cmd, args) => { spawned2.push({ cmd, args }); return fakeChild(); },
      out: captureOut(),
    }),
    0,
  );
  assert.equal(built2.length, 0);
  assert.deepEqual(spawned2, [{ cmd: "fake.exe", args: ["--skin-debug", "good"] }]);

  // spawn 抛异常(如 ENOENT)→ 1,不崩
  assert.equal(
    main(["debug", "good"], {
      roots,
      exeResolver: () => "fake.exe",
      spawner: () => { throw new Error("ENOENT"); },
      out: captureOut(),
    }),
    1,
  );

  // 校验不过 → 不构建不启动
  const spawned3 = [];
  const built3 = [];
  assert.equal(
    main(["debug", "ghost"], {
      roots,
      exeResolver: () => "fake.exe",
      builder: () => { built3.push(1); return { status: 0 }; },
      spawner: () => spawned3.push(1),
      out: captureOut(),
    }),
    1,
  );
  assert.equal(built3.length, 0);
  assert.equal(spawned3.length, 0);
});

test("main 参数错误与 help", () => {
  assert.equal(main(["bogus"], { out: captureOut() }), 1);
  assert.equal(main(["--help"], { out: captureOut() }), 0);
});
