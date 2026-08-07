# skills

该目录存放技能运行时相关测试。

- `skills_runtime_service.test.js`：验证技能提示词会优先引导智能体加载技能细节，并避免重复加载已读技能文件。
- `skills_runtime_resolver.test.js`：验证系统启动运行时解析、脚本命令解析、技能安装命令解析。
- `skills_script_runner.test.js`：验证技能脚本执行器如何组合命令参数与错误信息。
- `modelscope_provider.test.js`：验证 ModelScope 技能安装流程会复用解析出的 JavaScript 运行时入口。
