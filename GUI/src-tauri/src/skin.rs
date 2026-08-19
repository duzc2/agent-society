//! 皮肤系统:描述 JSON 解析、双文件夹动态枚举、skin:// 协议服务、调试模式参数。
//!
//! 核心约定:
//! - 皮肤身份 = 来源(official|user)+ 文件夹名(技术键 `official:folder` / `user:folder`);
//!   skin.json 里**没有 id 字段**(没人能跨来源分配 ID),可读名(name)在 JSON 里;
//!   两个文件夹允许同名子文件夹(不同来源 = 两个皮肤,并存)。
//! - 官方皮肤在 `GUI/skins/`(git 管理,随发布包),用户皮肤在 `GUI/skins-user/`(gitignore);
//!   集合完全由两个文件夹的子文件夹动态枚举,无索引文件。
//! - 皮肤文件夹必备三件:skin.json + preview.png(恰好 240×160,由校验脚本强校验)+ index.html。
//! - 数据契约:皮肤页监听 window 上的 CustomEvent "dateUpdate"(detail 携带数据),不依赖 Tauri API;
//!   右键菜单由启动器在 on_page_load 时统一注入(见 CONTEXTMENU_SCRIPT / DEBUG_SCRIPT)。

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const SKIN_SCHEME: &str = "skin";
pub const DEFAULT_SKIN: &str = "classic";
pub const SKIN_VERSION: u64 = 1;
pub const MIN_SIZE: f64 = 5.0;
pub const MAX_SIZE: f64 = 2000.0;
pub const PREVIEW_WIDTH: u32 = 240;
pub const PREVIEW_HEIGHT: u32 = 160;

/// 皮肤来源:官方(git 管理)或用户自定义(gitignore)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SkinSource {
    Official,
    User,
}

impl SkinSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SkinSource::Official => "official",
            SkinSource::User => "user",
        }
    }

    /// 设置界面来源角标文案
    pub fn label(self) -> &'static str {
        match self {
            SkinSource::Official => "官方",
            SkinSource::User => "自定义",
        }
    }
}

/// 两个皮肤文件夹的根路径。发行布局 `<exe>/GUI/skins[-user]`,开发布局 `GUI/skins[-user]`。
#[derive(Clone, Debug, Default)]
pub struct SkinRoots {
    pub official: Option<PathBuf>,
    pub user: Option<PathBuf>,
}

impl SkinRoots {
    pub fn resolve(exe_dir: &Path) -> SkinRoots {
        SkinRoots {
            official: resolve_skin_root(exe_dir, SkinSource::Official),
            user: resolve_skin_root(exe_dir, SkinSource::User),
        }
    }

    pub fn get(&self, source: SkinSource) -> Option<&PathBuf> {
        match source {
            SkinSource::Official => self.official.as_ref(),
            SkinSource::User => self.user.as_ref(),
        }
    }
}

/// 皮肤技术键:显式来源 + 文件夹名,或裸文件夹名(解析时官方优先)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkinRef {
    pub explicit: Option<SkinSource>,
    pub folder: String,
}

impl SkinRef {
    /// 解析 `official:x` / `user:x` / 裸 `x`;非法(空、含路径分隔、含 `:`)→ None。
    pub fn parse(s: &str) -> Option<SkinRef> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        for (prefix, source) in [
            ("official:", SkinSource::Official),
            ("user:", SkinSource::User),
        ] {
            if let Some(rest) = s.strip_prefix(prefix) {
                return is_valid_folder_name(rest)
                    .then(|| SkinRef { explicit: Some(source), folder: rest.to_string() });
            }
        }
        is_valid_folder_name(s).then(|| SkinRef { explicit: None, folder: s.to_string() })
    }

    /// 规范化键(裸名按官方输出;调用方应在 resolve 之后、用带显式来源的实例调用)。
    pub fn to_key(&self) -> String {
        format!(
            "{}:{}",
            self.explicit.map(|s| s.as_str()).unwrap_or("official"),
            self.folder
        )
    }

    /// 定位皮肤目录:显式来源直接查该根源;裸名官方优先、官方无再查用户。
    /// 目录存在即命中(哪怕 skin.json 缺失)——错误细节由 load_skin_dir 报告
    /// ("缺少 skin.json"),比"皮肤不存在"更准确。
    pub fn resolve(&self, roots: &SkinRoots) -> Option<(SkinSource, PathBuf)> {
        match self.explicit {
            Some(source) => roots
                .get(source)
                .map(|r| r.join(&self.folder))
                .filter(|d| d.is_dir())
                .map(|d| (source, d)),
            None => {
                for source in [SkinSource::Official, SkinSource::User] {
                    if let Some(r) = roots.get(source) {
                        let d = r.join(&self.folder);
                        if d.is_dir() {
                            return Some((source, d));
                        }
                    }
                }
                None
            }
        }
    }
}

