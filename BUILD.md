# 打包与发布

## Windows 发布目录

执行：

```powershell
bun run build:exe
```

脚本入口：

```text
package.json -> scripts/win/build_exe.ps1
```

输出目录：

```text
dist/win-unpacked/
```

前置条件：

1. 已安装 `bun`（用于 `bun build --compile` 编译，运行时不依赖 Bun）。
2. 已安装 `git`。

当前构建策略：

1. 使用 `bun build --compile` 生成 `agent-society.exe`。
2. 将当前工作区中 **由 git 跟踪且允许发布的文件** 复制到 `dist/win-unpacked/`。
3. **不复制任何未被 git 跟踪的工作区文件**。
4. 按当前发布要求，**不打包 `docs/` 与 `runtime/`**。
5. 额外附带发布运行需要的构建产物，例如 `ffmpeg.exe`。
6. 清理编译阶段生成但不应进入发布目录的临时文件，例如 `start.js.map`。

这样可以保证：

- 本地临时文件、缓存文件、私有配置不会误入发布包。
- git 已管理且允许发布的文件不会漏打。
- 打包范围由脚本统一控制，发布目录内容可重复生成。

构建完成后可检查：

- `dist/win-unpacked/agent-society.exe` 是否存在。
- `dist/win-unpacked/` 中是否未包含 `docs/` 与 `runtime/`。
- 如果本地存在 `node_modules/ffmpeg-static/ffmpeg.exe`，则发布目录根下会附带 `ffmpeg.exe`。

## Windows zip 包

执行：

```powershell
bun run package
```

脚本入口：

```text
package.json -> scripts/win/pack.cmd -> scripts/win/pack.ps1
```

输出目录：

```text
dist/agent-society-时间戳.zip
```

当前打包策略：

1. 先调用 `scripts/win/build_exe.ps1` 生成 `dist/win-unpacked/`。
2. 直接压缩 `dist/win-unpacked/`。
3. 优先使用 7-Zip；未安装时回退到 `Compress-Archive`。

这样做的目的，是避免先复制一整份发布目录再压缩，减少大量小文件的二次复制。

可选参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win/pack.ps1 -OutputName "agent-society-custom"
```

上面的命令会输出 `dist/agent-society-custom.zip`。

## Windows 安装包

前置条件：

1. 已执行 `bun run build:exe`。
2. 已安装 Inno Setup 6 或更高版本。

脚本：

```text
scripts/win/setup.iss
```

生成方式：

1. 在 Inno Setup 中打开 `scripts/win/setup.iss` 后编译。
2. 或在命令行执行 `ISCC scripts/win/setup.iss`。

输出文件：

```text
dist/AgentSociety_Setup.exe
```

当前安装包行为：

- 安装内容直接来自 `dist/win-unpacked/`。
- 快捷方式与安装后首次启动都会向程序传入用户数据目录参数：`"{userdocs}\Agent Society Data"`。
- 安装权限为当前用户级别，不要求管理员权限。

注意：

- `package.json` 中的 `node --run build:installer` 目前只输出提示文本，不会直接调用 Inno Setup 编译器。
