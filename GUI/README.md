# Agent Society 启动器(GUI)

Tauri 2 桌面引导启动器:无终端窗口启动 Agent Society 服务器(`--no-browser`),启动过程显示透明无边框进度窗,托盘常驻,服务器就绪后自动打开主窗口加载 `http://localhost:{port}/web/`。

## 构建要求

- Rust 工具链(rustup,host = `x86_64-pc-windows-msvc`)
- VS2022(C++ 桌面开发工作负载,MSVC 链接器)
- WebView2 Runtime(Win11 自带)
- 打包时需要系统 PATH 里有 node(供 `scripts/copy-node-sidecar.cmd` 复制)
- tauri-cli:`cargo install tauri-cli --locked`

## 开发运行

```bash
cd GUI/src-tauri
cargo tauri dev          # 或直接 cargo build 后运行 target/debug/agent-society-launcher.exe
```

- dev 模式:服务器子进程用**系统 PATH 的 node**;launcher 自身 debug 构建带控制台(仅开发期)。
- 日志:dev 模式写入 `agents/GUI/logs/launcher.log`(1MB 轮转为 `.old`);服务器 stdout/stderr 以 `[node:stdout]`/`[node:stderr]` 前缀进入同一日志。
- 服务器 PID 记录:`GUI/logs/server.pid`(spawn 时写入,子进程退出时删除)。

## 打包发行

```bash
cd GUI
scripts\copy-node-sidecar.cmd    # 复制系统 node.exe → src-tauri/binaries/node-x86_64-pc-windows-msvc.exe
cd src-tauri
cargo tauri build                # 产出 NSIS 安装包(dist/)
```

- 发行模式:服务器子进程用**包内 sidecar node.exe**(安装目录下的 `node.exe`,绝不静默回退系统 node,缺失则报错并显示在进度窗)。
- NSIS 未签名,SmartScreen 会提示,选"更多信息 → 仍要运行"。

## serverRoot 解析(按优先级)

1. `launcher.json` 的 `serverRoot`(查找顺序:exe 旁 → exe 旁 `config/` → GUI 项目根 `config/`;相对路径按 launcher.json 所在目录解释);
2. 从 exe 所在目录向上 ≤10 层找含 `start-wrapper.mjs` 的目录(开发布局直接命中);
3. 都失败 → 进度窗显示错误(此时可用"重试"按钮在修正配置后重新解析)。

端口取服务器配置:`config/app.local.json` 优先,否则 `config/app.json`,回退 3000(GUI 不传 `--port`,尊重服务器配置)。

## 使用行为

| 操作 | 行为 |
|---|---|
| 启动 | 进度窗(无边框/透明/置顶,不确定态动画+已用时)→ 服务器就绪 → 关闭进度窗、打开主窗口 |
| 主窗口点关闭 | 仅隐藏,进程与服务器继续运行 |
| 托盘右键 | 菜单:打开主界面 / 退出 |
| 托盘双击 | 打开主窗口(Windows 专用事件) |
| 托盘"退出" | 优雅停止服务器(≤60s)→ 退出;若服务器非本 GUI 启动(端口预占),不停止、直接退出 |
| 重复启动 | 单实例:第二个实例立即退出,并唤起已有实例的主窗口 |
| 启动失败 | 进度窗显示原因 + [重试] [退出];原因含服务器输出(launcher.log 有完整输出) |

## 维护者须知(踩过的坑,勿改)

1. **优雅停止 = CTRL_BREAK → SIGBREAK**。Windows 无法向指定 PID 发送真正的 Ctrl+C(CTRL_C_EVENT 不能定向进程组);做法是子进程以 `CREATE_NEW_PROCESS_GROUP` 创建(进程组 id == pid),退出时 `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)`,Node 映射为 SIGBREAK,服务器与 Ctrl+C 走同一条六阶段清理链(`shutdown_manager.js`)。**发送后绝不重发**——服务器收到二次信号会直接 `exit(1)` 跳过剩余清理。
2. **子进程必须有(隐藏)控制台**。实测 `CREATE_NO_WINDOW` 创建的无控制台子进程,CTRL_BREAK"调用成功但不送达"。因此 spawn 用 `CreateProcessW` + `STARTF_USESHOWWINDOW + SW_HIDE`(窗口从创建起隐藏,满足无终端要求)。GUI 自身无控制台(release)时需先 `AttachConsole(pid)` 加入子进程控制台再发信号,然后 `FreeConsole`。
3. **`CREATE_UNICODE_ENVIRONMENT`(0x400)必须设置**。不带此标志时 UTF-16 环境块被按 ANSI 解析,Win11 26200 上直接 `ERROR_INVALID_PARAMETER(87)`;环境块条目还需按字母序(大小写不敏感)排列。
4. 命令行参数含空格时必须按 CRT 规则加引号,否则被切成多个 token。
5. 管道(stdout/stderr)必须持续排空,否则子进程写满 64KB 缓冲后阻塞。
6. 托盘图标对象必须持有在状态里(TrayIcon drop 即消失);`image-png` feature 缺失时开发正常、打包后托盘图标不显示。
7. 主窗口加载远程 URL(`http://localhost:{port}/web/`),不调用任何 Tauri IPC(Tauri 2.11 起远程源强制 ACL,天然隔离)。

## 已知权衡与限制

- **CTRL_BREAK 波及同进程组孙进程**:服务器派生的 Puppeteer Chrome 等会立即终止而非走各自清理(服务器六阶段链对浏览器执行器的关闭有时间容忍)。
- **GUI 被强杀 → 服务器孤儿**:任务管理器强杀 GUI 时子进程不会自动终止。Job Object(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)方案列为后续增强,默认未实现。
- 端口被占用时(GUI 启动前已有服务器),GUI 判定为"外部实例":照常打开主界面,退出时不停止它。

## 测试

```bash
cd GUI/src-tauri
cargo test                 # 24 个单测(含 CTRL_BREAK 送达、spawn 环境/cwd、CreateProcessW 参数)
cargo test -- --ignored    # 集成测试:真实服务器完整优雅关闭链(~20s~1min,需服务器目录可达且端口空闲)
```

单测中的 `ctrl_break_reaches_hidden_console_child` 是本项目最关键的可回归验证:它证明 CTRL_BREAK 能真正送达隐藏控制台 + 新进程组的子进程(而不是"调用成功但不送达")。