/// 皮肤描述 JSON 的窗口结构配置。
#[derive(Clone, Debug, PartialEq)]
pub struct SkinConfig {
    pub name: String,
    pub width: f64,
    pub height: f64,
    pub transparency: bool,
    pub always_on_top: bool,
    pub shadow: bool,
    pub resizable: bool,
    pub skip_taskbar: bool,
}

impl Default for SkinConfig {
    /// 与内嵌回退页(ui/monitor.html)一致的经典尺寸与窗口标志。
    fn default() -> Self {
        SkinConfig {
            name: "经典卡片(内嵌回退)".to_string(),
            width: 300.0,
            height: 112.0,
            transparency: true,
            always_on_top: true,
            shadow: false,
            resizable: false,
            skip_taskbar: true,
        }
    }
}

/// 文件夹名白名单:只允许字母/数字/下划线/连字符(1–64 字符)。
/// 拒绝 `.`/`..`/路径分隔/`:`(与 SkinRef 的键格式不冲突)。
pub fn is_valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 严格解析 skin.json;返回 (配置, 警告列表)。错误信息含字段名/实际值/允许范围。
pub fn parse_skin_config(json: &str) -> Result<(SkinConfig, Vec<String>), String> {
    let v: Value =
        serde_json::from_str(json).map_err(|e| format!("skin.json JSON 解析失败: {}", e))?;
    let obj = v
        .as_object()
        .ok_or_else(|| "skin.json 顶层必须是 JSON 对象".to_string())?;

    let mut warnings: Vec<String> = Vec::new();
    const KNOWN: &[&str] = &[
        "name",
        "version",
        "width",
        "height",
        "transparency",
        "alwaysOnTop",
        "shadow",
        "resizable",
        "skipTaskbar",
    ];
    for key in obj.keys() {
        if !KNOWN.contains(&key.as_str()) {
            warnings.push(format!("未知字段: {}", key));
        }
    }

    let name = v
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "字段 name 缺失或非字符串".to_string())?;
    if name.chars().count() > 64 {
        return Err(format!("字段 name 超过 64 字符: {}", name));
    }

    let version = v
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "字段 version 缺失或非整数".to_string())?;
    if version != SKIN_VERSION {
        return Err(format!(
            "字段 version 必须为 {},实际: {}",
            SKIN_VERSION, version
        ));
    }

    let width = parse_dimension(&v, "width")?;
    let height = parse_dimension(&v, "height")?;

    let bool_field = |key: &str, default: bool| -> Result<bool, String> {
        match v.get(key) {
            None => Ok(default),
            Some(Value::Bool(b)) => Ok(*b),
            Some(other) => Err(format!("字段 {} 必须为布尔值,实际: {}", key, other)),
        }
    };
    let transparency = bool_field("transparency", true)?;
    let always_on_top = bool_field("alwaysOnTop", true)?;
    let shadow = bool_field("shadow", false)?;
    let resizable = bool_field("resizable", false)?;
    let skip_taskbar = bool_field("skipTaskbar", true)?;

    Ok((
        SkinConfig {
            name: name.to_string(),
            width,
            height,
            transparency,
            always_on_top,
            shadow,
            resizable,
            skip_taskbar,
        },
        warnings,
    ))
}

fn parse_dimension(v: &Value, key: &str) -> Result<f64, String> {
    let n = v
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("字段 {} 缺失或非数字", key))?;
    if !n.is_finite() || !(MIN_SIZE..=MAX_SIZE).contains(&n) {
        return Err(format!(
            "字段 {} 越界({}),允许范围 {}..={}",
            key, n, MIN_SIZE, MAX_SIZE
        ));
    }
    Ok(n)
}

