# Web Interface Guide

After launch, visit `http://localhost:3000/web/`. Mobile browsers are redirected to the mobile interface automatically; this chapter covers the desktop version.

## Layout

```
┌──────────┬─────────────────────────┬───────────────┐
│          │                         │               │
│ Sidebar  │       Chat area         │  Properties   │
│ (nav)    │  (message stream+input) │  (on demand)  │
│          │                         │               │
└──────────┴─────────────────────────┴───────────────┘
```

## Sidebar

| Entry | Purpose |
|-------|---------|
| **Overview** | System summary: agent count, how many are working |
| **Chat** | Conversations with agents — your main workspace |
| **Groups** | Multi-agent group chats |
| **Organization** | Current org structure: role tree, agent states and details |
| **Artifacts** | Task output files: preview, edit, download, upload |
| **Skills** | View and manage agent skills |
| **Modules** | Switches for extended capabilities (browser, CLI, SSH…) |
| **Templates** | Org structure templates |
| **Settings** | LLM services, system parameters |

## Chat area

- Renders Markdown, code highlighting, images, charts, and formulas;
- Send target defaults to the current conversation's agent; select an agent in the org view first and your message goes directly to it;
- **Interruptions**: messages sent while an agent is working are not lost — the agent sees them during processing;
- Long conversations: message navigation for quick jumps; conversation export supported.

## Organization view

Manage each "company" here, like running a business:

- Each organization is a separate team — switch between them in the sidebar and manage them independently;
- A tree of roles and agents: expand a role to see its sub-roles and agents;
- Click an agent to open the **properties panel**: status, todo list, settings;
- Common management actions live here: create a sub-role for an agent, edit role prompts, **Abort** an agent's current action.

Cross-organization cooperation: group chats can invite agents from any organization; tasks can be delegated to agents of other organizations in groups and direct messages.

## Artifacts panel

All task output lives here:

- Tree browsing of the workspace folder;
- Previews for text, code, Markdown, JSON, HTML (runnable), images, audio/video, PDF;
- Online editing of text files;
- Upload local files for agents to use.

## Groups panel

Create groups, invite/remove members, dissolve groups; group messages are listed separately from personal ones. See [Group Chat](06-group-chat.md).

## Skills panel

- Skill overview: installed skills and their sources;
- Skill manager: install (from ModelScope), uninstall, enable/disable;
- Binding: assign skills to roles or agents.

## Module windows

Each module provides its own management panel (browser tabs, command consoles). Open via sidebar → **Modules**.

## Error toasts

Errors surface as toasts; click for details (message, time, involved agents) to include when reporting issues.

## Quick operations

| I want to… | Do this |
|------------|---------|
| Submit a new requirement | Type it in the chat area |
| See the org structure | Sidebar → Organization |
| Leave a note for a specific agent | Select it in the org view → type and send |
| View task output files | Sidebar → Artifacts |
| Change the LLM service | Sidebar → Settings → LLM config |
| Enable an extension capability | Sidebar → Modules → enable |
| Stop an agent's current work | Org view → agent properties → Abort |
| Upload a file for agents | Sidebar → Artifacts → upload |

## FAQ

**Q: Images/charts don't render in the chat?**
Some rendering depends on network resources; check connectivity, or open the original file in the Artifacts panel.

**Q: Can't find a task's files?**
The Artifacts panel switches workspaces per task — confirm the right task is selected.

**Q: The interface stops updating?**
Updates arrive via heartbeat, usually within seconds. If stalled, refresh the page; task state is not lost.

**Q: Can I use it on a phone?**
Yes. Open the same URL in a mobile browser; the mobile interface loads automatically.

## Next steps

- [Usage Scenarios & Examples](05-usage-scenarios.md)
- [Configuration](07-configuration.md)
