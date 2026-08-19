//! 皮肤命中区域(触发范围):窗口逻辑像素坐标系(原点左上角,与 skin.json 的
//! width/height 同一坐标系)下的形状判定。
//!
//! - `Full`:整窗(skin.json 缺省 hitRegion 时的行为,不安装原生命中处理);
//! - `Ellipse`:椭圆(圆形取 rx == ry);
//! - `Path`:SVG path `d` 子集(M m L l H h V v Z z C c Q q A a),按偶奇填充规则判定。
//!   曲线在解析时自适应拍平为折线缓存(容差 0.25 逻辑像素),命中测试只做偶奇射线法。
//!
//! 解析与判定均为纯 Rust、无平台依赖,可独立单测。

use serde_json::Value;

const FLATTEN_TOL: f64 = 0.25; // 拍平容差(逻辑像素)
const MAX_FLATTEN_DEPTH: u32 = 24; // 防病态曲线无限递归
const EPS: f64 = 1e-9;
const TAU: f64 = std::f64::consts::TAU;
const FRAC_PI_2: f64 = std::f64::consts::FRAC_PI_2;

/// 一条拍平后的子路径。closed 的编码约定:闭合子路径的末点与首点相同
/// (解析时由 Z 补齐),射线法遍历相邻点对即可,无需再区分是否闭合。
#[derive(Clone, Debug, PartialEq)]
pub struct Polygon {
    pub points: Vec<(f64, f64)>,
}

/// 路径区域:保留原始 `d`(debug 覆盖层直接绘制,与作者意图一致),
/// 附解析时拍平好的折线(命中测试用)。
#[derive(Clone, Debug, PartialEq)]
pub struct PathRegion {
    pub d: String,
    pub polygons: Vec<Polygon>,
}

/// 皮肤命中区域。
#[derive(Clone, Debug, PartialEq)]
pub enum HitRegion {
    Full,
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    Path(PathRegion),
}

impl HitRegion {
    /// 整窗(缺省)→ 无需安装原生命中处理。
    pub fn is_full(&self) -> bool {
        matches!(self, HitRegion::Full)
    }

    /// 从 skin.json 的 `hitRegion` 值解析。缺省(None)→ Full。
    /// 返回 (区域, 子字段警告)。非法 → Err(与顶层字段同风格:响亮报错)。
    pub fn parse(v: Option<&Value>) -> Result<(HitRegion, Vec<String>), String> {
        let obj = match v {
            None | Some(Value::Null) => return Ok((HitRegion::Full, Vec::new())),
            Some(Value::Object(o)) => o,
            Some(_) => return Err("hitRegion 必须是对象".to_string()),
        };

        let known = ["shape", "cx", "cy", "rx", "ry", "d"];
        let mut warnings = Vec::new();
        for key in obj.keys() {
            if !known.contains(&key.as_str()) {
                warnings.push(format!("hitRegion 未知字段: {}", key));
            }
        }

        let shape = obj
            .get("shape")
            .and_then(Value::as_str)
            .ok_or_else(|| "hitRegion 缺少 shape 字段".to_string())?;
        match shape {
            "ellipse" => {
                let num = |key: &str| -> Result<f64, String> {
                    let n = obj
                        .get(key)
                        .and_then(Value::as_f64)
                        .ok_or_else(|| format!("hitRegion.ellipse 字段 {} 缺失或非数字", key))?;
                    if !n.is_finite() {
                        return Err(format!("hitRegion.ellipse 字段 {} 非有限数", key));
                    }
                    Ok(n)
                };
                let (cx, cy, rx, ry) = (num("cx")?, num("cy")?, num("rx")?, num("ry")?);
                if rx <= 0.0 || ry <= 0.0 {
                    return Err(format!(
                        "hitRegion.ellipse 的 rx/ry 必须为正数,实际: {} / {}",
                        rx, ry
                    ));
                }
                Ok((HitRegion::Ellipse { cx, cy, rx, ry }, warnings))
            }
            "path" => {
                let d = obj
                    .get("d")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "hitRegion.path 字段 d 缺失或非字符串".to_string())?;
                let path = PathRegion::parse(d).map_err(|e| format!("hitRegion.path 的 d 非法: {}", e))?;
                Ok((HitRegion::Path(path), warnings))
            }
            other => Err(format!("hitRegion.shape 不支持: {}", other)),
        }
    }

    /// debug 覆盖层用的 JSON 描述(直接内嵌为 JS 对象字面量)。
    pub fn to_json(&self) -> Value {
        match self {
            HitRegion::Full => serde_json::json!({ "shape": "full" }),
            HitRegion::Ellipse { cx, cy, rx, ry } => {
                serde_json::json!({ "shape": "ellipse", "cx": cx, "cy": cy, "rx": rx, "ry": ry })
            }
            HitRegion::Path(p) => serde_json::json!({ "shape": "path", "d": p.d }),
        }
    }

    /// 点是否落在区域内(偶奇填充规则)。
    pub fn contains(&self, x: f64, y: f64) -> bool {
        match self {
            HitRegion::Full => true,
            HitRegion::Ellipse { cx, cy, rx, ry } => {
                let dx = (x - cx) / rx;
                let dy = (y - cy) / ry;
                dx * dx + dy * dy <= 1.0
            }
            HitRegion::Path(p) => {
                let mut inside = false;
                for poly in &p.polygons {
                    let n = poly.points.len();
                    for i in 0..n.saturating_sub(1) {
                        let (x1, y1) = poly.points[i];
                        let (x2, y2) = poly.points[i + 1];
                        // 经典偶奇射线法:只数严格跨越射线(y1/y2 分居 y 两侧)
                        // 且在点右侧的交点;水平边(y1==y2)自然跳过。
                        if (y1 > y) != (y2 > y) {
                            let xint = (x2 - x1) * (y - y1) / (y2 - y1) + x1;
                            if x < xint {
                                inside = !inside;
                            }
                        }
                    }
                }
                inside
            }
        }
    }
}

