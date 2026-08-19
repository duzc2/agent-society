//! 启动器编排:配置解析 → spawn 服务器子进程 → 就绪轮询 → 守望 → 退出。
//! 步骤 4:进度窗口 + 相位事件 + 失败态(重试/退出)。主窗口/托盘在步骤 5,优雅关闭在步骤 6。

mod commands;
mod config_resolver;
mod hit_region;
#[cfg(windows)]
mod hit_test;
mod logging;
mod monitor;
mod readiness;
mod server_launcher;
mod skin;
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
    /// 当前皮肤技术键(如 "official:classic";回退时为 "embedded")
    pub current_skin: Mutex<String>,
    /// 最近一次监视数据 payload(监视窗页面加载后补发,防首帧丢失)
    pub last_monitor_payload: Mutex<Option<serde_json::Value>>,
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
            current_skin: Mutex::new("embedded".to_string()),
            last_monitor_payload: Mutex::new(None),
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
    let debug_skin = skin::parse_debug_args(std::env::args());
    skin::set_debug(debug_skin.is_some());
    let skin_roots = skin::SkinRoots::resolve(&current_exe_dir());
    let roots_for_setup = skin_roots.clone();

    let mut builder = tauri::Builder::default();
    if debug_skin.is_some() {
        // 调试模式:不注册单实例插件(可与生产实例并存)、不建托盘;
        // popup 菜单点击经全局监听器分发("debug_quit" → 直接退出)
        builder = builder.on_menu_event(|app, event| {
            if event.id().as_ref() == "debug_quit" {
                app.exit(0);
            } else if event.id().as_ref() == "debug_toggle_hit_overlay" {
                // 切换覆盖层显示并把新状态推给调试页面(页面侧 svg.style.display 跟随)
                let visible = skin::toggle_hit_overlay();
                if let Err(e) = app.emit_to(
                    "monitor",
                    "hit-overlay-toggle",
                    serde_json::json!({ "visible": visible }),
                ) {
                    let logger = app.state::<FileLogger>().inner().clone();
                    logger.error(&format!("发射覆盖层开关事件失败: {}", e), Some("hit_overlay"));
                }
            }
        });
    } else {
        // 单实例插件必须第一个注册(文档要求);二次启动唤起已有实例的主窗口
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let state = app.state::<LauncherState>();
            let ready = matches!(&*state.phase.lock().unwrap(), Phase::Ready);
            if ready {
                windows::show_main(app);
            } else {
                let logger = app.state::<FileLogger>().inner().clone();
                logger.info("单实例:忽略二次启动唤起(服务器未就绪)", None);
            }
        }));
    }
    // skin:// 协议必须在 .run() 前注册;作用于所有 webview(设置窗口预览图同用)
    builder = builder.register_uri_scheme_protocol(skin::SKIN_SCHEME, move |_ctx, request| {
        skin::serve_skin_request(&skin_roots, &request.uri().to_string())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::launcher_status,
            commands::launcher_retry,
            commands::launcher_exit,
            commands::monitor_context_menu,
            commands::monitor_start_drag,
            commands::skin_debug_menu,
            commands::skin_debug_exit,
            commands::settings_get,
            commands::settings_apply,
            commands::settings_close
        ])
        .setup(move |app| {
            if let Some(name) = debug_skin.as_deref() {
                setup_skin_debug(app, name, roots_for_setup)
            } else {
                setup_production(app, roots_for_setup)
            }
        })
        .on_window_event(|window, event| {
            // 生产:窗口点关闭 = 隐藏,进程常驻托盘(退出唯一路径是托盘菜单"退出")
            // 调试:关闭窗口 = 退出应用
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if skin::is_debug() {
                    window.app_handle().exit(0);
                } else {
                    api.prevent_close();
                    let logger = window.app_handle().state::<FileLogger>().inner().clone();
                    if let Err(e) = window.hide() {
                        logger.error(&format!("窗口关闭→隐藏失败: {}", e), None);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

/// 生产模式 setup:配置解析 → 皮肤选择 → 窗口/托盘 → 启动服务器。
fn setup_production(
    app: &mut tauri::App,
    skin_roots: skin::SkinRoots,
) -> Result<(), Box<dyn std::error::Error>> {
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
    app.manage(skin_roots.clone());

    match windows::create_progress_window(app.handle()) {
        Ok(_) => windows::show_progress(app.handle()),
        Err(e) => logger.error(&format!("创建进度窗口失败: {}", e), None),
    }
    match windows::create_main_window(app.handle(), port) {
        Ok(_) => logger.info("主窗口已创建(隐藏,就绪后显示)", None),
        Err(e) => logger.error(&format!("创建主窗口失败: {}", e), None),
    }
    // 皮肤选择:launcher.json monitorSkin(默认 classic);失败 → 回退内嵌页
    let requested = config_resolver::find_launcher_config(&exe_dir)
        .and_then(|p| config_resolver::parse_launcher_config(&p).ok())
        .and_then(|c| c.monitor_skin)
        .unwrap_or_else(|| skin::DEFAULT_SKIN.to_string());
    let (cfg, url, key) = match resolve_startup_skin(&skin_roots, &requested, &logger) {
        Ok(t) => t,
        Err(e) => {
            logger.error("皮肤加载失败,回退内置 classic 页面", Some(&e));
            (
                skin::SkinConfig::default(),
                tauri::WebviewUrl::App("monitor.html".into()),
                "embedded".to_string(),
            )
        }
    };
    {
        let state = app.state::<LauncherState>();
        *state.current_skin.lock().unwrap() = key;
    }
    match windows::create_monitor_window(app.handle(), &cfg, url, false) {
        Ok(_) => logger.info("监视窗口已创建(隐藏,就绪后显示)", None),
        Err(e) => logger.error(&format!("创建监视窗口失败: {}", e), None),
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
}

/// 皮肤调试模式 setup(--skin-debug):只建皮肤监视窗 + 假数据,无服务器/托盘/进度窗。
fn setup_skin_debug(
    app: &mut tauri::App,
    skin_key: &str,
    skin_roots: skin::SkinRoots,
) -> Result<(), Box<dyn std::error::Error>> {
    let exe_dir = current_exe_dir();
    // server_root 仅用于日志位置与生产模式保持一致(dev 布局下 {serverRoot}/GUI/logs);
    // 解析失败回退 {exe_dir}/logs(FileLogger 文档行为),不影响调试窗口
    let server_root =
        config_resolver::resolve_server_root(&exe_dir, config_resolver::DEFAULT_MAX_DEPTH).ok();
    let logger = FileLogger::init(tauri::is_dev(), server_root.as_deref(), &exe_dir);
    logger.info("皮肤调试模式启动", Some(&format!("key={}", skin_key)));

    app.manage(LauncherState::new(config_resolver::DEFAULT_PORT, None));
    app.manage(logger.clone());
    app.manage(skin_roots.clone());

    // 调试模式的全部目的就是展示该皮肤:无效 → 响亮报错并退出,不做回退
    let (cfg, url, key) = match resolve_startup_skin(&skin_roots, skin_key, &logger) {
        Ok(t) => t,
        Err(e) => {
            logger.error("皮肤加载失败,调试模式退出", Some(&e));
            app.handle().exit(1);
            return Ok(());
        }
    };
    {
        let state = app.state::<LauncherState>();
        *state.current_skin.lock().unwrap() = key;
        // 初始默认值先入状态,on_page_load 补发保证皮肤首帧有数据
        *state.last_monitor_payload.lock().unwrap() = Some(serde_json::json!({
            "total": 42, "working": 17, "server": "up", "updated": true
        }));
    }
    windows::create_monitor_window(app.handle(), &cfg, url, true)?;
    windows::show_monitor(app.handle());
    std::thread::spawn({
        let app = app.handle().clone();
        move || debug_fake_data_loop(app)
    });
    Ok(())
}

/// 解析启动皮肤:launcher.json 语义(官方/用户/裸名官方优先)。
/// 成功返回 (配置, 窗口URL, 规范化键 "official:<folder>" / "user:<folder>")。
fn resolve_startup_skin(
    roots: &skin::SkinRoots,
    requested: &str,
    logger: &FileLogger,
) -> Result<(skin::SkinConfig, tauri::WebviewUrl, String), String> {
    let skin_ref = skin::SkinRef::parse(requested)
        .ok_or_else(|| format!("monitorSkin 值非法: {}", requested))?;
    let (source, dir) = skin_ref
        .resolve(roots)
        .ok_or_else(|| format!("皮肤不存在: {}", requested))?;
    let (cfg, warnings) = skin::load_skin_dir(&dir)?;
    for w in warnings {
        logger.warn("皮肤配置警告", Some(&w));
    }
    let key = format!("{}:{}", source.as_str(), skin_ref.folder);
    logger.info(
        "皮肤加载成功",
        Some(&format!("key={} size={}x{}", key, cfg.width, cfg.height)),
    );
    Ok((cfg, skin::skin_url(source, &skin_ref.folder), key))
}

/// 调试假数据循环:每 10s 生成随机值(total 10..=99、working ≤ total、server 三态轮换),
/// 存入最近 payload 并派发 dateUpdate。std::time 纳秒取随机,零新依赖。
fn debug_fake_data_loop(app: tauri::AppHandle) {
    let states = ["up", "busy", "down"];
    let mut i = 0usize;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0);
        let total = 10 + nanos % 90;
        let working = nanos % (total + 1);
        let payload = serde_json::json!({
            "total": total,
            "working": working,
            "server": states[i % 3],
            "updated": true,
        });
        i += 1;
        {
            let state = app.state::<LauncherState>();
            *state.last_monitor_payload.lock().unwrap() = Some(payload.clone());
        }
        windows::dispatch_monitor_update(&app, &payload);
    }
}

/// 监视窗口页面加载后补发最近一次数据(皮肤页加载后才注册监听,首帧不丢)。
pub(crate) fn push_last_monitor_payload(app: &tauri::AppHandle) {
    let payload = {
        let state = app.state::<LauncherState>();
        let guard = state.last_monitor_payload.lock().unwrap();
        guard.clone()
    };
    if let Some(payload) = payload {
        windows::dispatch_monitor_update(app, &payload);
    }
}

/// 换肤失败回退:按 state.current_skin 原样重建监视窗并恢复可见性。
/// 返回 Some(()) 成功 / None 失败(记日志)。
fn rebuild_current_monitor(app: &tauri::AppHandle, visible: bool) -> Option<()> {
    let logger = app.state::<FileLogger>().inner().clone();
    let key = {
        let state = app.state::<LauncherState>();
        let guard = state.current_skin.lock().unwrap();
        guard.clone()
    };
    let roots = app.state::<skin::SkinRoots>().inner().clone();
    let (cfg, url) = if key == "embedded" {
        (
            skin::SkinConfig::default(),
            tauri::WebviewUrl::App("monitor.html".into()),
        )
    } else {
        let skin_ref = match skin::SkinRef::parse(&key) {
            Some(r) => r,
            None => {
                logger.error("回退重建失败:当前皮肤键非法", Some(&key));
                return None;
            }
        };
        let (source, dir) = match skin_ref.resolve(&roots) {
            Some(v) => v,
            None => {
                logger.error("回退重建失败:当前皮肤目录不存在", Some(&key));
                return None;
            }
        };
        match skin::load_skin_dir(&dir) {
            Ok((cfg, _w)) => (cfg, skin::skin_url(source, &skin_ref.folder)),
            Err(e) => {
                logger.error(&format!("回退重建失败: {}", e), Some(&key));
                return None;
            }
        }
    };
    match windows::create_monitor_window(app, &cfg, url, false) {
        Ok(w) => {
            if visible {
                if let Err(e) = w.show() {
                    logger.error(&format!("回退重建后显示监视窗口失败: {}", e), None);
                }
            }
            Some(())
        }
        Err(e) => {
            logger.error(&format!("回退重建监视窗口失败: {}", e), None);
            None
        }
    }
}

/// 运行时换肤(设置界面"应用"):transparency 等是窗口创建时参数,
/// 必须重建监视窗——销毁旧窗(记录可见性)→ 按新配置建新窗(label 不变)→ 恢复可见性 →
/// 更新 current_skin → 持久化 launcher.json(失败仅影响下次启动,本次会话仍生效)。
pub(crate) fn apply_skin(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    let logger = app.state::<FileLogger>().inner().clone();
    let roots = app.state::<skin::SkinRoots>().inner().clone();
    let skin_ref = skin::SkinRef::parse(key).ok_or_else(|| format!("皮肤键非法: {}", key))?;
    if skin_ref.explicit.is_none() {
        return Err("皮肤键必须带来源前缀(official: 或 user:)".to_string());
    }
    let (source, dir) = skin_ref
        .resolve(&roots)
        .ok_or_else(|| format!("皮肤不存在: {}", key))?;
    let (cfg, warnings) = skin::load_skin_dir(&dir)?;
    for w in warnings {
        logger.warn("皮肤配置警告", Some(&w));
    }
    let new_key = skin_ref.to_key();
    {
        let state = app.state::<LauncherState>();
        if *state.current_skin.lock().unwrap() == new_key {
            logger.info("皮肤未变化,跳过重建", Some(&new_key));
            return Ok(());
        }
    }
    // 重建窗口:记录可见性 → 销毁旧窗(必须用 destroy——close() 会被全局
    // CloseRequested 钩子 prevent_close 拦截,窗口不销毁、label 被占用)→
    // 按新配置建新窗 → 恢复可见性。
    let was_visible = app
        .get_webview_window("monitor")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if let Some(w) = app.get_webview_window("monitor") {
        if let Err(e) = w.destroy() {
            logger.error(&format!("销毁旧监视窗口失败: {}", e), None);
            return Err(e.to_string());
        }
    }
    // destroy 后 label 的释放要等 Destroyed 事件经主线程事件循环处理
    // (tauri app.rs: on_window_close)——本命令跑在 async 工作线程,轮询等待(上限 2s)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if app.get_webview_window("monitor").is_none() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            logger.error("销毁旧监视窗口后 label 迟迟未释放,放弃重建", None);
            return Err("销毁旧窗口超时".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let url = skin::skin_url(source, &skin_ref.folder);
    let new_window = match windows::create_monitor_window(app, &cfg, url, false) {
        Ok(w) => w,
        Err(e) => {
            // 新建失败:用当前皮肤原样重建,避免把监视窗留在"已销毁"状态
            logger.error(
                &format!("按新皮肤重建监视窗口失败,回退当前皮肤: {}", e),
                Some(&new_key),
            );
            let fallback = rebuild_current_monitor(app, was_visible);
            return Err(match fallback {
                Some(_) => format!("换肤失败,已回退当前皮肤: {}", e),
                None => format!("换肤失败且回退失败: {}", e),
            });
        }
    };
    if was_visible {
        if let Err(e) = new_window.show() {
            logger.error(&format!("换肤后显示监视窗口失败: {}", e), None);
        }
    }
    {
        let state = app.state::<LauncherState>();
        *state.current_skin.lock().unwrap() = new_key.clone();
    }
    if let Err(e) = config_resolver::persist_monitor_skin(&current_exe_dir(), &new_key) {
        logger.error("monitorSkin 持久化失败(本次会话仍生效)", Some(&e));
    }
    logger.info(
        "皮肤已切换",
        Some(&format!("key={} size={}x{}", new_key, cfg.width, cfg.height)),
    );
    Ok(())
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
            } else {
                logger.info(
                    "端口上已有 Agent Society 服务器(外部实例),本 GUI 退出时不会停止它",
                    Some(&format!("port={}", port)),
                );
            }
            windows::show_monitor(&app);
            // 监视窗口数据循环(独立线程;FileLogger 与 AppHandle 均 Clone)
            std::thread::spawn({
                let app = app.clone();
                let logger = logger.clone();
                move || status_window_loop(app, logger)
            });
            // owned 与 external 都进入心跳监控:端口关闭 → 退出启动器
            watch_after_ready(app, logger);
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

/// 就绪后的监控循环(owned 与 external 都进入):
/// - 每 1s 心跳探端口:Up/Busy 重置计数;连续 3 次 Down(连接被拒绝)→ 端口已关闭 → 退出启动器。
///   Busy(连接超时,如服务器繁忙 backlog 满)不计入关闭——这是用户明确要求的容错。
/// - owned 时同时监视子进程:退出后重评估——端口上还有校验过的 Agent Society → 外部实例;
///   端口已关 → 交给心跳退出;端口被无关程序占用 → Failed(保留重试 UI)。
fn watch_after_ready(app: tauri::AppHandle, logger: FileLogger) {
    let state = app.state::<LauncherState>();
    let port = state.port;
    let mut heartbeat = readiness::HeartbeatState::default();
    const HEARTBEAT_DOWN_THRESHOLD: u32 = 3;

    loop {
        std::thread::sleep(Duration::from_secs(1));
        // 退出序列开始(Stopping)后不再探测
        if !matches!(&*state.phase.lock().unwrap(), Phase::Ready) {
            return;
        }
        // 1) 子进程监视(仅 owned)
        if state.owned.load(Ordering::SeqCst) {
            if let Some(st) = try_wait_child(&state, &logger) {
                reevaluate_after_child_exit(&app, &state, &logger, st);
                // reevaluate 可能把相位改为 Failed 或 owned=false;下一轮由相位检查兜底
                if !matches!(&*state.phase.lock().unwrap(), Phase::Ready) {
                    return;
                }
            }
        }
        // 2) 端口心跳
        let probe = readiness::tcp_probe_detailed(port, readiness::PROBE_TIMEOUT);
        match readiness::heartbeat_step(&mut heartbeat, probe, HEARTBEAT_DOWN_THRESHOLD) {
            readiness::HeartbeatAction::Continue => {}
            readiness::HeartbeatAction::Exit => {
                logger.error(
                    "心跳检测:服务器端口已关闭,启动器退出",
                    Some(&format!(
                        "port={} consecutive_down={}",
                        port, heartbeat.consecutive_down
                    )),
                );
                begin_quit(app);
                return;
            }
        }
    }
}

/// 监视窗口数据循环(就绪后独立线程,与退出判定的心跳线程并行):
/// 每 2s 三态 TCP 探测定服务器状态;Up 时 POST /api/heartbeat 取智能体计数。
/// HTTP 超时/失败 = 繁忙容忍:保留上次计数,不视为服务器关闭(退出判定归心跳线程)。
/// 状态变化才写日志,避免 2s 一条刷爆 launcher.log。
fn status_window_loop(app: tauri::AppHandle, logger: FileLogger) {
    let state = app.state::<LauncherState>();
    let port = state.port;
    let mut client = monitor::HeartbeatClient::new();
    let mut counts: Option<monitor::AgentCounts> = None;
    let mut last_server: &'static str = "";
    let mut last_counts: Option<monitor::AgentCounts> = None;

    loop {
        std::thread::sleep(Duration::from_secs(2));
        // 退出序列/失败态后停止刷新
        if !matches!(&*state.phase.lock().unwrap(), Phase::Ready) {
            return;
        }
        let server = match readiness::tcp_probe_detailed(port, readiness::PROBE_TIMEOUT) {
            readiness::ProbeResult::Up => "up",
            readiness::ProbeResult::Busy => "busy",
            readiness::ProbeResult::Down => "down",
        };
        let mut updated = false;
        if server == "up" {
            match monitor::fetch_heartbeat(port, &mut client) {
                Ok(new_counts) => {
                    if let Some(c) = new_counts {
                        counts = Some(c);
                        updated = true;
                    }
                }
                Err(e) => {
                    logger.warn(
                        "监视窗口心跳请求失败(保留上次数据)",
                        Some(&format!("port={} {}", port, e)),
                    );
                }
            }
        }
        let payload = serde_json::json!({
            "server": server,
            "total": counts.map(|c| c.total),
            "working": counts.map(|c| c.working),
            "updated": updated
        });
        {
            let state = app.state::<LauncherState>();
            *state.last_monitor_payload.lock().unwrap() = Some(payload.clone());
        }
        windows::dispatch_monitor_update(&app, &payload);
        if server != last_server || counts != last_counts {
            logger.info(
                "监视数据更新",
                Some(&format!(
                    "server={} total={:?} working={:?}",
                    server,
                    counts.map(|c| c.total),
                    counts.map(|c| c.working)
                )),
            );
            last_server = server;
            last_counts = counts;
        }
    }
}

/// 就绪后子进程退出时的重评估:
/// - 端口可连且 /api/config/status 校验过 → 端口上是 Agent Society 外部实例(owned=false);
/// - 端口已关 → 不改相位,交给心跳的 Down 计数退出(用户要求:端口关闭 → 退出自己);
/// - 端口可连但校验不过(被无关程序占用)→ Failed,保留重试/退出 UI。
fn reevaluate_after_child_exit(
    app: &tauri::AppHandle,
    state: &LauncherState,
    logger: &FileLogger,
    st: ExitStatus,
) {
    let port = state.port;
    let child_pid = state.child.lock().unwrap().as_ref().map(|c| c.id());
    if let Some(pid) = child_pid {
        remove_server_pid(app, pid);
    }

    let port_open = readiness::tcp_probe(port, readiness::PROBE_TIMEOUT);
    let verified = port_open && readiness::http_status_probe(port, readiness::PROBE_TIMEOUT);

    if verified {
        state.owned.store(false, Ordering::SeqCst);
        set_phase(app, state, Phase::Ready);
        windows::show_main(app);
        logger.info(
            "子进程已退出但端口上仍有 Agent Society(外部实例),本 GUI 退出时不会停止它",
            Some(&format!(
                "port={} child_exit={:?}",
                port,
                st.code()
            )),
        );
    } else if port_open {
        let reason = "端口被占用但无法确认是 Agent Society".to_string();
        logger.error("服务器进程已退出且端口被无关程序占用", Some(&reason));
        set_phase(app, state, Phase::Failed(reason));
        windows::show_progress(app);
    } else {
        logger.warn(
            "服务器子进程已退出,等待端口心跳确认关闭后退出",
            Some(&format!("port={} child_exit={:?}", port, st.code())),
        );
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
    // 调试模式无服务器可停,直接退出
    if skin::is_debug() {
        app.exit(0);
        return;
    }
    let state = app.state::<LauncherState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        let logger = app.state::<FileLogger>().inner().clone();
        logger.info("退出序列已在进行中,忽略重复请求", None);
        return;
    }
    // 监视窗口显示"正在停止…"(计数保持上次值,停止期间不再刷新)
    windows::dispatch_monitor_update(&app, &serde_json::json!({ "server": "stopping" }));
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
