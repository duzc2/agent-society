# Agent Society

> Self-organizing multi-agent collaboration framework

English | [中文](./README.zh.md)

Agent Society is an LLM-based agent collaboration system. Agents autonomously build organizations, assign tasks, and collaborate to complete complex goals.

---

![Agent Society UI](docs/images/首页.png)

## Key Features

- **Self-organizing** - Agents autonomously create roles, assign tasks, and establish collaboration relationships, with no preset org structure
- **Multi-model support** - Connect to multiple LLM services simultaneously; the system selects the best model per task
- **Async collaboration** - Agents communicate via messages, supporting parallel processing and complex collaboration patterns
- **Web interface** - Built-in WeChat-style visual interface; view conversations and org structure in real time
- **Modular extension** - Dynamically load external modules to extend tools and web components

---

## Layered Memory

Agent Society gives agents multiple memory layers:

- **Prompt self-modification** - Agents inject important content into their own prompts (systemPromptAppendix)
- **Vector memory** - Long-term fragmentary memories are summarized by a small model, then stored in a vector database
- **Event & skill memory** - Significant event summaries and skills are summarized by a large model, stored in hierarchically managed folders
- **Team consensus** - Cross-agent consensus is written as documents in the workspace
- **Role prompts** - Role-level work content lives in the role prompt, shared by all agents of that role
- **Work logs** - Agents can write work logs in the workspace
- **Report passing** - For large message payloads, agents write reports to the workspace and pass only filenames
- **Skills** - Agents can create their own skills
- **Org prompt** - A prompt for the whole organization, defining why it exists and what it aims to achieve

This is a collaboration model built on layered memory, async messaging, documents, and skill solidification.

Agent Society also lets agents modify the software itself: they can turn a capability directly into code and inject it into the software. Agents can modify the software's interface and create new features. Agents can evolve themselves, and the software evolves with user needs.

![Agent Society 输入需求](docs/images/输入需求.png)
![Agent Society work](docs/images/work.png)

### Notepad Operations

[![记事本操作](docs/video/记事本操作.jpg "Watch")](docs/video/记事本操作.mp4)

### Software Development Team

[![软件团队](docs/video/软件团队.jpg "Watch")](docs/video/软件团队.mp4)

### Browser DevTools Invocation

[![获取网页控制台](docs/video/获取网页控制台.jpg "Watch")](docs/video/获取网页控制台.mp4)

### Video Generation and Editing

[![视频生成和剪辑](docs/video/视频生成和剪辑2.jpg "Watch")](docs/video/视频生成和剪辑.mp4)

### Instant UI Generation

[![打地鼠](docs/video/打地鼠.jpg "Watch")](docs/video/打地鼠.mp4)

### Instant Weather Widget

![天气挂件需求](docs/images/天气挂件需求.png)
![天气挂件需求](docs/images/天气挂件效果.png)

### Organization Structure

![组织架构](docs/images/组织架构.png)

---

### More Examples

![Agent Society 查天气](docs/images/查天气.png)

![Agent Society 推荐旅游路线](docs/images/推荐旅游路线.png)

![Agent Society 推荐旅游路线报告HTML内容](docs/images/推荐旅游路线报告HTML内容.png)

## Quick Start

### Requirements

- Node.js >= 18 (recommended). [Bun](https://bun.sh/) is supported as a fallback runtime; the start scripts offer to install it when Node.js is unavailable
- An OpenAI-API-compatible LLM service
- (Optional) An embedding model. The repository does not ship `models/qwen3-embedding.gguf`; supply the file yourself, or point the `embedding` section in `config/app.json` at a remote `provider`

### Installation

Clone from either host:

```bash
# GitHub
git clone https://github.com/duzc2/agent-society.git agent_society

# or Gitee
git clone https://gitee.com/duzc2/agent_society.git agent_society

cd agent_society
npm install
```

### Launch

```bash
npm start
```

A browser opens the web interface at `http://localhost:3000`.

---

## Usage

After launch, talk to the agents in the browser:

1. State a requirement to the Root agent
2. Watch agents decompose the task and create sub-agents
3. Observe agent-to-agent collaboration in real time
4. Jump into the conversation at any time

### The intended way to use it

The system mirrors how humans run an organization. Think of yourself as the manager: consider how to build your organization — which roles to create, whom to staff, how to divide the work.

- **Defined roles**: every agent must hold a position. Create one role for each kind of work; roles can be added, removed, and their duties edited.
- **Long-term agents**: there is no "new session" capability, and no fresh batch of agents per task. Use the agents on a role long term — they accumulate memory and solidify skills, performing better the longer they serve.
- **Root only builds organizations**: the Root agent does no work at all — it only builds the organization. The real work is done by the agents on their roles.
- **Organization as company**: each organization can be managed as an independent company, and organizations can cooperate.
- **Teams at every level**: every agent can create sub-roles and staff agents on them.
- **Near-zero hiring cost**: agents are virtual employees — recruiting and firing costs nearly nothing, so adjust staffing boldly with the business.

---

## How It Works

```
User
 │
 ▼
Root agent —— analyzes the requirement, decomposes tasks
 │
 ├──────┬──────┐
 ▼      ▼      ▼
Agent A  Agent B  Agent C
 │        │
 ▼        ▼
Agent D  Agent E
```

1. The **user** states a requirement to the Root agent
2. **Root** analyzes it and decides whether sub-agents are needed
3. **Sub-agents** execute independently, creating lower-level agents when necessary
4. **Results** are aggregated and returned to the user

Each agent holds only the minimal context needed for its task; complex tasks are completed through workspace documents and messages.

---

## Configuration

A setup dialog appears on first login. To configure manually, edit config files and restart the server.

1. Copy the config templates:

```bash
cp config/app.json config/app.local.json
cp config/llmservices_template.json config/llmservices.local.json
```

2. Edit `config/llmservices.local.json` to configure LLM services:

```json
{
  "services": [
    {
      "id": "local",
      "name": "Local model",
      "baseURL": "http://127.0.0.1:1234/v1",
      "model": "your-model-name",
      "apiKey": "NOT_NEEDED",
      "capabilityTags": ["text", "tool_calling"]
    }
  ]
}
```

---

### Multi-Model Configuration

Assign different LLM services to different roles:

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
      "name": "Local model",
      "baseURL": "http://localhost:1234/v1",
      "model": "qwen2.5-7b",
      "apiKey": "any",
      "capabilityTags": ["chat", "fast"]
    }
  ]
}
```

The system selects the best model per role prompt automatically; manual pinning is also supported.

---

### Extension Modules

Extend the system through modules:

- **chrome** - Control Chrome for web automation
- **ssh** - SSH remote connections to operate remote servers

Edit `config/modules.enabled.json`:

```json
{
  "enableAll": false,
  "enabled": ["chrome", "ssh"]
}
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [User Guide (English)](./docs/en/user-guide/index.md) | Installation, usage, configuration |
| [Developer Guide (English)](./docs/en/developer-guide/index.md) | Architecture, services, extensions |
| [用户手册（中文）](./docs/zh/user-guide/index.md) | 安装、使用、配置、进阶 |
| [开发者文档（中文）](./docs/zh/developer-guide/index.md) | 架构、服务层、扩展开发 |

---

## License

This project is licensed under the [Apache License 2.0](./LICENSE).

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
  <a href="./docs/en/user-guide/index.md">Docs</a> •
  <a href="./LICENSE">License</a>
</p>