impl PathRegion {
    /// 解析 SVG path `d` 子集并拍平。非法命令/缺参数/空路径 → Err(含字符位置)。
    pub fn parse(d: &str) -> Result<PathRegion, String> {
        let mut sc = Scanner::new(d);
        let mut polygons: Vec<Polygon> = Vec::new();
        let mut cur = (0.0, 0.0); // 当前点(绝对坐标)
        let mut sub_start = (0.0, 0.0); // 当前子路径起点(Z 后恢复)
        let mut cmd: Option<u8> = None;
        let mut has_any = false;

        loop {
            if let Some(c) = sc.try_cmd() {
                cmd = Some(c);
            } else if sc.at_end() {
                break;
            } else if cmd.is_none() {
                return Err(format!("第 {} 个字符处:数字前缺少命令字母", sc.pos));
            }
            let c = cmd.unwrap();
            match c {
                // M 的第一个坐标对建立新子路径,后续坐标对按 L 处理(SVG 规则)
                b'M' | b'm' => {
                    let p = rel_point((sc.number()?, sc.number()?), cur, c == b'm');
                    has_any = true;
                    cur = p;
                    sub_start = p;
                    polygons.push(Polygon { points: vec![p] });
                    cmd = Some(if c == b'm' { b'l' } else { b'L' });
                }
                b'L' | b'l' => {
                    let p = rel_point((sc.number()?, sc.number()?), cur, c == b'l');
                    has_any = true;
                    push_line(&mut polygons, cur, p);
                    cur = p;
                }
                b'H' | b'h' => {
                    let v = sc.number()?;
                    let p = if c == b'h' { (cur.0 + v, cur.1) } else { (v, cur.1) };
                    has_any = true;
                    push_line(&mut polygons, cur, p);
                    cur = p;
                }
                b'V' | b'v' => {
                    let v = sc.number()?;
                    let p = if c == b'v' { (cur.0, cur.1 + v) } else { (cur.0, v) };
                    has_any = true;
                    push_line(&mut polygons, cur, p);
                    cur = p;
                }
                b'C' | b'c' => {
                    let rel = c == b'c';
                    let n: [f64; 6] = sc.numbers()?;
                    let p1 = rel_point((n[0], n[1]), cur, rel);
                    let p2 = rel_point((n[2], n[3]), cur, rel);
                    let p3 = rel_point((n[4], n[5]), cur, rel);
                    has_any = true;
                    let mut out = Vec::new();
                    flatten_cubic(cur, p1, p2, p3, &mut out, 0);
                    extend(&mut polygons, &out);
                    cur = p3;
                }
                b'Q' | b'q' => {
                    let rel = c == b'q';
                    let n: [f64; 4] = sc.numbers()?;
                    let p1 = rel_point((n[0], n[1]), cur, rel);
                    let p2 = rel_point((n[2], n[3]), cur, rel);
                    has_any = true;
                    // 二次贝塞尔升阶为三次后统一拍平
                    let c1 = (cur.0 + 2.0 / 3.0 * (p1.0 - cur.0), cur.1 + 2.0 / 3.0 * (p1.1 - cur.1));
                    let c2 = (p2.0 + 2.0 / 3.0 * (p1.0 - p2.0), p2.1 + 2.0 / 3.0 * (p1.1 - p2.1));
                    let mut out = Vec::new();
                    flatten_cubic(cur, c1, c2, p2, &mut out, 0);
                    extend(&mut polygons, &out);
                    cur = p2;
                }
                b'A' | b'a' => {
                    let rel = c == b'a';
                    let n: [f64; 7] = sc.numbers()?;
                    let end = rel_point((n[5], n[6]), cur, rel);
                    has_any = true;
                    // SVG 规范 F.6.5/F.6.6:端点参数化 → 中心参数化 → 分段三次贝塞尔
                    let cubics = arc_to_cubics(
                        cur.0, cur.1, n[0], n[1], n[2], n[3] != 0.0, n[4] != 0.0, end.0, end.1,
                    );
                    for (p0, c1, c2, p3) in cubics {
                        let mut out = Vec::new();
                        flatten_cubic(p0, c1, c2, p3, &mut out, 0);
                        extend(&mut polygons, &out);
                    }
                    cur = end;
                }
                b'Z' | b'z' => {
                    // 闭合:末点与首点不同才补线段(与射线法遍历约定对应);
                    // 之后把命令清空——Z 不消费参数,数字前必须再有命令字母
                    if let Some(poly) = polygons.last_mut() {
                        if let (Some(&first), Some(&last)) = (poly.points.first(), poly.points.last()) {
                            if first != last {
                                poly.points.push(first);
                            }
                        }
                    }
                    cur = sub_start;
                    cmd = None;
                }
                other => {
                    return Err(format!(
                        "第 {} 个字符处:不支持的命令 '{}'(仅支持 M m L l H h V v Z z C c Q q A a)",
                        sc.pos, other as char
                    ));
                }
            }
        }
        if !has_any {
            return Err("路径为空,无任何命令".to_string());
        }
        Ok(PathRegion {
            d: d.to_string(),
            polygons,
        })
    }
}

