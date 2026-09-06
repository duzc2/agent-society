# LLM 服务层

LLM 服务层负责与大模型的一切交互。源码目录：`src/platform/services/llm/`（该目录有 `llm.md` 自述），配套运行时部分在 `runtime/llm_client_pool.js`、`runtime/retry_coordinator.js`。

## 组件地图

```
services/llm/
├── llm_client.js             # 最小 LLM 客户端（OpenAI/Anthropic SDK 封装）
├── llm_service_registry.js   # 服务注册表：加载/校验 llmservices 配置
├── model_selector.js         # 选模器：按岗位提示词选服务
├── concurrency_controller.js # 并发控制器
├── llm_retry_service.js      # 请求级重试
├── llm_stream_service.js     # 流式处理
├── llm_truncation_service.js # 上下文/输出截断
├── llm_augment_service.js    # 请求增强
├── llm_response_service.js   # 响应归一化
├── llm_fetch_service.js      # fetch 型调用
├── llm_providers_service.js  # 多 provider 适配
├── client_exchange_state.js  # 交换状态
├── message_snip_service.js   # 消息裁剪
├── tool_result_aging_service.js # 工具结果老化
└── utils/message_adapter.js  # 消息格式适配
```

## LlmClient

`llm_client.js` 是所有调用的出口：

- **多 provider**：OpenAI 兼容（`@ai-sdk/openai` / `openai`）与 Anthropic（`@anthropic-ai/sdk`），按配置的 provider 字段选择；
- **重试**：指数退避（`_chatWithRetry`），可配置次数；
- **并发控制集成**：请求经 `ConcurrencyController.executeRequest()` 进入，超出并发上限自动排队；
- **按 agentId 中断**：`cancelRequest(agentId)` 取消该智能体在途请求（Abort 按钮、terminate 级联都用它）；
- **指标记录**：调用耗时、token 用量写入日志（`logLlmMetrics`）。

## LlmServiceRegistry

加载 `config/llmservices.local.json`（无则回退默认 `llm` 配置）：

- 校验服务条目结构（id/name/baseURL/model 必填，capabilities 格式合法）；
- 提供 `getService(id)`、按能力标签/输入输出能力筛选等服务查询；
- 单条目校验失败只拒绝该条目并记日志，不中断整体加载。

## ModelSelector（自动选模）

选模流程（`model_selector.js`）：

1. 输入：岗位提示词 + 候选服务列表（含 capabilityTags/description）；
2. 用 `config/prompts/model_selector.txt` 模板构造选择提示词，调用一次 LLM；
3. 解析返回的 `serviceId` 与理由（`_parseSelectionResult`）；
4. 校验 serviceId 存在；失败/超时回退默认服务。

触发时机：岗位首次执行、岗位的 LLM 服务未手动指定时。选模结果记录在岗位上，之后固定使用。

## ConcurrencyController

- 全局并发上限（`maxConcurrentRequests`，来自 app.json 的 `llm` 配置）；
- **同智能体互斥**：同一 agentId 的请求串行，防止上下文交错；
- 队列化管理等待请求，支持取消（活跃/排队均可）；
- 统计信息（活跃数/排队数）供诊断。

## 重试体系

| 级别 | 位置 | 策略 |
|------|------|------|
| 请求级 | `llm_retry_service.js` / LlmClient 内部 | 指数退避，网络错误/5xx/429 触发 |
| 调度级 | `runtime/retry_coordinator.js` | 全局槽位错开多智能体的重试时刻，防惊群 |

## 上下文相关服务

- **llm_truncation_service**：请求超限时截断；
- **message_snip_service**：历史消息裁剪；
- **tool_result_aging_service**：老的工具调用结果降级为摘要（配合 conversation 层的压缩）。

## 客户端池（LlmClientPoolManager）

`runtime/llm_client_pool.js` 按 serviceId 缓存 LlmClient 实例，避免重复构建 SDK 客户端。服务不存在时返回 null（这是对外部配置的容错，不属于内部组件空值兼容）。

## 服务配置字段

```json
{
  "id": "my-service",
  "name": "显示名",
  "baseURL": "https://…/v1",
  "model": "model-id",
  "apiKey": "sk-…",
  "timeout": 600000,
  "maxTokens": 8192,
  "maxConcurrentRequests": 2,
  "stream": true,
  "thinking": { "…": "推理模型 thinking 注入（OpenAI 兼容 reasoning 配置）" },
  "capabilityTags": ["coding"],
  "capabilities": { "input": ["text"], "output": ["text", "tool_calling"] },
  "description": "选模器阅读的服务描述"
}
```

## 相关文档

- 用户视角：[多模型配置](../user-guide/08-llm-services.md)
- 上下文压缩：[会话与上下文](05-conversation.md)
