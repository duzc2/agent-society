//! 监视窗口数据源:POST /api/heartbeat 心跳队列客户端(org_tree 消息 → 智能体计数)。
//!
//! 协议依据(服务器源码):
//! - `http_server/heartbeat.js`:`POST /api/heartbeat`,body `{"lastMessageId":N}`,
//!   响应 `{"messages":[{messageId,type,payload}],"needRefresh":bool?}`;
//! - `heartbeat_broker.js`:无客户端状态、全局递增 messageId(从 1 开始),
//!   drain(lastMessageId) 只返回更大的消息;needRefresh = 客户端序列号来自上一服务器会话;
//! - `http_server/agents.js` buildOrgTree:org_tree 消息 payload = {tree,nodeCount},
//!   节点含 `status`(active/deleted)与 `computeStatus`
//!   (idle|waiting_llm|processing|stopping|stopped|terminating,定义于 runtime_state.js);
//! - org_tree 无 TTL 常驻,org 数据变更与 computeStatus 变更时替换重推(agent_manager.js)。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const MONITOR_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

/// 智能体统计。
/// total = 组织树中 status != "deleted" 的节点(含 root/user,与 web 组织树口径一致);
/// working = computeStatus 为 processing / waiting_llm 的节点(真正在运算中的状态;
/// stopping/stopped/terminating 是消亡过渡态,不计入"工作中")。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCounts {
    pub total: u64,
    pub working: u64,
}

/// 心跳客户端状态:lastMessageId 从 0 开始;needRefresh(服务器重启,序列号重置)时归零,
/// 下一轮 drain(0) 重取全量。
#[derive(Debug, Default)]
pub struct HeartbeatClient {
    last_message_id: u64,
}

impl HeartbeatClient {
    pub fn new() -> Self {
        Self::default()
    }
}

/// 递归遍历 org_tree 节点计数(纯函数,便于单测)。
fn count_org_tree(payload: &serde_json::Value) -> AgentCounts {
    let mut counts = AgentCounts { total: 0, working: 0 };
    fn walk(node: &serde_json::Value, counts: &mut AgentCounts) {
        let status = node.get("status").and_then(|s| s.as_str()).unwrap_or("active");
        // deleted 节点既不算"存在"也不算"工作中"(其余子树仍递归,与 web 组织树一致)
        if status != "deleted" {
            counts.total += 1;
            let compute = node
                .get("computeStatus")
                .and_then(|s| s.as_str())
                .unwrap_or("idle");
            if compute == "processing" || compute == "waiting_llm" {
                counts.working += 1;
            }
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                walk(child, counts);
            }
        }
    }
    if let Some(tree) = payload.get("tree").and_then(|t| t.as_array()) {
        for node in tree {
            walk(node, &mut counts);
        }
    }
    counts
}

/// 解析 /api/heartbeat 响应体,推进 lastMessageId,返回最新一条 org_tree 的计数。
/// - needRefresh → lastMessageId 归零(服务器重启,下轮重取全量);
/// - messages 按升序,lastMessageId 取最大 messageId;
/// - 本轮没有 org_tree → Ok(None)(计数保持上次值,由调用方处理)。
pub fn parse_heartbeat_response(
    body: &str,
    client: &mut HeartbeatClient,
) -> Result<Option<AgentCounts>, String> {
    let root: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("心跳响应非法 JSON: {}", e))?;
    if root
        .get("needRefresh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        client.last_message_id = 0;
    }
    let Some(messages) = root.get("messages").and_then(|m| m.as_array()) else {
        return Ok(None);
    };
    let mut counts = None;
    for msg in messages {
        if let Some(id) = msg.get("messageId").and_then(|v| v.as_u64()) {
            if id > client.last_message_id {
                client.last_message_id = id;
            }
        }
        if msg.get("type").and_then(|t| t.as_str()) == Some("org_tree") {
            if let Some(payload) = msg.get("payload") {
                counts = Some(count_org_tree(payload));
            }
        }
    }
    Ok(counts)
}