/// 追加线段到当前子路径的折线里(无当前子路径时开一个新子路径——不应发生,
/// 仅防御非法序列;实际 M 必先出现)。
fn push_line(polygons: &mut Vec<Polygon>, from: (f64, f64), to: (f64, f64)) {
    let poly = match polygons.last_mut() {
        Some(p) => p,
        None => {
            polygons.push(Polygon { points: vec![from] });
            polygons.last_mut().unwrap()
        }
    };
    poly.points.push(to);
}

/// 把拍平输出(不含起点,起点即当前点)追加进当前子路径。
fn extend(polygons: &mut Vec<Polygon>, out: &[(f64, f64)]) {
    if out.is_empty() {
        return;
    }
    match polygons.last_mut() {
        Some(p) => p.points.extend_from_slice(out),
        None => polygons.push(Polygon { points: out.to_vec() }),
    }
}

/// 相对坐标:rel 时加当前点。
fn rel_point(p: (f64, f64), cur: (f64, f64), rel: bool) -> (f64, f64) {
    if rel {
        (p.0 + cur.0, p.1 + cur.1)
    } else {
        p
    }
}

/// 自适应拍平三次贝塞尔:控制点与弦的距离 ≤ 容差即认为足够直。
/// out 只收各子段终点(起点 = p0,由调用方持有)。
fn flatten_cubic(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), p3: (f64, f64), out: &mut Vec<(f64, f64)>, depth: u32) {
    if depth >= MAX_FLATTEN_DEPTH
        || (dist_point_seg(p1, p0, p3) <= FLATTEN_TOL && dist_point_seg(p2, p0, p3) <= FLATTEN_TOL)
    {
        out.push(p3);
        return;
    }
    // de Casteljau 中点分割
    let mid = |a: (f64, f64), b: (f64, f64)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let p01 = mid(p0, p1);
    let p12 = mid(p1, p2);
    let p23 = mid(p2, p3);
    let p012 = mid(p01, p12);
    let p123 = mid(p12, p23);
    let p0123 = mid(p012, p123);
    flatten_cubic(p0, p01, p012, p0123, out, depth + 1);
    flatten_cubic(p0123, p123, p23, p3, out, depth + 1);
}

