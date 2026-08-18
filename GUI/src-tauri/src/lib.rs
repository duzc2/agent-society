//! 启动器编排:配置解析 → spawn 服务器子进程 → 就绪轮询 → 守望 → 退出。
//! 步骤 4:进度窗口 + 相位事件 + 失败态(重试/退出)。主窗口/托盘在步骤 5,优雅关闭在步骤 6。

mod commands;
mod config_resolver;
mod logging;
mod readiness;
mod server_launcher;
mod tray;
mod windows;

use logging::FileLogger;
use readiness::PollConfig;
use server_launcher::{RecentOutput, ServerChild};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub enum Phase {
    Starting,
    Ready,
    Failed(String),
    Stopping,
}

impl Phase {
    /// 相位 → (事件名, 附带消息),供进度窗口渲染。
    fn as_event(&self) -> (&'static str, String) {
        match self {
            Phase::Starting => ("starting", String::new()),
            Phase::Ready => ("ready", String::new()),
            Phase::Failed(m) => ("failed", m.clone()),
            Phase::Stopping => ("stopping", String::new()),
        }
    }
}

pub struct LauncherState {
    pub phase: Mutex<Phase>,
    pub child: Mutex<Option<ServerChild>>,
    pub owned: AtomicBool,
    pub port: u16,
    pub server_root: Option<PathBuf>,
    pub recent: RecentOutput,
    pub attempt: AtomicU64,
    /// 托盘图标必须持有,否则 drop 后图标消失
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// 退出序列防重入
    pub quitting: AtomicBool,
}

impl LauncherState {
    fn new(port: u16, server_root: Option<PathBuf>) -> Self {
        LauncherState {
            phase: Mutex::new(Phase::Starting),
            child: Mutex::new(None),
            owned: AtomicBool::new(false),
            port,
            server_root,
            recent: Arc::new(Mutex::new(VecDeque::new())),
            attempt: AtomicU64::new(0),
            tray: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }
}

fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .expect("无法获取 exe 路径")
        .parent()
        .expect("exe 路径无父目录")
        .to_path_buf()
}

/// 设置相位并通知进度窗口;发射失败记日志(UI 事件属于外部通道,允许容错)。
fn set_phase(app: &tauri::AppHandle, state: &LauncherState, phase: Phase) {
    let (name, message) = phase.as_event();
    *state.phase.lock().unwrap() = phase;
    if let Err(e) = app.emit_to(
        "progress",
        "launcher://phase",
        serde_json::json!({ "phase": name, "message": message }),
    ) {
        let logger = app.state::<FileLogger>().inner().clone();
        logger.error(&format!("发射相位事件失败: {}", e), Some(name));
    }
}

/// 采样子进程状态;try_wait 出错时记日志并按"仍存活"处理(轮询超时兜底)。
fn try_wait_child(state: &LauncherState, logger: &FileLogger) -> Option<ExitStatus> {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        None => None,
        Some(c) => c.try_wait(logger),
    }
}

pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须第一个注册(文档要求);二次启动唤起已有实例的主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let state = app.state::<LauncherState>();
            let ready = matches!(&*state.phase.lock().unwrap(), Phase::Ready);
            if ready {
                windows::show_main(app);
            } else {
                let logger = app.state::<FileLogger>().inner().clone();
                logger.info("单实例:忽略二次启动唤起(服务器未就绪)", None);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::launcher_status,
            commands::launcher_retry,
            commands::launcher_exit
        ])
        .setup(|app| {
            let exe_dir = current_exe_dir();
            let is_dev = tauri::is_dev();
            let server_root =
                config_resolver::resolve_server_root(&exe_dir, config_resolver::DEFAULT_MAX_DEPTH);
            let logger = FileLogger::init(is_dev, server_root.as_deref().ok(), &exe_dir);
            logger.info(
                "launcher 启动",
                Some(&format!("dev={} exeDir={}", is_dev, exe_dir.display())),
            );
            match &server_root {
                Ok(r) => logger.info("服务器目录解析成功", Some(&r.display().to_string())),
                Err(e) => logger.error("服务器目录解析失败", Some(e)),
            }
            let (port, source) = match &server_root {
                Ok(r) => config_resolver::resolve_http_port(r),
                Err(_) => (
                    config_resolver::DEFAULT_PORT,
                    "默认(服务器目录未解析)".to_string(),
                ),
            };
            logger.info(
                "HTTP 端口解析",
                Some(&format!("port={} source={}", port, source)),
            );

            app.manage(LauncherState::new(port, server_root.ok()));
            app.manage(logger.clone());

            match windows::create_progress_window(app.handle()) {
                Ok(_) => windows::show_progress(app.handle()),
                Err(e) => logger.error(&format!("创建进度窗口失败: {}", e), None),
            }
            match windows::create_main_window(app.handle(), port) {
                Ok(_) => logger.info("主窗口已创建(隐藏,就绪后显示)", None),
                Err(e) => logger.error(&format!("创建主窗口失败: {}", e), None),
            }
            match tray::create_tray(app.handle()) {
                Ok(icon) => {
                    let state = app.state::<LauncherState>();
                    *state.tray.lock().unwrap() = Some(icon);
                }
                Err(e) => logger.error(&format!("创建托盘失败: {}", e), None),
            }

            launch_attempt(app.handle().clone(), logger);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 两个窗口统一:点关闭 = 隐藏,进程常驻托盘(退出唯一路径是托盘菜单"退出")
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let logger = window.app_handle().state::<FileLogger>().inner().clone();
                if let Err(e) = window.hide() {
                    logger.error(&format!("窗口关闭→隐藏失败: {}", e), None);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

fn launch_attempt(app: tauri::AppHandle, logger: FileLogger) {
    let state = app.state::<LauncherState>();
    let attempt = state.attempt.fetch_add(1, Ordering::SeqCst) + 1;
    logger.info("启动尝试开始", Some(&format!("attempt={}", attempt)));

    let server_root = match state.server_root.as_ref() {
        Some(r) => r.clone(),
        None => {
            let reason = "服务器目录未解析,无法启动服务器(请配置 launcher.json 的 serverRoot)";
            logger.error(reason, None);
            set_phase(&app, &state, Phase::Failed(reason.to_string()));
            return;
        }
    };
    let node = match server_launcher::resolve_node(tauri::is_dev(), &current_exe_dir(), &logger) {
        Ok(n) => n,
        Err(e) => {
            set_phase(&app, &state, Phase::Failed(e.clone()));
            return;
        }
    };
    let child = match server_launcher::spawn_server(&node, &server_root, &logger, &state.recent) {
        Ok(c) => c,
        Err(e) => {
            logger.error("spawn 失败", Some(&e));
            set_phase(&app, &state, Phase::Failed(e));
            return;
        }
    };
    let child_pid = child.id();
    write_server_pid(&app, child_pid);
    *state.child.lock().unwrap() = Some(child);
    state.owned.store(true, Ordering::SeqCst);
    set_phase(&app, &state, Phase::Starting);

    std::thread::spawn(move || monitor_loop(app, logger));
}

fn monitor_loop(app: tauri::AppHandle, logger: FileLogger) {
    let state = app.state::<LauncherState>();
    let port = state.port;

    let mut cfg = PollConfig::default();
    // launcher.json 的 startupTimeoutSec 覆盖(若有)
    if let Some(lc) = config_resolver::find_launcher_config(&current_exe_dir()) {
        if let Ok(parsed) = config_resolver::parse_launcher_config(&lc) {
            if let Some(secs) = parsed.startup_timeout_sec {
                if secs > 0 {
                    cfg.total_timeout = Duration::from_secs(secs.min(3600));
                    logger.info(
                        "启动超时覆盖",
                        Some(&format!("startupTimeoutSec={}", secs)),
                    );
                }
            }
        }
    }

    let mut child_status = || try_wait_child(&state, &logger);
    match readiness::poll_until_terminal(port, &cfg, &mut child_status) {
        readiness::PollOutcome::Ready { owned } => {
            state.owned.store(owned, Ordering::SeqCst);
            set_phase(&app, &state, Phase::Ready);
            windows::hide_progress(&app);
            windows::show_main(&app);
            if owned {
                logger.info("服务器就绪", Some(&format!("port={} owned=true", port)));
                watch_child(app, logger);
            } else {
                logger.info(
                    "端口上已有 Agent Society 服务器(外部实例),本 GUI 退出时不会停止它",
                    Some(&format!("port={}", port)),
                );
            }
        }
        readiness::PollOutcome::Failed(reason) => {
            logger.error("服务器启动失败", Some(&reason));
            set_phase(&app, &state, Phase::Failed(reason));
            windows::show_progress(&app);
        }
        readiness::PollOutcome::Timeout => {
            let reason = "服务器启动超时".to_string();
            logger.error(&reason, Some(&format!("totalTimeout={:?}", cfg.total_timeout)));
            set_phase(&app, &state, Phase::Failed(reason));
            windows::show_progress(&app);
        }
    }
}

/// 就绪后守望。子进程退出不是无条件失败:端口预占场景下,"端口可连"先于
/// "子进程退出判决"到达,会出现短暂的 ReadyOwned → 子进程 exit(0) 序列。
/// 此时按退出码决策表重评估:exit=0 + 可连 + 校验过 → 外部实例(owned=false);
/// 否则 Failed。返回 true 表示已进入终态,无需继续守望。
fn reevaluate_after_child_exit(
    app: &tauri::AppHandle,
    state: &LauncherState,
    logger: &FileLogger,
    st: ExitStatus,
) -> bool {
    let port = state.port;
    let reason: Option<String> = if !st.success() {
        Some(format!(
            "服务器启动失败,退出码 {}",
            st.code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into())
        ))
    } else if !readiness::tcp_probe(port, readiness::PROBE_TIMEOUT) {
        Some("服务器进程立即退出(exit=0),端口未监听".to_string())
    } else if !readiness::http_status_probe(port, readiness::PROBE_TIMEOUT) {
        Some("端口被占用但无法确认是 Agent Society".to_string())
    } else {
        None
    };
    let child_pid = state.child.lock().unwrap().as_ref().map(|c| c.id());
    if let Some(pid) = child_pid {
        remove_server_pid(app, pid);
    }
    match reason {
        Some(r) => {
            logger.error("服务器启动失败", Some(&r));
            set_phase(app, state, Phase::Failed(r));
            windows::show_progress(app);
            true
        }
        None => {
            state.owned.store(false, Ordering::SeqCst);
            set_phase(app, state, Phase::Ready);
            windows::hide_progress(app);
            windows::show_main(app);
            logger.info(
                "端口上已有 Agent Society 服务器(外部实例),本 GUI 退出时不会停止它",
                Some(&format!("port={}", port)),
            );
            true
        }
    }
}

fn watch_child(app: tauri::AppHandle, logger: FileLogger) {
    let state = app.state::<LauncherState>();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if let Some(st) = try_wait_child(&state, &logger) {
            if reevaluate_after_child_exit(&app, &state, &logger, st) {
                return;
            }
        }
    }
}

/// 记录服务器子进程 PID(用户要求:按 PID 发信号前必须先落盘可查)。
fn write_server_pid(app: &tauri::AppHandle, pid: u32) {
    let logger = app.state::<FileLogger>().inner().clone();
    let path = logger.log_dir().join("server.pid");
    match std::fs::write(&path, pid.to_string()) {
        Ok(_) => logger.info(
            "已记录服务器 PID",
            Some(&format!("pid={} file={}", pid, path.display())),
        ),
        Err(e) => logger.error(
            &format!("写入 server.pid 失败: {}", e),
            Some(&path.display().to_string()),
        ),
    }
}

pub(crate) fn remove_server_pid(app: &tauri::AppHandle, pid: u32) {
    let logger = app.state::<FileLogger>().inner().clone();
    let path = logger.log_dir().join("server.pid");
    match std::fs::remove_file(&path) {
        Ok(_) => logger.info("已删除 server.pid", Some(&format!("pid={}", pid))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => logger.error(
            &format!("删除 server.pid 失败: {}", e),
            Some(&path.display().to_string()),
        ),
    }
}

/// 退出序列入口(托盘"退出"/失败界面"退出"共用)。
/// 只停本 GUI 启动的服务器:按 PID 发 CTRL_BREAK → 等优雅关闭(≤60s)→ 超时强杀。
pub fn begin_quit(app: tauri::AppHandle) {
    let state = app.state::<LauncherState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        let logger = app.state::<FileLogger>().inner().clone();
        logger.info("退出序列已在进行中,忽略重复请求", None);
        return;
    }
    set_phase(&app, &state, Phase::Stopping);
    windows::show_progress(&app); // 退出过程显示"正在停止服务器…"
    std::thread::spawn(move || quit_sequence(app)); // 不阻塞事件循环(等待可能长达 60s)
}

fn quit_sequence(app: tauri::AppHandle) {
    let state = app.state::<LauncherState>();
    let logger = app.state::<FileLogger>().inner().clone();

    if state.owned.load(Ordering::SeqCst) {
        if let Some(child) = state.child.lock().unwrap().take() {
            let pid = child.id();
            match child.try_wait(&logger) {
                Some(st) => logger.info(
                    "退出:子进程已退出",
                    Some(&format!("pid={} exit={:?}", pid, st.code())),
                ),
                None => {
                    // ① 直接定向(调用方与子进程同控制台时生效,如 dev 下 GUI 自带控制台)
                    server_launcher::send_ctrl_break_direct(pid, &logger);
                    let evidence = wait_for_signal_evidence(&state, &child, &logger, Duration::from_secs(3));
                    if !evidence {
                        // ② 附加到子进程的隐藏控制台再发(GUI 无控制台时的主路径)
                        server_launcher::send_ctrl_break_via_attach(pid, &logger);
                        let _ = wait_for_signal_evidence(&state, &child, &logger, Duration::from_secs(3));
                    }
                    // 长等待 ≤60s(六阶段清理最坏 ~50s),期间绝不重发:
                    // shutdown_manager.js 收到二次信号会直接 exit(1) 跳过剩余清理
                    let deadline = std::time::Instant::now() + Duration::from_secs(60);
                    loop {
                        match child.try_wait(&logger) {
                            Some(st) => {
                                logger.info(
                                    "服务器优雅退出完成",
                                    Some(&format!("pid={} exit={:?}", pid, st.code())),
                                );
                                break;
                            }
                            None => {
                                if std::time::Instant::now() >= deadline {
                                    server_launcher::force_kill(&child, &logger);
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(500));
                            }
                        }
                    }
                }
            }
            remove_server_pid(&app, pid);
        }
    } else {
        logger.info("退出:服务器非本 GUI 启动,不停止", None);
    }
    logger.info("launcher 退出", None);
    app.exit(0);
}

/// 在窗口期内寻找信号送达证据:子进程退出,或输出出现 SIGBREAK/优雅退出标记。
fn wait_for_signal_evidence(
    state: &LauncherState,
    child: &ServerChild,
    logger: &FileLogger,
    window: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + window;
    loop {
        if let Some(st) = child.try_wait(logger) {
            logger.info(
                "信号送达确认:子进程已退出",
                Some(&format!("exit={:?}", st.code())),
            );
            return true;
        }
        let marker = {
            let recent = state.recent.lock().unwrap();
            recent
                .iter()
                .any(|l| l.contains("SIGBREAK") || l.contains("正在优雅退出"))
        };
        if marker {
            logger.info("信号送达确认:输出出现 SIGBREAK 标记", None);
            return true;
        }
        if std::time::Instant::now() >= deadline {
            logger.warn(
                "窗口期内未见信号送达证据,继续等待退出(不重发,防二次信号强退)",
                Some(&format!("pid={}", child.id())),
            );
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
