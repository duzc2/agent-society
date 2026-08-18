//! 系统托盘:右键菜单(打开主界面/退出)+ 双击打开主界面(Windows 专用事件)。

use crate::logging::FileLogger;
use crate::windows;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

pub fn create_tray(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    let logger = app.state::<FileLogger>().inner().clone();

    let open_item = MenuItem::with_id(app, "open_main", "打开主界面", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let tray = TrayIconBuilder::with_id("launcher-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("托盘图标文件无效"))
        .tooltip("Agent Society")
        .menu(&menu)
        .show_menu_on_left_click(false) // 左键不弹菜单,避免与双击冲突
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_main" => windows::show_main(app),
            "quit" => crate::begin_quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                windows::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    logger.info("托盘已创建", Some("菜单: 打开主界面 / 退出;双击打开主界面"));
    Ok(tray)
}
