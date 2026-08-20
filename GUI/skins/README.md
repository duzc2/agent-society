# Agent Society 悬浮窗皮肤开发文档

本文档面向两类读者:人类开发者与 LLM(大语言模型)开发者。所有规则表述力求无歧义、可逐条执行;第 5 节的最小示例可以直接整段抄写。

## 1. 什么是皮肤

悬浮监视窗(无边框、透明、置顶的小窗口)的**外观与窗口结构**由一个"皮肤"决定。皮肤不写任何 Rust 代码,就是一个普通文件夹:

- **窗口结构**(宽、高、透明、置顶等)由 `skin.json` 声明;
- **全部视觉**(背景、文字、图形、动画)由 `index.html`(可带 css/js/图片等任意资源)实现;
- **数据**由启动器通过全局 DOM 事件 `dateUpdate` 推送给页面。

皮肤页面**不得依赖 Tauri API**(`window.__TAURI__` 等);右键菜单由启动器统一注入,皮肤无需(也不应)自行实现。

## 2. 目录与必备文件

皮肤放在两个文件夹之一,集合由**子文件夹动态枚举**(无索引文件):

| 文件夹 | 来源标识 | 说明 |
|---|---|---|
| `GUI/skins/` | `official` | 官方皮肤,**git 管理**,随发布包 |
| `GUI/skins-user/` | `user` | 用户自定义皮肤,**gitignore 排除**,不随发布包 |

每个皮肤文件夹(如 `GUI/skins/classic/`)必备三件,可另带任意资源:

```
classic/
├── skin.json      # 描述性 JSON:显示名 + 窗口结构(必填)
├── preview.png    # 效果图:恰好 240x160 像素的 PNG(必填,设置界面平铺展示)
└── index.html     # 页面入口(必填;css/js/图片等由其自行引用)
```

**皮肤身份 = 来源 + 文件夹名**,例如 `official:classic`、`user:classic`。文件夹名规则:`^[A-Za-z0-9_-]{1,64}$`(字母/数字/下划线/连字符)。JSON 里**没有 id 字段**;两个文件夹可以有同名子文件夹(视为两个皮肤,并存互不覆盖)。文件夹名只作存储定位与技术键,显示名以 `skin.json` 的 `name` 为准。

## 3. skin.json 规范

```json
{
  "name": "经典卡片",
  "version": 1,
  "width": 300,
  "height": 112,
  "transparency": true,
  "alwaysOnTop": true,
  "shadow": false,
  "resizable": false,
  "skipTaskbar": true
}
```

| 字段 | 类型 | 必填 | 取值 | 默认值 |
|---|---|---|---|---|
| `name` | string | 是 | 1–64 字符,设置界面显示名 | — |
| `version` | integer | 是 | 必须为 `1` | — |
| `width` | number | 是 | `5` ~ `2000`(逻辑像素) | — |
| `height` | number | 是 | `5` ~ `2000`(逻辑像素) | — |
| `hitRegion` | object | 否 | 鼠标命中区域(见 3.1);缺省 = 整窗 | 整窗 |
| `transparency` | boolean | 否 | 窗口背景透明(Windows 上决定窗口是否带 WS_EX_NOREDIRECTIONBITMAP) | `true` |
| `alwaysOnTop` | boolean | 否 | 置顶 | `true` |
| `shadow` | boolean | 否 | 系统窗口阴影(透明窗口建议 `false`) | `false` |
| `resizable` | boolean | 否 | 用户可否调整大小 | `false` |
| `skipTaskbar` | boolean | 否 | 不在任务栏出现 | `true` |

规则:

- 未知字段**仅警告**,不报错(帮助发现拼写错误);
- `version` 为将来 schema 演进预留,现在只接受 `1`;
- 窗口位置不由皮肤配置:监视窗固定停靠主显示器工作区右上角(边距 12 逻辑像素,按皮肤宽度计算);
- 解析失败的皮肤在启动时回退内置 classic 页面,错误写入 `GUI/logs/launcher.log`。

