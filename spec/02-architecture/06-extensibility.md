# 扩展性设计

## 模块系统

**为什么需要模块系统？**
核心系统提供基础能力，但特定功能（如 SSH 连接、特定网站自动化）应由模块提供。模块可以独立开发和发布。

**模块加载机制**
- 模块是 Python 包，放在 modules/ 目录
- 系统启动时扫描并加载启用的模块
- 模块通过钩子函数注册工具和事件监听

**模块接口**
- `init(runtime)`：模块初始化时调用
- `cleanup(runtime)`：模块卸载时调用
- 通过 runtime 提供的 API 注册工具和监听事件

## 工具组管理器

**职责**
Tool Group Manager 负责管理所有工具组：
- 注册内置工具组（org_management、workspace、command、network 等）
- 注册模块工具组
- 根据智能体岗位获取可用工具
- 工具权限控制

**内置工具组**
| 工具组 | 说明 | 包含工具 |
|-------|------|---------|
| `org_management` | 组织管理 | create_role, spawn_agent_with_task, delete_agent 等 |
| `workspace` | 工作空间 | read_file, replace_file, list_files 等 |
| `command` | 代码执行 | run_javascript |
| `network` | HTTP 请求 | http_request |
| `localllm` | 本地 LLM | localllm_chat |

**工具权限规则**
- Root 智能体：只能使用 `org_management` 工具组
- 普通智能体：根据 `role.toolGroups` 配置
- 模块工具：对所有非 Root 智能体可用

## 工具扩展

**工具注册**
模块可以注册新工具：
1. 定义工具函数
2. 提供工具描述和参数定义
3. 调用 `runtime.register_tool()` 注册
4. 指定工具所属工具组

**工具发现**
智能体获取可用工具时，系统自动收集：
- 内置工具
- 模块注册的工具
- 根据智能体岗位过滤

## 配置扩展

**为什么配置服务不感知配置项？**
如果配置服务需要知道所有可能的配置项，就无法支持模块添加新配置。

**配置扩展方式**
模块自行管理配置：
1. 在 config/ 目录下添加配置文件（可选）
2. 通过 `config.load("module_name")` 加载
3. 自行验证配置有效性
4. 监听配置变更事件
