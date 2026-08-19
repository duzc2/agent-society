# Agent Society 启动器(GUI)

Tauri 2 桌面引导启动器:无终端窗口启动 Agent Society 服务器(`--no-browser`),启动过程显示透明无边框进度窗,托盘常驻,服务器就绪后自动打开主窗口加载 `http://localhost:{port}/web/`,并显示悬浮监视窗(服务器状态 + 智能体总数/工作中数)。

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
| 启动 | 进度窗(无边框/透明/置顶,不确定态动画+已用时)→ 服务器就绪 → 关闭进度窗、打开主窗口与监视窗 |
| 监视窗口 | 悬浮(无边框/透明/置顶/可拖动),停靠主屏工作区右上角:服务器状态 + 智能体总数 + 工作中数;外观与窗口结构由**皮肤**决定(GUI/skins/ 官方 + GUI/skins-user/ 用户自定义,launcher.json 的 monitorSkin 选择);关闭=隐藏,托盘菜单"监视窗口"可再显隐;右键弹出与托盘**完全相同**的菜单(同一份内容与行为定义) |
| 设置窗口 | 托盘/监视窗右键菜单"设置"打开:皮肤**两列平铺**展示(240x160 效果图 + 名称 + 来源角标),选中点"应用"**立即生效**并持久化到 launcher.json;关闭=隐藏 |
| 主窗口点关闭 | 仅隐藏,进程与服务器继续运行 |
| 托盘右键 | 菜单:打开主界面 / 监视窗口 / 退出 |
| 托盘双击 | 打开主窗口(Windows 专用事件) |
| 托盘"退出" | 优雅停止服务器(≤60s)→ 退出;若服务器非本 GUI 启动(端口预占),不停止、直接退出 |
| 重复启动 | 单实例:第二个实例立即退出,并唤起已有实例的主窗口 |
| 启动失败 | 进度窗显示原因 + [重试] [退出];原因含服务器输出(launcher.log 有完整输出) |
| 服务器运行中(心跳) | 就绪后每秒探一次 127.0.0.1:{port}:连接成功=存活;连接超时(服务器繁忙 backlog 满)=容忍;连续 3 次"连接被拒绝"=端口已关闭 → **启动器自动退出** |

## 维护者须知(踩过的坑,勿改)

