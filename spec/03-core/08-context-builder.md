# ContextBuilder 上下文构建器

## 1. 职责

ContextBuilder 负责构建智能体执行所需的上下文对象，包括运行时引用、工具函数集合、系统提示词组件等。

## 2. 上下文对象结构

```python
@dataclass
class AgentContext:
    # 运行时引用
    runtime: Runtime              # Runtime 实例
    org: OrgPrimitives           # 组织原语
    bus: MessageBus              # 消息总线
    workspace_manager: WorkspaceManager  # 工作区管理器
    prompts: PromptLoader        # 提示词加载器
    
    # 系统提示词组件
    system_base_prompt: str              # 基础系统提示词
    system_compose_template: str         # 提示词组合模板
    system_tool_rules: str               # 工具调用规则
    system_workspace_prompt: str         # 工作空间提示词
    
    # 工具函数集合
    tools: ToolFunctions
    
    # 当前智能体
    agent: Agent

@dataclass
class ToolFunctions:
    find_role_by_name: Callable[[str], Optional[Role]]
    create_role: Callable[..., Awaitable[Role]]
    spawn_agent: Callable[..., Awaitable[Agent]]
    send_message: Callable[..., Awaitable[str]]
    compose_prompt: Callable[[str, Dict], str]
    console_print: Callable[[str], None]
```

## 3. 工具函数注入

### 3.1 create_role

```python
async def create_role(
    name: str,
    role_prompt: str,
    org_prompt: Optional[str] = None,
    tool_groups: Optional[List[str]] = None
) -> Role:
    """
    创建新岗位
    
    自动注入 createdBy 为当前智能体 ID
    """
    return await runtime.org.create_role(
        name=name,
        role_prompt=role_prompt,
        org_prompt=org_prompt,
        tool_groups=tool_groups or [],
        created_by=agent.id
    )
```

### 3.2 spawn_agent

```python
async def spawn_agent(
    role_id: str,
    name: Optional[str] = None,
    task_brief: Optional[str] = None,
    initial_message: Optional[str] = None
) -> Agent:
    """
    创建智能体
    
    验证调用者身份，确保只能创建自己的子智能体
    """
    # 验证 role 存在
    role = runtime.org.get_role(role_id)
    if not role:
        raise ValueError(f"Role {role_id} not found")
    
    # 创建智能体
    return await runtime.spawn_agent(
        role_id=role_id,
        parent_id=agent.id,
        name=name,
        task_brief=task_brief,
        initial_message=initial_message
    )
```

### 3.3 send_message

```python
async def send_message(
    to: str,
    payload: Any,
    delay_ms: int = 0
) -> str:
    """
    发送消息
    
    验证收件人是否存在，拦截无效消息
    """
    # 验证收件人存在
    if not runtime.get_agent(to):
        raise ValueError(f"Agent {to} not found")
    
    result = await runtime.bus.send(
        to=to,
        from_=agent.id,
        payload=payload,
        delay_ms=delay_ms
    )
    return result.message_id
```

### 3.4 compose_prompt

```python
def compose_prompt(template: str, variables: Dict[str, Any]) -> str:
    """
    组合提示词
    
    使用模板引擎替换变量
    """
    return runtime.prompts.render(template, variables)
```

## 4. 构建流程

```python
class ContextBuilder:
    def __init__(
        self,
        runtime: Runtime,
        prompt_loader: PromptLoader,
        system_prompts: SystemPrompts
    ):
        self._runtime = runtime
        self._prompt_loader = prompt_loader
        self._system_prompts = system_prompts
    
    def build_context(self, agent: Agent) -> AgentContext:
        """构建智能体执行上下文"""
        
        # 构建工具函数集合
        tools = ToolFunctions(
            find_role_by_name=self._make_find_role_by_name(),
            create_role=self._make_create_role(agent),
            spawn_agent=self._make_spawn_agent(agent),
            send_message=self._make_send_message(agent),
            compose_prompt=self._make_compose_prompt(),
            console_print=self._make_console_print(agent)
        )
        
        return AgentContext(
            runtime=self._runtime,
            org=self._runtime.org,
            bus=self._runtime.bus,
            workspace_manager=self._runtime.workspace_manager,
            prompts=self._prompt_loader,
            system_base_prompt=self._system_prompts.base,
            system_compose_template=self._system_prompts.compose_template,
            system_tool_rules=self._system_prompts.tool_rules,
            system_workspace_prompt=self._system_prompts.workspace,
            tools=tools,
            agent=agent
        )
```

## 5. 使用场景

在智能体处理消息前构建上下文：

```python
# 在 TurnEngine 中
context = context_builder.build_context(agent)
await agent.on_message(context, message)
```

## 6. 安全考虑

- 工具函数自动注入当前智能体 ID，防止伪造
- 敏感操作（如删除智能体）验证调用者权限
- 所有工具函数都是只读的或受控的修改
