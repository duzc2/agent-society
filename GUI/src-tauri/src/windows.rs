//! 窗口创建与显隐。步骤 4:进度窗口;步骤 5 加入主窗口。

use crate::logging::FileLogger;
use tauri::Manager;

/// 无边框 + 透明背景 + 置顶 + 不出现在任务栏的小窗口。
/// 透明在 Windows 上依赖 vendor/tao 补丁:transparent 窗口创建时即带
/// WS_EX_NOREDIRECTIONBITMAP(事后设置被系统静默忽略,上游 DWM blur-behind
/// 回退在 Win11 上渲染白底)。shadow(false) 避免 DWM 边框扩展干扰合成。
pub fn create_progress_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, "progress", tauri::WebviewUrl::App("progress.html".into()))
        .title("Agent Society 启动器")
        .inner_size(420.0, 160.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .center()
        .visible(false)
        .build()
}

pub fn show_progress(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    match app.get_webview_window("progress") {
        Some(w) => {
            if let Err(e) = w.show() {
                logger.error(&format!("显示进度窗口失败: {}", e), None);
            }
        }
        None => logger.error("进度窗口不存在,无法显示", None),
    }
}

pub fn hide_progress(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    match app.get_webview_window("progress") {
        Some(w) => {
            if let Err(e) = w.hide() {
                logger.error(&format!("隐藏进度窗口失败: {}", e), None);
            }
        }
        None => logger.error("进度窗口不存在,无法隐藏", None),
    }
}

/// 悬浮监视窗口:无边框 + 透明背景 + 置顶 + 可拖动,停靠主显示器工作区右上角。
pub fn create_monitor_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let logger = app.state::<FileLogger>().inner().clone();
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "monitor", tauri::WebviewUrl::App("monitor.html".into()))
            .title("Agent Society 监视")
            .inner_size(300.0, 112.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false);
    // 停靠工作区右上角(避开任务栏);无显示器信息时用系统默认位置
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        let margin = 12.0;
        let x = work.position.x as f64 / scale + work.size.width as f64 / scale - 300.0 - margin;
        let y = work.position.y as f64 / scale + margin;
        builder = builder.position(x, y);
    } else {
        logger.warn("无法获取主显示器,监视窗口使用系统默认位置", None);
    }
    builder.build()
}

pub fn show_monitor(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    match app.get_webview_window("monitor") {
        Some(w) => {
            if let Err(e) = w.show() {
                logger.error(&format!("显示监视窗口失败: {}", e), None);
            }
        }
        None => logger.error("监视窗口不存在,无法显示", None),
    }
}

/// 托盘"监视窗口"项:可见则隐藏,隐藏则显示。
pub fn toggle_monitor(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    match app.get_webview_window("monitor") {
        Some(w) => {
            let visible = w.is_visible().unwrap_or(false);
            let action = if visible { w.hide() } else { w.show() };
            if let Err(e) = action {
                logger.error(&format!("切换监视窗口失败: {}", e), None);
            }
        }
        None => logger.error("监视窗口不存在,无法切换", None),
    }
}

/// 主窗口:标准窗口结构(默认 decorations=true),加载服务器 Web 界面。
pub fn create_main_window(app: &tauri::AppHandle, port: u16) -> tauri::Result<tauri::WebviewWindow> {
    let url = format!("http://localhost:{}/web/", port);
    tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(url.parse().expect("主窗口 URL 无效")),
    )
    .title("Agent Society")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 600.0)
    .center()
    .visible(false)
    .build()
}

/// 显示主窗口(托盘菜单/双击/单实例唤起共用);窗口未创建时记日志不动作。
pub fn show_main(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    match app.get_webview_window("main") {
        Some(w) => {
            if let Err(e) = w.unminimize() {
                logger.error(&format!("主窗口取消最小化失败: {}", e), None);
            }
            if let Err(e) = w.show() {
                logger.error(&format!("显示主窗口失败: {}", e), None);
            }
            if let Err(e) = w.set_focus() {
                logger.error(&format!("主窗口聚焦失败: {}", e), None);
            }
        }
        None => logger.info("主窗口尚未创建,忽略唤起", None),
    }
}
