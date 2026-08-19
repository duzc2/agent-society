#!/usr/bin/env node
// 皮肤校验与调试工具。
//
// 用法(在 GUI/scripts/ 目录或任意位置运行):
//   node skin-tool.mjs check <skin>   校验指定皮肤(配置/效果图/媒体资源),✅ 通过 / ❌ 失败
//   node skin-tool.mjs list           列出两个皮肤文件夹下的全部皮肤及状态
//   node skin-tool.mjs debug <skin>   校验通过后启动 GUI 皮肤调试模式(真实悬浮窗 + 假数据)
//   node skin-tool.mjs --help         显示本帮助
//
// <skin> 为皮肤技术键:
//   official:<folder>  官方皮肤(GUI/skins/)
//   user:<folder>      用户自定义皮肤(GUI/skins-user/)
//   <folder>           裸文件夹名 = 官方优先,官方无再查用户
//
// 校验规则(与 GUI/src-tauri/src/skin.rs 的解析一致):
//   skin.json 必备:name(1-64 字符)、version(=1)、width/height(5..2000 数字);
//   可选布尔:transparency/alwaysOnTop/shadow/resizable/skipTaskbar(默认 true/true/false/false/true);
//   可选命中区域:hitRegion(shape=ellipse|path,缺省=整窗,详见 skins/README.md 3.1 节);
//   未知字段仅警告。index.html 必备。preview.png 必备且恰好 240x160 PNG。
//   媒体引用(HTML src/href/poster、style 内联 url()、<style> 块、CSS url()/@import、
//   JS fetch()/import()/url() 的相对路径)必须存在且不得逃逸皮肤目录;
//   不允许 "/" 开头的绝对路径与 skin:// / tauri:// 字面量;http(s)/data:/# 放行。
//
// 调试模式(--skin-debug)由 GUI 启动器支持:校验通过后自动启动悬浮窗(exe 缺失时
// 先自动 cargo build);只开皮肤悬浮窗,假数据每 10s 随机变化,不启动服务器/托盘/
// 单实例;右键菜单可切换命中区域覆盖层显示;退出:右键菜单"退出调试" / Esc / 关闭窗口。
//
// 测试: cd GUI/scripts && node --test test/skin-tool.test.mjs(root npm test 的 glob 不覆盖此目录)
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = path.resolve(scriptDir, "..");
const SRC_TAURI = path.join(GUI_ROOT, "src-tauri");
const BUILD_HINT = "请先构建 GUI: cd GUI/src-tauri && cargo build";

export const PREVIEW_WIDTH = 240;
export const PREVIEW_HEIGHT = 160;

// ---------- 参数解析 ----------

export function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { mode: "help" };
  }
  const [mode, skin] = argv;
  if (mode === "list") return { mode: "list" };
  if ((mode === "check" || mode === "debug") && typeof skin === "string" && skin.length > 0) {
    return { mode, skin };
  }
  return null;
}

export function usageText() {
  return [
    "用法: node skin-tool.mjs <check|debug> <skin> | list | --help",
    "  check <skin>  校验皮肤(配置/效果图/媒体资源)",
    "  list          列出两个皮肤文件夹下的全部皮肤",
    "  debug <skin>  校验通过后启动 GUI 皮肤调试模式(悬浮窗 + 假数据)",
    "  <skin> = official:<folder> | user:<folder> | <folder>(裸名官方优先)",
  ].join("\n");
}

// ---------- 路径解析 ----------

export function defaultRoots(guiRoot = GUI_ROOT) {
  return {
    official: path.join(guiRoot, "skins"),
    user: path.join(guiRoot, "skins-user"),
  };
}

const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isFolderName(name) {
  return FOLDER_RE.test(name);
}

/// 解析皮肤键 → { source: "official"|"user"|null, folder, dir }(裸名官方优先)。
export function resolveSkinDir(roots, key) {
  const m = key.match(/^(official|user):(.+)$/);
  if (m) {
    const [, source, folder] = m;
    if (!isFolderName(folder)) return { source: null, folder, dir: null };
    const root = roots[source];
    return { source, folder, dir: root ? path.join(root, folder) : null };
  }
  if (!isFolderName(key)) return { source: null, folder: key, dir: null };
  for (const source of ["official", "user"]) {
    const root = roots[source];
    if (!root) continue;
    const dir = path.join(root, key);
    // 目录存在即命中(哪怕缺 skin.json)——校验要能报"缺少 skin.json"而不是"不存在"
    if (existsSync(dir)) return { source, folder: key, dir };
  }
  return { source: null, folder: key, dir: null };
}

