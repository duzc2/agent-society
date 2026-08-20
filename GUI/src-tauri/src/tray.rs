//! 系统托盘:右键菜单(打开/关闭主窗口、打开/关闭悬浮窗、设置、退出,前两项文案随
//! 窗口显隐动态切换)+ 双击打开主窗口(Windows 专用事件)。
//! 菜单构建与点击分发抽为共用函数,监视窗口右键 popup 同一套定义:
//! - `build_menu` / `handle_menu_event` 各只有一处,托盘与 popup 共用;
//! - 托盘 `on_menu_event` 注册的是全局监听器(tauri tray/mod.rs 注释:
//!   "called for any menu event, ... from the tray icon menu"),popup 菜单的点击
//!   自动走同一分发,不要为 popup 另行注册(会双份触发)。

use crate::logging::FileLogger;
use crate::windows;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// 菜单项文案:主窗口项随显隐切换。
pub fn main_menu_label(visible: bool) -> &'static str {
    if visible {
        "关闭主窗口"
    } else {
        "打开主窗口"
    }
}

/// 菜单项文案:悬浮窗项随显隐切换。
pub fn monitor_menu_label(visible: bool) -> &'static str {
    if visible {
        "关闭悬浮窗"
    } else {
        "打开悬浮窗"
    }
}

/// 窗口可见性(窗口不存在视为隐藏)。is_visible 是 tao 直连 Win32 的
/// IsWindowVisible,不做主线程往返,菜单点击等主线程回调中可安全调用。
fn window_visible(app: &tauri::AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// 菜单内容(托盘与监视窗口右键共用,只有这一处定义)。
/// 主窗口/悬浮窗两项文案随当前显隐动态取值;popup 每次弹出重建天然跟随,
/// 托盘菜单由显隐变化后的 sync_menu_labels 重建。
pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItem::with_id(
        app,
        "toggle_main",
        main_menu_label(window_visible(app, "main")),
        true,
        None::<&str>,
    )?;
    let monitor_item = MenuItem::with_id(
        app,
        "toggle_monitor",
        monitor_menu_label(window_visible(app, "monitor")),
        true,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open_item, &monitor_item, &settings_item, &quit_item])
}

/// 菜单项点击行为(托盘与 popup 共用,只有这一处定义)。
pub fn handle_menu_event(app: &tauri::AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "toggle_main" => windows::toggle_main(app),
        "toggle_monitor" => windows::toggle_monitor(app),
        "settings" => windows::show_settings(app),
        "quit" => crate::begin_quit(app.clone()),
        _ => {}
    }
}

/// 按当前显隐状态重建托盘菜单(文案动态)。必须脱离调用线程:
/// build_menu/set_menu 内部走 run_item_main_thread!(投递主线程 + 阻塞等待),
/// 主线程(菜单点击/托盘双击/关闭按钮事件)上直接调用会自己等自己死锁
/// (README 第 15 条 popup 必须 async 同一原因)——统一 spawn 线程,任何调用点安全。
/// 调试模式无托盘,直接返回。成功记日志(文本方式验证文案切换的唯一证据)。
pub fn sync_menu_labels(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(tray) = app.tray_by_id("launcher-tray") else {
            return; // 调试模式无托盘
        };
        let logger = app.state::<FileLogger>().inner().clone();
        let main_label = main_menu_label(window_visible(&app, "main"));
        let monitor_label = monitor_menu_label(window_visible(&app, "monitor"));
        match build_menu(&app) {
            Ok(menu) => match tray.set_menu(Some(menu)) {
                Ok(()) => logger.info(
                    "托盘菜单文案已同步",
                    Some(&format!("main={} monitor={}", main_label, monitor_label)),
                ),
                Err(e) => logger.error(&format!("重建托盘菜单失败: {}", e), None),
            },
            Err(e) => logger.error(&format!("构建托盘菜单失败: {}", e), None),
        }
    });
}

/// 调试模式菜单:"显示命中区域"勾选项(控制覆盖层显示/隐藏)+ "退出调试"
/// (调试模式无托盘,popup 点击由 run() 里 Builder::on_menu_event 注册的全局监听器分发;
/// 勾选态每次弹出时按当前状态重建)。
pub fn build_debug_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let overlay_item = CheckMenuItem::with_id(
        app,
        "debug_toggle_hit_overlay",
        "显示命中区域",
        true,
        crate::skin::hit_overlay_visible(),
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "debug_quit", "退出调试", true, None::<&str>)?;
    Menu::with_items(app, &[&overlay_item, &quit_item])
}

pub fn create_tray(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    let logger = app.state::<FileLogger>().inner().clone();

    let menu = build_menu(app)?;

    let tray = TrayIconBuilder::with_id("launcher-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("托盘图标文件无效"))
        .tooltip("Agent Society")
        .menu(&menu)
        .show_menu_on_left_click(false) // 左键不弹菜单,避免与双击冲突
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                windows::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    logger.info("托盘已创建", Some("菜单: 打开/关闭主窗口 / 打开/关闭悬浮窗 / 设置 / 退出(前两项文案随显隐切换);双击打开主窗口"));
    Ok(tray)
}

#[cfg(test)]
mod tests {
    use super::{main_menu_label, monitor_menu_label};

    #[test]
    fn menu_labels_follow_visibility() {
        assert_eq!(main_menu_label(true), "关闭主窗口");
        assert_eq!(main_menu_label(false), "打开主窗口");
        assert_eq!(monitor_menu_label(true), "关闭悬浮窗");
        assert_eq!(monitor_menu_label(false), "打开悬浮窗");
    }
}
