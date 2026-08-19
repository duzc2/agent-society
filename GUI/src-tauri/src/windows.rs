//! 窗口创建与显隐。步骤 4:进度窗口;步骤 5 加入主窗口。

use crate::logging::FileLogger;
use crate::skin::{self, SkinConfig};
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

/// 工作区右上角停靠(逻辑坐标)。work = (x, y, w, h) 物理像素;返回 (x, y)。
pub fn dock_top_right(work: (i32, i32, u32, u32), scale: f64, width: f64, margin: f64) -> (f64, f64) {
    let x = work.0 as f64 / scale + work.2 as f64 / scale - width - margin;
    let y = work.1 as f64 / scale + margin;
    (x, y)
}

/// 悬浮监视窗口:无边框 + 皮肤配置的尺寸/透明/置顶,停靠主显示器工作区右上角。
/// 页面加载完成后统一注入右键菜单脚本(皮肤页与内嵌回退页同机制),并补发最近一次数据。
pub fn create_monitor_window(
    app: &tauri::AppHandle,
    cfg: &SkinConfig,
    url: tauri::WebviewUrl,
    debug: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let logger = app.state::<FileLogger>().inner().clone();
    let mut builder = tauri::WebviewWindowBuilder::new(app, "monitor", url)
        .title(if debug {
            format!("皮肤调试 - {}", cfg.name)
        } else {
            "Agent Society 监视".to_string()
        })
        .inner_size(cfg.width, cfg.height)
        .decorations(false)
        .transparent(cfg.transparency)
        .shadow(cfg.shadow)
        .always_on_top(cfg.always_on_top)
        .skip_taskbar(cfg.skip_taskbar)
        .resizable(cfg.resizable)
        .visible(false);
    // 停靠工作区右上角(避开任务栏,按皮肤宽度重算);无显示器信息时用系统默认位置
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let work = monitor.work_area();
        let (x, y) = dock_top_right(
            (work.position.x, work.position.y, work.size.width, work.size.height),
            monitor.scale_factor(),
            cfg.width,
            12.0,
        );
        builder = builder.position(x, y);
    } else {
        logger.warn("无法获取主显示器,监视窗口使用系统默认位置", None);
    }
    let inject = if debug { skin::DEBUG_SCRIPT } else { skin::CONTEXTMENU_SCRIPT };
    let builder = builder.on_page_load(move |window, _payload| {
        if let Err(e) = window.eval(inject) {
            let logger = window.app_handle().state::<FileLogger>().inner().clone();
            logger.error(
                &format!("监视窗口注入脚本失败: {}", e),
                Some("on_page_load"),
            );
        }
        // 皮肤页在页面加载后才注册监听,补发最近一次数据避免丢首帧
        crate::push_last_monitor_payload(window.app_handle());
    });
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

/// 设置窗口:标准窗口(有标题栏,非透明非置顶),加载内嵌 ui/settings.html。
/// 懒创建(首次打开时创建,之后 hide/show);关闭 = 隐藏(全局 CloseRequested 钩子覆盖)。
pub fn create_settings_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("设置")
        .inner_size(640.0, 480.0)
        .min_inner_size(520.0, 400.0)
        .center()
        .visible(false)
        .build()
}

/// 显示设置窗口(托盘/监视窗菜单"设置"项);窗口未创建时先创建。
pub fn show_settings(app: &tauri::AppHandle) {
    let logger = app.state::<FileLogger>().inner().clone();
    let window = match app.get_webview_window("settings") {
        Some(w) => w,
        None => match create_settings_window(app) {
            Ok(w) => w,
            Err(e) => {
                logger.error(&format!("创建设置窗口失败: {}", e), None);
                return;
            }
        },
    };
    if let Err(e) = window.show() {
        logger.error(&format!("显示设置窗口失败: {}", e), None);
    }
    if let Err(e) = window.set_focus() {
        logger.error(&format!("设置窗口聚焦失败: {}", e), None);
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

/// 向监视窗口派发数据更新:注入 window 上的 CustomEvent "dateUpdate"
/// (皮肤数据契约,皮肤页不依赖 Tauri API)。
/// payload 由调用方以 serde_json 构造,值全为受控数字/布尔/枚举,
/// serde_json 输出即合法 JS 对象字面量;eval 非内联 HTML,无 </script> 注入面。
/// 窗口缺失/评估失败 → 记日志,不 panic。
pub fn dispatch_monitor_update(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let logger = app.state::<FileLogger>().inner().clone();
    let window = match app.get_webview_window("monitor") {
        Some(w) => w,
        None => {
            logger.error("监视窗口不存在,无法派发数据更新", None);
            return;
        }
    };
    let json = serde_json::to_string(payload).expect("payload 序列化失败");
    let js = format!(
        "window.dispatchEvent(new CustomEvent(\"dateUpdate\", {{ detail: {} }}));",
        json
    );
    if let Err(e) = window.eval(&js) {
        logger.error(
            &format!("派发 dateUpdate 失败: {}", e),
            Some("window.eval"),
        );
    }
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

#[cfg(test)]
mod tests {
    use super::dock_top_right;

    #[test]
    fn dock_top_right_math() {
        // 1920x1080 @100%:右上角 = 1920-300-12, 12
        assert_eq!(dock_top_right((0, 0, 1920, 1080), 1.0, 300.0, 12.0), (1608.0, 12.0));
        // 2560x1440 @150%:物理 (0,0,2560,1440) 逻辑 1706.67x960
        assert_eq!(dock_top_right((0, 0, 2560, 1440), 1.5, 300.0, 12.0), (1394.6666666666667, 12.0));
        // 240 宽皮肤 + 主屏带偏移
        assert_eq!(dock_top_right((100, 50, 1920, 1080), 1.0, 240.0, 12.0), (1768.0, 62.0));
        // 1.25 缩放:1920/1.25=1536,1536-300-12=1224
        assert_eq!(dock_top_right((0, 0, 1920, 1080), 1.25, 300.0, 12.0), (1224.0, 12.0));
    }
}
