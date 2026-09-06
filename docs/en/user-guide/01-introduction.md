# Introduction

## Overview

Agent Society is a **self-organizing multi-agent collaboration system** built on large language models (LLMs), used through a web interface.

You state a goal in natural language. Agents in the system form a team, divide the work, and deliver the result. The whole process is visible in real time; you can jump in at any moment to correct, adjust, or add requirements.

## Design principles

The system mirrors how humans run an organization. When using it, think of yourself as the manager: consider how to build your organization — which roles to create, whom to staff, how to divide the work.

**Defined roles**: every agent must hold a position. A role is an explicit job definition; one role can staff one or more agents. Roles can be added or removed, and their duties edited; when a role changes, the agents on it change with it.

**Long-term agents**: the system has no "new session" capability and does not spin up a fresh batch of agents per task. The intended usage: create one role for each kind of work, then use the agents on that role long term. Over time they accumulate memory and solidify skills — the longer they serve, the better they perform.

**Root builds organizations, does no work**: the Root agent is the organization builder. It never handles work itself — it only analyzes requirements, creates roles, staffs agents on them, and assigns tasks.

**Organization as company**: each organization is an "independent company" — its own role structure and team, managed separately. Organizations can also cooperate: pull agents from different organizations into the same group chat, or have them delegate to each other.

**Teams at every level**: not just Root — every agent can create sub-roles and staff agents on them, like a department head leading their own team.

**Near-zero hiring cost**: this is the only difference from a human company. Agents are virtual employees; recruiting and firing costs nearly nothing — staff up when you need hands, downsize when you don't. Adjust boldly with the business.

What this means for usage:

- Give the same kind of work to the same role; no need to re-explain the background each time — the agents on the role remember the context;
- When workload grows, add agents to the role or add sub-roles; shrink roles when the business contracts;
- Hand new requirements to the agents already on duty and let them continue from where things stand, instead of rebuilding;
- Requirements go to Root, and Root only builds the organization; the real work is done by the agents on their roles.

## Use cases

| Task type | Example |
|-----------|---------|
| Information gathering | "Collect ten important AI news items from the past week into a report" |
| Software development | "Build a whack-a-mole web game with score and sound" |
| Writing | "Write a user manual for my application" |
| Content operations | "Write three promo copy variants in different styles for our new product" |
| Browser operations | "Count the open issues in this GitHub repository" |
| Local commands | "Compress demo.mp4 to 720p with ffmpeg" |
| Remote operations | "Deploy this report to my server" |
| UI generation | "Add a weather widget to the main interface" |
| Group discussion | "Create a group with product, tech, and operations to discuss the release plan" |

## Working mechanism

```
You (browser interface)
 │  state a requirement
 ▼
Root agent ── understands it, appoints an owner
 │
 ▼
Owner agent ── does it alone, or builds a sub-team as needed
 │
 ├──────┬──────┐
 ▼      ▼      ▼
Agent A  Agent B  Agent C
 │
 ▼
Result returns → you see the reply and output files in the interface
```

- Agents message and delegate to each other; every message is visible in the chat area;
- Output files (reports, web pages, images…) appear in the **Artifacts** panel for viewing and download;
- Each agent has an avatar, a name, and a status (idle/processing); complex tasks show several agents working at once;
- Organizations and agents persist: after a task finishes, the organization stays in the sidebar and you continue with it next time.

## Key terms

| Term | Meaning |
|------|---------|
| **Agent** | A member working on a role. Has a name, avatar, and status; long-term on duty, accumulating memory and skills. |
| **Role** | A job definition. Every agent must hold a role; one role can staff one or more agents; roles can be added or removed and duties edited. Every agent can create sub-roles and staff agents on them. |
| **Root agent** | The organization builder. All your requirements go to it; it only builds the organization — creates roles, staffs agents, assigns tasks — and never does the work itself. |
| **Organization** | The team structure of roles and agents. Each organization is an "independent company", managed separately; organizations can cooperate. |
| **Task** | One of your requirements. Related messages and output files belong to it. |
| **Workspace** | The task's dedicated folder. Agents put outputs there; you view them in the interface. |
| **Group chat** | A multi-party conversation among several agents (you can join). |
| **Skill** | A reusable working method. Agents create skills themselves; you can install them. |
| **Module** | A switch for real-world capabilities: browser control, local commands, remote servers, etc. |
| **Org template** | A preset team structure (software dev team, editorial desk…); Root references it when organizing. |

Agents also have memory: important information is retained, valuable working methods solidify into skills and are reused across tasks.

## Safety boundaries

- By default agents can only read/write their own task's workspace folder; accessing other files on your computer requires your explicit authorization in the interface;
- Browser control, local commands, remote connections and similar capabilities are controlled by module switches — not enabled, not available;
- Agents ask for your confirmation before running high-risk local commands.

## FAQ

**Q: What tasks suit it?**
Tasks whose goals can be stated clearly and whose results can be checked. The more specific the requirement, the better the outcome (see [Usage Scenarios](05-usage-scenarios.md)).

**Q: Do I need to know programming?**
No. Everything happens in the web interface; the only technical step is installation and launch (next chapter).

**Q: Will agents touch my private files?**
Not by default. They can only access the task workspace; files outside it require folder-by-folder authorization from you.

**Q: What can I do while a task runs?**
Send follow-up messages at any time, abort an agent's current work, and view or download any output file.

**Q: Do I need a new organization for every task?**
No. Keep one role for each kind of work and use it long term; the agents on duty remember previous work — just state the new requirement. When the business changes, add or remove roles in the organization view.

## Next steps

- [Installation & Launch](02-installation.md) — get the system running
- [Quick Start](03-quick-start.md) — submit your first requirement
