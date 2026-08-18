//! 服务器子进程生命周期。
//!
//! Windows 上的核心设计(实测验证,勿改):
//! - spawn 用 CreateProcessW 而不是 std::Command,因为需要 STARTUPINFO 控制:
//!   `STARTF_USESHOWWINDOW + SW_HIDE` 让子进程的**控制台窗口从创建起就是隐藏的**
//!   (满足"无终端窗口"),同时子进程**拥有控制台**——这是优雅关闭信号送达的前提。
//! - `CREATE_NEW_PROCESS_GROUP`:进程组 id == 子进程 pid,信号可定向送达。
//! - 退出信号:GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) 的送达前提是
//!   调用方与目标进程组共享同一控制台。GUI 无控制台 → 先 AttachConsole(pid)
//!   加入子进程的控制台再发,然后 FreeConsole。Node 将 Ctrl+Break 映射为
//!   SIGBREAK,服务器与 Ctrl+C 走同一条六阶段优雅关闭链。
//! - 实测:直接定向调用(CREATE_NO_WINDOW 无控制台子进程)返回值成功但**不送达**,
//!   这就是为什么子进程必须有(隐藏)控制台。

use crate::logging::FileLogger;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const RECENT_CAP: usize = 200;

/// 子进程最近输出环形缓冲(失败诊断与 SIGBREAK 送达判断用)
pub type RecentOutput = Arc<Mutex<VecDeque<String>>>;

