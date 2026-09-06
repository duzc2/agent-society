# Data & Directories

Knowing where data lives makes backup, migration, and cleanup straightforward.

## Data locations

| Location | Contents |
|----------|----------|
| `agent-society-data/` (in the project root) | All runtime data: org state, workspace files, memory, logs |
| `config/` | Configuration files |

The data directory location can be set at launch (see [Installation & Launch](02-installation.md)).

## Directory contents

```
agent-society-data/
├── org/            # Org state: roles, agents, hierarchy
├── agents/         # Agent runtime data
├── agent-memory/   # Vector memory
├── workspaces/     # One subfolder per task: all task outputs live here
├── runtime/
│   ├── state/      # Conversation history
│   └── logs/       # Runtime logs
├── logs/           # Boot log, exit reasons
├── skills/         # Skills
└── …               # Per-module runtime data
```

You interact with `workspaces/` most — uploaded files and agent outputs are all there; the **Artifacts** panel is its visual view.

## File access scope

- By default, only the task workspace;
- To let them read files elsewhere (e.g. "analyze the csv files in D:\data"): interface → workspace file access panel → add an authorized folder;
- Every external file access is logged and viewable in the panel.

## Backup & migration

| Goal | How |
|------|-----|
| Full backup | Copy the whole `agent-society-data/` |
| Just one task's files | Copy `workspaces/<that task's folder>/` |
| Migrate to a new machine | Install the project → copy the data directory and `config/*.local.json` → launch |

## Cleanup

- Old task workspaces are never auto-deleted; remove unneeded ones from `workspaces/` (verify in the Artifacts panel first);
- Clearing `org/` loses all organizations and agents — confirm before doing it;
- Runtime logs can be cleaned periodically from `runtime/logs/`.

## FAQ

**Q: Do organizations/agents survive a restart?**
Yes. Org state and conversation history persist and are restored automatically on startup.

**Q: Disk usage grows fast?**
Usually `workspaces/` and `runtime/logs/`; clean them as described above.

**Q: Can I run multiple independent instances?**
Yes — launch several instances with different data directories (launch parameters in [Installation & Launch](02-installation.md)); they don't interfere.
