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
