本文件夹提供面向本软件自身 Web UI 页面的工具模块（非 puppeteer/chrome）。

功能：
- 将智能体的工具调用转换为“前端页面指令”，由浏览器页面通过轮询领取并在页面上下文中执行。
- 支持在页面内执行 JavaScript、获取页面内容、对 DOM/CSS 做临时修改；刷新页面后修改自然丢失。
- **自动加载**：执行 JS 后的保存提示可勾选「自动加载」——脚本只记录工作区路径（不复制文件），
  之后每次页面刷新/加载时按注册顺序自动执行。可在「模块管理 → ui_page」面板中启用/禁用/删除记录
  （删除仅移除记录，不删除工作区文件），面板支持搜索、添加脚本（列出各工作区 `ui_page_js/` 下
  未注册的 JS）、以及单条"运行"预览（在主页面上下文执行一次，确认效果，不弹保存提示）。
  注册表持久化在 `config/modules/ui_page.json`（autoLoadScripts 键）。
- **脚本目的描述**：保存脚本时把 `purpose`（工具参数）写入脚本文件头部注释 `// purpose: xxx`，
  作为描述的唯一数据源（不落注册表）。管理面板的启动项列表与候选脚本列表都从文件解析展示
  （启动项里描述独立整行，单行截断、悬停看全文），搜索框也按描述匹配；旧脚本无头注释则无描述。
- **归属显示**：列表的「组织」列显示 agentName（组织名 / 最上层agent名），由服务端从 org 树
  （`org.listAgents()` + `getOrgName()`，沿 parentAgentId 链找顶层 agent）富化而来；
  org 不可用或 agent 不在树中时回退显示原始 workspaceId。

文件：
- index.js：模块入口，定义工具组并通过 runtime.uiCommandBroker 下发指令并等待结果；
  提供 Web 管理面板（getWebComponent）与自动加载脚本管理 API（getHttpHandler）。
- tools.js：工具定义（OpenAI tools schema）。
- broker.js：UI 指令投递与结果等待（心跳通道）。
- auto_load.js：自动加载脚本注册表（记录 workspaceId+路径、启停、按路径读文件内容）。
- save-eval-script.js：`POST /api/save-eval-script` 保存脚本到工作区 `ui_page_js/`（purpose 写入文件头注释），支持 autoLoad 注册。
- web/panel.html|css|js：模块管理窗口的「Web JS 自动加载」管理面板。