/// POST /api/heartbeat 一次,成功返回最新 org_tree 计数(可能为 None)。
/// 连接失败/超时/非 200/解析失败 → Err(带上下文)。调用方按"繁忙容忍"处理:
/// HTTP 层面的失败不构成"服务器关闭"的判定(退出判定属于心跳线程的三态 TCP 探测)。
pub fn fetch_heartbeat(
    port: u16,
    client: &mut HeartbeatClient,
) -> Result<Option<AgentCounts>, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, MONITOR_HTTP_TIMEOUT)
        .map_err(|e| format!("心跳连接失败: {}", e))?;
    stream
        .set_read_timeout(Some(MONITOR_HTTP_TIMEOUT))
        .map_err(|e| format!("设置读超时失败: {}", e))?;
    stream
        .set_write_timeout(Some(MONITOR_HTTP_TIMEOUT))
        .map_err(|e| format!("设置写超时失败: {}", e))?;
    let body = format!("{{\"lastMessageId\":{}}}", client.last_message_id);
    let req = format!(
        "POST /api/heartbeat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("心跳请求发送失败: {}", e))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("心跳响应读取失败: {}", e))?;
    let head_end = find_header_end(&buf);
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let status_line = head.lines().next().unwrap_or("(空状态行)");
    if !status_line.contains(" 200 ") {
        return Err(format!("心跳响应非 200: {}", status_line));
    }
    // 实体定界按服务器实际选择解码(实测 Hono/Node 对大 JSON 用 chunked)
    let body_bytes = decode_http_body(&head, &buf[head_end + 4..])?;
    let body_str =
        std::str::from_utf8(&body_bytes).map_err(|e| format!("心跳响应体非 UTF-8: {}", e))?;
    parse_heartbeat_response(body_str, client)
}

/// 找响应头结束位置("\r\n\r\n");找不到时返回整体长度(空体)。
fn find_header_end(buf: &[u8]) -> usize {
    (0..buf.len().saturating_sub(3))
        .find(|&i| buf[i] == b'\r' && buf[i + 1] == b'\n' && buf[i + 2] == b'\r' && buf[i + 3] == b'\n')
        .unwrap_or(buf.len())
}

/// 按 Content-Length 或 Transfer-Encoding: chunked 解码响应体(两者都没有时原样返回)。
/// 依据:实测 Hono/Node 对本接口的 JSON 响应为 `Transfer-Encoding: chunked`。
fn decode_http_body(head: &str, raw: &[u8]) -> Result<Vec<u8>, String> {
    if let Some(te) = header_value(head, "transfer-encoding") {
        if te.to_ascii_lowercase().contains("chunked") {
            return decode_chunked(raw);
        }
    }
    if let Some(cl) = header_value(head, "content-length") {
        let n: usize = cl
            .parse()
            .map_err(|e| format!("Content-Length 非法: {} ({})", cl, e))?;
        if n <= raw.len() {
            return Ok(raw[..n].to_vec());
        }
    }
    Ok(raw.to_vec())
}

/// 大小写不敏感取响应头字段值。
fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim().eq_ignore_ascii_case(name) {
            Some(v.trim())
        } else {
            None
        }
    })
}

/// 解码 chunked 传输编码体:
/// 每块 = 十六进制大小行(可带 ;扩展)+ CRLF + 数据 + CRLF;0 块结束(trailers 忽略)。
fn decode_chunked(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        let line_end = find_crlf(raw, pos).ok_or_else(|| "chunked 编码缺少大小行".to_string())?;
        let size_line = std::str::from_utf8(&raw[pos..line_end])
            .map_err(|e| format!("chunk 大小行非 UTF-8: {}", e))?;
        let size_str = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_str, 16)
            .map_err(|e| format!("chunk 大小非法: {} ({})", size_str, e))?;
        pos = line_end + 2;
        if size == 0 {
            return Ok(out);
        }
        if pos + size + 2 > raw.len() {
            return Err("chunked 编码数据不完整".to_string());
        }
        out.extend_from_slice(&raw[pos..pos + size]);
        pos += size + 2;
    }
}

