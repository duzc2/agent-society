//! 服务器就绪探测:TCP connect + 可选 /api/config/status 校验(无第三方 HTTP 依赖)。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitStatus;
use std::thread;
use std::time::{Duration, Instant};

pub const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);
pub const DEFAULT_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 端口探测:127.0.0.1:{port} 可建立 TCP 连接即认为监听中。
pub fn tcp_probe(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

/// HTTP 校验:GET /api/config/status,状态行含 " 200 " 才通过。
/// 用于区分"端口上是 Agent Society"与"端口被无关程序占用"。
pub fn http_status_probe(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = b"GET /api/config/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return false;
    }
    let head = String::from_utf8_lossy(&buf);
    head.lines().next().is_some_and(|l| l.contains(" 200 "))
}

/// 单次轮询的相位判定(纯函数,便于单测)。
/// child_status: None = 存活,Some(st) = 已退出。
#[derive(Debug)]
pub enum PhaseTrans {
    Starting,
    ReadyOwned,
    ReadyExternal,
    Failed(String),
}

pub fn decide_phase(child_status: Option<ExitStatus>, port_open: bool, http_verified: bool) -> PhaseTrans {
    match child_status {
        None => {
            if port_open {
                PhaseTrans::ReadyOwned
            } else {
                PhaseTrans::Starting
            }
        }
        Some(st) => {
            if !st.success() {
                return PhaseTrans::Failed(format!(
                    "服务器启动失败,退出码 {}",
                    st.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                ));
            }
            if !port_open {
                return PhaseTrans::Failed("服务器进程立即退出(exit=0),端口未监听".to_string());
            }
            if http_verified {
                PhaseTrans::ReadyExternal
            } else {
                PhaseTrans::Failed("端口被占用但无法确认是 Agent Society".to_string())
            }
        }
    }
}

pub struct PollConfig {
    pub interval: Duration,
    pub total_timeout: Duration,
}

impl Default for PollConfig {
    fn default() -> Self {
        PollConfig {
            interval: DEFAULT_POLL_INTERVAL,
            total_timeout: DEFAULT_TOTAL_TIMEOUT,
        }
    }
}

#[derive(Debug)]
pub enum PollOutcome {
    Ready { owned: bool },
    Failed(String),
    Timeout,
}

/// 轮询直到终态(Ready/Failed/Timeout)。child_status 每次采样子进程状态。
pub fn poll_until_terminal(
    port: u16,
    cfg: &PollConfig,
    child_status: &mut dyn FnMut() -> Option<ExitStatus>,
) -> PollOutcome {
    let start = Instant::now();
    loop {
        let st = child_status();
        let open = tcp_probe(port, PROBE_TIMEOUT);
        // http 校验只在"子进程已退出且端口可连"时需要(存活+可连已足够判定 ReadyOwned)
        let verified = st.is_some() && open && http_status_probe(port, PROBE_TIMEOUT);
        match decide_phase(st, open, verified) {
            PhaseTrans::Starting => {}
            PhaseTrans::ReadyOwned => return PollOutcome::Ready { owned: true },
            PhaseTrans::ReadyExternal => return PollOutcome::Ready { owned: false },
            PhaseTrans::Failed(reason) => return PollOutcome::Failed(reason),
        }
        if start.elapsed() >= cfg.total_timeout {
            return PollOutcome::Timeout;
        }
        thread::sleep(cfg.interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::process::Command as ProcCommand;

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn tcp_probe_open_and_closed() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(tcp_probe(port, PROBE_TIMEOUT), "监听中的端口应可连");
        drop(listener);
        assert!(!tcp_probe(port, PROBE_TIMEOUT), "已释放的端口应不可连");
    }

    fn spawn_http_responder(status_line: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                // 必须先读请求再回包:带着未读入站数据关闭 socket 会触发 RST(10054)
                // 而非正常 FIN,导致客户端 read 报"连接被重置"。真实服务器都会先读。
                let mut reqbuf = [0u8; 1024];
                let _ = s.read(&mut reqbuf);
                let _ = s.write_all(format!("HTTP/1.1 {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status_line).as_bytes());
            }
        });
        port
    }

    #[test]
    fn http_probe_ok_and_not_ok() {
        let ok_port = spawn_http_responder("200 OK");
        assert!(http_status_probe(ok_port, PROBE_TIMEOUT));
        let not_ok_port = spawn_http_responder("404 Not Found");
        assert!(!http_status_probe(not_ok_port, PROBE_TIMEOUT));
        let closed = free_port();
        assert!(!http_status_probe(closed, PROBE_TIMEOUT));
    }

    /// 起一个真实短命子进程拿到 ExitStatus(用于 decide_phase 全分支测试)
    fn exited_status(success: bool) -> ExitStatus {
        let code = if success { 0 } else { 7 };
        ProcCommand::new("cmd")
            .args(["/C", &format!("exit {}", code)])
            .status()
            .unwrap()
    }

    #[test]
    fn decide_phase_all_branches() {
        let alive: Option<ExitStatus> = None;
        // 存活 + 可连 → ReadyOwned
        assert!(matches!(decide_phase(alive, true, false), PhaseTrans::ReadyOwned));
        // 存活 + 不可连 → Starting
        assert!(matches!(decide_phase(alive, false, false), PhaseTrans::Starting));
        // exit=0 + 可连 + 校验过 → ReadyExternal
        let ok = exited_status(true);
        assert!(matches!(decide_phase(Some(ok), true, true), PhaseTrans::ReadyExternal));
        // exit=0 + 可连 + 校验不过 → Failed
        let ok = exited_status(true);
        assert!(matches!(decide_phase(Some(ok), true, false), PhaseTrans::Failed(_)));
        // exit=0 + 不可连 → Failed
        let ok = exited_status(true);
        assert!(matches!(decide_phase(Some(ok), false, false), PhaseTrans::Failed(_)));
        // exit≠0 → Failed(含退出码)
        let bad = exited_status(false);
        match decide_phase(Some(bad), false, false) {
            PhaseTrans::Failed(reason) => assert!(reason.contains('7'), "{}", reason),
            other => panic!("应判定 Failed,实际 {:?}", other),
        }
    }

    #[test]
    fn poll_times_out_on_closed_port() {
        let cfg = PollConfig {
            interval: Duration::from_millis(10),
            total_timeout: Duration::from_millis(150),
        };
        let mut alive = || None;
        assert!(matches!(
            poll_until_terminal(free_port(), &cfg, &mut alive),
            PollOutcome::Timeout
        ));
    }

    #[test]
    fn poll_ready_on_open_port_with_alive_child() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cfg = PollConfig {
            interval: Duration::from_millis(10),
            total_timeout: Duration::from_secs(2),
        };
        let mut alive = || None;
        match poll_until_terminal(port, &cfg, &mut alive) {
            PollOutcome::Ready { owned } => assert!(owned),
            other => panic!("应判定 Ready(owned),实际 {:?}", other),
        }
    }

    #[test]
    fn poll_failed_when_child_exits_nonzero() {
        let cfg = PollConfig {
            interval: Duration::from_millis(10),
            total_timeout: Duration::from_secs(2),
        };
        let mut exited = || Some(exited_status(false));
        match poll_until_terminal(free_port(), &cfg, &mut exited) {
            PollOutcome::Failed(reason) => assert!(reason.contains('7'), "{}", reason),
            other => panic!("应判定 Failed,实际 {:?}", other),
        }
    }
}