/// 点到线段的距离(投影在段内取垂距,否则取端点距)——拍平平坦度判据。
fn dist_point_seg(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 <= EPS {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0);
    let (qx, qy) = (a.0 + t * dx, a.1 + t * dy);
    ((p.0 - qx).powi(2) + (p.1 - qy).powi(2)).sqrt()
}

/// 椭圆弧 → 最多每 90° 一段的三次贝塞尔近似(SVG 规范 F.6.5 端点参数化 →
/// 中心参数化,F.6.6 弧 → 贝塞尔)。返回 (p0, c1, c2, p3) 序列。
/// 退化(rx 或 ry 为 0)→ 单段直线;large/sweep 为非零即真(与 SVG 容错一致)。
fn arc_to_cubics(
    x1: f64,
    y1: f64,
    rx_in: f64,
    ry_in: f64,
    phi_deg: f64,
    large: bool,
    sweep: bool,
    x2: f64,
    y2: f64,
) -> Vec<((f64, f64), (f64, f64), (f64, f64), (f64, f64))> {
    let mut rx = rx_in.abs();
    let mut ry = ry_in.abs();
    if rx <= EPS || ry <= EPS {
        // SVG:半径为零按直线处理
        return vec![((x1, y1), (x1, y1), (x2, y2), (x2, y2))];
    }
    let phi = phi_deg.to_radians();
    let (sinp, cosp) = phi.sin_cos();

    // F.6.5:端点参数化 → 中心参数化(先做半径校正)
    let dx2 = (x1 - x2) / 2.0;
    let dy2 = (y1 - y2) / 2.0;
    let x1p = cosp * dx2 + sinp * dy2;
    let y1p = -sinp * dx2 + cosp * dy2;
    let lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let sign = if large == sweep { -1.0 } else { 1.0 };
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let (cxp, cyp) = if den.abs() <= EPS {
        (0.0, 0.0)
    } else {
        let coef = sign * (num.max(0.0) / den).sqrt();
        (coef * rx * y1p / ry, -coef * ry * x1p / rx)
    };
    let cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2.0;
    let cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2.0;

    let (ux, uy) = ((x1p - cxp) / rx, (y1p - cyp) / ry);
    let (vx, vy) = ((-x1p - cxp) / rx, (-y1p - cyp) / ry);
    let theta1 = uy.atan2(ux);
    let mut dtheta = (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    if !sweep && dtheta > 0.0 {
        dtheta -= TAU;
    }
    if sweep && dtheta < 0.0 {
        dtheta += TAU;
    }

    // F.6.6:每段 ≤ 90° 的三次贝塞尔近似
    let segs = (dtheta.abs() / FRAC_PI_2).ceil().max(1.0) as usize;
    let dt = dtheta / segs as f64;
    let alpha = 4.0 / 3.0 * (dt / 4.0).tan();
    let mut out = Vec::with_capacity(segs);
    for i in 0..segs {
        let t1 = theta1 + i as f64 * dt;
        let t2 = t1 + dt;
        let (s1, c1) = t1.sin_cos();
        let (s2, c2) = t2.sin_cos();
        let p0 = (cx + rx * c1, cy + ry * s1);
        let p3 = (cx + rx * c2, cy + ry * s2);
        let c1p = (cx + rx * (c1 - alpha * s1), cy + ry * (s1 + alpha * c1));
        let c2p = (cx + rx * (c2 + alpha * s2), cy + ry * (s2 - alpha * c2));
        out.push((p0, c1p, c2p, p3));
    }
    out
}

/// path `d` 的字节扫描器:命令字母 / 数字(带符号、小数、指数),跳过空白与逗号。
struct Scanner<'a> {
    s: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(s: &'a str) -> Self {
        Scanner { s: s.as_bytes(), pos: 0 }
    }

    fn at_end(&self) -> bool {
        self.pos >= self.s.len()
    }

    fn skip_ws(&mut self) {
        while let Some(&c) = self.s.get(self.pos) {
            if c.is_ascii_whitespace() || c == b',' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    /// 下一个字符是命令字母则消费并返回;否则 None(隐式重复前一命令)。
    fn try_cmd(&mut self) -> Option<u8> {
        self.skip_ws();
        let c = *self.s.get(self.pos)?;
        if c.is_ascii_alphabetic() {
            self.pos += 1;
            Some(c)
        } else {
            None
        }
    }

    /// 读取固定数量的数字。
    fn numbers<const N: usize>(&mut self) -> Result<[f64; N], String> {
        let mut out = [0.0; N];
        for item in out.iter_mut() {
            *item = self.number()?;
        }
        Ok(out)
    }

    fn number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        if let Some(c) = self.s.get(self.pos) {
            if *c == b'+' || *c == b'-' {
                self.pos += 1;
            }
        }
        while let Some(c) = self.s.get(self.pos) {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }
        if let Some(c) = self.s.get(self.pos) {
            if *c == b'.' {
                self.pos += 1;
                while let Some(c2) = self.s.get(self.pos) {
                    if c2.is_ascii_digit() {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
            }
        }
        if let Some(c) = self.s.get(self.pos) {
            if *c == b'e' || *c == b'E' {
                let mut p = self.pos + 1;
                if let Some(c2) = self.s.get(p) {
                    if *c2 == b'+' || *c2 == b'-' {
                        p += 1;
                    }
                }
                let mut digits = 0;
                while let Some(c2) = self.s.get(p) {
                    if c2.is_ascii_digit() {
                        p += 1;
                        digits += 1;
                    } else {
                        break;
                    }
                }
                if digits == 0 {
                    return Err(format!("第 {} 个字符处:指数缺少数字", self.pos));
                }
                self.pos = p;
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.pos])
            .map_err(|_| format!("第 {} 个字符处:非法字符", start))?;
        text.parse::<f64>()
            .map_err(|_| format!("第 {} 个字符处:非法数字 '{}'", start, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(d: &str) -> HitRegion {
        HitRegion::Path(PathRegion::parse(d).unwrap())
    }

    fn assert_contains(region: &HitRegion, points: &[(f64, f64, bool)]) {
        for &(x, y, want) in points {
            assert_eq!(
                region.contains(x, y),
                want,
                "contains({}, {}) 应为 {}",
                x,
                y,
                want
            );
        }
    }

    #[test]
    fn ellipse_contains() {
        let r = HitRegion::Ellipse { cx: 100.0, cy: 100.0, rx: 88.0, ry: 50.0 };
        assert_contains(
            &r,
            &[
                (100.0, 100.0, true),   // 中心
                (188.0, 100.0, true),   // 右缘(rx 边界含等号)
                (188.01, 100.0, false), // 右缘外
                (100.0, 150.0, true),   // 下缘(ry 边界)
                (100.0, 150.01, false), // 下缘外
                (100.0 + 88.0 * 0.8, 100.0 + 50.0 * 0.8, false), // 0.64+0.64=1.28 > 1
                (100.0 + 88.0 * 0.8, 100.0 + 50.0 * 0.3, true),  // 0.64+0.09 < 1
            ],
        );
    }

    #[test]
    fn full_contains_everything() {
        assert!(HitRegion::Full.contains(-1e9, -1e9));
        assert!(HitRegion::Full.contains(0.0, 0.0));
        assert!(HitRegion::Full.is_full());
    }

    #[test]
    fn path_rect_with_h_v_relative() {
        let r = region("M 10 10 h 80 v 80 h -80 z");
        assert_contains(
            &r,
            &[
                (50.0, 50.0, true),
                (10.0, 50.0, true),  // 左边界(半开约定算在内)
                (89.9, 89.9, true),
                (95.0, 95.0, false), // 右下角外
                (0.0, 50.0, false),  // 左边外
            ],
        );
    }

    #[test]
    fn path_triangle() {
        let r = region("M 0 0 L 100 0 L 50 80 Z");
        assert_contains(
            &r,
            &[
                (50.0, 40.0, true),
                (10.0, 10.0, true),
                (90.0, 60.0, false), // 右腰之外
                (50.0, 85.0, false), // 底边之下
                (50.0, -5.0, false), // 顶边之上
            ],
        );
    }

    #[test]
    fn path_m_implicit_lineto() {
        // M 后的坐标对按 L 处理
        let r = region("M 0 0 100 0 100 100 0 100 Z");
        assert_contains(&r, &[(50.0, 50.0, true), (150.0, 50.0, false)]);
    }

    #[test]
    fn path_cubic_bulge() {
        // 曲线从 (0,0) 下凸到 y≈75 再回到 (100,0),与弦围成封闭区域
        let r = region("M 0 0 C 0 100 100 100 100 0 Z");
        assert_contains(
            &r,
            &[
                (50.0, 30.0, true),  // 弦与曲线之间
                (50.0, 70.0, true),  // 靠近曲线最低点 y=75,但明确在内侧
                (50.0, 80.0, false), // 曲线最低点之下(曲线外侧)
                (50.0, -5.0, false), // 弦之上
            ],
        );
    }

    #[test]
    fn path_circle_from_arcs() {
        // 两个半圆弧拼成整圆(含 A 命令拍平路径)
        let r = region("M 100 0 A 100 100 0 1 1 100 200 A 100 100 0 1 1 100 0 Z");
        assert_contains(
            &r,
            &[
                (100.0, 100.0, true),  // 圆心
                (150.0, 100.0, true),  // 圆内右
                (100.0, 15.0, true),   // 圆内上(距边缘 15)
                (100.0, 205.0, false), // 圆外下
                (210.0, 100.0, false), // 圆外右
                (100.0, -10.0, false), // 圆外上
                (40.0, 40.0, true),    // 左上:√(60²+60²)≈84.9 < 100 → 圆内
            ],
        );
    }

    #[test]
    fn path_evenodd_ring_hole() {
        // 外圆 r=100 + 内圆 r=50:偶奇规则 → 圆环为命中区,内孔/外圈之外都不命中
        let d = "M 100 0 A 100 100 0 1 1 100 200 A 100 100 0 1 1 100 0 Z \
                 M 100 50 A 50 50 0 1 0 100 150 A 50 50 0 1 0 100 50 Z";
        let r = region(d);
        assert_contains(
            &r,
            &[
                (100.0, 25.0, true),   // 环内(内外圆之间,上部)
                (100.0, 175.0, true),  // 环内(下部)
                (100.0, 100.0, false), // 内孔(圆心)
                (100.0, 130.0, false), // 内孔
                (100.0, 230.0, false), // 外圆之外
            ],
        );
    }

    #[test]
    fn path_open_polyline_no_implicit_close() {
        // 开放折线:不允许末点→首点的隐含闭合边。
        // 判别点 (5,90):若错误补上隐含闭合边,三条边构成三角形,
        // 斜边在 y=90 处交点 x=10,(5,90) 在三角形外 → false;
        // 开放路径只数两条实际边(竖边 x=100)→ true。
        let r = region("M 0 0 L 100 0 L 100 100");
        assert_contains(&r, &[(5.0, 90.0, true), (150.0, 50.0, false), (50.0, -10.0, false)]);
    }

    #[test]
    fn path_quad_and_arc_degenerate() {
        // Q 命令 + 零半径弧退化直线
        let r = region("M 0 0 Q 50 100 100 0 Z");
        assert_contains(&r, &[(50.0, 30.0, true), (50.0, 80.0, false)]);
        let line = region("M 0 0 A 0 0 0 0 1 100 0 Z");
        assert_contains(&line, &[(50.0, 1.0, false)]);
    }

    #[test]
    fn parse_errors() {
        let cases: &[(&str, &str)] = &[
            ("", "空"),
            ("10 20", "缺少命令字母"),
            ("M", "缺参数"),
            ("M 0", "缺参数"),
            ("M 0 0 L 10", "缺参数"),
            ("M 0 0 X 1 2", "不支持的命令"),
            ("M 0 0 L 10 abc", "非法数字"),
            ("M 0 0 Q 10", "缺参数"),
        ];
        for (d, why) in cases {
            let err = PathRegion::parse(d).expect_err(&format!("{} 应报错: {}", why, d));
            assert!(!err.is_empty(), "错误信息不应为空: {}", d);
        }
    }

    #[test]
    fn parse_ok_cases() {
        // 数字格式:指数、.5 前导、逗号分隔、多余空白
        let r = region("M 1e1,1e1 L .5 20. 30 40Z");
        assert!(r.contains(11.0, 15.0));
        // Z 后显式 M 开新子路径
        let r2 = region("M 0 0 H 10 V 10 H 0 Z M 50 50 H 60 V 60 H 50 Z");
        assert!(r2.contains(5.0, 5.0));
        assert!(r2.contains(55.0, 55.0));
        assert!(!r2.contains(30.0, 30.0));
    }

    #[test]
    fn parse_json_variants() {
        // 缺省 → Full
        let (r, w) = HitRegion::parse(None).unwrap();
        assert_eq!(r, HitRegion::Full);
        assert!(w.is_empty());

        // 合法椭圆
        let (r, w) = HitRegion::parse(Some(&serde_json::json!({
            "shape": "ellipse", "cx": 100, "cy": 100, "rx": 88, "ry": 88
        })))
        .unwrap();
        assert_eq!(
            r,
            HitRegion::Ellipse { cx: 100.0, cy: 100.0, rx: 88.0, ry: 88.0 }
        );
        assert!(w.is_empty());

        // 合法路径
        let (r, _) = HitRegion::parse(Some(&serde_json::json!({
            "shape": "path", "d": "M 0 0 H 10 V 10 H 0 Z"
        })))
        .unwrap();
        assert!(r.contains(5.0, 5.0));

        // 未知子字段 → 警告
        let (_, w) = HitRegion::parse(Some(&serde_json::json!({
            "shape": "ellipse", "cx": 1, "cy": 1, "rx": 1, "ry": 1, "extra": 5
        })))
        .unwrap();
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("extra"));
    }

    #[test]
    fn parse_json_errors() {
        let cases: &[(&Value, &str)] = &[
            (&serde_json::json!(5), "hitRegion 必须是对象"),
            (&serde_json::json!({"cx": 1, "cy": 1, "rx": 1, "ry": 1}), "缺少 shape"),
            (&serde_json::json!({"shape": "rect"}), "shape 不支持"),
            (&serde_json::json!({"shape": "ellipse"}), "cx 缺失"),
            (&serde_json::json!({"shape": "ellipse", "cx": 1, "cy": 1, "rx": 1}), "ry 缺失"),
            (
                &serde_json::json!({"shape": "ellipse", "cx": 1, "cy": 1, "rx": -1, "ry": 1}),
                "rx 非正",
            ),
            (&serde_json::json!({"shape": "ellipse", "cx": 1, "cy": 1, "rx": 0, "ry": 1}), "rx 非正"),
            (&serde_json::json!({"shape": "ellipse", "cx": "a", "cy": 1, "rx": 1, "ry": 1}), "非数字"),
            (&serde_json::json!({"shape": "path"}), "d 缺失"),
            (&serde_json::json!({"shape": "path", "d": "M 0 0 X"}), "d 非法"),
        ];
        for (v, why) in cases {
            let err = HitRegion::parse(Some(v)).expect_err(&format!("应报错: {}", why));
            assert!(!err.is_empty());
        }
    }

    #[test]
    fn to_json_roundtrip() {
        assert_eq!(HitRegion::Full.to_json(), serde_json::json!({"shape": "full"}));
        let ell = HitRegion::Ellipse { cx: 1.0, cy: 2.0, rx: 3.0, ry: 4.0 };
        assert_eq!(
            ell.to_json(),
            serde_json::json!({"shape": "ellipse", "cx": 1.0, "cy": 2.0, "rx": 3.0, "ry": 4.0})
        );
        let p = HitRegion::Path(PathRegion::parse("M 0 0 Z").unwrap());
        assert_eq!(p.to_json(), serde_json::json!({"shape": "path", "d": "M 0 0 Z"}));
    }
}