### 3.1 命中区域 hitRegion(可选)

透明窗口的**整个矩形**(含看不见的部分)默认都会拦截鼠标。`hitRegion` 把"窗口响应点击/拖拽的区域"缩小到内容形状:**区域外的点击直接穿透到下层软件**,区域内行为(拖拽、右键菜单)不变。

- 坐标单位 = 窗口逻辑像素,原点左上角(与 `width`/`height` 同一坐标系);
- **区域内拖拽**:鼠标事件只会到达命中区域内的页面。建议皮肤把可拖拽容器标 `data-tauri-drag-region="deep"`(子树任意后代按下左键都拖拽;**裸属性只对元素自身生效**,点在文字/图形等子元素上不会拖——三款官方皮肤均已用 `deep`)。皮肤没有任何标记时,启动器兜底为**拖拽移动悬浮窗**;可交互元素(A/BUTTON/INPUT/SELECT/TEXTAREA/LABEL/SUMMARY、可交互 role)、`data-tauri-drag-region="false"` 的显式禁用、以及皮肤对 `mousedown` 调 `preventDefault`,兜底都会让位;
- 两种形状:
  - `ellipse`:椭圆(圆形取 `rx == ry`);
  - `path`:SVG path `d` 子集(`M m L l H h V v Z z C c Q q A a`),按偶奇填充规则判定(嵌套子路径自动成孔);
- 非法配置按 skin.json 错误处理(响亮失败,不静默回退整窗);
- debug 模式下启动器会叠加半透明红色覆盖层显示实际命中区域(仅调试窗口可见);缺省时显示整窗虚线框。

```jsonc
// 圆形(环形仪表窗口 200x200,圆环外缘约 80,留少量边距):
"hitRegion": { "shape": "ellipse", "cx": 100, "cy": 100, "rx": 88, "ry": 88 }

// 圆角矩形(190x112 卡片,圆角半径 16):
"hitRegion": { "shape": "path", "d": "M 20 4 H 170 Q 186 4 186 20 V 92 Q 186 108 170 108 H 20 Q 4 108 4 92 V 20 Q 4 4 20 4 Z" }

// 挖孔圆环(外圆 + 内圆,偶奇规则自动成孔):
"hitRegion": { "shape": "path", "d": "M 100 0 A 100 100 0 1 1 100 200 A 100 100 0 1 1 100 0 Z M 100 50 A 50 50 0 1 0 100 150 A 50 50 0 1 0 100 50 Z" }
```

提示:窗口尺寸应尽量贴合内容(透明边也会吞点击——命中区域外、窗口矩形内的部分仍拦截鼠标;只有 `hitRegion` 外才穿透)。为此宁可多写一条 path,也不要留大面积透明窗口。

## 4. 数据契约:dateUpdate 事件

启动器在每次数据更新时,向监视窗页面派发 `window` 上的 **CustomEvent `"dateUpdate"`**。页面必须在脚本**解析期**(而非 `DOMContentLoaded` 之后)注册监听——启动器在页面加载完成后立即补发最近一次数据,晚注册会丢第一帧。

```html
<script>
window.addEventListener("dateUpdate", (event) => {
  const { total, working, server, updated } = event.detail;
  // ...
});
</script>
```