fn find_crlf(raw: &[u8], from: usize) -> Option<usize> {
    (from..raw.len().saturating_sub(1)).find(|&i| raw[i] == b'\r' && raw[i + 1] == b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn org_tree_node(id: &str, status: &str, compute: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "status": status, "computeStatus": compute, "children": []
        })
    }

    #[test]
    fn count_org_tree_recursively_with_deleted_and_working() {
        // root(active/idle) → child1(active/processing) → grand(active/waiting_llm);
        // child2(deleted/processing) 不计入 total;root 与 user 都计。
        let payload = serde_json::json!({
            "tree": [
                {
                    "id": "root", "status": "active", "computeStatus": "idle",
                    "children": [
                        {
                            "id": "child1", "status": "active", "computeStatus": "processing",
                            "children": [
                                {"id": "grand", "status": "active", "computeStatus": "waiting_llm", "children": []}
                            ]
                        },
                        {"id": "child2", "status": "deleted", "computeStatus": "processing", "children": []}
                    ]
                },
                {"id": "user", "status": "active", "computeStatus": "idle", "children": []}
            ],
            "nodeCount": 5
        });
        let counts = count_org_tree(&payload);
        assert_eq!(counts.total, 4, "deleted 节点不计入 total");
        assert_eq!(counts.working, 2, "processing + waiting_llm 计入 working");
    }

    #[test]
    fn parse_empty_response_keeps_state() {
        let mut client = HeartbeatClient::new();
        assert_eq!(parse_heartbeat_response("{}", &mut client).unwrap(), None);
        assert_eq!(client.last_message_id, 0);
    }

    #[test]
    fn parse_org_tree_updates_counts_and_last_id() {
        let mut client = HeartbeatClient::new();
        let body = serde_json::json!({
            "messages": [{
                "messageId": 7, "type": "org_tree",
                "payload": {"tree": [org_tree_node("root", "active", "processing")], "nodeCount": 1}
            }]
        })
        .to_string();
        let counts = parse_heartbeat_response(&body, &mut client).unwrap();
        assert_eq!(counts, Some(AgentCounts { total: 1, working: 1 }));
        assert_eq!(client.last_message_id, 7);
    }

    #[test]
    fn parse_mixed_messages_takes_last_org_tree_and_max_id() {
        let mut client = HeartbeatClient { last_message_id: 5 };
        let body = serde_json::json!({
            "messages": [
                {"messageId": 6, "type": "agent_message", "payload": {"text": "x"}},
                {"messageId": 8, "type": "org_tree",
                 "payload": {"tree": [org_tree_node("root", "active", "idle")], "nodeCount": 1}},
                {"messageId": 9, "type": "mood_colors", "payload": {}}
            ]
        })
        .to_string();
        let counts = parse_heartbeat_response(&body, &mut client).unwrap();
        assert_eq!(counts, Some(AgentCounts { total: 1, working: 0 }));
        assert_eq!(client.last_message_id, 9, "lastMessageId 取最大 messageId");
    }

    #[test]
    fn parse_need_refresh_resets_last_id() {
        // 服务器重启后 _nextId 重置:客户端旧序列号 ≥ getNextId() → needRefresh。
        let mut client = HeartbeatClient { last_message_id: 47 };
        let body = serde_json::json!({"needRefresh": true}).to_string();
        assert_eq!(parse_heartbeat_response(&body, &mut client).unwrap(), None);
        assert_eq!(client.last_message_id, 0, "needRefresh 必须归零重取全量");
    }

    #[test]
    fn parse_invalid_json_is_error() {
        let mut client = HeartbeatClient::new();
        assert!(parse_heartbeat_response("not json", &mut client).is_err());
    }

    #[test]
    fn parse_missing_messages_field_is_none() {
        let mut client = HeartbeatClient::new();
        assert_eq!(
            parse_heartbeat_response(r#"{"messages":null}"#, &mut client).unwrap(),
            None
        );
    }

    /// mock 心跳响应器:先读请求(防 Windows 对未读入站数据关闭发 RST),回固定响应,
    /// 并把收到的请求体写入捕获器供断言。
    fn spawn_heartbeat_responder(
        response: String,
        captured: Arc<Mutex<Vec<String>>>,
    ) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mut reqbuf = [0u8; 4096];
                let n = s.read(&mut reqbuf).unwrap_or(0);
                if let Ok(text) = String::from_utf8(reqbuf[..n].to_vec()) {
                    captured.lock().unwrap().push(text);
                }
                let _ = s.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn fetch_heartbeat_ok_and_advances_last_message_id() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        // 响应体:org_tree messageId=3
        let body = serde_json::json!({
            "messages": [{"messageId": 3, "type": "org_tree",
                          "payload": {"tree": [org_tree_node("root", "active", "processing")], "nodeCount": 1}}]
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let port = spawn_heartbeat_responder(response.clone(), captured.clone());
        let mut client = HeartbeatClient::new();
        let counts = fetch_heartbeat(port, &mut client).unwrap();
        assert_eq!(counts, Some(AgentCounts { total: 1, working: 1 }));
        assert_eq!(client.last_message_id, 3);

        // 第二轮:请求体必须携带推进后的 lastMessageId=3
        let port2 = spawn_heartbeat_responder(response, captured.clone());
        fetch_heartbeat(port2, &mut client).unwrap();
        let texts = captured.lock().unwrap();
        let second = texts.last().unwrap();
        assert!(
            second.contains(r#""lastMessageId":3"#),
            "第二轮请求应携带 lastMessageId=3,实际: {}",
            second
        );
    }

    #[test]
    fn fetch_heartbeat_non_200_is_error() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let response = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_string();
        let port = spawn_heartbeat_responder(response, captured);
        let mut client = HeartbeatClient::new();
        let err = fetch_heartbeat(port, &mut client).unwrap_err();
        assert!(err.contains("非 200"), "{}", err);
    }

    #[test]
    fn fetch_heartbeat_connection_refused_is_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut client = HeartbeatClient::new();
        let err = fetch_heartbeat(port, &mut client).unwrap_err();
        assert!(err.contains("心跳连接失败"), "{}", err);
    }

    #[test]
    fn fetch_heartbeat_chunked_response() {
        // 实测服务器对心跳响应用 Transfer-Encoding: chunked,必须正确解码
        let captured = Arc::new(Mutex::new(Vec::new()));
        let body = serde_json::json!({
            "messages": [{"messageId": 5, "type": "org_tree",
                          "payload": {"tree": [org_tree_node("root", "active", "waiting_llm")], "nodeCount": 1}}]
        })
        .to_string();
        // 拆成两个 chunk:第一个 3 字节,其余为第二个
        let b = body.as_bytes();
        let chunked = format!("3\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            String::from_utf8_lossy(&b[..3]), b.len() - 3, String::from_utf8_lossy(&b[3..]));
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n{}",
            chunked
        );
        let port = spawn_heartbeat_responder(response, captured);
        let mut client = HeartbeatClient::new();
        let counts = fetch_heartbeat(port, &mut client).unwrap();
        assert_eq!(counts, Some(AgentCounts { total: 1, working: 1 }));
        assert_eq!(client.last_message_id, 5);
    }

    #[test]
    fn decode_chunked_multiple_chunks_with_extension() {
        // "5;ext=1" 扩展被忽略;两个数据块 + 0 块
        let raw = b"5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(raw).unwrap(), b"hello world");
    }

    #[test]
    fn decode_chunked_uppercase_hex() {
        let raw = b"A\r\n0123456789\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(raw).unwrap(), b"0123456789");
    }

    #[test]
    fn decode_chunked_truncated_is_error() {
        assert!(decode_chunked(b"5\r\nhel").is_err());
    }

    #[test]
    fn decode_chunked_bad_hex_is_error() {
        assert!(decode_chunked(b"zz\r\nx\r\n").is_err());
    }

    #[test]
    fn decode_http_body_prefers_chunked_over_content_length() {
        let head = "HTTP/1.1 200 OK\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\n";
        let raw = b"5\r\nhello\r\n0\r\n\r\n";
        assert_eq!(decode_http_body(head, raw).unwrap(), b"hello");
    }

    #[test]
    fn decode_http_body_content_length_truncates() {
        let head = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n";
        let raw = b"helloEXTRA";
        assert_eq!(decode_http_body(head, raw).unwrap(), b"hello");
    }

    #[test]
    fn decode_http_body_no_framing_returns_all() {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n";
        let raw = b"{\"a\":1}";
        assert_eq!(decode_http_body(head, raw).unwrap(), b"{\"a\":1}");
    }
}
