# Agent Society Developer Guide (English)

> Documentation baseline: written against the current `main` branch

This documentation set targets **developers**: understanding the architecture, reading the code, building extension modules, and contributing.

If you only want to use Agent Society, read the [User Documentation](../user-guide/index.md) instead.

## Table of Contents

### Understanding the System

1. [Architecture Overview](01-architecture.md) — Layered model, core flows, directory tour
2. [Core Concepts & Data Model](02-concepts.md) — Implementation details of Agent, Role, Task, Message, Workspace
3. [Messaging & Scheduling](03-messaging-scheduling.md) — MessageBus, message loop, turn engine, compute scheduler

### Service Layer

4. [LLM Service Layer](04-llm-services.md) — Client, registry, model selector, concurrency, retries
5. [Conversation & Context](05-conversation.md) — Conversation management, auto-compression, context thresholds
6. [Workspace & File Services](06-workspace.md) — Workspace management, file access authorization, HTTP file service

### Extension Development

7. [HTTP API Reference](07-http-api.md) — Quick reference for all REST endpoints
8. [Module Development Guide](08-module-development.md) — Module contract, tool registration, web panels, routes
9. [Tool System](09-tools.md) — Quick reference for the 68 built-in tools, tool group mechanics
10. [Proc Messaging Protocol](10-proc-protocol.md) — Protocol specification summary

### Engineering Practice

11. [Testing Guide](11-testing.md) — Test system, how to run, writing conventions
12. [Build & Release](12-build-release.md) — Web builds, exe packaging, installers, desktop launcher
13. [Prompt Engineering](13-prompts.md) — System prompt template system and organization templates
14. [Coding Standards](14-coding-standards.md) — Code organization, exception handling, comments, testing conventions

## Suggested Reading Paths

- **First contact with the code**: [Architecture Overview](01-architecture.md) → [Core Concepts](02-concepts.md) → browse `src/platform/` alongside the source
- **Writing an extension module**: [Module Development Guide](08-module-development.md) → study `modules/localcmd/` and `modules/chrome/`
- **Debugging / troubleshooting**: [Testing Guide](11-testing.md) → [Data & Directory Structure](../user-guide/10-data-directories.md) (log locations)
- **Frontend work**: the Web frontend section of [Architecture Overview](01-architecture.md) → `web/v3/src/` → [HTTP API Reference](07-http-api.md)

## Extension Points Overview

The system provides five official extension points; design details in the linked chapters:

| Extension point | Capability | Chapter |
|-----------------|-----------|---------|
| **Module** | Tool group + web panel + HTTP routes, dynamic loading / lazy loading | [Module Development Guide](08-module-development.md) |
| **Built-in tools** | Add a tool to an existing domain, or register a new domain | [Tool System](09-tools.md) |
| **Proc protocol** | Connect external processes to the message channels and HTTP bridge | [Proc Messaging Protocol](10-proc-protocol.md) |
| **Declarative DI (ModuleRegistry)** | Service exchange between modules and platform services, topology-ordered init | [Module Development Guide](08-module-development.md) |
| **Org templates** | Customize organization generation via `org/<template>/org.md` | [Prompt Engineering](13-prompts.md) |

Selection rule: adding an operating capability for agents → module; adding data/flow capability to the system → built-in tool; bringing an external program into the collaboration → Proc protocol; defining a team structure → org template.

## Key Source Entry Points

| To understand | Read |
|---------------|------|
| System entry & user interface | `src/platform/core/agent_society.js` |
| Runtime coordinator | `src/platform/core/runtime.js` |
| Message bus | `src/platform/core/message_bus.js` |
| Organization primitives (role/agent persistence) | `src/platform/core/org_primitives.js` |
| Declarative module registry (DI) | `src/platform/core/module_registry.js` |
| All services | `src/platform/services/` (each subdirectory ships a same-name `.md`) |
| Runtime submodules | `src/platform/runtime/` |
| Module loader | `src/platform/extensions/module_loader.js` |
| Tool schemas | `src/platform/runtime/tools_schema.js` and `tools_*.js` |
