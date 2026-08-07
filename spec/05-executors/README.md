# Agent Society 执行器模块设计

## 概述

执行器模块负责执行智能体调用的各种工具，是系统与外部世界交互的接口。执行器的设计原则是：安全、隔离、可控。

### 执行器类型

系统包含三类执行器：
- **Tool Executor**：工具调用执行器，执行系统工具
- **Python Executor**：Python 代码执行器，在沙箱中运行 Python 代码
- **Browser Executor**：浏览器执行器，在 Headless Chrome 中运行 JavaScript

### 设计原则

**安全隔离**
- 代码执行在隔离环境中进行
- 限制资源访问（文件、网络、系统）
- 限制执行时间和内存

**错误处理**
- 执行错误不传播到系统
- 提供友好的错误信息
- 完整记录执行日志

**资源控制**
- 超时控制
- 内存限制
- 输出大小限制

---

## 目录导航

| 文档 | 内容 |
|-----|------|
| [01-tool-executor.md](./01-tool-executor.md) | Tool Executor 工具执行器 |
| [02-python-executor.md](./02-python-executor.md) | Python Executor 沙箱执行器 |
| [03-browser-executor.md](./03-browser-executor.md) | Browser Executor 浏览器执行器 |
| [04-message-validator.md](./04-message-validator.md) | Message Validator 消息验证器 |
| [05-memory-monitor.md](./05-memory-monitor.md) | Memory Monitor 内存监控器 |
| [06-execution-flow.md](./06-execution-flow.md) | 执行流程示例 |

---

## 执行器管理

### 生命周期

**初始化**
- Tool Executor：系统启动时初始化
- Python Executor：按需创建子进程
- Browser Executor：系统启动时创建浏览器实例

**关闭**
- Tool Executor：无需特殊处理
- Python Executor：确保子进程已终止
- Browser Executor：关闭浏览器实例

### 资源管理

**并发控制**
- Python Executor：通过 semaphore 限制并发子进程数
- Browser Executor：通过 semaphore 限制并发页面数

**超时控制**
- 所有执行器都有超时机制
- 超时后强制终止执行

**内存管理**
- Python Executor：子进程资源由操作系统回收
- Browser Executor：定期关闭空闲上下文

### 错误监控

**日志记录**
- 记录所有工具调用
- 记录执行时间和资源使用
- 记录错误信息

**指标收集**
- 执行成功率
- 平均执行时间
- 资源使用峰值

---

## 工具注册流程

### 内置工具注册

系统启动时，RuntimeTools 注册内置工具：

```python
# 组织管理工具
self.register_tool("create_role", handle_create_role, group="org_management")
self.register_tool("spawn_agent_with_task", handle_spawn, group="org_management")
...

# 工作空间工具
self.register_tool("replace_file", handle_write_file, group="workspace")
...

# 代码执行工具
self.register_tool("run_python", handle_run_python, group="execution")
self.register_tool("run_javascript", handle_run_javascript, group="execution")
```

### 模块工具注册

模块加载时，通过 Runtime 注册工具：

```python
def init(runtime):
    runtime.register_tool(
        name="module_specific_tool",
        description="...",
        parameters={...},
        handler=handler_function,
        group="module_group"
    )
```

### 工具发现

智能体获取可用工具时：

1. 获取智能体的岗位配置
2. 获取岗位的工具组列表
3. 收集这些工具组中的所有工具
4. 转换为 OpenAI function calling 格式
5. 返回给智能体
