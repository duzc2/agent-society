//! 系统托盘:右键菜单(打开主界面/监视窗口/退出)+ 双击打开主界面(Windows 专用事件)。
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

/// 菜单内容(托盘与监视窗口右键共用,只有这一处定义)。
pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItem::with_id(app, "open_main", "打开主界面", true, None::<&str>)?;
    let monitor_item = MenuItem::with_id(app, "toggle_monitor", "监视窗口", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open_item, &monitor_item, &settings_item, &quit_item])
}

/// 菜单项点击行为(托盘与 popup 共用,只有这一处定义)。
pub fn handle_menu_event(app: &tauri::AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open_main" => windows::show_main(app),
        "toggle_monitor" => windows::toggle_monitor(app),
        "settings" => windows::show_settings(app),
        "quit" => crate::begin_quit(app.clone()),
        _ => {}
    }
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

    logger.info("托盘已创建", Some("菜单: 打开主界面 / 监视窗口 / 退出;双击打开主界面"));
    Ok(tray)
}