/// 读取并解析 <root>/<folder>/skin.json,并检查 index.html 存在。
pub fn load_skin(root: &Path, folder: &str) -> Result<(SkinConfig, Vec<String>), String> {
    if !is_valid_folder_name(folder) {
        return Err(format!("皮肤文件夹名非法: {}", folder));
    }
    load_skin_dir(&root.join(folder))
}

/// 读取并解析 <dir>/skin.json,并检查 index.html 存在(换肤/调试流程直接持有目录时用)。
pub fn load_skin_dir(dir: &Path) -> Result<(SkinConfig, Vec<String>), String> {
    let json_path = dir.join("skin.json");
    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("读取 {} 失败: {}", json_path.display(), e))?;
    let (cfg, warnings) = parse_skin_config(&raw)?;
    if !dir.join("index.html").is_file() {
        return Err(format!("{} 缺少 index.html", dir.display()));
    }
    Ok((cfg, warnings))
}

/// 定位单个来源的 skins 根:发行布局 `<exe>/GUI/skins[-user]` 优先,
/// 否则开发布局 `find_gui_root(exe_dir)/skins[-user]`。
pub fn resolve_skin_root(exe_dir: &Path, source: SkinSource) -> Option<PathBuf> {
    let folder = match source {
        SkinSource::Official => "skins",
        SkinSource::User => "skins-user",
    };
    let release = exe_dir.join("GUI").join(folder);
    if release.is_dir() {
        return Some(release);
    }
    crate::config_resolver::find_gui_root(exe_dir, crate::config_resolver::DEFAULT_MAX_DEPTH)
        .map(|gui_root| gui_root.join(folder))
        .filter(|p| p.is_dir())
}

/// 皮肤入口 URL。host 必须为 localhost(wry 导航时改写为 http://skin.localhost/...,
/// 请求拦截时 revert 回 skin://localhost/... 交给 handler,跨平台统一)。
pub fn skin_url(source: SkinSource, folder: &str) -> tauri::WebviewUrl {
    tauri::WebviewUrl::CustomProtocol(
        tauri::Url::parse(&format!(
            "{}://localhost/{}/{}/index.html",
            SKIN_SCHEME,
            source.as_str(),
            folder
        ))
        .expect("皮肤 URL 构造失败"),
    )
}

/// 皮肤枚举条目(settings_get 返回给设置界面)。
#[derive(Clone, Debug, Serialize)]
pub struct SkinEntry {
    /// 技术键,如 "official:classic"
    pub key: String,
    pub folder: String,
    /// 显示名(skin.json 的 name;皮肤无效时回退文件夹名)
    pub name: String,
    /// "official" | "user"
    pub source: String,
    pub valid: bool,
    pub error: Option<String>,
    pub preview_ok: bool,
}

/// 枚举两个文件夹下的全部皮肤(按来源、文件夹名排序;同名文件夹并列)。
/// 返回 (条目列表, 枚举过程中的错误——如目录不可读)。
pub fn enumerate_skins(roots: &SkinRoots) -> (Vec<SkinEntry>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for source in [SkinSource::Official, SkinSource::User] {
        let root = match roots.get(source) {
            Some(r) => r,
            None => continue,
        };
        let rd = match std::fs::read_dir(root) {
            Ok(rd) => rd,
            Err(e) => {
                errors.push(format!("读取皮肤目录失败: {}: {}", root.display(), e));
                continue;
            }
        };
        let mut folders: Vec<String> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| is_valid_folder_name(n))
            .collect();
        folders.sort();
        for folder in folders {
            let key = format!("{}:{}", source.as_str(), folder);
            match load_skin(root, &folder) {
                Ok((cfg, _warnings)) => out.push(SkinEntry {
                    key: key.clone(),
                    folder: folder.clone(),
                    name: cfg.name,
                    source: source.as_str().to_string(),
                    valid: true,
                    error: None,
                    preview_ok: root.join(&folder).join("preview.png").is_file(),
                }),
                Err(e) => out.push(SkinEntry {
                    key,
                    folder: folder.clone(),
                    name: folder,
                    source: source.as_str().to_string(),
                    valid: false,
                    error: Some(e),
                    preview_ok: false,
                }),
            }
        }
    }
    (out, errors)
}

