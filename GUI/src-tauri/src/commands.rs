//! 进度窗口的 invoke 命令:状态查询、重试、退出。

use crate::logging::FileLogger;
use crate::{begin_quit, launch_attempt, LauncherState, Phase};
use std::sync::atomic::Ordering;
use tauri::Manager;

#[tauri::command]
pub fn launcher_status(state: tauri::State<'_, LauncherState>) -> String {
    match &*state.phase.lock().unwrap() {
        Phase::Starting => "starting".to_string(),
        Phase::Ready => "ready".to_string(),
        Phase::Stopping => "stopping".to_string(),
        Phase::Failed(msg) => format!("failed:{}", msg),
    }
}

#[tauri::command]
pub fn launcher_retry(
    app: tauri::AppHandle,
    state: tauri::State<'_, LauncherState>,
) -> Result<(), String> {
    if !matches!(&*state.phase.lock().unwrap(), Phase::Failed(_)) {
        return Err("当前不在 Failed 状态,无法重试".to_string());
    }
    let logger = app.state::<FileLogger>().inner().clone();

    // 清理残留子进程:仍存活则发优雅信号后短等,不响应则强杀(重试场景下残留多为死进程)
    if let Some(child) = state.child.lock().unwrap().take() {
        let pid = child.id();
        match child.try_wait(&logger) {
            Some(st) => logger.info(
                "重试:残留子进程已退出",
                Some(&format!("pid={} exit={:?}", pid, st.code())),
            ),
            None => {
                crate::server_launcher::send_ctrl_break_direct(pid, &logger);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let mut exited = false;
                while std::time::Instant::now() < deadline {
                    if let Some(st) = child.try_wait(&logger) {
                        logger.info(
                            "重试:残留子进程已优雅退出",
                            Some(&format!("pid={} exit={:?}", pid, st.code())),
                        );
                        exited = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                if !exited {
                    logger.warn(
                        "重试:残留子进程未响应优雅信号,强制终止",
                        Some(&format!("pid={}", pid)),
                    );
                    crate::server_launcher::force_kill(&child, &logger);
                }
            }
        }
        crate::remove_server_pid(&app, pid);
    }
    state.owned.store(false, Ordering::SeqCst);
    launch_attempt(app, logger);
    Ok(())
}

#[tauri::command]
pub fn launcher_exit(app: tauri::AppHandle) -> Result<(), String> {
    begin_quit(app);
    Ok(())
}

/// 监视窗拖拽兜底:命中区域内皮肤未处理的左键按下 → 移动悬浮窗。
/// 由注入脚本在页面层判断"皮肤未处理"(不在 data-tauri-drag-region 内、未
/// preventDefault)后调用;页面只会在命中区域内收到鼠标事件,兜底天然限于触发区域。
#[tauri::command]
pub fn monitor_start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/// 双击悬浮窗兜底:皮肤未处理双击(未 preventDefault)时切换主窗口显隐。
/// 由注入脚本判定"未处理"后调用(见 skin.rs DBLCLICK_TOGGLE_SCRIPT)。
#[tauri::command]
pub fn monitor_toggle_main(app: tauri::AppHandle) -> Result<(), String> {
    crate::windows::toggle_main(&app);
    Ok(())
}

/// 调试模式右键:弹出单条目菜单("退出调试")。结构与 monitor_context_menu 相同:
/// async(防主线程死锁)+ 点击坐标定位 + POPUP_ACTIVE 重入守卫。
/// 菜单点击由 run() 里注册的全局 on_menu_event 分发(无托盘,popup 事件仍走全局监听器)。
#[tauri::command]
pub async fn skin_debug_menu(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    static POPUP_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if POPUP_ACTIVE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(()); // 上一次弹出尚未结束,忽略重入
    }
    let logger = app.state::<FileLogger>().inner().clone();
    let window = app
        .get_webview_window("monitor")
        .ok_or_else(|| "监视窗口不存在".to_string())?;
    let menu = crate::tray::build_debug_menu(&app).map_err(|e| e.to_string())?;
    let result = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
    POPUP_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    match result {
        Ok(()) => {
            logger.info("调试菜单弹出", Some(&format!("x={} y={}", x, y)));
            Ok(())
        }
        Err(e) => {
            logger.error(&format!("调试菜单弹出失败: {}", e), None);
            Err(e.to_string())
        }
    }
}

/// 调试模式退出(Esc 注入脚本与"退出调试"菜单项调用)。
#[tauri::command]
pub fn skin_debug_exit(app: tauri::AppHandle) -> Result<(), String> {
    if !crate::skin::is_debug() {
        return Err("非调试模式".to_string());
    }
    app.exit(0);
    Ok(())
}

/// 设置界面:枚举两个皮肤文件夹的全部皮肤(含无效皮肤与预览状态)+ 当前皮肤键。
#[tauri::command]
pub fn settings_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let logger = app.state::<FileLogger>().inner().clone();
    let roots = app.state::<crate::skin::SkinRoots>().inner().clone();
    let (entries, errors) = crate::skin::enumerate_skins(&roots);
    for e in errors {
        logger.error("皮肤枚举错误", Some(&e));
    }
    let current = {
        let state = app.state::<LauncherState>();
        let guard = state.current_skin.lock().unwrap();
        guard.clone()
    };
    Ok(serde_json::json!({
        "skins": entries,
        "current": current,
        "officialRoot": roots.official.map(|p| p.display().to_string()),
        "userRoot": roots.user.map(|p| p.display().to_string()),
    }))
}