#[cfg(windows)]
mod win_child {
    use super::FileLogger;
    use std::os::windows::process::ExitStatusExt;
    use std::process::ExitStatus;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess};

    /// 裸 CreateProcess 句柄的子进程包装(替代 std::process::Child,
    /// 因为 std 的 spawn 无法控制 STARTUPINFO 的隐藏控制台)。
    pub struct WinChild {
        pid: u32,
        handle: HANDLE,
    }

    impl WinChild {
        pub fn new(pid: u32, handle: HANDLE) -> Self {
            WinChild { pid, handle }
        }

        pub fn id(&self) -> u32 {
            self.pid
        }

        /// None = 仍存活;出错记日志并按仍存活处理。
        pub fn try_wait(&self, logger: &FileLogger) -> Option<ExitStatus> {
            let mut code: u32 = 0;
            if unsafe { GetExitCodeProcess(self.handle, &mut code) } == 0 {
                logger.error(
                    "GetExitCodeProcess 失败",
                    Some(&format!(
                        "pid={} GetLastError={}",
                        self.pid,
                        unsafe { GetLastError() }
                    )),
                );
                return None;
            }
            if code as i32 == STILL_ACTIVE {
                None
            } else {
                Some(ExitStatus::from_raw(code))
            }
        }

        /// 强杀(非优雅路径,调用前必须先尝试优雅信号)。
        pub fn terminate_and_wait(&self, logger: &FileLogger) -> Option<ExitStatus> {
            if unsafe { TerminateProcess(self.handle, 1) } == 0 {
                logger.error(
                    "TerminateProcess 失败",
                    Some(&format!(
                        "pid={} GetLastError={}",
                        self.pid,
                        unsafe { GetLastError() }
                    )),
                );
            }
            // 终止是异步的,轮询直到退出码可用
            for _ in 0..100 {
                if let Some(st) = self.try_wait(logger) {
                    return Some(st);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            logger.error("强杀后子进程仍未退出", Some(&format!("pid={}", self.pid)));
            None
        }
    }

    impl Drop for WinChild {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    // 进程句柄由本结构独占管理(Drop 时 CloseHandle),跨线程安全(std::process::Child 同模式)
    unsafe impl Send for WinChild {}
    unsafe impl Sync for WinChild {}
}

#[cfg(windows)]
pub use win_child::WinChild;

#[cfg(windows)]
pub type ServerChild = WinChild;

#[cfg(not(windows))]
pub type ServerChild = std::process::Child;

#[cfg(windows)]
fn build_env_block(overrides: &[(&str, &str)]) -> Vec<u16> {
    use std::collections::HashMap;
    use std::ffi::OsString;
    let mut map: HashMap<OsString, OsString> = std::env::vars_os().collect();
    for (k, v) in overrides {
        map.insert(OsString::from(k), OsString::from(v));
    }
    // CreateProcessW 文档要求:环境块必须按字母序(Unicode 序,大小写不敏感)排列,
    // 否则报 ERROR_INVALID_PARAMETER(87)。vars_os() 无序,必须显式排序。
    let mut entries: Vec<(OsString, OsString)> = map.into_iter().collect();
    entries.sort_by(|a, b| {
        a.0.to_string_lossy()
            .to_uppercase()
            .cmp(&b.0.to_string_lossy().to_uppercase())
    });
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in entries {
        block.extend(k.to_string_lossy().encode_utf16());
        block.push('=' as u16);
        block.extend(v.to_string_lossy().encode_utf16());
        block.push(0);
    }
    block.push(0); // 双 null 终止
    block
}

/// Windows 底层 spawn:隐藏控制台 + 新进程组 + stdout/stderr 管道。
/// 返回 (子进程, stdout 文件, stderr 文件)。
#[cfg(windows)]
fn spawn_windows_child(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    env_overrides: &[(&str, &str)],
) -> Result<(WinChild, Option<std::fs::File>, Option<std::fs::File>), String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetHandleInformation, HANDLE_FLAG_INHERIT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_UNICODE_ENVIRONMENT, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES,
        STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    // 管道:子进程端可继承,父进程读端不可继承
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut out_read, mut out_write) = (std::ptr::null_mut(), std::ptr::null_mut());
    let (mut err_read, mut err_write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut out_read, &mut out_write, &mut sa, 0) } == 0 {
        return Err(format!(
            "CreatePipe(stdout) 失败 GetLastError={}",
            unsafe { GetLastError() }
        ));
    }
    if unsafe { CreatePipe(&mut err_read, &mut err_write, &mut sa, 0) } == 0 {
        let e = unsafe { GetLastError() };
        unsafe {
            CloseHandle(out_read);
            CloseHandle(out_write);
        }
        return Err(format!("CreatePipe(stderr) 失败 GetLastError={}", e));
    }
    if unsafe { SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(err_read, HANDLE_FLAG_INHERIT, 0) } == 0
    {
        let e = unsafe { GetLastError() };
        unsafe {
            CloseHandle(out_read);
            CloseHandle(out_write);
            CloseHandle(err_read);
            CloseHandle(err_write);
        }
        return Err(format!("SetHandleInformation 失败 GetLastError={}", e));
    }

    // 命令行:首个 token 加引号(路径可能含空格);lpApplicationName=NULL → PATH 查找。
    // 含空白/引号的参数必须按 CRT 规则加引号,否则会被解析器切成多个 token。
    // 本项目实际参数(start-wrapper.mjs / --no-browser)不含空格,引号逻辑为通用正确性而设。
    let mut cmdline = format!("\"{}\"", program.display());
    for a in args {
        cmdline.push(' ');
        if a.contains(char::is_whitespace) || a.contains('"') {
            cmdline.push('"');
            cmdline.push_str(&a.replace('"', "\\\""));
            cmdline.push('"');
        } else {
            cmdline.push_str(a);
        }
    }
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().collect();
    cmdline_w.push(0);

    let env_block = build_env_block(env_overrides);
    let cwd_w: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        let mut v: Vec<u16> = cwd.as_os_str().encode_wide().collect();
        v.push(0);
        v
    };

    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE as u16; // 控制台窗口从创建起即隐藏
    si.hStdOutput = out_write;
    si.hStdError = err_write;
    si.hStdInput = std::ptr::null_mut();
    let mut pi: windows_sys::Win32::System::Threading::PROCESS_INFORMATION =
        unsafe { std::mem::zeroed() };

    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(), // lpApplicationName → 走 PATH 查找
            cmdline_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1, // bInheritHandles → 管道写端可继承
            // CREATE_NEW_PROCESS_GROUP: 组 id == pid;不设 CREATE_NO_WINDOW → 子进程有隐藏控制台
            // CREATE_UNICODE_ENVIRONMENT: 必设——否则 UTF-16 环境块被按 ANSI 解析
            // (实测 Win11 26200 上直接报 ERROR_INVALID_PARAMETER 87)
            CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr() as *const std::ffi::c_void,
            cwd_w.as_ptr(),
            &mut si,
            &mut pi,
        )
    };
    if ok == 0 {
        let e = unsafe { GetLastError() };
        unsafe {
            CloseHandle(out_read);
            CloseHandle(out_write);
            CloseHandle(err_read);
            CloseHandle(err_write);
        }
        return Err(format!("CreateProcessW 失败({}): GetLastError={}", cmdline, e));
    }
    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(out_write); // 父进程侧写端
        CloseHandle(err_write);
    }
    let stdout_file = if out_read.is_null() {
        None
    } else {
        Some(unsafe { std::fs::File::from_raw_handle(out_read as std::os::windows::raw::HANDLE) })
    };
    let stderr_file = if err_read.is_null() {
        None
    } else {
        Some(unsafe { std::fs::File::from_raw_handle(err_read as std::os::windows::raw::HANDLE) })
    };
    Ok((WinChild::new(pi.dwProcessId, pi.hProcess), stdout_file, stderr_file))
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 启动服务器子进程。复刻 start.cmd 的环境变量与启动参数(--no-browser,不传 --port)。
#[cfg(windows)]
pub fn spawn_server(
    node: &Path,
    server_root: &Path,
    logger: &FileLogger,
    recent: &RecentOutput,
) -> Result<ServerChild, String> {
    let (child, stdout_file, stderr_file) = spawn_windows_child(
        node,
        &["start-wrapper.mjs", "--no-browser"],
        server_root,
        &[
            ("NODE_OPTIONS", "--max-old-space-size=4096 --expose-gc"),
            ("AGENT_SOCIETY_GC_INTERVAL_MS", "300000"),
        ],
    )?;
    let pid = child.id();
    if let Some(out) = stdout_file {
        spawn_drain(out, logger.clone(), "[node:stdout]", recent.clone());
    }
    if let Some(err) = stderr_file {
        spawn_drain(err, logger.clone(), "[node:stderr]", recent.clone());
    }
    logger.info(
        "服务器子进程已启动(隐藏控制台)",
        Some(&format!(
            "node={} pid={} cwd={}",
            node.display(),
            pid,
            server_root.display()
        )),
    );
    Ok(child)
}