/// 定位 GUI 启动器 exe:target/debug 优先,target/release 兜底。
export function resolveExe(srcTauriDir = SRC_TAURI) {
  for (const profile of ["debug", "release"]) {
    const p = path.join(srcTauriDir, "target", profile, "agent-society-launcher.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- 校验 ----------

const KNOWN_FIELDS = [
  "name",
  "version",
  "width",
  "height",
  "hitRegion",
  "transparency",
  "alwaysOnTop",
  "shadow",
  "resizable",
  "skipTaskbar",
];

function validateSchema(obj) {
  const errors = [];
  const warnings = [];
  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.includes(k)) warnings.push(`未知字段: ${k}`);
  }
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    errors.push("字段 name 缺失或非字符串");
  } else if (obj.name.trim().length > 64) {
    errors.push(`字段 name 超过 64 字符: ${obj.name}`);
  }
  if (obj.version !== 1) {
    errors.push(`字段 version 必须为 1(实际: ${JSON.stringify(obj.version)})`);
  }
  for (const k of ["width", "height"]) {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 5 || v > 2000) {
      errors.push(`字段 ${k} 必须为 5..2000 的数字(实际: ${JSON.stringify(v)})`);
    }
  }
  for (const k of ["transparency", "alwaysOnTop", "shadow", "resizable", "skipTaskbar"]) {
    if (obj[k] !== undefined && typeof obj[k] !== "boolean") {
      errors.push(`字段 ${k} 必须为布尔值(实际: ${JSON.stringify(obj[k])})`);
    }
  }
  const hr = validateHitRegion(obj.hitRegion);
  errors.push(...hr.errors);
  warnings.push(...hr.warnings);
  return { errors, warnings };
}

/// 校验 hitRegion(与启动器 skin.rs 规则一致;path 的 d 只做字符级白名单,
/// 深度语法解析由启动器加载时强校验)。
function validateHitRegion(hr) {
  const errors = [];
  const warnings = [];
  if (hr === undefined) return { errors, warnings };
  if (typeof hr !== "object" || hr === null || Array.isArray(hr)) {
    errors.push("字段 hitRegion 必须是对象");
    return { errors, warnings };
  }
  const knownSub = ["shape", "cx", "cy", "rx", "ry", "d"];
  for (const k of Object.keys(hr)) {
    if (!knownSub.includes(k)) warnings.push(`hitRegion 未知字段: ${k}`);
  }
  const shape = hr.shape;
  if (!["ellipse", "path"].includes(shape)) {
    errors.push(`hitRegion.shape 必须是 "ellipse" 或 "path"(实际: ${JSON.stringify(shape)})`);
    return { errors, warnings };
  }
  if (shape === "ellipse") {
    for (const k of ["cx", "cy", "rx", "ry"]) {
      const v = hr[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`hitRegion.ellipse 字段 ${k} 缺失或非数字(实际: ${JSON.stringify(v)})`);
      }
    }
    for (const k of ["rx", "ry"]) {
      if (typeof hr[k] === "number" && Number.isFinite(hr[k]) && hr[k] <= 0) {
        errors.push(`hitRegion.ellipse 的 ${k} 必须为正数(实际: ${hr[k]})`);
      }
    }
  } else {
    const d = hr.d;
    if (typeof d !== "string" || d.trim().length === 0) {
      errors.push("hitRegion.path 字段 d 缺失或非字符串");
    } else if (!/^[\s,0-9.eE+\-MmLlHhVvZzCcQqAa]+$/.test(d)) {
      errors.push("hitRegion.path 的 d 含非法字符(仅支持数字与 M m L l H h V v Z z C c Q q A a 命令)");
    }
  }
  return { errors, warnings };
}

/// 校验 preview.png:PNG 魔数 + IHDR + 恰好 240x160。返回 null 或错误描述。
export function checkPreview(file) {
  const b = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return "非 PNG 文件(魔数不符)";
  if (b.toString("ascii", 12, 16) !== "IHDR") return "PNG 结构异常(无 IHDR)";
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  if (w !== PREVIEW_WIDTH || h !== PREVIEW_HEIGHT) {
    return `效果图尺寸须为 ${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}(实际: ${w}x${h})`;
  }
  return null;
}

function collectHtmlRefs(html) {
  const refs = [];
  let m;
  const attrRe = /\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi;
  while ((m = attrRe.exec(html))) refs.push(m[2]);
  const styleAttrRe = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
  while ((m = styleAttrRe.exec(html))) {
    refs.push(...collectCssRefs(m[2]));
  }
  const styleBlockRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleBlockRe.exec(html))) {
    refs.push(...collectCssRefs(m[1]));
  }
  return refs;
}

