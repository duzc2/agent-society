/**
 * 生产环境 Web 前端构建脚本
 *
 * 用法:
 *   node scripts/build-web.mjs          # 构建 v3 + mobile
 *   node scripts/build-web.mjs v3       # 仅构建 v3
 *   node scripts/build-web.mjs mobile   # 仅构建 mobile
 *
 * 环境要求:
 *   - 会在 web/<target>/ 下执行 npm install，确保依赖就绪
 *   - 设置 NODE_ENV=production 以启用 Vite 生产构建优化
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const TARGETS = {
  v3: resolve(ROOT, "web", "v3"),
  mobile: resolve(ROOT, "web", "mobile"),
};

const args = process.argv.slice(2);
const targets = args.length > 0 ? args.filter((t) => TARGETS[t]) : Object.keys(TARGETS);

if (targets.length === 0) {
  console.error(`未知目标: ${args.join(", ")}`);
  console.error(`可用目标: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

console.log(`\n🛠  生产环境前端构建\n`);
console.log(`目标: ${targets.join(", ")}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "(未设置，将自动设为 production)"}\n`);

let failed = [];

for (const name of targets) {
  const dir = TARGETS[name];
  console.log(`━━━ 构建 ${name} (${dir}) ━━━`);

  try {
    // 1. 安装依赖
    console.log(`[${name}] 安装依赖...`);
    execSync("npm install", { cwd: dir, stdio: "inherit" });

    // 2. 生产构建
    console.log(`[${name}] 开始构建...`);
    execSync("npm run build", {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });

    console.log(`[${name}] ✅ 构建成功\n`);
  } catch (err) {
    console.error(`[${name}] ❌ 构建失败: ${err.message}\n`);
    failed.push(name);
  }
}

console.log(`━━━━━━━━━━━━━━━━━━━━━━━━`);
if (failed.length === 0) {
  console.log(`✅ 全部构建成功 (${targets.length}/${targets.length})`);
  process.exit(0);
} else {
  console.error(`❌ 构建失败: ${failed.join(", ")}`);
  process.exit(1);
}