/// 非 Windows 平台的等价实现(std Command;本应用只面向 Windows,此路径未实测)。
#[cfg(not(windows))]
pub fn spawn_server(
    node: &Path,
    server_root: &Path,
    logger: &FileLogger,
    recent: &RecentOutput,
) -> Result<ServerChild, String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(node)
        .args(["start-wrapper.mjs", "--no-browser"])
        .current_dir(server_root)
        .env("NODE_OPTIONS", "--max-old-space-size=4096 --expose-gc")
        .env("AGENT_SOCIETY_GC_INTERVAL_MS", "300000")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn node 失败({}): {}", node.display(), e))?;
    let pid = child.id();
    if let Some(out) = child.stdout.take() {
        spawn_drain(out, logger.clone(), "[node:stdout]", recent.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_drain(err, logger.clone(), "[node:stderr]", recent.clone());
    }
    logger.info(
        "服务器子进程已启动",
        Some(&format!(
            "node={} pid={} cwd={}",
            node.display(),
            pid,
            server_root.display()
        )),
    );
    Ok(child)
}

/// 管道必须持续排空,否则子进程写满管道缓冲(64KB)后会阻塞在 stdout 写入上。
fn spawn_drain<R: Read + Send + 'static>(
    r: R,
    logger: FileLogger,
    tag: &'static str,
    recent: RecentOutput,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(r);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    logger.info(&text, Some(tag));
                    let mut q = recent.lock().unwrap();
                    if q.len() >= RECENT_CAP {
                        q.pop_front();
                    }
                    q.push_back(text);
                }
                Err(e) => {
                    logger.error(&format!("读取子进程输出流失败: {}", e), Some(tag));
                    break;
                }
            }
        }
    });
}

