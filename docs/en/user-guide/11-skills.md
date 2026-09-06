# Skill System

A skill is a reusable capability package: a document describing "how to do a certain kind of work", optionally with scripts. Once bound to a role, its agents use it automatically and long-term.

## Skill sources

- **Agent-authored**: agents solidify valuable methods they discover into skills on their own;
- **ModelScope**: skill manager → install, enter the skill ID;
- **Git**: import from a Git repository, for team-internal sharing;
- **Blank creation**: "Blank creation" in the skill manager — fill in the description and content in the form.

## Interface operations

Sidebar → **Skills**:

| Action | Where |
|--------|-------|
| Browse skill content | Skill overview |
| Install/uninstall/enable | Skill manager |
| Assign a skill to a role or agent | Binding panel |
| Duplicate one to modify | Skill manager → copy |

## Essentials

1. **Bind before use**: unbound skills are invisible to agents;
2. **Enablement**: installed skills start disabled — enable first, then bind;
3. **Role-level bindings** are shared by all agents of that role; agent-level bindings affect one agent only.

## Writing tips

- Write the description around **when to use it, how, and its limits** — agents rely on this text to decide whether to use the skill;
- One skill, one topic; don't pile all methods into one giant skill;
- A pure-document skill with no scripts is still valuable (solidified procedural knowledge).

## Skills and memory

Agents solidify best practices from repeated tasks into skills, then reuse them. When you notice an agent handling a task type well, tell it to "organize this method into a skill" and benefit long-term.

## FAQ

**Q: Bound a skill but the agent seems unaware?**
Check the skill is enabled (toggle in the manager); confirm the binding targets the agent's role or the agent itself.

**Q: The agent doesn't pick the skill I installed?**
The description drives selection. Rewrite it closer to your task's wording; or name it in the requirement: "use the xxx skill to…".

**Q: ModelScope install fails?**
Check network access to modelscope.cn; verify the skill ID.

**Q: I want to edit a skill an agent created?**
Skill manager → copy → edit the copy; or view content in the overview and adjust bindings in the binding panel.

**Q: What do skill scripts run?**
Scripts execute inside the workspace under its safety constraints. Review a skill's content in the overview before installing from an unknown source.

**Q: I want to make my own skill?**
Skill manager → Blank creation, fill in the form; a skill's body is a description stating "when to use it, how, and its limits". See the tips above.
