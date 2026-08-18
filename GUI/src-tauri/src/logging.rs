//! 启动器文件日志:append + 大小上限轮转。
//! 工程铁律:所有 catch 必须先经此记录 message + 来源链 + 上下文,禁止静默吞异常。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAX_BYTES: u64 = 1024 * 1024; // 1MB

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

struct LogState {
    file: File,
    written: u64,
}

/// 可克隆的文件日志器,克隆共享同一文件句柄;多线程写经内部 Mutex 串行化。
#[derive(Clone)]
pub struct FileLogger {
    path: PathBuf,
    max_bytes: u64,
    inner: Arc<Mutex<LogState>>,
}

fn open_append(path: &Path, written: &mut u64) -> File {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|e| panic!("创建日志目录失败 {}: {}", parent.display(), e));
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap_or_else(|e| panic!("打开日志文件失败 {}: {}", path.display(), e));
    *written = file.metadata().map(|m| m.len()).unwrap_or(0);
    file
}

impl FileLogger {
    /// 按运行模式选择日志目录:
    /// - dev: {serverRoot}/GUI/logs/launcher.log(serverRoot 未知则 {exe_dir}/logs/launcher.log)
    /// - release: %APPDATA%/AgentSocietyLauncher/logs/launcher.log(缺失则 {exe_dir}/logs/launcher.log)
    pub fn init(is_dev: bool, server_root: Option<&Path>, exe_dir: &Path) -> FileLogger {
        let path = if is_dev {
            server_root
                .map(|r| r.join("GUI").join("logs").join("launcher.log"))
                .unwrap_or_else(|| exe_dir.join("logs").join("launcher.log"))
        } else {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|p| p.join("AgentSocietyLauncher").join("logs").join("launcher.log"))
                .unwrap_or_else(|| exe_dir.join("logs").join("launcher.log"))
        };
        FileLogger::open(path, DEFAULT_MAX_BYTES)
    }

    /// 打开指定路径的日志文件;父目录不存在则创建;打开时超限即轮转为 .old。
    pub fn open(path: PathBuf, max_bytes: u64) -> FileLogger {
        let mut written = 0u64;
        let file = open_append(&path, &mut written);
        let mut state = LogState { file, written };
        if state.written > max_bytes {
            rotate(&path, &mut state);
        }
        FileLogger {
            path,
            max_bytes,
            inner: Arc::new(Mutex::new(state)),
        }
    }

    pub fn log(&self, level: Level, msg: &str, ctx: Option<&str>) {
        let mut line = format!("{} [{}] {}", utc_timestamp(), level.as_str(), msg);
        if let Some(c) = ctx {
            line.push_str(" | ctx=");
            line.push_str(c);
        }
        line.push('\n');

        let mut st = self.inner.lock().unwrap(); // 锁中毒即内部 bug,直接暴露
        if st.written + line.len() as u64 > self.max_bytes {
            rotate(&self.path, &mut st);
        }
        if let Err(e) = st.file.write_all(line.as_bytes()) {
            eprintln!("[launcher] 写日志失败: {}", e);
        }
        st.written += line.len() as u64;
    }

    /// 记录错误及其完整 source 链(message + caused by 链),ctx 为业务上下文。
    pub fn error_chain(&self, ctx: &str, err: &(dyn std::error::Error + 'static)) {
        let mut parts = vec![err.to_string()];
        let mut cur = err.source();
        let mut depth = 0;
        while let Some(e) = cur {
            if depth >= 10 {
                parts.push("caused by: ...(截断)".to_string());
                break;
            }
            parts.push(format!("caused by: {}", e));
            cur = e.source();
            depth += 1;
        }
        self.log(Level::Error, &parts.join("; "), Some(ctx));
    }

    pub fn debug(&self, msg: &str, ctx: Option<&str>) {
        self.log(Level::Debug, msg, ctx)
    }

    /// 日志目录(供 server.pid 等伴生文件使用)
    pub fn log_dir(&self) -> &Path {
        self.path.parent().expect("日志路径无父目录")
    }

    pub fn info(&self, msg: &str, ctx: Option<&str>) {
        self.log(Level::Info, msg, ctx)
    }

    pub fn warn(&self, msg: &str, ctx: Option<&str>) {
        self.log(Level::Warn, msg, ctx)
    }

    pub fn error(&self, msg: &str, ctx: Option<&str>) {
        self.log(Level::Error, msg, ctx)
    }
}