/// 强制终止(非优雅路径,调用前必须先尝试优雅信号)。
#[cfg(windows)]
pub fn force_kill(child: &ServerChild, logger: &FileLogger) {
    let pid = child.id();
    match child.terminate_and_wait(logger) {
        Some(st) => logger.warn(
            "优雅关闭失败,已强制终止服务器子进程(状态可能未持久化)",
            Some(&format!("pid={} exit={:?}", pid, st.code())),
        ),
        None => logger.error(
            "强制终止服务器子进程失败",
            Some(&format!("pid={}", pid)),
        ),
    }
}

#[cfg(not(windows))]
pub fn force_kill(child: &mut ServerChild, logger: &FileLogger) {
    let pid = child.id();
    match child.kill() {
        Ok(()) => {
            let _ = child.wait();
            logger.warn(
                "优雅关闭失败,已强制终止服务器子进程(状态可能未持久化)",
                Some(&format!("pid={}", pid)),
            );
        }
        Err(e) => logger.error(
            &format!("强制终止子进程失败: {}", e),
            Some(&format!("pid={}", pid)),
        ),
    }
}

/// 直接定向发送 CTRL_BREAK(调用方与目标同控制台时生效;返回值不可靠,
/// 送达与否由调用方以"进程退出/输出标记"验证)。
#[cfg(windows)]
pub fn send_ctrl_break_direct(pid: u32, logger: &FileLogger) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    let r = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) };
    if r != 0 {
        logger.info(
            "已发送 CTRL_BREAK(直接定向)",
            Some(&format!("pid={}", pid)),
        );
    } else {
        logger.error(
            "直接定向 CTRL_BREAK 调用失败",
            Some(&format!("pid={} GetLastError={}", pid, unsafe { GetLastError() })),
        );
    }
}

/// 附加到子进程的(隐藏)控制台后定向发送 CTRL_BREAK——GUI 无控制台时的主路径。
/// 定向到进程组(pid),不会波及调用方自身。
#[cfg(windows)]
pub fn send_ctrl_break_via_attach(pid: u32, logger: &FileLogger) -> bool {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT,
    };
    unsafe {
        if AttachConsole(pid) == 0 {
            logger.error(
                "AttachConsole 失败",
                Some(&format!("pid={} GetLastError={}", pid, GetLastError())),
            );
            return false;
        }
        let r = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
        let e = GetLastError();
        FreeConsole();
        if r != 0 {
            logger.info(
                "已发送 CTRL_BREAK(附加控制台定向)",
                Some(&format!("pid={}", pid)),
            );
            true
        } else {
            logger.error(
                "附加控制台后 CTRL_BREAK 调用失败",
                Some(&format!("pid={} GetLastError={}", pid, e)),
            );
            false
        }
    }
}

