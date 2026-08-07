# scripts

## 综述
该目录存放工程相关的脚本工具，主要用于质量校验与平台打包。

## 文件列表
- check-coverage.js: 功能：测试覆盖率检查脚本。责任：解析 LCOV 报告并按阈值判断通过/失败，输出覆盖率摘要并以进程退出码反馈结果。内部结构：使用 node 运行；包含 parseArgs（解析 --threshold/--lcov-file）、parseLcov（读取并汇总 LF/LH/FNF/FNH/BRF/BRH）、calculateOverallCoverage（加权计算总体覆盖率）、generateReport（输出报告并 exit）、main（串联流程）。
- scripts.md: 功能：本目录说明文档。责任：描述本目录的综述、文件列表与子目录列表。内部结构：包含“综述 / 文件列表 / 子目录列表”。

## 子目录列表
- win: 功能：Windows 平台脚本目录。责任：提供打包脚本、安装脚本与崩溃取证脚本（WER/ProcDump/事件日志导出）。内部结构：包含 .cmd/.ps1/.iss 与目录说明文档。（详见 win/win.md）
