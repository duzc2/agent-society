# 构建与发布

本篇覆盖 Web 前端构建、Windows 发布打包、安装包与桌面启动器。项目自带的 `BUILD.md` 与本篇内容一致，可互为参照。

## Web 前端构建

```bash
bun run build:web        # 构建 v3 + mobile
bun run build:v3         # 仅桌面端
bun run build:mobile     # 仅移动端
# 或
node scripts/build-web.mjs [v3|mobile]
```

- 实际执行 `web/<target>/` 下的 Vite 构建（自动先 `npm install` 就绪依赖，`NODE_ENV=production` 启用优化）；
- 产物在 `web/<target>/dist/`，由 HTTP 服务静态提供；
- 开发前端：在 `web/v3/` 下 `npm run dev`（Vite dev server）。

## Windows 发布目录（exe）

前置条件：已安装 bun（仅编译期需要）与 git。

```powershell
bun run build:exe        # → scripts/win/build_exe.ps1
```

输出：`dist/win-unpacked/agent-society.exe` + 随附文件。

打包策略：

1. `bun build --compile` 生成单文件 `agent-society.exe`；
2. 复制**由 git 跟踪且允许发布的文件**到输出目录（未跟踪文件一律不进包）；
3. 不打包：`docs/`、`runtime/`、`agent-society-data*`、`config/`、句点开头的顶层条目；
4. 附带运行所需构建产物（如 `ffmpeg.exe`）；
5. 清理编译临时文件（如 `start.js.map`）。

打包后检查：

- `dist/win-unpacked/agent-society.exe` 存在；
- 输出目录不含上述排除项。

## Windows zip 包

```powershell
bun run package          # → scripts/win/pack.cmd → pack.ps1
```

- 先执行 build_exe 生成 `dist/win-unpacked/`，再压缩为 `dist/agent-society-<时间戳>.zip`；
- 优先用 7-Zip，缺失时回退 `Compress-Archive`；
- 自定义文件名：`powershell -File scripts/win/pack.ps1 -OutputName "agent-society-custom"`。

## Windows 安装包（Inno Setup）

前置：已执行 `bun run build:exe`；已安装 Inno Setup 6+。

```
ISCC scripts/win/setup.iss        # 或在 Inno Setup IDE 编译
# 输出 dist/AgentSociety_Setup.exe
```

安装包行为：

- 内容直接取自 `dist/win-unpacked/`；
- 快捷方式与首次启动向程序传入用户数据目录参数：`{userdocs}\Agent Society Data`；
- 按当前用户级安装，不需管理员权限。

> `package.json` 的 `build:installer` 只输出提示，不会调用 ISCC。

## 桌面启动器（GUI/）

`GUI/` 是 Tauri 2 桌面引导器：无终端窗口启动服务器、托盘常驻、启动进度窗、服务器就绪后打开主窗口与悬浮监视窗。

```bash
# 开发
cd GUI/src-tauri && cargo tauri dev

# 打包（NSIS 安装包 → GUI/src-tauri/dist/）
cd GUI && scripts\copy-node-sidecar.cmd   # 复制系统 node.exe 为 sidecar
cd src-tauri && cargo tauri build
```

要点：

- 发行模式用**包内 sidecar node.exe**，缺失即报错，绝不静默回退系统 node；
- 服务器目录解析：从 exe 向上 ≤10 层找含 `start-wrapper.mjs` 的目录；
- 端口读服务器配置（app.local.json → app.json → 3000），启动器不传 `--port`；
- 详细说明见 `GUI/README.md`。

## 版本与协议

- 版本号在 `package.json`；
- 许可证 Apache License 2.0（`LICENSE`）。

## 发布核对清单

1. [ ] `npm test` 全绿
2. [ ] `npm run lint` / `npm run typecheck` 通过
3. [ ] `bun run build:web` 成功，`web/*/dist/` 已更新
4. [ ] `bun run build:exe` 成功，输出目录核对通过
5. [ ] 安装包/启动器在干净环境人工验证
