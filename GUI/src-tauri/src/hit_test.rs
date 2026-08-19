//! 监视窗命中区域(Windows 专用):在 tao 的链式子类化之上再叠加一层
//! WM_NCHITTEST 处理——命中区域外的点返回 HTTRANSPARENT,点击穿透到下层窗口;
//! 区域内(含拖拽/右键菜单)行为不变。
//!
//! 依据:
//! - tao 窗口实例用 SetWindowSubclass 实现事件分发(见 vendor/tao
//!   platform_impl/windows/event_loop.rs:703,ID=1),同机制叠加、ID 错开互不干扰;
//!   我们的子类回调先执行,DefSubclassProc 传给 tao 的结果再被本层改写。
//! - 命中判定每次用 GetDpiForWindow 实时换算逻辑坐标,窗口被拖到 DPI 不同的
//!   显示器上时自动保持对齐,无需监听缩放事件重建区域。
//! - 区域数据(Box<HitTestCtx>)以裸指针交给系统的 dwRefData 持有;窗口销毁时在
//!   Destroyed 事件里恰好释放一次(AtomicBool 防双路径竞态)。
//!   销毁后不调 RemoveWindowSubclass:窗口已消亡,且 hwnd 可能被系统复用。

#![cfg(windows)]

use crate::hit_region::HitRegion;
use crate::logging::FileLogger;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Manager, WebviewWindow};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{HTCAPTION, HTCLIENT, HTTRANSPARENT, WM_NCHITTEST};

/// 与 tao 的事件分发子类 ID(1)错开,避免同 ID 互相替换。
const HIT_TEST_SUBCLASS_ID: usize = 2;

/// 随 dwRefData 存进子类化的命中上下文。
struct HitTestCtx {
    region: HitRegion,
}

/// 为监视窗安装命中区域子类化;整窗区域(缺省)直接跳过——零拦截开销。
/// 同时注册 Destroyed 清理,保证 Box<HitTestCtx> 恰好释放一次。
pub fn apply(app: &tauri::AppHandle, window: &WebviewWindow, region: &HitRegion) {
    if region.is_full() {
        return;
    }
    let logger = app.state::<FileLogger>().inner().clone();
    let raw = Box::into_raw(Box::new(HitTestCtx { region: region.clone() })) as usize;
    let freed = Arc::new(AtomicBool::new(false));

    // 子类化必须装在窗口所在线程(主线程);窗口可能由命令线程经事件循环代理创建,
    // run_on_main_thread 保证线程正确,且代理消息先于本消息入队、HWND 必已就绪。
    let logger2 = logger.clone();
    let freed2 = freed.clone();
    let w2 = window.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        let hwnd = match w2.hwnd() {
            Ok(h) => h,
            Err(err) => {
                logger2.error(
                    &format!("获取监视窗 HWND 失败,命中区域未生效: {}", err),
                    Some("hit_test"),
                );
                free_ctx(raw, &freed2);
                return;
            }
        };
        // tauri 返回 windows crate 的 HWND 新类型(.0 是裸指针),
        // windows-sys 的 HWND 就是 *mut c_void 别名,直接转。
        let hwnd_sys = hwnd.0 as HWND;
        if unsafe { SetWindowSubclass(hwnd_sys, Some(hit_test_proc), HIT_TEST_SUBCLASS_ID, raw) }
            == 0
        {
            logger2.error("SetWindowSubclass 失败,命中区域未生效", Some("hit_test"));
            free_ctx(raw, &freed2);
        }
    }) {
        logger.error(
            &format!("投递主线程任务失败,命中区域未生效: {}", e),
            Some("hit_test"),
        );
        free_ctx(raw, &freed);
    }

    let freed_cleanup = freed.clone();
    let w3 = window.clone();
    w3.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            free_ctx(raw, &freed_cleanup);
        }
    });
}

/// 子类回调:先取 tao 链的结果,只有窗口本会吞掉点击(客户区/拖拽区)且
/// 点落在命中区域外时,改写为 HTTRANSPARENT 让点击穿透。
unsafe extern "system" fn hit_test_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    dwrefdata: usize,
) -> LRESULT {
    let res = DefSubclassProc(hwnd, msg, wparam, lparam);
    if !should_block(msg, res, false) {
        return res;
    }
    let ctx = &*(dwrefdata as *const HitTestCtx);
    let mut pt = lparam_point(lparam);
    if ScreenToClient(hwnd, &mut pt) == 0 {
        return res; // 换算失败:不拦截,保持默认行为
    }
    let dpi = GetDpiForWindow(hwnd) as f64;
    if dpi <= 0.0 {
        return res;
    }
    let logical_x = pt.x as f64 * 96.0 / dpi;
    let logical_y = pt.y as f64 * 96.0 / dpi;
    if should_block(msg, res, ctx.region.contains(logical_x, logical_y)) {
        return HTTRANSPARENT as isize;
    }
    res
}

/// 纯判定(可单测):消息是 NCHITTEST、默认结果会吞掉点击、且点不在区域内 → 拦截。
fn should_block(msg: u32, def_result: isize, in_region: bool) -> bool {
    msg == WM_NCHITTEST
        && (def_result == HTCLIENT as isize || def_result == HTCAPTION as isize)
        && !in_region
}

/// 从 WM_NCHITTEST 的 lParam 取屏幕坐标(低 16 位 x、高 16 位 y,带符号)。
fn lparam_point(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam as u32 & 0xffff) as u16 as i16 as i32,
        y: ((lparam as u32 >> 16) & 0xffff) as u16 as i16 as i32,
    }
}

/// 释放子类化上下文,恰好一次(安装失败路径与 Destroyed 清理路径共享)。
fn free_ctx(raw: usize, freed: &AtomicBool) {
    if !freed.swap(true, Ordering::SeqCst) {
        // SAFETY: raw 的唯一所有权在系统子类数据与清理路径之间转移,swap 保证恰好释放一次
        drop(unsafe { Box::from_raw(raw as *mut HitTestCtx) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_block_rules() {
        // 非 NCHITTEST 消息一律不拦
        assert!(!should_block(0, HTCLIENT as isize, false));
        // 默认结果不吞点击(如 HTTRANSPARENT/边框)不拦
        assert!(!should_block(WM_NCHITTEST, HTTRANSPARENT as isize, false));
        // 客户区/拖拽区 + 点在外 → 拦
        assert!(should_block(WM_NCHITTEST, HTCLIENT as isize, false));
        assert!(should_block(WM_NCHITTEST, HTCAPTION as isize, false));
        // 区域内 → 不拦
        assert!(!should_block(WM_NCHITTEST, HTCLIENT as isize, true));
    }

    #[test]
    fn lparam_point_decodes_signed_coords() {
        let pt = lparam_point(((200i64 << 16) | 100) as isize);
        assert_eq!((pt.x, pt.y), (100, 200));
        // 负坐标(高 16 位带符号):y = -10
        let pt = lparam_point((((-10i64) << 16) | 50) as isize);
        assert_eq!((pt.x, pt.y), (50, -10));
        // x 负:0xFFF6 = -10
        let pt = lparam_point(0x0000_FFF6i64 as isize);
        assert_eq!(pt.x, -10);
    }

    #[test]
    fn free_ctx_releases_exactly_once() {
        let raw = Box::into_raw(Box::new(HitTestCtx { region: HitRegion::Full })) as usize;
        let freed = AtomicBool::new(false);
        free_ctx(raw, &freed);
        free_ctx(raw, &freed); // 第二次必须无操作(不 double free)
    }
}
