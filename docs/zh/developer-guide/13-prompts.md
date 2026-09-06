# 提示词工程

智能体的行为由提示词驱动。系统提示词模板在 `config/prompts/`，组装逻辑在 `src/platform/prompt_loader.js`，组织模板在 `org/`。

## 模板清单

| 文件 | 用途 |
|------|------|
| `base.txt` | 所有智能体的基础预置提示词 |
| `compose.txt` | **组装模板**：定义最终 system prompt 的骨架与占位符 |
| `root.txt` | Root 智能体专属提示词（含"单需求单子智能体"硬约束与四步流程） |
| `workspace.txt` | 工作区使用指南（file_* 工具用法、路径规则） |
| `tool_rules.txt` | 工具使用规则 |
| `model_selector.txt` | 自动选模的决策提示词 |
| `context_status.txt` / `context_warning.txt` / `context_critical.txt` / `context_exceeded.txt` | 上下文各级状态提示（normal/warning/critical/exceeded） |
| `knowledge_tree.txt` / `knowledge_tree_maintenance.txt` / `knowledge_tree_retrieval.txt` | 知识树的抽取/维护/检索（位于 `services/knowledge_tree/prompts/`） |

## 组装结构

`compose.txt` 定义骨架：

```
【系统预置提示词】
{{BASE}}

【工作空间使用指南】
{{WORKSPACE}}

【岗位提示词（运行时）】
{{ROLE}}

【任务与上下文（运行时）】
{{TASK}}
```

`PromptLoader.compose(parts)` 按占位符装配，最终 system prompt 的构成（按运行时注入顺序）：

1. compose 模板渲染结果（BASE + WORKSPACE + ROLE + TASK）；
2. 动态提供者追加（SystemPromptManager 注册的各提供者）：技能总览、知识树召回、向量记忆召回、待办事项、上下文状态提示等；
3. `agent.systemPromptAppendix` 条目（智能体自己写的内容，排在最后）。

## Root 约束

`root.txt` 是理解组织生成行为的必读文件，要点：

- **单需求单子智能体（硬约束）**：每个需求只创建 1 个直属子智能体，已创建必须复用；
- Root 不处理需求本身，只创建岗位与智能体；
- 四步固定流程：查模板 → 创建岗位（完整参数）→ 创建智能体（完整 TaskBrief）→ 发送澄清后的任务说明；
- 有可用组织模板时优先按模板设计岗位，否则自行撰写 rolePrompt；
- 用户没提编程时，默认按"执行行为、达成目的"理解，不默认写代码。

## 组织模板

`org/<模板名>/` 每个模板两个文件：

| 文件 | 用途 |
|------|------|
| `info.md` | 模板简介（`list_org_template_infos` 只读这个） |
| `org.md` | 组织架构设计全文（`get_org_template_org` 读取，作为 orgPrompt 注入） |

内置模板：`software_develop`、`content-operation`、`information_collector`、`entrepreneur-team`、`courseware`、`editorial-board`、`web-app-learn`、`virtual-world`、`Chinese_chess`。

模板经 `services/org_templates/org_template_repository.js` 存取，HTTP 端点 `/api/org-templates/*` 提供管理界面。

## 注意事项

1. **模板是行为契约**：改 root.txt 的约束会改变全系统的组织生成方式，改前先跑 `test/platform/core/runtime.test.js` 与 e2e；
2. **占位符必须保留**：compose.txt 的 `{{BASE}}` 等占位符删掉会导致对应内容丢失；
3. **面向 LLM 写**：description/规则是给模型读的操作说明——具体、无歧义、给正反例，不写给人看的客套话；
4. **长度敏感**：BASE/WORKSPACE 级别的内容随每个智能体每个请求发送，精炼比详尽重要；
5. 提示词相关改动在根目录 `CHANGELOG_SYSTEM_PROMPT.md`（如存在）记录变更。

## 记忆与提示词

七层记忆中有三层直接作用于 system prompt（见 [核心概念](02-concepts.md)）：

- orgPrompt（第 7 层）→ ROLE 段的组织部分；
- 岗位 rolePrompt（第 5 层）→ ROLE 段；
- systemPromptAppendix（第 1 层）→ 末尾追加。

理解这条链路才能判断"智能体为什么这么想"：按顺序读它的 ROLE、动态注入、附录即可还原其完整视角。
