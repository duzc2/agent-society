# Agent Society

> 自组织多智能体协作框架

[English](./README.md) | 中文

Agent Society 是一个基于大语言模型的智能体协作系统。智能体可以自主建立组织、分配任务、协作完成复杂目标。

---

![Agent Society UI](docs/images/首页.png)

## 核心特性

- **自组织** - 智能体自主创建岗位、分配任务、建立协作关系，无需预置组织结构
- **多模型支持** - 同时连接多个 LLM 服务，根据任务智能选择最合适的模型
- **异步协作** - 智能体通过消息通信，支持并行处理与复杂协作模式
- **Web 界面** - 内置仿微信风格的可视化界面，实时查看对话和组织结构
- **模块化扩展** - 动态加载外部模块，扩展工具能力和 Web 组件

---

## 多层记忆

Agent Society 为智能体设计了多层记忆机制：

- **提示词自修改** - 智能体可以把重要内容注入自己的提示词（systemPromptAppendix）
- **向量记忆** - 长期零碎记忆先由小模型提取摘要，再存入向量数据库
- **事件与技能记忆** - 重要事件摘要和技能由大模型摘要，存入层级管理的文件夹
- **团队共识** - 跨智能体的共识写成文档，放在工作区
- **岗位提示词** - 岗位工作内容放在岗位提示词里，同岗位智能体共享
- **工作日志** - 智能体可以在工作区里写工作日志
- **报告传递** - 消息量大时在工作区写报告，只传文件名
- **技能** - 智能体可以自己创建技能
- **组织提示词** - 整个组织的提示词定义组织存在的意义和工作目标

这是七层记忆、基于异步消息和文档、技能固化的协作模式。

Agent Society 还允许智能体修改软件本身：直接把一项能力变成代码，注入到软件里。智能体有能力修改软件的界面、创造新的功能。智能体可以自我进化，软件也可以根据用户的需要自我进化。

![Agent Society 输入需求](docs/images/输入需求.png)
![Agent Society work](docs/images/work.png)

### 记事本操作

[![记事本操作](docs/video/记事本操作.jpg "点击观看")](docs/video/记事本操作.mp4)

### 软件研发团队

[![软件团队](docs/video/软件团队.jpg "点击观看")](docs/video/软件团队.mp4)

### 浏览器开发者工具调用

[![获取网页控制台](docs/video/获取网页控制台.jpg "点击观看")](docs/video/获取网页控制台.mp4)

### 视频生成和剪辑

[![视频生成和剪辑](docs/video/视频生成和剪辑2.jpg "点击观看")](docs/video/视频生成和剪辑.mp4)

### 即时生成UI

[![打地鼠](docs/video/打地鼠.jpg "点击观看")](docs/video/打地鼠.mp4)

### 天气挂件即时生成

![天气挂件需求](docs/images/天气挂件需求.png)
![天气挂件需求](docs/images/天气挂件效果.png)

### 组织架构

![组织架构](docs/images/组织架构.png)

---

### 更多样例

![Agent Society 查天气](docs/images/查天气.png)

![Agent Society 推荐旅游路线](docs/images/推荐旅游路线.png)

![Agent Society 推荐旅游路线报告HTML内容](docs/images/推荐旅游路线报告HTML内容.png)

## 快速开始

### 环境要求