`event.detail` 字段:

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` | number \| null | 存在的智能体总数(组织树中未删除节点) |
| `working` | number \| null | 正在工作的智能体数(processing / waiting_llm) |
| `server` | string | `"up"`(运行中)/ `"busy"`(繁忙)/ `"down"`(端口关闭)/ `"stopping"`(正在停止) |
| `updated` | boolean | 本次是否有新数据(用于"更新时间"类展示) |

注意:

- **`stopping` 载荷只带 `server` 字段**(数字保留上次值)——渲染数字前必须类型守卫:`typeof p.total === "number"`;`total`/`working` 可能为 `null`(尚无数据),初始渲染请用 `--` 或"连接中…";
- 生产模式刷新周期 2 秒;皮肤调试模式每 10 秒随机变化;
- 四态视觉都应当有对应呈现(up/busy/down/stopping),调试模式会轮换三态供核对。

## 5. 最小完整示例(可直接抄写)

`GUI/skins-user/minimal/` 下三件套:

**skin.json**

```json
{
  "name": "我的最小皮肤",
  "version": 1,
  "width": 240,
  "height": 88
}
```

**index.html**(样式与脚本内联,单文件即可)

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      background: transparent;  /* 透明窗口必须 */
      margin: 0; overflow: hidden;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      user-select: none;
    }
    .num { font-size: 30px; font-weight: 700; color: #fff;
           text-shadow: 0 1px 3px rgba(0,0,0,.7); }
    .label { font-size: 11px; color: rgba(255,255,255,.6); }
    #working { color: #fbbf24; }
  </style>
</head>
<body>
  <div data-tauri-drag-region="deep">
    <span class="label">智能体</span> <span id="total" class="num">--</span>
    &nbsp;&nbsp;
    <span class="label">工作中</span> <span id="working" class="num">--</span>
  </div>
  <script>
    window.addEventListener("dateUpdate", (event) => {
      const p = event.detail || {};
      if (typeof p.total === "number") {
        document.getElementById("total").textContent = String(p.total);
      }
      if (typeof p.working === "number") {
        document.getElementById("working").textContent = String(p.working);
      }
    });
  </script>
</body>
</html>
```

**preview.png**:任意 240x160 PNG(可在调试后截图替换)。

校验:`node GUI/scripts/skin-tool.mjs check user:minimal`,通过后 `node GUI/scripts/skin-tool.mjs debug user:minimal` 即可预览。

## 6. 内置官方皮肤对照

| 皮肤 | 技术键 | 尺寸 | 演示要点 |
|---|---|---|---|
| 经典卡片 | `official:classic` | 190x112 | 深色圆角卡片 + 状态点四色 + 双计数 + 更新时间;迁移旧版设计的模板 |
| 极简数字 | `official:minimal` | 216x84 | 无卡片、纯文字大字数字、完全透明背景、自定义排版 |
| 环形仪表 | `official:gauge` | 200x200 | SVG 渐变圆环 + stroke-dasharray 比例动画 + 中心数字;命中区域为椭圆(圆环外四角点击穿透) |

每个皮肤都遵循第 2–4 节全部规则,是开发新皮肤的参考实现。

## 7. 校验与调试工具

`GUI/scripts/skin-tool.mjs`(纯 Node,零依赖):

```bash
node GUI/scripts/skin-tool.mjs check <skin>   # 校验:配置/效果图/媒体资源
node GUI/scripts/skin-tool.mjs list           # 列出两个文件夹的全部皮肤与状态
node GUI/scripts/skin-tool.mjs debug <skin>   # 校验通过后打开调试悬浮窗
node GUI/scripts/skin-tool.mjs --help
```

`<skin>` 取值:`official:<folder>` / `user:<folder>` / 裸 `<folder>`(官方优先)。

**check 校验内容**(全部通过退出码 0,任一 ❌ 退出码 1):

1. 皮肤目录存在;`skin.json` 存在且是合法 JSON(顶层对象);
2. schema 逐字段校验(见第 3 节表);未知字段 ⚠ 警告;
3. `index.html` 存在;
4. `preview.png` 存在、PNG 魔数正确、IHDR 尺寸**恰好 240x160**;
5. 媒体引用扫描:HTML 的 `src`/`href`/`poster`、内联 `style="url(...)"`、`<style>` 块、CSS 的 `url()`/`@import`、JS 的 `fetch()`/`import()`/`url()` 中的**相对路径**必须存在且不逃逸皮肤目录;`http(s):`、`data:`、`#锚点` 放行;`/` 开头的绝对路径、`..` 逃逸、`skin://`/`tauri://` 字面量、反斜杠路径 → ❌。