/// 设置界面"应用":运行时换肤(重建监视窗)+ 持久化 monitorSkin。失败不切换。
/// **必须是 async 命令**:apply 需要 destroy 旧窗后等 Destroyed 事件经主线程
/// 事件循环释放 label(同步命令阻塞主线程,事件永远无法处理 → "label already exists")。
#[tauri::command]
pub async fn settings_apply(app: tauri::AppHandle, key: String) -> Result<(), String> {
    crate::apply_skin(&app, &key)
}

/// 设置界面"关闭"按钮:隐藏设置窗口。
#[tauri::command]
pub fn settings_close(app: tauri::AppHandle) -> Result<(), String> {
    match app.get_webview_window("settings") {
        Some(w) => {
            let _ = w.hide();
            Ok(())
        }
        None => Err("设置窗口不存在".to_string()),
    }
}

/// 监视窗口右键:在右键点击处弹出与托盘完全相同的原生菜单。
/// 菜单内容与点击行为只有一处定义(tray::build_menu / tray::handle_menu_event);
/// muda::Menu 内部是 Rc<RefCell>(非 Send),不能放进 managed state,
/// 因此每次 popup 重建实例——同一份定义,不存在第二套维护。
///
/// **必须是 async 命令**:同步命令在 invoke 到达的主线程上内联执行
/// (tauri-macros body_blocking: `let result = $path(...)`),而 build_menu/popup_menu
/// 内部的 run_item_main_thread! 是"向主线程投递 + 阻塞等待"——主线程上调用等于
/// 自己等自己,永久死锁(实测:整个主线程冻结,后续所有 IPC 排队)。
/// async 命令跑在 async_runtime 线程池,投递-等待的双方不在同一线程。
/// tauri 官方 menu 插件的 popup 命令同为 async(plugin.rs:668),同一原因。
///
/// **定位用点击点而非光标**:popup_menu 内部用 GetCursorPos 定位,用户右键后
/// 若光标已移动,菜单会出现在错误位置;这里由 JS 传 event.clientX/Y(逻辑像素),
/// popup_menu_at(LogicalPosition) 由 muda 做 DPI 转换 + ClientToScreen,钉在点击点。
///
/// **重入守卫**:菜单开着时再次右键,新 invoke 的 popup 任务会在 TrackPopupMenu
/// 的 modal loop 里被泵出 → 嵌套菜单级联。POPUP_ACTIVE 期间忽略后续请求。
#[tauri::command]
pub async fn monitor_context_menu(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    static POPUP_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if POPUP_ACTIVE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(()); // 上一次弹出尚未结束,忽略重入
    }
    let logger = app.state::<FileLogger>().inner().clone();
    let window = app
        .get_webview_window("monitor")
        .ok_or_else(|| "监视窗口不存在".to_string())?;
    let menu = crate::tray::build_menu(&app).map_err(|e| e.to_string())?;
    let t0 = std::time::Instant::now();
    let result = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
    let dur_ms = t0.elapsed().as_millis();
    POPUP_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    match result {
        Ok(()) => {
            logger.info(
                "监视窗口右键菜单弹出",
                Some(&format!("x={} y={} dur_ms={}", x, y, dur_ms)),
            );
            Ok(())
        }
        Err(e) => {
            logger.error(&format!("监视窗口右键菜单弹出失败: {}", e), None);
            Err(e.to_string())
        }
    }
}
