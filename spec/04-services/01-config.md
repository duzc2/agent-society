# Config Service 配置服务

## 2.1 设计哲学

**为什么不耦合业务逻辑？**

配置服务的职责是"管理配置文件的读写"，而不是"理解配置的含义"。如果为每个配置项提供专用方法：
- 新增模块时需要修改配置服务
- 配置服务与业务逻辑耦合
- 无法在不同项目中复用

**通用设计的优势**
- 配置服务只关注"如何存储"
- 各模块自行定义"存储什么"
- 新增模块无需修改配置服务
- 配置服务可以独立复用

## 2.2 核心功能

**文件管理**

配置服务管理 `config/` 目录下的 JSON 文件。每个配置文件是一个独立的 JSON 对象。

配置文件命名：
- `app.json`：基础配置
- `app.local.json`：本地覆盖配置
- 其他模块配置：`{module_name}.json`

**加载机制**

配置加载时，先加载基础配置，再加载本地覆盖配置，后者覆盖前者：
```python
config = load_json("app.json")
local_config = load_json("app.local.json")
deep_merge(config, local_config)
```

**键值访问**

支持点号路径访问嵌套属性：
```python
# 访问 llm.model
value = config_service.get("app", "llm.model")

# 访问深层属性
value = config_service.get("app", "modules.browser.headless")
```

为什么用点号路径而不是多级参数？因为：
- 与 JavaScript 版本兼容
- 更简洁
- 便于存储和传递

## 2.3 操作接口

**加载配置**
```python
async def load(self, filename: str) -> Dict[str, Any]
```
从文件加载配置，应用本地覆盖，缓存到内存。

**保存配置**
```python
async def save(self, filename: str, data: Dict[str, Any]) -> None
```
保存配置到本地覆盖文件（.local.json），触发变更事件。

**获取配置值**
```python
def get(self, filename: str, key: str, default: Any = None) -> Any
```
使用点号路径获取配置值，如果键不存在返回默认值。

**设置配置值**
```python
async def set(self, filename: str, key: str, value: Any) -> None
```
使用点号路径设置配置值，保存到本地覆盖文件。

**更新配置**
```python
async def update(self, filename: str, updates: Dict[str, Any]) -> None
```
批量更新配置，只修改指定的顶层键。

**删除配置**
```python
async def delete(self, filename: str, key: str) -> None
```
删除指定键的配置。

## 2.4 变更监听

**监听机制**

模块可以监听配置变更事件：
```python
config_service.on_change("app", "llm", callback)
```

当 `app.local.json` 中的 `llm` 配置变更时，调用 callback。

**使用场景**

- LLM 配置变更时，重新初始化 LLM 客户端
- 日志级别变更时，动态调整日志输出
- 模块配置变更时，重新加载模块

**实现方式**

保存配置时，对比新旧值，触发变更回调：
```python
old_value = deep_get(old_config, key)
new_value = deep_get(new_config, key)
if old_value != new_value:
    for callback in listeners[key]:
        await callback(key, old_value, new_value)
```

## 2.5 配置分层

**三层配置体系**

1. **默认配置**：代码中定义的默认值，优先级最低
2. **基础配置**：`app.json`，随代码提交，定义通用配置
3. **本地覆盖**：`app.local.json`，不提交，用户本地自定义

**优先级**：本地覆盖 > 基础配置 > 默认值

**配置覆盖示例**

`app.json`：
```json
{
  "llm": { "model": "gpt-4o", "timeout": 60 },
  "log": { "level": "info" }
}
```

`app.local.json`：
```json
{
  "llm": { "model": "gpt-4o-mini" }
}
```

最终配置：
```json
{
  "llm": { "model": "gpt-4o-mini", "timeout": 60 },
  "log": { "level": "info" }
}
```

## 2.6 数据验证

**验证原则**

配置服务不负责验证配置值的合法性。验证是各模块的职责。

例如：
- Config Service 只管存储 `llm.api_key`
- LLM Service 在使用时验证 key 是否有效

**为什么这样做？**
- 配置服务保持通用性
- 模块最了解自己的配置要求
- 避免配置服务变得臃肿