**debug 调试模式**:

- 校验不过不启动;通过后**自动启动** GUI 启动器的皮肤调试模式(`--skin-debug <key>`),全程无需人工拉起 launcher;
- exe 不存在时自动先执行 `cargo build`(src-tauri)再启动,构建失败才报错退出;
- 只打开皮肤悬浮窗(**真实 WebView2 窗口**:透明/置顶/无边框/尺寸全部与生产一致);
- 命中区域以半透明红色覆盖层显示(定义了 `hitRegion` 时;缺省显示整窗虚线框),用于核对"哪些点击会穿透";右键菜单"**显示命中区域**"勾选项可随时显示/隐藏覆盖层(初始显示);
- 假数据:初始 `{total: 42, working: 17, server: "up"}`,之后每 10 秒随机(total 10..99、working ≤ total、server 在 up/busy/down 轮换);
- 不启动服务器/托盘/单实例插件——可与运行中的生产实例并存;
- 退出:悬浮窗上右键 → "退出调试" / 按 Esc(先点一下窗口获得焦点)/ 关闭窗口;
- 要求 GUI 已构建:`cd GUI/src-tauri && cargo build`(脚本自动找 `target/debug`,其次 `target/release`)。

工具自身的测试:`cd GUI/scripts && node --test test/skin-tool.test.mjs`(根目录 `npm test` 的 glob 不覆盖 GUI/scripts,故用此命令)。

## 8. 设置界面与换肤

- 入口:托盘图标右键菜单或监视窗右键菜单 → "**设置**"。
- 设置窗口以**两列网格**平铺所有皮肤(官方 + 自定义,卡片带来源角标"官方/自定义");预览图按 240x160 显示;无效皮肤显示"无效:原因";当前皮肤高亮。
- 选中卡片 → 点"**应用**"→ **立即生效**(运行时换肤:重建监视窗,尺寸/透明/置顶等按新配置);同时把 `monitorSkin` 写入 `launcher.json`(**保留其余键**),下次启动沿用。`launcher.json` 是**用户本地文件**(git 不跟踪,从 `config/launcher.json.example` 复制创建)。
- `launcher.json` 的 `monitorSkin` 键与皮肤键同格式:`"official:classic"`、`"user:my-skin"`、裸 `"classic"`(官方优先)。默认值 `classic`。
- 写配置失败不影响本次会话(仅记日志),但下次启动会回到旧值。

## 9. 打包与发布

- 官方皮肤(`GUI/skins/`)必须 **git 跟踪**(`git ls-files` 能看到)才会被 `scripts/win/build_exe.ps1` 复制进发布包;未跟踪文件永不打包。发布布局:`<安装目录>/GUI/skins/<folder>/`。
- 启动器安装包(`cargo tauri build` 的 NSIS 产物)经 `tauri.conf.json` 的 `bundle.resources` map(`"../skins": "GUI/skins"`)携带官方皮肤,安装布局同为 `<安装目录>/GUI/skins/<folder>/`;注意该方式按目录**整体复制**(含未跟踪文件),与 build_exe.ps1 的 git 跟踪过滤不同。
- `GUI/skins-user/` 被 .gitignore 排除,**不随包发布**;但发布版运行时会动态发现安装目录旁的 `GUI/skins-user/`——用户把皮肤文件夹放进去即可在设置界面看到,无需改官方皮肤。
- 开发布局:启动器从 `GUI/src-tauri/target/debug` 向上找 GUI 项目根(`src-tauri/tauri.conf.json` 标记),使用 `GUI/skins/` 与 `GUI/skins-user/`。dev 下**优先取 GUI 项目根的活文件**——tauri-build 每次构建都会把 resources 复制到 `target/debug/GUI/skins`,该副本仅供发行布局回退,不改皮肤不重新构建也生效。

