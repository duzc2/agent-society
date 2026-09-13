# Installation & Launch

## Requirements

| Item | Requirement |
|------|-------------|
| OS | Windows 10/11 (recommended), macOS, Linux |
| Node.js | >= 18 (22+ recommended) |
| LLM service | Any OpenAI-API-compatible service (local LM Studio/Ollama, or cloud API) |
| Disk | ≥ 2 GB suggested |

> No Node.js? Download a release package (runtime included); or run from source and let the start scripts install Bun as a fallback.

## Installation

**Option 1: release package (no Node.js needed)**

Download the zip or installer from Gitee, extract, and run `start.cmd` (Windows) or `./start.sh` (macOS/Linux).

**Option 2: from source**

Clone from either host:

```bash
# GitHub
git clone https://github.com/duzc2/agent-society.git agent_society

# or Gitee
git clone https://gitee.com/duzc2/agent_society.git agent_society

cd agent_society
npm install
```

## Launch

```bash
# Windows
start.cmd

# macOS / Linux
./start.sh
```

Or `npm start`. A browser opens at `http://localhost:3000` automatically.

Launch parameters (with `node start.js`):

| Parameter | Effect |
|-----------|--------|
| `--port 3001` | Change the port |
| `--no-browser` | Don't open a browser |
| `./data-dir` | Data location (default `./agent-society-data`) |

## First run

1. The browser opens with a **Settings** dialog;
2. Fill in the LLM service address, model name, and API key; save;
3. Send "Hello, what can you do?" in the chat — a reply confirms the installation.

> **No LLM service?** Simplest local option: install [LM Studio](https://lmstudio.ai/) or Ollama, load any tool-capable model, and enter `http://127.0.0.1:1234/v1` (LM Studio) or `http://127.0.0.1:11434/v1` (Ollama) as the service address.

## FAQ

**Q: The browser didn't open automatically?**
Visit `http://localhost:3000/web/` manually.

**Q: Port already in use?**
Use `node start.js --port 3001`; or change the port in **Settings**.

**Q: start.cmd flashes and closes on Windows?**
Run `.\start.cmd` from the project root in PowerShell to see the error. Usual cause: `npm install` was not run.

**Q: Agents never reply?**
Almost always the LLM service being unconfigured or unreachable: check the service status in Settings; check logs under `agent-society-data/logs/`.

**Q: npm install is slow or fails?**
Switch the npm mirror: `npm config set registry https://registry.npmmirror.com`, then retry.

**Q: How do I upgrade?**
Source: pull the latest code → `npm install` → restart. Release package: download the new package and replace (do not overwrite the `agent-society-data/` data directory).

## Next steps

- [Quick Start](03-quick-start.md) — submit your first requirement
- [Configuration](07-configuration.md) — config in depth
