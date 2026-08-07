本文件夹提供面向本软件自身 Web UI 页面的工具模块（非 puppeteer/chrome）。

功能：
- 将智能体的工具调用转换为“前端页面指令”，由浏览器页面通过轮询领取并在页面上下文中执行。
- 支持在页面内执行 JavaScript、获取页面内容、对 DOM/CSS 做临时修改；刷新页面后修改自然丢失。

文件：
- index.js：模块入口，定义工具组并通过 runtime.uiCommandBroker 下发指令并等待结果。
- tools.js：工具定义（OpenAI tools schema）。
