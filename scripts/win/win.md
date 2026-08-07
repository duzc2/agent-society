# win

## 综述

本目录存放 Windows 平台相关脚本，覆盖构建、打包、安装包生成、崩溃取证。

## 文件列表

- `build_exe.ps1`：构建 Windows 发布目录。先编译 `agent-society.exe`，再复制允许发布的 git 跟踪文件，排除 `docs/` 与 `runtime/`，附带必要构建产物，并移除不应进入发布目录的临时文件。
- `pack.ps1`：生成 Windows zip 包。复用 `build_exe.ps1` 的发布目录，直接压缩 `dist/win-unpacked/`，优先使用 7-Zip，未安装时回退到 `Compress-Archive`。
- `pack.cmd`：CMD 入口脚本。职责是以稳定入口转调 `pack.ps1`，统一工作目录，并透传退出码给 `node --run package` 等上层调用方。
- `setup.iss`：Inno Setup 安装脚本。基于 `dist/win-unpacked/` 生成安装包，创建开始菜单与可选桌面快捷方式，并在启动参数中传入用户数据目录。
- `enable-wer-dumps.ps1`：启用 WER LocalDumps。
- `disable-wer-dumps.ps1`：关闭 WER LocalDumps。
- `start-procdump-monitor.ps1`：启动 ProcDump 监控。
- `stop-procdump-monitor.ps1`：停止 ProcDump 监控。
- `export-crash-events.ps1`：导出崩溃时间窗内的事件日志。
- `crash-forensics.md`：崩溃取证操作文档。
- `win.md`：本目录说明文档。

## 子目录列表

- `node.exe/`：现存历史取证目录。当前打包流程不依赖此目录，但如果其中的文件已被 git 跟踪，则会按照 git 跟踪规则进入发布目录。