/// node 来源:dev → 系统 PATH 的 node;release → 包内 sidecar。
/// release 下 sidecar 缺失时返回 Err,**绝不静默回退系统 node**。
pub fn resolve_node(is_dev: bool, exe_dir: &Path, logger: &FileLogger) -> Result<PathBuf, String> {
    if is_dev {
        logger.info("node 来源: 系统 PATH(dev 模式)", None);
        return Ok(PathBuf::from("node"));
    }
    for name in ["node.exe", "node-x86_64-pc-windows-msvc.exe"] {
        let p = exe_dir.join(name);
        if p.is_file() {
            logger.info("node 来源: 包内 sidecar", Some(&p.display().to_string()));
            return Ok(p);
        }
    }
    let msg = "包内 node.exe 缺失,请重新安装".to_string();
    logger.error(&msg, Some(&format!("已检查目录: {}", exe_dir.display())));
    Err(msg)
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 核心风险验证:CTRL_BREAK 必须真正送达隐藏控制台 + 新进程组的子进程
    /// (而不是像 CREATE_NO_WINDOW 无控制台子进程那样"调用成功但不送达")。
    /// 环境无 node 时跳过(打印说明,不视为失败)。
    #[test]
    fn ctrl_break_reaches_hidden_console_child() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("SKIP: 环境无 node,跳过 CTRL_BREAK 送达测试");
            return;
        }
        let log_path = std::env::temp_dir().join(format!(
            "asl-test-ctrlbreak-{}.log",
            std::process::id()
        ));
        let logger = FileLogger::open(log_path, 1024 * 1024);

        let (child, stdout_file, _stderr_file) = spawn_windows_child(
            Path::new("node"),
            &[
                "-e",
                "process.on('SIGBREAK',()=>{console.log('GOT_SIGBREAK');process.exit(0)});setInterval(()=>{},1000)",
            ],
            &std::env::temp_dir(),
            &[],
        )
        .expect("spawn node 失败");
        let pid = child.id();
        // 等 1s 确保子进程的 SIGBREAK 处理器注册完成
        std::thread::sleep(Duration::from_secs(1));

        send_ctrl_break_direct(pid, &logger);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            if let Some(st) = child.try_wait(&logger) {
                exited = true;
                assert!(st.success(), "子进程应以 exit 0 退出");
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !exited {
            let _ = child.terminate_and_wait(&logger);
            panic!("CTRL_BREAK 未在 5s 内送达(子进程未退出)");
        }
        let mut out = String::new();
        if let Some(mut so) = stdout_file {
            use std::io::Read;
            let _ = so.read_to_string(&mut out);
        }
        assert!(
            out.contains("GOT_SIGBREAK"),
            "子进程应收到 SIGBREAK,实际 stdout: {}",
            out
        );
    }

    /// 集成测试(#[ignore],约 1 分钟):真实服务器完整优雅关闭链。
    /// 前置:能解析到服务器根目录且端口空闲;不满足则跳过。
    /// 链路:spawn(隐藏控制台)→ 等端口就绪 → CTRL_BREAK → 等退出
    /// → 断言 exit 0 + shutdown.log 有优雅关闭记录 + 端口释放。
    #[test]
    #[ignore]
    fn graceful_shutdown_with_real_server() {
        let exe_dir = std::env::current_exe()
            .expect("exe 路径")
            .parent()
            .expect("父目录")
            .to_path_buf();
        let server_root = match crate::config_resolver::resolve_server_root(&exe_dir, 10) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("SKIP: 无法解析服务器根目录: {}", e);
                return;
            }
        };
        let (port, _source) = crate::config_resolver::resolve_http_port(&server_root);
        if crate::readiness::tcp_probe(port, Duration::from_millis(300)) {
            eprintln!("SKIP: 端口 {} 已被占用(服务器可能已在运行)", port);
            return;
        }
        let log_path = std::env::temp_dir().join(format!(
            "asl-test-integration-{}.log",
            std::process::id()
        ));
        let logger = FileLogger::open(log_path, 4 * 1024 * 1024);
        let recent: RecentOutput = Arc::new(Mutex::new(VecDeque::new()));

        let (child, stdout_file, stderr_file) = spawn_windows_child(
            Path::new("node"),
            &["start-wrapper.mjs", "--no-browser"],
            &server_root,
            &[
                ("NODE_OPTIONS", "--max-old-space-size=4096 --expose-gc"),
                ("AGENT_SOCIETY_GC_INTERVAL_MS", "300000"),
            ],
        )
        .expect("spawn 真实服务器失败");
        let pid = child.id();
        if let Some(out) = stdout_file {
            spawn_drain(out, logger.clone(), "[node:stdout]", recent.clone());
        }
        if let Some(err) = stderr_file {
            spawn_drain(err, logger.clone(), "[node:stderr]", recent.clone());
        }

        // 等端口就绪 ≤120s
        let ready_deadline = std::time::Instant::now() + Duration::from_secs(120);
        let mut ready = false;
        while std::time::Instant::now() < ready_deadline {
            if crate::readiness::tcp_probe(port, Duration::from_millis(500)) {
                ready = true;
                break;
            }
            if child.try_wait(&logger).is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(ready, "服务器 120s 内未就绪(端口 {})", port);

        // 发信号(测试进程自带控制台,子进程继承同一控制台 → 直接定向可送达)
        send_ctrl_break_direct(pid, &logger);

        // 等退出 ≤60s(六阶段清理最坏 ~50s)
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(st) = child.try_wait(&logger) {
                break Some(st);
            }
            if std::time::Instant::now() >= exit_deadline {
                let _ = child.terminate_and_wait(&logger);
                panic!("CTRL_BREAK 后 60s 未退出");
            }
            std::thread::sleep(Duration::from_millis(500));
        };
        let st = status.expect("子进程状态");
        assert!(
            st.success(),
            "服务器应以 exit 0 优雅退出,实际 exit={:?}",
            st.code()
        );

        // shutdown.log 应有优雅关闭记录
        let shutdown_log = server_root
            .join("agent-society-data")
            .join("logs")
            .join("shutdown.log");
        let content = std::fs::read_to_string(&shutdown_log)
            .unwrap_or_else(|e| format!("(读取失败: {})", e));
        assert!(
            content.contains("优雅关闭完成") || content.contains("SIGBREAK"),
            "shutdown.log 应含优雅关闭记录,实际: {}",
            &content[content.len().saturating_sub(2000)..]
        );

        // 端口应已释放
        assert!(
            !crate::readiness::tcp_probe(port, Duration::from_millis(300)),
            "端口 {} 未释放",
            port
        );
    }

    /// spawn 参数正确性:环境变量覆盖生效、cwd 生效(用 node 打印验证)。
    #[test]
    fn spawn_env_and_cwd_applied() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("SKIP: 环境无 node,跳过 spawn 参数测试");
            return;
        }
        let log_path = std::env::temp_dir().join(format!(
            "asl-test-spawn-{}.log",
            std::process::id()
        ));
        let logger = FileLogger::open(log_path, 1024 * 1024);
        let cwd = std::env::temp_dir();

        let (child, stdout_file, stderr_file) = spawn_windows_child(
            Path::new("node"),
            &["-e", "console.log(process.env.ASL_TEST_VAR + '|' + process.cwd())"],
            &cwd,
            &[("ASL_TEST_VAR", "hello-42")],
        )
        .expect("spawn node 失败");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(st) = child.try_wait(&logger) {
                break Some(st);
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.terminate_and_wait(&logger);
                panic!("子进程 10s 未退出");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut out = String::new();
        if let Some(mut so) = stdout_file {
            use std::io::Read;
            let _ = so.read_to_string(&mut out);
        }
        let mut err_out = String::new();
        if let Some(mut se) = stderr_file {
            use std::io::Read;
            let _ = se.read_to_string(&mut err_out);
        }
        let st = status.expect("子进程状态");
        assert!(
            st.success(),
            "子进程应以 exit 0 退出,实际 exit={:?}, stderr: {}",
            st.code(),
            err_out
        );
        assert!(
            out.contains("hello-42|"),
            "环境变量覆盖应生效,实际 stdout: {}",
            out
        );
        // temp_dir() 返回带尾分隔符的路径,而子进程 cwd 是传入值原样(无尾分隔符)
        let cwd_display = cwd
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_string();
        assert!(
            out.trim().ends_with(&cwd_display),
            "cwd 应生效,实际 stdout: {:?},期望结尾: {:?}",
            out,
            cwd_display
        );
    }
}
