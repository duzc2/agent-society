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