## 10. 资源与 MIME

- 皮肤页通过 `skin://` 协议加载(如 `skin://localhost/official/classic/index.html`),同目录相对引用自动可用;**只允许相对路径**。
- 设置页预览图是页面内**子资源**请求:Windows/WebView2 上 wry 只拦截 `http://skin.*` 形式的请求(导航 URL 才会被自动改写),所以预览图必须用 `http://skin.localhost/<source>/<folder>/preview.png`(拦截后 revert 回 `skin://` 交给同一 handler)。
- 支持的 MIME(按扩展名):html/htm、css、js/mjs、json、txt、svg、png、jpg/jpeg、gif、webp、ico、woff/woff2、ttf、mp3、wav;其他按 `application/octet-stream`。
- 皮肤文件不得被 symlink 指到皮肤目录之外(协议层会拒绝)。
- 皮肤内不要写死 `skin://` / `tauri://` URL(校验器会拒绝);远程 http(s) 资源允许但不建议(离线不可用)。

## 11. 常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| 校验报 `preview.png 尺寸须为 240x160` | 效果图尺寸不符 | 生成/截取恰好 240x160 的 PNG |
| 窗口有白底 | 页面未设置 `html,body{background:transparent}`,或 `transparency:false` | 补 CSS 透明;确认 skin.json 的 transparency |
| 应用后窗口没变化 | 换肤失败(launcher.log 有"皮肤加载失败") | 按日志原因修复后重试;失败时不切换 |
| 启动时皮肤没生效,回退成默认卡片 | launcher.json 的 monitorSkin 指向不存在/非法皮肤 | `skin-tool.mjs list` 核对技术键 |
| 首次数据迟迟不来 | 监听注册晚于页面加载完成 | 把 `addEventListener` 放在脚本顶层(解析期) |
| `stopping` 时数字变 `undefined` | 没做类型守卫 | `typeof p.total === "number"` 再渲染 |
| 右键菜单消失 | 皮肤脚本对 `contextmenu` 调用了 `stopImmediatePropagation` | 皮肤不要拦截该事件(启动器注入的菜单依赖它) |
| 调试窗口关不掉 | 未使用"退出调试"/Esc | 右键 → 退出调试;或任务管理器结束进程(调试实例不启动服务器,无副作用) |

## 12. 给 LLM 开发者的清单

生成一个合法皮肤,依次满足:

1. 文件夹名匹配 `^[A-Za-z0-9_-]{1,64}$`,放 `GUI/skins/`(官方)或 `GUI/skins-user/`(自定义);
2. `skin.json`:顶层对象;`name` 非空 ≤64 字符;`version` 恰为整数 `1`;`width`/`height` 为 `5..2000` 的数字;布尔字段缺省即默认,写了必须是 true/false;命中区域可选 `hitRegion`(见 3.1,窗口大内容小时建议定义);不要发明新字段(会被警告);
3. `index.html`:UTF-8 + `lang="zh-CN"`;CSS 里 `html, body { background: transparent; margin: 0; overflow: hidden; user-select: none; }`;
4. 脚本在解析期注册 `window.addEventListener("dateUpdate", ...)`,不做任何 `__TAURI__` 调用;窗口拖拽:拖拽容器标 `data-tauri-drag-region="deep"`(裸属性只对元素自身生效),或完全不管(启动器在命中区域内兜底拖拽,见 3.1);
5. 渲染 `total`/`working` 前做 `typeof === "number"` 守卫;`server` 四态(up/busy/down/stopping)都有视觉;
6. 全部资源用相对路径(`./` 或直接文件名),无 `/` 开头、无 `..` 逃逸、无 `skin://`/`tauri://` 字面量;
7. `preview.png` 恰好 240x160;
8. 交付前运行 `node GUI/scripts/skin-tool.mjs check <key>`,全部 ✅ 再交付;用 `debug <key>` 实际打开看效果。
