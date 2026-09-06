# 安装与启动

## 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10/11（推荐）、macOS、Linux |
| Node.js | >= 18（推荐 22+） |
| LLM 服务 | 任意 OpenAI API 兼容的服务（本地 LM Studio/Ollama，或云端 API） |
| 磁盘空间 | 建议 ≥ 2 GB |

> 没有 Node.js：直接下载发行包（内含运行时）；或使用源码内置的 Bun 回退。

## 安装

**方式一：发行包（免安装 Node.js）**

从 Gitee 下载 zip 或安装包，解压后运行 `start.cmd`（Windows）或 `./start.sh`（macOS/Linux）。

**方式二：源码**

```bash
git clone https://gitee.com/duzc2/agent_society.git
cd agent_society
npm install
```

## 启动

```bash
# Windows
start.cmd

# macOS / Linux
./start.sh
```

或 `npm start`。启动后自动打开浏览器（`http://localhost:3000`）。

常用启动参数（`node start.js` 时可用）：

| 参数 | 作用 |
|------|------|
| `--port 3001` | 换端口 |
| `--no-browser` | 不自动开浏览器 |
| `./数据目录` | 指定数据存放位置（默认 `./agent-society-data`） |

## 首次运行

1. 浏览器打开后弹出**设置窗口**；
2. 填写 LLM 服务地址、模型名、API Key，保存；
3. 在聊天框发一句"你好，请介绍一下你能做什么"，收到回复即安装成功。

> **没有 LLM 服务？** 最简单的本地方案：安装 [LM Studio](https://lmstudio.ai/) 或 Ollama，加载任意支持工具调用的模型，服务地址填 `http://127.0.0.1:1234/v1`（LM Studio）或 `http://127.0.0.1:11434/v1`（Ollama）。

## 常见问题

**Q：启动后浏览器没有自动打开？**
手动访问 `http://localhost:3000/web/`。

**Q：提示端口被占用？**
`start.cmd` 换用 `node start.js --port 3001` 启动；或在**设置**中修改端口。

**Q：Windows 双击 start.cmd 闪退？**
在 PowerShell 中于项目根目录执行 `.\start.cmd` 查看报错。常见原因：未执行 `npm install`。

**Q：智能体一直不回复？**
基本都是 LLM 服务未配置或不通：检查设置中的服务状态；查看 `agent-society-data/logs/` 下日志。

**Q：npm install 很慢或失败？**
切换 npm 镜像：`npm config set registry https://registry.npmmirror.com` 后重试。

**Q：如何升级？**
源码方式：拉取最新代码 → `npm install` → 重启。发行包方式：下载新包替换（数据目录 `agent-society-data/` 不要覆盖）。

## 下一步

- [快速上手](03-quick-start.md) — 提交第一个需求
- [配置详解](07-configuration.md) — 深入了解配置
