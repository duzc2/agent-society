# agents

## 综述
该目录是本项目的根目录，包含服务端与 Web UI 的实现、配置、模块扩展、示例程序、测试与文档。

目录下的主要可执行入口包括：
- start.js / start.cmd / start.sh / start_monitor.cmd：启动脚本入口。

源代码的主要位置包括：
- src/：Node.js 源码。
- web/：随 HTTP 服务提供的 Web UI 静态资源。
- modules/：可插拔模块。

## 文件列表
- .gitignore: 功能：Git 忽略规则。责任：定义版本控制中需要忽略的文件与目录。内部结构：按路径/通配模式配置忽略规则。
- AGENTS.md: 功能：项目说明。责任：描述项目背景、启动方式与工程约束。内部结构：按“项目 / 启动项目 / 环境 / 注释 / 约束 / 流程 / 测试 / 代码”等章节组织。
- CHANGELOG_SYSTEM_PROMPT.md: 功能：系统提示词变更记录。责任：记录与系统提示词相关的变更内容。内部结构：按时间或版本顺序记录条目。
- FEATURE_SUMMARY.md: 功能：功能摘要。责任：汇总项目提供的能力点。内部结构：按功能模块分段描述。
- LICENSE: 功能：许可证文件。责任：声明项目的授权条款。内部结构：标准许可证文本。
- README.md: 功能：项目对外说明。责任：提供简介、特性、快速开始、项目结构等信息。内部结构：按章节组织，并包含示例代码与命令。
- bun.lock: 功能：Bun 依赖锁文件。责任：锁定依赖版本以保证可复现安装。内部结构：Bun 生成的锁定数据。
- package-lock.json: 功能：npm 依赖锁文件。责任：锁定依赖版本以保证可复现安装。内部结构：npm 生成的锁定数据。
- package.json: 功能：Node.js 包配置。责任：声明包信息、脚本与依赖。内部结构：包含 scripts、dependencies、devDependencies 等字段。
- start.cmd: 功能：Windows 启动脚本。责任：在 Windows 环境启动服务。内部结构：命令行脚本。
- start_monitor.cmd: 功能：Windows 监控启动脚本。责任：联动 WER、ProcDump 与事件日志导出，并阻塞调用 start.cmd。内部结构：命令行脚本。
- start.js: 功能：启动入口。责任：解析参数、加载配置并启动运行时与 HTTP 服务。内部结构：按启动流程组织的顶层脚本。
- start.sh: 功能：Unix 启动脚本。责任：在类 Unix 环境启动服务。内部结构：Shell 脚本。
- test-baseline-output.txt: 功能：测试基线输出。责任：记录对比用的基线结果文本。内部结构：按测试输出内容顺序存储。
- test-results.txt: 功能：测试运行结果记录。责任：保存一次或多次测试执行的输出内容。内部结构：按测试输出内容顺序存储。

## 子目录列表
- .github: 功能：CI 配置目录。责任：存放工作流与相关说明文件。内部结构：包含 workflows/ 等子目录。
- .kiro: 功能：规格与任务管理目录。责任：存放需求/设计/任务拆分文档。内部结构：以 specs/ 为主。
- .vscode: 功能：编辑器配置目录。责任：存放 VS Code 的工程级配置。内部结构：包含 settings.json。
- config: 功能：配置与提示词模板。责任：存放应用配置、日志配置与提示词模板文件。内部结构：包含 prompts/ 与若干 .json/.md 文件。（详见 config/config.md）
- demo: 功能：示例程序。责任：提供可直接运行的演示脚本与说明。内部结构：包含多个 demo*.js 与示例说明文档。
- docs: 功能：项目文档。责任：提供架构、配置、API、工具等说明。内部结构：包含若干 .md 文档与 images/。
- modules: 功能：可插拔模块目录。责任：提供扩展工具、Web 组件与相关路由的模块实现。内部结构：按模块名称分子目录，并包含 modules.md。（详见 modules/modules.md）
- requirements: 功能：需求文档目录。责任：存放产品需求与相关文本。内部结构：以 .txt 为主。
- scripts: 功能：工程脚本目录。责任：提供打包、覆盖率检查等工具脚本。内部结构：包含 win/ 与若干 .js 脚本。（详见 scripts/scripts.md）
- src: 功能：源码目录。责任：存放 Node.js 运行时与平台实现代码。内部结构：按 agents/、platform/ 划分。（详见 src/src.md）
- test: 功能：测试目录。责任：存放单元/集成/端到端测试与基线数据。内部结构：按模块划分子目录，并包含测试说明文档。
- web: 功能：Web UI 静态资源目录。责任：提供对话查看与管理界面的前端资源。内部结构：包含 index.html、css/、js/。（详见 web/web.md）