- Node.js >= 18（推荐）。支持 [Bun](https://bun.sh/) 作为备选运行时，缺少 Node.js 时启动脚本会提示安装
- 兼容 OpenAI API 的 LLM 服务
- （可选）嵌入模型。仓库不包含 `models/qwen3-embedding.gguf`，需自行提供该文件，或将 `config/app.json` 的 `embedding` 段改为远程 `provider`

### 安装

从任一托管平台克隆：

```bash
# GitHub
git clone https://github.com/duzc2/agent-society.git agent_society

# 或 Gitee
git clone https://gitee.com/duzc2/agent_society.git agent_society

cd agent_society
npm install
```

### 启动

```bash
npm start
```

启动后会自动打开浏览器访问 Web 界面（`http://localhost:3000`）。

---

## 使用方式

启动系统后，在浏览器里与智能体对话：

1. 向 Root 智能体提出需求
2. 观察智能体自主拆解任务、创建子智能体
3. 实时查看智能体之间的协作过程
4. 随时介入对话，与智能体互动

### 正确的使用姿势

系统完全模拟人类管理企业的方法。使用时把自己当成管理者：考虑如何建立自己的组织——设哪些岗位、招什么人、怎么分工。

- **确定岗位**：每个智能体必须在岗位上。为每一种工作创造一个岗位，岗位可以增加、减少，职责可以修改。
- **长期工作**：软件里没有新建会话的能力，也不为每个任务另起一批智能体。长期使用同一个岗位上的智能体，它会积累记忆、沉淀技能，越用越熟练。
- **Root 只建组织**：根智能体不做任何工作，只负责建立组织。真正干活的是岗位上的智能体。
- **组织即公司**：每个组织都可以作为一家独立的公司来管理，组织之间也可以有合作。
- **层层建团队**：每个智能体都可以建立下级岗位，并在岗位上创建智能体。
- **招聘零成本**：智能体是虚拟员工，招聘和解聘的成本接近 0——大胆按业务调整编制。

---

## 系统工作方式

```
用户
 │
 ▼
Root 智能体 —— 分析需求，拆解任务
 │
 ├──────┬──────┐
 ▼      ▼      ▼
智能体A  智能体B  智能体C
 │        │
 ▼        ▼
智能体D  智能体E
```

1. **用户**向 Root 智能体提出需求
2. **Root**分析需求，决定是否需要创建子智能体
3. **子智能体**独立执行任务，必要时继续创建下级智能体
4. **结果汇总**后返回给用户

每个智能体只掌握完成任务所需的最小上下文，复杂任务通过工作区和消息传递协作完成。

---

## 配置

第一次登录网页后会弹出设置界面。如需手动配置，编辑配置文件后重启服务器加载。

1. 复制配置文件模板：

```bash
cp config/app.json config/app.local.json
cp config/llmservices_template.json config/llmservices.local.json
```

2. 编辑 `config/llmservices.local.json`，配置 LLM 服务：

```json
{
  "services": [
    {
      "id": "local",
      "name": "本地模型",
      "baseURL": "http://127.0.0.1:1234/v1",
      "model": "your-model-name",
      "apiKey": "NOT_NEEDED",
      "capabilityTags": ["text", "tool_calling"]
    }
  ]
}
```

---

### 配置多模型服务

为不同岗位配置不同的 LLM 服务：

```json
{
  "services": [
    {
      "id": "gpt4",
      "name": "GPT-4",
      "baseURL": "https://api.openai.com/v1",
      "model": "gpt-4",
      "apiKey": "sk-...",
      "capabilityTags": ["reasoning", "coding"]
    },
    {
      "id": "local",
      "name": "本地模型",
      "baseURL": "http://localhost:1234/v1",
      "model": "qwen2.5-7b",
      "apiKey": "any",
      "capabilityTags": ["chat", "fast"]
    }
  ]
}
```

系统根据岗位提示词自动选择最合适的模型，也可以手动指定。

---

### 扩展模块

通过模块扩展系统能力：

- **chrome** - 控制 Chrome 浏览器，实现网页自动化
- **ssh** - SSH 远程连接，操作远程服务器

编辑 `config/modules.enabled.json`：

```json
{
  "enableAll": false,
  "enabled": ["chrome", "ssh"]
}
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [用户手册（中文）](./docs/zh/user-guide/index.md) | 安装、使用、配置、进阶 |
| [开发者文档（中文）](./docs/zh/developer-guide/index.md) | 架构、服务层、扩展开发 |
| [User Guide (English)](./docs/en/user-guide/index.md) | Installation, usage, configuration |
| [Developer Guide (English)](./docs/en/developer-guide/index.md) | Architecture, services, extensions |

---

## 开源协议

本项目采用 [Apache License 2.0](./LICENSE) 开源协议。

```
Copyright 2025 Agent Society Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

<p align="center">
  <a href="https://github.com/duzc2/agent-society">GitHub</a> •
  <a href="https://gitee.com/duzc2/agent_society">Gitee</a> •
  <a href="./docs/zh/user-guide/index.md">文档</a> •
  <a href="./LICENSE">许可证</a>
</p>
