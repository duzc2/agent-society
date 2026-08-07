# 性能考虑

## 1. 并发控制

### 1.1 消息处理并发

- 使用 Semaphore 限制并发数
- 默认 50 并发，可通过配置调整
- 超过限制的请求排队等待

```python
self._semaphore = asyncio.Semaphore(max_concurrency)
```

### 1.2 LLM 调用并发

- 使用单独的 Semaphore
- 默认 2 并发，防止 API 限流
- 超出限制时等待许可

```python
self._llm_semaphore = asyncio.Semaphore(max_llm_concurrency)
```

## 2. 内存管理

### 2.1 消息队列

- 只保留在内存中的消息
- 已处理的消息可以清理（可选）

### 2.2 智能体缓存

- 活跃智能体保留对话缓存
- 长时间未访问的智能体释放缓存

```python
async def cleanup_inactive_agents(self, max_idle_seconds: int = 3600):
    """清理长时间未访问的智能体缓存"""
    now = datetime.now()
    for agent_id, last_access in list(self._last_access_times.items()):
        if (now - last_access).seconds > max_idle_seconds:
            if agent_id not in self._active_processing_agents:
                await self._unload_agent_cache(agent_id)
```

## 3. I/O 优化

### 3.1 异步文件操作

- 使用 aiofiles 进行文件读写
- 避免阻塞事件循环

```python
async with aiofiles.open(file_path, 'w') as f:
    await f.write(data)
```

### 3.2 批量操作

- 状态更新批量保存
- 消息持久化使用追加模式

```python
# 追加模式写入，避免重写整个文件
async with aiofiles.open(queue_file, 'a') as f:
    await f.write(json.dumps(message) + '\n')
```

## 4. 调度优化

### 4.1 轮询间隔

- 使用事件通知 + 退避轮询
- 有新消息时立即唤醒
- 无消息时指数退避等待

```python
async def _wait_for_work(self):
    """等待新工作，使用事件通知"""
    try:
        await asyncio.wait_for(
            self._new_message_event.wait(),
            timeout=self._poll_interval
        )
        self._new_message_event.clear()
    except asyncio.TimeoutError:
        pass
```

### 4.2 智能体优先级

- 支持消息优先级
- 紧急消息优先处理

## 5. LLM 优化

### 5.1 连接池

- 重用 HTTP 连接
- 减少连接建立开销

```python
# 使用 aiohttp 的 ClientSession 连接池
self._session = aiohttp.ClientSession()
```

### 5.2 请求合并

- 批量处理相似请求
- 共享上下文缓存

### 5.3 响应缓存

- 缓存频繁查询的响应
- 设置合理的过期时间

```python
@lru_cache(maxsize=100)
def get_cached_response(prompt_hash: str) -> Optional[str]:
    return cache.get(prompt_hash)
```

## 6. 监控指标

### 6.1 关键指标

- 消息处理延迟
- LLM 调用延迟和成功率
- 队列长度
- 并发数
- 内存使用量

### 6.2 指标收集

```python
class MetricsCollector:
    def record_message_latency(self, latency_ms: float): ...
    def record_llm_latency(self, latency_ms: float): ...
    def record_llm_error(self, error_type: str): ...
    def set_queue_length(self, agent_id: str, length: int): ...
```
