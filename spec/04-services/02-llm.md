# LLM Service 大语言模型服务

## 3.1 职责

LLM Service 负责：
- 管理 LLM 服务配置
- 创建和管理 LLM 客户端
- 提供统一的调用接口
- 处理 API 错误和重试
- 跟踪 token 使用

## 3.2 服务配置

**服务定义**

系统中可以配置多个 LLM 服务，每个服务包含：
- `id`：服务标识
- `name`：显示名称
- `base_url`：API 地址
- `api_key`：API 密钥
- `model`：模型名称
- `timeout`：超时时间（秒）
- `max_retries`：最大重试次数

**默认服务**

必须有一个默认服务，当智能体没有指定服务时使用。

## 3.3 客户端管理

**客户端创建**

根据配置创建 OpenAI/Anthropic 客户端：
```python
client = AsyncOpenAI(
    base_url=service.base_url,
    api_key=service.api_key,
    timeout=service.timeout
)
```

**客户端缓存**

按服务 ID 缓存客户端，避免重复创建。

## 3.4 调用接口

**基本调用**
```python
async def chat(
    self,
    service_id: str,
    messages: List[Dict[str, str]],
    stream: bool = False,
    **kwargs
) -> Union[ChatCompletion, AsyncIterator[ChatCompletionChunk]]
```

**流式响应**

返回异步迭代器，调用方逐块接收响应：
```python
async for chunk in llm_service.chat(service_id, messages, stream=True):
    content = chunk.choices[0].delta.content
    # 处理内容块
```

**使用跟踪**

每次调用记录 token 使用：
- prompt_tokens
- completion_tokens
- total_tokens

用于成本分析和限额控制。

## 3.5 错误处理

**错误分类**

- **网络错误**：连接失败、超时等，可重试
- **API 错误**：限流、无效 key 等，根据错误码决定是否重试
- **内容错误**：内容过滤、过长等，不可重试

**重试策略**

使用指数退避：
- 第 1 次重试：等待 1 秒
- 第 2 次重试：等待 2 秒
- 第 3 次重试：等待 4 秒

最大重试次数可配置（默认 3 次）。

## 3.6 工具调用支持

**函数调用格式**

将内部工具定义转换为 OpenAI function calling 格式：
```json
{
  "type": "function",
  "function": {
    "name": "send_message",
    "description": "发送消息给其他智能体",
    "parameters": { ... }
  }
}
```

**响应解析**

解析 LLM 响应中的 tool_calls：
```python
if response.choices[0].message.tool_calls:
    for tool_call in response.choices[0].message.tool_calls:
        tool_name = tool_call.function.name
        args = json.loads(tool_call.function.arguments)
        # 调用工具
```
