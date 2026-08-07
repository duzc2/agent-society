# 执行流程示例

## 1. 发送消息工具执行

```
智能体调用 send_message
  ↓
RuntimeTools.validate_permission(agent_id, "send_message")
  ↓
RuntimeTools.validate_arguments(tool_name, args)
  ↓
创建 ToolContext
  ↓
调用 handle_send_message(ctx, args)
  ↓
ctx.runtime.send_message(...)
  ↓
MessageBus.enqueue(...)
  ↓
返回成功结果
```

## 2. Python 代码执行

```
智能体调用 run_python
  ↓
验证权限和参数
  ↓
PythonExecutor.execute(code, packages, timeout)
  ↓
安全检查（扫描危险模式）
  ↓
创建子进程执行包装后的代码
  ↓
等待执行完成或超时
  ↓
收集 stdout、stderr、返回值
  ↓
终止子进程
  ↓
返回执行结果
```

## 3. JavaScript 代码执行

```
智能体调用 run_javascript
  ↓
验证权限和参数
  ↓
BrowserExecutor.execute(code, timeout, return_canvas)
  ↓
创建新的 BrowserContext
  ↓
创建新 Page
  ↓
在页面中执行代码
  ↓
如果需要，提取 Canvas 数据
  ↓
关闭 Page 和 Context
  ↓
返回执行结果
```
