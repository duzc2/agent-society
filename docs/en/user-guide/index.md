# Agent Society User Documentation (English)

> Documentation baseline: written against the current `main` branch

This is the documentation for **users**: from installation and launch, to understanding how the agent organization works, to everyday usage, configuration, and advanced features.

If you are a developer who wants to understand the internal architecture or extend the system, read the [Developer Guide](../developer-guide/index.md) instead.

## Table of Contents

### Getting Started

1. [Introduction](01-introduction.md) — What Agent Society is, what you can do with it, key terms
2. [Installation & Launch](02-installation.md) — Requirements, installation, launch, first run
3. [Quick Start](03-quick-start.md) — Submit your first requirement and watch the organization work

### Everyday Usage

4. [Web Interface Guide](04-web-interface.md) — Sidebar, chat area, org view, artifacts panel
5. [Usage Scenarios & Examples](05-usage-scenarios.md) — Research, development, content, browser, remote, GUI automation
6. [Group Chat](06-group-chat.md) — Creating groups, group message mechanics, typical patterns

### Configuration & Management

7. [Configuration](07-configuration.md) — Settings dialog, config files, common settings
8. [Multi-Model Configuration](08-llm-services.md) — Adding LLM services, capability declarations, auto-selection
9. [Module Extensions](09-modules.md) — Browser, CLI, SSH and other capability switches
10. [Data & Directories](10-data-directories.md) — Where data lives, backup and migration, file access authorization

### Advanced

11. [Skill System](11-skills.md) — Installing, binding, authoring and reusing skills
12. [Process Collaboration (Proc Protocol)](12-proc-messaging.md) — How agent-launched background processes talk to your interface

## Conventions

- UI elements are shown in **bold**, e.g. the **Send button**.
- `Inline code` marks filenames, config keys, or text to enter verbatim.
- Each chapter ends with a FAQ; if your question isn't covered, report it in the repository Issues.

## Help & Feedback

- Project home (GitHub): <https://github.com/duzc2/agent-society>
- Project home (Gitee): <https://gitee.com/duzc2/agent_society>
- Bug reports: open an issue in the repository, and attach logs from `agent-society-data/logs/`.