1. **优雅停止 = CTRL_BREAK → SIGBREAK**。Windows 无法向指定 PID 发送真正的 Ctrl+C(CTRL_C_EVENT 不能定向进程组);做法是子进程以 `CREATE_NEW_PROCESS_GROUP` 创建(进程组 id == pid),退出时 `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)`,Node 映射为 SIGBREAK,服务器与 Ctrl+C 走同一条六阶段清理链(`shutdown_manager.js`)。**发送后绝不重发**——服务器收到二次信号会直接 `exit(1)` 跳过剩余清理。
2. **子进程必须有(隐藏)控制台**。实测 `CREATE_NO_WINDOW` 创建的无控制台子进程,CTRL_BREAK"调用成功但不送达"。因此 spawn 用 `CreateProcessW` + `STARTF_USESHOWWINDOW + SW_HIDE`(窗口从创建起隐藏,满足无终端要求)。GUI 自身无控制台(release)时需先 `AttachConsole(pid)` 加入子进程控制台再发信号,然后 `FreeConsole`。
3. **`CREATE_UNICODE_ENVIRONMENT`(0x400)必须设置**。不带此标志时 UTF-16 环境块被按 ANSI 解析,Win11 26200 上直接 `ERROR_INVALID_PARAMETER(87)`;环境块条目还需按字母序(大小写不敏感)排列。
4. 命令行参数含空格时必须按 CRT 规则加引号,否则被切成多个 token。
5. 管道(stdout/stderr)必须持续排空,否则子进程写满 64KB 缓冲后阻塞。
6. 托盘图标对象必须持有在状态里(TrayIcon drop 即消失);`image-png` feature 缺失时开发正常、打包后托盘图标不显示。
7. 主窗口加载远程 URL(`http://localhost:{port}/web/`),不调用任何 Tauri IPC(Tauri 2.11 起远程源强制 ACL,天然隔离)。
8. **心跳的"繁忙容错"判别**:实测 std 在 Windows 上对被拒连接报 `TimedOut` 而非 `ConnectionRefused`(阻塞 connect 也要 ~2s 才报真实错误)。因此三态探测在连接失败后用"能否 bind 该端口"二次判别:bind 成功 = 无监听者(Down);bind 失败 = 端口被占(Busy,容忍)。不要改回只靠 connect 错误类型判断。
9. **监视数据来源 = 心跳消息队列,不是 REST 端点**。智能体计数来自 `POST /api/heartbeat`(body `{"lastMessageId":N}`)响应中的 `org_tree` 消息(服务器 HeartbeatBroker,无客户端状态):客户端记住最大 messageId 增量拉取,`needRefresh=true` 时归零重取(服务器重启序列号重置)。计数口径:`total` = 组织树中 `status != "deleted"` 的节点(含 root/user);`working` = `computeStatus ∈ {processing, waiting_llm}`(stopping/stopped/terminating 是消亡过渡态不计入)。
10. **心跳响应的实体是 chunked 编码**:实测 Hono/Node 对大 JSON 响应给 `Transfer-Encoding: chunked`(无 Content-Length),读体前必须按 chunked 解码(monitor.rs 的 `decode_http_body` 已处理 chunked / Content-Length / 无定界三种)。不要假定 read_to_end 拿到的是裸 JSON。
11. **监视窗口 2s 轮询与退出判定的 1s 心跳是两条独立线程**:HTTP 失败只降级为"保留上次数据"(繁忙容忍),绝不触发退出判定;退出只由三态 TCP 探测的连续 Down 计数决定。修改时不要把两者合并。
12. **Windows 透明窗口白底 = Tauri 2 的缺陷,已用 vendor tao 补丁修复**:Tauri 2(tao 0.35)从不给 tao 传 no_redirection_bitmap,透明窗口走旧式 `DwmEnableBlurBehindWindow` 空区域 hack(tao window.rs:1284),在 Win11(26200)上渲染成**白底**。修复方式:`GUI/src-tauri/vendor/tao/` 是 tao 0.35.3 的本地副本,唯一改动在 `platform_impl/windows/window.rs`(init 处,带 PATCH 注释):`no_redirection_bitmap || attributes.transparent`——transparent 窗口**创建时**即带 `WS_EX_NOREDIRECTIONBITMAP`,同时让 blur hack 根本不执行。**关键事实:该位事后用 `SetWindowLongPtrW` 设置会被 Windows 静默忽略**(实测读回不变),必须创建时带;升级 tauri/tao 时核对上游是否已修复,修复后删除 vendor 目录与 Cargo.toml 的 `[patch.crates-io]`。`shadow(false)` 一并设置在两个透明窗口上(避免 DWM 边框扩展干扰)。
13. **退出时 stderr 的 `Failed to unregister class Chrome_WidgetWin_0. Error = 1412` 是无害的**:1412 = ERROR_CLASS_HAS_WINDOWS,Chromium/WebView2 退出时类注销与窗口销毁的跨线程竞态(与透明补丁无关,已用 A/B 实验证实补丁禁用后仍出现;Electron/CEF 应用同款)。进程退出时 OS 回收一切,无功能影响;release 无控制台,最终用户不可见。不建议为消除它改动退出序列。
14. **皮肤系统关键事实(换肤 = 重建窗口,勿改)**:
    - **皮肤身份 = 来源 + 文件夹名**(`official:x`/`user:x`),JSON 无 id;集合由 `GUI/skins/`(git)与 `GUI/skins-user/`(gitignore)子文件夹**动态枚举**,无索引文件;同名文件夹允许并存。皮肤必备 skin.json + preview.png(恰好 240x160)+ index.html;数据经 `window` 的 CustomEvent **`dateUpdate`**(eval 注入,皮肤页不依赖 Tauri API);右键菜单由启动器在 `on_page_load` 统一注入(ui/monitor.js 无自带 contextmenu)。
    - **skin:// 协议**:`register_uri_scheme_protocol` 必须在 `.run()` 前注册;URL 必须 `skin://localhost/<source>/<folder>/...`(wry 导航时改写为 `http://skin.localhost/...`,拦截时 revert 回原样,handler 跨平台统一收到 skin:// 形式);路径安全靠文件夹名白名单 + 拒绝 `.`/`..`/`\`/`:` 段 + 双重 canonicalize + starts_with。
    - **运行时换肤必须重建监视窗**:transparency/阴影等是窗口创建时参数(WS_EX_NOREDIRECTIONBITMAP 创建后设置被静默忽略,见第 12 条),apply_skin = 关旧窗 → 按新配置建新窗(label 不变)→ 恢复可见性;数据经 last_monitor_payload 补发不丢帧。
    - **monitorSkin 持久化**:apply 时 read-modify-write launcher.json(保留其他键、tmp+rename 原子覆盖);写失败仅影响下次启动,本次会话仍生效。
    - **调试模式**(`--skin-debug <key>`):跳过单实例插件(与生产实例并存)/托盘/服务器;假数据循环每 10s 随机(server 三态轮换);退出 = 右键"退出调试"/Esc/关窗;`begin_quit` 有 debug 守卫直退。校验/调试工具:`node GUI/scripts/skin-tool.mjs check|list|debug <skin>`,其测试 `cd GUI/scripts && node --test test/skin-tool.test.mjs`(root npm test glob 不覆盖此目录)。