/// 把当前日志文件轮转为 launcher.log.old 并重开新文件;失败时保留旧文件继续追加(不丢日志)。
fn rotate(path: &Path, state: &mut LogState) {
    let old = path.with_extension("log.old");
    if fs::rename(path, &old).is_ok() {
        state.file = open_append(path, &mut state.written);
    } else {
        eprintln!(
            "[launcher] 日志轮转失败(rename): {} -> {}",
            path.display(),
            old.display()
        );
    }
}

/// UTC 时间戳,格式 `2026-08-19T10:00:00.123Z`(不引 chrono)。
fn utc_timestamp() -> String {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        dur.subsec_millis()
    )
}

/// Howard Hinnant 的 civil_from_days 算法:自 1970-01-01 起的天数 → (年, 月, 日)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("asl-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-01-01 距 1970-01-01 共 19723 天(1970..2023 含 13 个闰年)
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 2024-02-29(闰日)
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn timestamp_format() {
        let ts = utc_timestamp();
        assert_eq!(ts.len(), 24);
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.as_bytes()[10], b'T');
        assert_eq!(ts.as_bytes()[13], b':');
        assert_eq!(ts.as_bytes()[16], b':');
        assert_eq!(ts.as_bytes()[19], b'.');
    }

    #[test]
    fn log_within_limit_no_rotation() {
        let dir = temp_dir("log-ok");
        let path = dir.join("launcher.log");
        let logger = FileLogger::open(path.clone(), 1024);
        for i in 0..10 {
            logger.info(&format!("line {}", i), Some("测试"));
        }
        assert!(!dir.join("launcher.log.old").exists());
        let size = fs::metadata(&path).unwrap().len();
        assert!(size <= 1024, "超出上限仍未轮转: {}", size);
    }

    #[test]
    fn log_over_limit_rotates() {
        let dir = temp_dir("log-rotate");
        let path = dir.join("launcher.log");
        let logger = FileLogger::open(path.clone(), 1024);
        let line = "x".repeat(64);
        for _ in 0..100 {
            logger.info(&line, None);
        }
        assert!(dir.join("launcher.log.old").exists(), "未生成轮转文件");
        let size = fs::metadata(&path).unwrap().len();
        assert!(size <= 1024, "轮转后仍超上限: {}", size);
    }

    #[test]
    fn error_chain_includes_sources() {
        let dir = temp_dir("log-chain");
        let logger = FileLogger::open(dir.join("launcher.log"), 64 * 1024);
        let inner = std::io::Error::new(std::io::ErrorKind::NotFound, "文件不存在");
        let outer = std::io::Error::new(std::io::ErrorKind::Other, inner);
        logger.error_chain("测试上下文", &outer);
        let content = fs::read_to_string(dir.join("launcher.log")).unwrap();
        assert!(content.contains("文件不存在"), "缺失根因: {}", content);
        assert!(content.contains("测试上下文"));
    }

    #[test]
    fn open_rotates_existing_oversized_file() {
        let dir = temp_dir("log-open-rotate");
        let path = dir.join("launcher.log");
        fs::write(&path, "y".repeat(5000)).unwrap();
        let _logger = FileLogger::open(path.clone(), 1024);
        assert!(dir.join("launcher.log.old").exists());
        let size = fs::metadata(&path).unwrap().len();
        assert!(size <= 1024);
    }
}