/// 服务 skin:// 请求(纯函数,可单测):解析 URI → 来源/文件夹/文件路径 →
/// 白名单 + 双重 canonicalize 防逃逸 → 读文件 → MIME。任何失败 → 404。
pub fn serve_skin_request(roots: &SkinRoots, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(b"skin not found".to_vec())
            .unwrap()
    };
    let url = match tauri::Url::parse(uri) {
        Ok(u) => u,
        Err(_) => return not_found(),
    };
    if url.scheme() != SKIN_SCHEME {
        return not_found();
    }
    let mut segments = match url.path_segments() {
        Some(s) => s,
        None => return not_found(),
    };
    let source = match segments.next() {
        Some("official") => SkinSource::Official,
        Some("user") => SkinSource::User,
        _ => return not_found(),
    };
    let folder = match segments.next() {
        Some(f) if is_valid_folder_name(f) => f.to_string(),
        _ => return not_found(),
    };
    let mut rel: Vec<&str> = segments.collect();
    // 空路径或尾斜杠 → index.html
    if rel.is_empty() {
        rel.push("index.html");
    } else if rel.last() == Some(&"") {
        *rel.last_mut().unwrap() = "index.html";
    }
    let root = match roots.get(source) {
        Some(r) => r,
        None => return not_found(),
    };
    let skin_dir = root.join(&folder);
    let mut full = skin_dir.clone();
    for part in &rel {
        if part.is_empty() || *part == "." || *part == ".." || part.contains('\\') || part.contains(':')
        {
            return not_found();
        }
        full.push(part);
    }
    // 双重 canonicalize:防止 .. 逃逸、编码逃逸与符号链接跳出皮肤目录
    let canonical = match full.canonicalize() {
        Ok(c) => c,
        Err(_) => return not_found(),
    };
    let canonical_dir = match skin_dir.canonicalize() {
        Ok(c) => c,
        Err(_) => return not_found(),
    };
    if !canonical.starts_with(&canonical_dir) {
        return not_found();
    }
    let bytes = match std::fs::read(&canonical) {
        Ok(b) => b,
        Err(_) => return not_found(),
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime_for_path(&canonical))
        .header("Cache-Control", "no-cache")
        .body(bytes)
        .unwrap()
}