15. **监视窗口右键菜单 = 托盘菜单的共用实现,四个坑都实测踩过**:
    - **共用方式**:菜单内容与点击行为各只有一处定义(`tray.rs` 的 `build_menu` / `handle_menu_event`)。popup 每次重建菜单实例(muda::Menu 内部是 `Rc<RefCell>` 非 Send,不能放进 managed state)。点击分发**不要**为 popup 另行注册——托盘 `on_menu_event` 注册的是全局监听器(tauri tray/mod.rs 注释:"called for any menu event, ... from the tray icon menu"),popup 点击自动走同一分发,再注册会双份触发。
    - **popup 必须是 async 命令**:同步命令在 invoke 到达的主线程上内联执行(tauri-macros body_blocking: `let result = $path(...)`),而 build_menu/popup_menu 内部的 `run_item_main_thread!` 是"向主线程投递 + 阻塞等待"——主线程上调用等于自己等自己,永久死锁(实测整个主线程冻结、后续所有 IPC 排队)。async 命令跑在 async_runtime 线程池,投递-等待的双方不在同一线程。tauri 官方 menu 插件的 popup 命令同为 async,同一原因。
    - **菜单定位用 `popup_menu_at` + JS 传的点击坐标**(`event.clientX/Y` → `LogicalPosition`,muda 内部做 DPI 转换 + ClientToScreen,钉在点击点)。不要用无参 `popup_menu`(内部 `GetCursorPos` 定位):右键后用户光标一动,菜单就弹到错误位置。
    - **重入守卫**:菜单开着时再次右键,新 invoke 的 popup 任务会被 TrackPopupMenu 的 modal loop 泵出 → 嵌套菜单级联。`commands.rs` 里 `POPUP_ACTIVE` 原子布尔在弹出期间忽略后续请求。
    - **测试教训**:本机(Win11 26200)上跨进程 `EnumWindows` 枚举不到任何菜单窗口(阳性对照:同一进程内确定开着的 TrackPopupMenu 菜单,跨进程枚举不可见)——菜单可见性无法用跨进程窗口枚举验证,应以"弹出持续时间日志(modal loop 时长)+ 用户实际操作"为证据。

## 已知权衡与限制

- **CTRL_BREAK 波及同进程组孙进程**:服务器派生的 Puppeteer Chrome 等会立即终止而非走各自清理(服务器六阶段链对浏览器执行器的关闭有时间容忍)。
- **GUI 被强杀 → 服务器孤儿**:任务管理器强杀 GUI 时子进程不会自动终止。Job Object(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)方案列为后续增强,默认未实现。
- 端口被占用时(GUI 启动前已有服务器),GUI 判定为"外部实例":照常打开主界面,退出时不停止它。

## 测试

```bash
cd GUI/src-tauri
cargo test                 # 单测(CTRL_BREAK 送达、spawn 环境/cwd、心跳三态探测、org_tree 计数、chunked 解码、皮肤解析/协议/换肤等)
cargo test -- --ignored    # 集成测试:真实服务器完整优雅关闭链(~20s~1min,需服务器目录可达且端口空闲)
cd ../scripts && node --test test/skin-tool.test.mjs   # 皮肤校验工具单测(root npm test 的 glob 不覆盖此目录)
```

单测中的 `ctrl_break_reaches_hidden_console_child` 是本项目最关键的可回归验证:它证明 CTRL_BREAK 能真正送达隐藏控制台 + 新进程组的子进程(而不是"调用成功但不送达")。