function collectCssRefs(css) {
  const refs = [];
  let m;
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
  while ((m = urlRe.exec(css))) refs.push(m[2]);
  const importRe = /@import\s+(["'])([^"']+)\1/g;
  while ((m = importRe.exec(css))) refs.push(m[2]);
  return refs;
}

function collectJsRefs(js) {
  const refs = [];
  let m;
  const re = /(?:fetch|import|url)\(\s*(["'])([^"']+)\1\s*\)/g;
  while ((m = re.exec(js))) refs.push(m[2]);
  const staticImportRe = /import\s+(["'])([^"']+)\1/g;
  while ((m = staticImportRe.exec(js))) refs.push(m[2]);
  return refs;
}

/// 引用分类:skip(远程/锚点/数据)/error(违规)/check(需存在)。
export function classifyRef(ref) {
  if (/^(https?:|data:|#|\/\/)/i.test(ref)) return { kind: "skip" };
  if (/^(skin|tauri):\/\//i.test(ref)) {
    return { kind: "error", reason: "不允许 skin:// / tauri:// 字面量(皮肤应可移植)" };
  }
  if (ref.startsWith("/")) {
    return { kind: "error", reason: "不允许 \"/\" 开头的绝对路径(skin:// 映射下会失效)" };
  }
  if (ref.includes("\\")) {
    return { kind: "error", reason: "路径请使用 \"/\" 分隔符" };
  }
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return { kind: "skip" };
  const norm = path.posix.normalize(clean);
  if (norm === ".." || norm.startsWith("../")) {
    return { kind: "error", reason: "路径逃逸出皮肤目录" };
  }
  return { kind: "check", file: norm };
}

/// 校验单个皮肤(纯函数,check/debug 共用)。
/// 返回 { ok, errors: string[], warnings: string[], checks: string[] }。
export function validateSkin(roots, key) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const { source, folder, dir } = resolveSkinDir(roots, key);
  if (!source || !dir || !existsSync(dir)) {
    return {
      ok: false,
      errors: [`皮肤不存在: ${key} (官方目录: ${roots.official}, 用户目录: ${roots.user})`],
      warnings,
      checks,
    };
  }
  const label = `${source}:${folder}`;
  checks.push(`✅ ${label} 目录存在`);

  const jsonPath = path.join(dir, "skin.json");
  if (!existsSync(jsonPath)) {
    errors.push(`${label}: 缺少 skin.json`);
  } else {
    checks.push(`✅ ${label} skin.json 存在`);
    let obj;
    try {
      obj = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch (e) {
      return { ok: false, errors: [`${label}: skin.json JSON 解析失败: ${e.message}`], warnings, checks };
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return { ok: false, errors: [`${label}: skin.json 顶层必须是 JSON 对象`], warnings, checks };
    }
    const schema = validateSchema(obj);
    errors.push(...schema.errors.map((e) => `${label}: ${e}`));
    warnings.push(...schema.warnings.map((w) => `${label}: ${w}`));
    if (schema.errors.length === 0) checks.push(`✅ ${label} skin.json 配置合法`);
  }

  if (!existsSync(path.join(dir, "index.html"))) {
    errors.push(`${label}: 缺少 index.html`);
  } else {
    checks.push(`✅ ${label} index.html 存在`);
  }

  const previewPath = path.join(dir, "preview.png");
  if (!existsSync(previewPath)) {
    errors.push(`${label}: 缺少 preview.png`);
  } else {
    const pErr = checkPreview(previewPath);
    if (pErr) errors.push(`${label}: ${pErr}`);
    else checks.push(`✅ ${label} preview.png (${PREVIEW_WIDTH}x${PREVIEW_HEIGHT})`);
  }

  // 媒体引用扫描(仅当 index.html 存在时)
  if (existsSync(path.join(dir, "index.html"))) {
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    const queue = collectHtmlRefs(html);
    const seen = new Set();
    while (queue.length > 0) {
      const ref = queue.shift();
      const cls = classifyRef(ref);
      if (cls.kind === "skip") continue;
      if (cls.kind === "error") {
        errors.push(`${label}: 引用 "${ref}" ${cls.reason}`);
        continue;
      }
      if (seen.has(cls.file)) continue;
      seen.add(cls.file);
      const full = path.join(dir, cls.file);
      if (!existsSync(full)) {
        errors.push(`${label}: 引用文件不存在: ${cls.file}`);
        continue;
      }
      checks.push(`✅ ${label}: ${cls.file}`);
      const ext = path.extname(cls.file).toLowerCase();
      try {
        if (ext === ".css") queue.push(...collectCssRefs(readFileSync(full, "utf8")));
        else if (ext === ".js" || ext === ".mjs") queue.push(...collectJsRefs(readFileSync(full, "utf8")));
      } catch (e) {
        errors.push(`${label}: 读取 ${cls.file} 失败: ${e.message}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}

// ---------- list ----------

/// 枚举两个皮肤文件夹的全部皮肤 → [{ key, name, source, valid, error, preview }]。
export function listSkins(roots) {
  const out = [];
  for (const source of ["official", "user"]) {
    const root = roots[source];
    if (!root || !existsSync(root)) {
      out.push({ header: `${source} 皮肤目录不存在: ${root}` });
      continue;
    }
    out.push({ header: `${source} 皮肤(${root}):` });
    let folders;
    try {
      folders = readdirSync(root).filter((n) => isFolderName(n) && statSync(path.join(root, n)).isDirectory()).sort();
    } catch (e) {
      out.push({ header: `读取目录失败: ${e.message}` });
      continue;
    }
    for (const folder of folders) {
      const res = validateSkin(roots, `${source}:${folder}`);
      let name = folder;
      try {
        const cfg = JSON.parse(readFileSync(path.join(root, folder, "skin.json"), "utf8"));
        if (typeof cfg.name === "string" && cfg.name) name = cfg.name;
      } catch { /* 无效皮肤回退文件夹名 */ }
      out.push({
        key: `${source}:${folder}`,
        name,
        source,
        valid: res.ok,
        error: res.ok ? null : res.errors.join("; "),
        preview: existsSync(path.join(root, folder, "preview.png")) && !res.errors.some((e) => e.includes("preview.png")),
      });
    }
  }
  return out;
}

// ---------- 主入口 ----------

export function main(argv, deps = {}) {
  const {
    roots = defaultRoots(),
    exeResolver = resolveExe,
    spawner = (cmd, args) => spawn(cmd, args, { stdio: "inherit" }),
    builder = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: "inherit" }),
    out = console,
  } = deps;

  const parsed = parseArgs(argv);
  if (!parsed) {
    out.error("参数错误。\n" + usageText());
    return 1;
  }
  if (parsed.mode === "help") {
    out.log(usageText());
    return 0;
  }
  if (parsed.mode === "list") {
    for (const row of listSkins(roots)) {
      if (row.header) {
        out.log(row.header);
        continue;
      }
      const status = row.valid ? "✅" : "❌";
      const preview = row.preview ? "预览 OK" : "预览无效";
      out.log(`  ${status} ${row.key}\t${row.name}\t${preview}${row.error ? "\t" + row.error : ""}`);
    }
    return 0;
  }
  // check / debug
  const res = validateSkin(roots, parsed.skin);
  for (const line of res.checks) out.log(line);
  for (const w of res.warnings) out.log("⚠ " + w);
  for (const e of res.errors) out.error("❌ " + e);
  if (!res.ok) {
    out.error(`❌ 校验未通过(${res.errors.length} 个错误)`);
    return 1;
  }
  out.log(`✅ 校验通过(${res.checks.length} 项检查, ${res.warnings.length} 个警告)`);
  if (parsed.mode !== "debug") return 0;

  // 校验通过后自动拉起 launcher 调试悬浮窗;exe 不存在时先自动 cargo build,
  // 构建成功继续启动,失败才报错退出——全程无需人工启动 launcher。
  let exe = exeResolver();
  if (!exe) {
    out.log("未找到 agent-society-launcher.exe,自动构建: cargo build(src-tauri)");
    const build = builder("cargo", ["build"], SRC_TAURI);
    if (build.status !== 0) {
      out.error("❌ 自动构建失败。" + BUILD_HINT);
      return 1;
    }
    exe = exeResolver();
  }
  if (!exe) {
    out.error("❌ 构建后仍未找到 agent-society-launcher.exe(target/debug 与 target/release 均无)。" + BUILD_HINT);
    return 1;
  }
  out.log(`启动皮肤调试模式: ${exe} --skin-debug ${parsed.skin}`);
  out.log("仅打开皮肤悬浮窗;假数据每 10s 随机变化;不启动服务器/托盘/单实例(可与生产实例并存)。");
  out.log('退出调试:悬浮窗右键菜单"退出调试" / Esc / 关闭窗口。');
  try {
    spawner(exe, ["--skin-debug", parsed.skin]);
  } catch (err) {
    out.error(`❌ 启动失败: ${err && err.message ? err.message : err}`);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