/// 按扩展名映射 MIME(文本类带 charset)。
pub fn mime_for_path(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 解析命令行参数:"--skin-debug" 后跟皮肤键(可为官方/用户/裸名),缺失 → None。
pub fn parse_debug_args<I: Iterator<Item = String>>(mut args: I) -> Option<String> {
    while let Some(arg) = args.next() {
        if arg == "--skin-debug" {
            return args.next().filter(|s| !s.is_empty());
        }
    }
    None
}

static DEBUG_MODE: AtomicBool = AtomicBool::new(false);

pub fn set_debug(v: bool) {
    DEBUG_MODE.store(v, Ordering::SeqCst);
}

pub fn is_debug() -> bool {
    DEBUG_MODE.load(Ordering::SeqCst)
}

/// 生产模式注入:监视窗口每个页面(皮肤与内嵌回退页)统一获得右键菜单
/// (页面 preventDefault 抑制 WebView2 默认菜单;invoke 失败静默——Rust 侧已记日志)。
pub const CONTEXTMENU_SCRIPT: &str = r#"
window.addEventListener("contextmenu", function (event) {
  event.preventDefault();
  window.__TAURI__.core.invoke("monitor_context_menu", { x: event.clientX, y: event.clientY }).catch(function () {});
});
"#;

/// 调试模式注入:右键 → 单条"退出调试"菜单;Esc 直接退出。
pub const DEBUG_SCRIPT: &str = r#"
window.addEventListener("contextmenu", function (event) {
  event.preventDefault();
  window.__TAURI__.core.invoke("skin_debug_menu", { x: event.clientX, y: event.clientY }).catch(function () {});
});
window.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    window.__TAURI__.core.invoke("skin_debug_exit").catch(function () {});
  }
});
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("asl-skin-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// 建一个最小合法皮肤(含 skin.json/index.html/preview.png 假文件)。
    fn make_skin(root: &Path, folder: &str, json_extra: &str) -> PathBuf {
        let dir = root.join(folder);
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(
            dir.join("skin.json"),
            format!("{{\"name\": \"T\", \"version\": 1, \"width\": 300, \"height\": 112{} }}", json_extra),
        )
        .unwrap();
        fs::write(dir.join("index.html"), "<html></html>").unwrap();
        fs::write(dir.join("assets").join("style.css"), "body{}").unwrap();
        fs::write(dir.join("preview.png"), b"fake-png").unwrap();
        dir
    }

    #[test]
    fn parse_full_valid_config() {
        let (cfg, warnings) = parse_skin_config(
            r#"{"name":"经典卡片","version":1,"width":300,"height":112,
                "transparency":true,"alwaysOnTop":false,"shadow":true,
                "resizable":true,"skipTaskbar":false}"#,
        )
        .unwrap();
        assert_eq!(cfg.name, "经典卡片");
        assert_eq!(cfg.width, 300.0);
        assert_eq!(cfg.height, 112.0);
        assert!(cfg.transparency);
        assert!(!cfg.always_on_top);
        assert!(cfg.shadow);
        assert!(cfg.resizable);
        assert!(!cfg.skip_taskbar);
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_minimal_applies_defaults() {
        let (cfg, _) =
            parse_skin_config(r#"{"name":"x","version":1,"width":240,"height":88}"#).unwrap();
        assert!(cfg.transparency);
        assert!(cfg.always_on_top);
        assert!(!cfg.shadow);
        assert!(!cfg.resizable);
        assert!(cfg.skip_taskbar);
    }

    #[test]
    fn parse_errors_named_fields() {
        let cases: &[(&str, &str)] = &[
            ("{}", "name"),
            (r#"{"name":5,"version":1,"width":1,"height":1}"#, "name"),
            (r#"{"name":"x","width":1,"height":1}"#, "version"),
            (r#"{"name":"x","version":2,"width":1,"height":1}"#, "version"),
            (r#"{"name":"x","version":"1","width":1,"height":1}"#, "version"),
            (r#"{"name":"x","version":1,"height":1}"#, "width"),
            (r#"{"name":"x","version":1,"width":"300","height":1}"#, "width"),
            (r#"{"name":"x","version":1,"width":4.9,"height":1}"#, "width"),
            (r#"{"name":"x","version":1,"width":2001,"height":1}"#, "width"),
            (r#"{"name":"x","version":1,"width":300,"height":null}"#, "height"),
            (r#"{"name":"x","version":1,"width":300,"height":4}"#, "height"),
            (r#"{"name":"x","version":1,"width":300,"height":100,"transparency":"yes"}"#, "transparency"),
        ];
        for (json, field) in cases {
            let err = parse_skin_config(json).unwrap_err();
            assert!(err.contains(field), "json={} err={}", json, err);
        }
    }

    #[test]
    fn parse_boundary_values_ok() {
        parse_skin_config(r#"{"name":"x","version":1,"width":5,"height":2000}"#).unwrap();
    }

    #[test]
    fn parse_unknown_fields_warn() {
        let (_cfg, warnings) =
            parse_skin_config(r#"{"name":"x","version":1,"width":300,"height":112,"fancy":true}"#)
                .unwrap();
        assert_eq!(warnings, vec!["未知字段: fancy".to_string()]);
    }

    #[test]
    fn parse_invalid_json_errors() {
        assert!(parse_skin_config("not json{").unwrap_err().contains("JSON 解析失败"));
        assert!(parse_skin_config("[1,2]").unwrap_err().contains("对象"));
    }

    #[test]
    fn folder_name_whitelist() {
        for ok in ["classic", "my-skin_2", "a"] {
            assert!(is_valid_folder_name(ok), "{}", ok);
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a b", "a:b", "中文", &"x".repeat(65)] {
            assert!(!is_valid_folder_name(bad), "{}", bad);
        }
    }

    #[test]
    fn skin_ref_parse_and_key() {
        assert_eq!(
            SkinRef::parse("official:classic").unwrap(),
            SkinRef { explicit: Some(SkinSource::Official), folder: "classic".into() }
        );
        assert_eq!(
            SkinRef::parse("user:x").unwrap(),
            SkinRef { explicit: Some(SkinSource::User), folder: "x".into() }
        );
        assert_eq!(
            SkinRef::parse("classic").unwrap(),
            SkinRef { explicit: None, folder: "classic".into() }
        );
        assert_eq!(SkinRef::parse(""), None);
        assert_eq!(SkinRef::parse("a/b"), None);
        assert_eq!(SkinRef::parse("user:"), None);
        assert_eq!(
            SkinRef::parse("official:a").unwrap().to_key(),
            "official:a"
        );
    }

    #[test]
    fn skin_ref_resolve_same_name_two_sources() {
        let root = temp_dir("resolve");
        let official = root.join("official-root");
        let user = root.join("user-root");
        make_skin(&official, "classic", "");
        make_skin(&user, "classic", "");
        let roots = SkinRoots { official: Some(official), user: Some(user) };
        // 裸名官方优先
        assert_eq!(
            SkinRef::parse("classic").unwrap().resolve(&roots).map(|(s, _)| s),
            Some(SkinSource::Official)
        );
        // 显式 user 命中用户目录
        assert_eq!(
            SkinRef::parse("user:classic").unwrap().resolve(&roots).map(|(s, _)| s),
            Some(SkinSource::User)
        );
        // 官方缺失时裸名回退用户
        let roots_no_official = SkinRoots { official: None, user: roots.user.clone() };
        assert_eq!(
            SkinRef::parse("classic").unwrap().resolve(&roots_no_official).map(|(s, _)| s),
            Some(SkinSource::User)
        );
        assert_eq!(SkinRef::parse("nope").unwrap().resolve(&roots), None);
    }

    #[test]
    fn load_skin_checks_required_files() {
        let root = temp_dir("load");
        let dir = make_skin(&root, "s1", "");
        let (cfg, w) = load_skin(&root, "s1").unwrap();
        assert_eq!(cfg.width, 300.0);
        assert!(w.is_empty());
        // 缺 index.html
        fs::remove_file(dir.join("index.html")).unwrap();
        assert!(load_skin(&root, "s1").unwrap_err().contains("index.html"));
        // 缺 skin.json
        let dir2 = root.join("s2");
        fs::create_dir_all(&dir2).unwrap();
        assert!(load_skin(&root, "s2").unwrap_err().contains("skin.json"));
        // 非法文件夹名
        assert!(load_skin(&root, "../s1").unwrap_err().contains("非法"));
    }

    #[test]
    fn skin_root_resolution_layouts() {
        let root = temp_dir("roots");
        // 发行布局:exe/GUI/skins
        let exe_release = root.join("dist").join("win-unpacked");
        fs::create_dir_all(exe_release.join("GUI").join("skins")).unwrap();
        fs::create_dir_all(exe_release.join("GUI").join("skins-user")).unwrap();
        assert!(resolve_skin_root(&exe_release, SkinSource::Official).unwrap().ends_with("GUI/skins"));
        // 开发布局:gui_root 标记 + skins
        let gui = root.join("GUI");
        fs::create_dir_all(gui.join("src-tauri")).unwrap();
        fs::write(gui.join("src-tauri").join("tauri.conf.json"), "{}").unwrap();
        fs::create_dir_all(gui.join("skins")).unwrap();
        let exe_dev = gui.join("src-tauri").join("target").join("debug");
        fs::create_dir_all(&exe_dev).unwrap();
        assert!(resolve_skin_root(&exe_dev, SkinSource::Official).unwrap().ends_with("GUI/skins"));
        // 无 skins-user 目录 → None
        assert_eq!(resolve_skin_root(&exe_dev, SkinSource::User), None);
    }

    #[test]
    fn skin_url_exact_form() {
        match skin_url(SkinSource::Official, "classic") {
            tauri::WebviewUrl::CustomProtocol(url) => {
                assert_eq!(url.as_str(), "skin://localhost/official/classic/index.html");
            }
            other => panic!("应为 CustomProtocol,实际 {:?}", other),
        }
    }

    #[test]
    fn serve_index_and_assets() {
        let root = temp_dir("serve");
        make_skin(&root, "s1", "");
        let roots = SkinRoots { official: Some(root.clone()), user: None };
        // index.html
        let resp = serve_skin_request(&roots, "skin://localhost/official/s1/index.html");
        assert_eq!(resp.status(), 200);
        assert!(resp.headers()["Content-Type"].to_str().unwrap().starts_with("text/html"));
        // 嵌套 css
        let resp = serve_skin_request(&roots, "skin://localhost/official/s1/assets/style.css");
        assert_eq!(resp.status(), 200);
        assert!(resp.headers()["Content-Type"].to_str().unwrap().starts_with("text/css"));
        // 单段路径与尾斜杠 → index.html
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/s1").status(), 200);
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/s1/").status(), 200);
        // 查询串忽略
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/s1/index.html?v=1").status(), 200);
        // 空路径
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official").status(), 404);
        // 未知皮肤/文件/来源/协议
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/nope/index.html").status(), 404);
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/s1/missing.js").status(), 404);
        assert_eq!(serve_skin_request(&roots, "skin://localhost/other/s1/index.html").status(), 404);
        assert_eq!(serve_skin_request(&roots, "tauri://localhost/official/s1/index.html").status(), 404);
        // 预览图
        assert_eq!(serve_skin_request(&roots, "skin://localhost/official/s1/preview.png").status(), 200);
        // 用户根缺失 → 404
        assert_eq!(serve_skin_request(&roots, "skin://localhost/user/s1/index.html").status(), 404);
    }

    #[test]
    fn serve_traversal_blocked() {
        let root = temp_dir("traverse");
        make_skin(&root, "s1", "");
        fs::write(root.join("secret.txt"), "secret").unwrap();
        let roots = SkinRoots { official: Some(root.clone()), user: None };
        let cases = [
            "skin://localhost/official/s1/../secret.txt",
            "skin://localhost/official/s1/%2e%2e/secret.txt",
            "skin://localhost/official/s1/%2E%2E%2Fsecret.txt",
            "skin://localhost/official/s1/..%5Csecret.txt",
            "skin://localhost/official/s1/a%2F..%2F..%2Fsecret.txt",
            "skin://localhost/official/s1/%00",
        ];
        for uri in cases {
            let resp = serve_skin_request(&roots, uri);
            assert_eq!(resp.status(), 404, "uri={}", uri);
        }
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for_path(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for_path(Path::new("a.css")), "text/css; charset=utf-8");
        assert_eq!(mime_for_path(Path::new("a.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime_for_path(Path::new("a.json")), "application/json; charset=utf-8");
        assert_eq!(mime_for_path(Path::new("a.png")), "image/png");
        assert_eq!(mime_for_path(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for_path(Path::new("a.woff2")), "font/woff2");
        assert_eq!(mime_for_path(Path::new("a.xyz")), "application/octet-stream");
        assert_eq!(mime_for_path(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn debug_args_parsing() {
        fn str_args(xs: &[&str]) -> Vec<String> {
            xs.iter().map(|s| s.to_string()).collect()
        }
        assert_eq!(parse_debug_args(str_args(&["exe", "--skin-debug", "gauge"]).into_iter()), Some("gauge".into()));
        assert_eq!(parse_debug_args(str_args(&["exe", "--skin-debug", "user:x"]).into_iter()), Some("user:x".into()));
        assert_eq!(parse_debug_args(str_args(&["exe"]).into_iter()), None);
        assert_eq!(parse_debug_args(str_args(&["exe", "--skin-debug"]).into_iter()), None);
        assert_eq!(parse_debug_args(str_args(&["exe", "--other", "x"]).into_iter()), None);
    }

    #[test]
    fn enumerate_two_roots_same_folder() {
        let root = temp_dir("enum");
        let official = root.join("official-root");
        let user = root.join("user-root");
        make_skin(&official, "classic", r#", "name": "经典卡片""#);
        make_skin(&user, "classic", r#", "name": "经典卡片(自定义)""#);
        make_skin(&official, "bad-json", "");
        fs::write(
            official.join("bad-json").join("skin.json"),
            "not json{",
        )
        .unwrap();
        // 缺 skin.json 的子文件夹也是皮肤(无效皮肤),在设置界面可见"无效"而非消失
        fs::create_dir_all(user.join("empty-dir")).unwrap();
        let roots = SkinRoots { official: Some(official), user: Some(user) };
        let (entries, errors) = enumerate_skins(&roots);
        assert!(errors.is_empty());
        let keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, vec!["official:bad-json", "official:classic", "user:classic", "user:empty-dir"]);
        let user_classic = entries.iter().find(|e| e.key == "user:classic").unwrap();
        assert_eq!(user_classic.name, "经典卡片(自定义)");
        assert!(user_classic.valid);
        assert!(user_classic.preview_ok);
        let bad = entries.iter().find(|e| e.key == "official:bad-json").unwrap();
        assert!(!bad.valid);
        assert!(bad.error.as_deref().unwrap().contains("JSON 解析失败"));
        assert_eq!(bad.name, "bad-json"); // 无效时回退文件夹名
    }
}
