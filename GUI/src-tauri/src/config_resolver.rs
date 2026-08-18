//! 服务器根目录与端口解析,纯函数便于单测:
//! - serverRoot: launcher.json 覆盖 > 从 exe 向上查找含 start-wrapper.mjs 的目录(≤10 层)
//! - httpPort: 镜像服务器 config.js loadApp 的优先级(config/app.local.json > config/app.json > 默认 3000)

use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 3000;
pub const DEFAULT_MAX_DEPTH: u8 = 10;

/// launcher.json 的内容(原始字段,路径解释由 resolve_server_root 完成)
pub struct LauncherConfig {
    pub server_root: Option<String>,
    pub startup_timeout_sec: Option<u64>,
}

/// 查找 launcher.json:exe 旁 → exe 旁 config/ → GUI 项目根 config/(开发布局)
pub fn find_launcher_config(exe_dir: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        exe_dir.join("launcher.json"),
        exe_dir.join("config").join("launcher.json"),
    ];
    if let Some(gui_root) = find_gui_root(exe_dir, 4) {
        candidates.push(gui_root.join("config").join("launcher.json"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// 从 exe_dir 向上找 GUI 项目根(含 src-tauri/tauri.conf.json 的目录)
pub fn find_gui_root(exe_dir: &Path, max_depth: u8) -> Option<PathBuf> {
    let mut cur = Some(exe_dir);
    for _ in 0..=max_depth {
        let dir = cur?;
        if dir.join("src-tauri").join("tauri.conf.json").is_file() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

pub fn parse_launcher_config(path: &Path) -> Result<LauncherConfig, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} JSON 解析失败: {}", path.display(), e))?;
    let server_root = v
        .get("serverRoot")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let startup_timeout_sec = v.get("startupTimeoutSec").and_then(Value::as_u64);
    Ok(LauncherConfig {
        server_root,
        startup_timeout_sec,
    })
}

/// 解析服务器根目录:launcher.json 的 serverRoot 覆盖优先(相对路径按 launcher.json 所在目录解释),
/// 否则从 exe_dir 向上查找含 start-wrapper.mjs 的目录。
pub fn resolve_server_root(exe_dir: &Path, max_depth: u8) -> Result<PathBuf, String> {
    let mut override_failed: Option<String> = None;

    if let Some(lc_path) = find_launcher_config(exe_dir) {
        match parse_launcher_config(&lc_path) {
            Ok(cfg) => {
                if let Some(root) = cfg.server_root {
                    let base = lc_path.parent().unwrap_or(exe_dir);
                    let resolved = if Path::new(&root).is_absolute() {
                        PathBuf::from(&root)
                    } else {
                        base.join(&root)
                    };
                    if resolved.join("start-wrapper.mjs").is_file() {
                        return Ok(resolved);
                    }
                    override_failed = Some(format!(
                        "launcher.json 的 serverRoot 无效(目录内无 start-wrapper.mjs): {}",
                        resolved.display()
                    ));
                }
            }
            Err(e) => override_failed = Some(e),
        }
    }

    let mut cur = Some(exe_dir);
    for depth in 0..=max_depth {
        let dir = cur.ok_or_else(|| {
            let mut msg = format!(
                "未找到服务器目录(从 {} 向上查找 {} 层)",
                exe_dir.display(),
                depth
            );
            if let Some(o) = &override_failed {
                msg.push_str(&format!(";launcher.json 覆盖也失败: {}", o));
            }
            msg
        })?;
        if dir.join("start-wrapper.mjs").is_file() {
            return Ok(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    let mut msg = format!(
        "未找到服务器目录(从 {} 向上查找超过 {} 层)",
        exe_dir.display(),
        max_depth
    );
    if let Some(o) = &override_failed {
        msg.push_str(&format!(";launcher.json 覆盖也失败: {}", o));
    }
    Err(msg)
}

/// 返回 (端口, 来源说明)。镜像服务器 config.js:local 优先,单文件选择后校验,
/// 缺失/解析失败/值非法一律回退默认 3000(来源说明里带原因,由调用方记日志)。
pub fn resolve_http_port(server_root: &Path) -> (u16, String) {
    for (file, label) in [
        ("app.local.json", "config/app.local.json"),
        ("app.json", "config/app.json"),
    ] {
        let p = server_root.join("config").join(file);
        if p.is_file() {
            match parse_http_port(&p) {
                Ok(port) => return (port, label.to_string()),
                Err(reason) => {
                    return (
                        DEFAULT_PORT,
                        format!("默认 {}({} 无效: {})", DEFAULT_PORT, label, reason),
                    )
                }
            }
        }
    }
    (
        DEFAULT_PORT,
        format!("默认 {}(config/app.local.json 与 app.json 均不存在)", DEFAULT_PORT),
    )
}

/// 只提取 httpPort 字段(u64 整数、1..=65535),不反序列化整个配置,
/// 避免把 app.local.json 里的明文 API key 带入内存对象。
fn parse_http_port(path: &Path) -> Result<u16, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} JSON 解析失败: {}", path.display(), e))?;
    let n = v
        .get("httpPort")
        .and_then(Value::as_u64)
        .ok_or_else(|| "httpPort 缺失或非整数".to_string())?;
    if !(1..=65535).contains(&n) {
        return Err(format!("端口越界: {}", n));
    }
    Ok(n as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("asl-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_port_config(root: &Path, file: &str, port_value: &str) {
        let dir = root.join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(file),
            format!("{{\"httpPort\": {},\"other\": \"x\"}}", port_value),
        )
        .unwrap();
    }

    #[test]
    fn port_local_priority_over_app() {
        let root = temp_dir("port-local");
        write_port_config(&root, "app.json", "3000");
        write_port_config(&root, "app.local.json", "3003");
        let (port, source) = resolve_http_port(&root);
        assert_eq!(port, 3003);
        assert_eq!(source, "config/app.local.json");
    }

    #[test]
    fn port_fallback_to_app_without_local() {
        let root = temp_dir("port-app");
        write_port_config(&root, "app.json", "4100");
        let (port, source) = resolve_http_port(&root);
        assert_eq!(port, 4100);
        assert_eq!(source, "config/app.json");
    }

    #[test]
    fn port_default_when_both_missing() {
        let root = temp_dir("port-none");
        let (port, source) = resolve_http_port(&root);
        assert_eq!(port, 3000);
        assert!(source.contains("默认"), "来源说明应含默认: {}", source);
    }

    #[test]
    fn port_local_invalid_json_falls_back_default() {
        let root = temp_dir("port-badjson");
        let dir = root.join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("app.local.json"), "not json{{{").unwrap();
        fs::write(dir.join("app.json"), "{\"httpPort\": 4100}").unwrap();
        // 镜像服务器行为:local 存在即选中,解析失败 → 默认 3000,不回退 app.json
        let (port, source) = resolve_http_port(&root);
        assert_eq!(port, 3000);
        assert!(source.contains("解析失败"), "{}", source);
    }

    #[test]
    fn port_invalid_values_fall_back_default() {
        for bad in ["\"abc\"", "0", "70000", "3000.5", "null"] {
            let root = temp_dir("port-invalid");
            write_port_config(&root, "app.local.json", bad);
            let (port, source) = resolve_http_port(&root);
            assert_eq!(port, 3000, "{} 应回退 3000({})", bad, source);
            assert!(source.contains("默认"), "{}", source);
        }
    }

    #[test]
    fn server_root_walk_up_finds_wrapper() {
        let root = temp_dir("root-walk");
        let server = root.join("a").join("b").join("c");
        fs::create_dir_all(server.join("sub")).unwrap();
        fs::write(server.join("start-wrapper.mjs"), "// marker").unwrap();
        let exe_dir = server.join("sub").join("x").join("y");
        fs::create_dir_all(&exe_dir).unwrap();
        assert_eq!(resolve_server_root(&exe_dir, 10).unwrap(), server);
    }

    #[test]
    fn server_root_walk_up_exceeds_depth() {
        let root = temp_dir("root-depth");
        let deep = root.join("1/2/3/4/5/6/7/8/9/10/11");
        fs::create_dir_all(&deep).unwrap();
        let err = resolve_server_root(&deep, 5).unwrap_err();
        assert!(err.contains("未找到服务器目录"), "{}", err);
    }

    #[test]
    fn server_root_launcher_json_override() {
        let root = temp_dir("root-override");
        let server = root.join("real-server");
        fs::create_dir_all(&server).unwrap();
        fs::write(server.join("start-wrapper.mjs"), "// marker").unwrap();
        let exe_dir = root.join("app");
        fs::create_dir_all(&exe_dir).unwrap();
        // exe 旁 launcher.json(candidates 第 1 项)
        fs::write(
            exe_dir.join("launcher.json"),
            format!("{{\"serverRoot\": {:?}}}", server.to_string_lossy()),
        )
        .unwrap();
        assert_eq!(resolve_server_root(&exe_dir, 10).unwrap(), server);
    }

    #[test]
    fn server_root_override_invalid_falls_to_walk_up() {
        let root = temp_dir("root-badoverride");
        let server = root.join("srv");
        fs::create_dir_all(&server).unwrap();
        fs::write(server.join("start-wrapper.mjs"), "// marker").unwrap();
        let exe_dir = root.join("app");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::write(
            exe_dir.join("launcher.json"),
            format!("{{\"serverRoot\": {:?}}}", root.join("nowhere").to_string_lossy()),
        )
        .unwrap();
        // 覆盖无效 → 向上查找失败(server 不在 exe 上方)→ Err 且提及覆盖失败原因
        let err = resolve_server_root(&exe_dir, 10).unwrap_err();
        assert!(err.contains("launcher.json 覆盖也失败"), "{}", err);
        assert!(err.contains("nowhere"), "{}", err);
    }

    #[test]
    fn gui_root_detection() {
        let root = temp_dir("gui-root");
        fs::create_dir_all(root.join("GUI").join("src-tauri")).unwrap();
        fs::write(root.join("GUI").join("src-tauri").join("tauri.conf.json"), "{}").unwrap();
        let exe_dir = root.join("GUI").join("src-tauri").join("target").join("debug");
        fs::create_dir_all(&exe_dir).unwrap();
        assert_eq!(
            find_gui_root(&exe_dir, 4).unwrap(),
            root.join("GUI")
        );
        assert_eq!(find_gui_root(&root, 4), None);
    }
}
