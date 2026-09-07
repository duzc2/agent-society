# Prompts & System Prompts

Agent behavior is prompt-driven. System prompt templates live in `config/prompts/`, assembly logic in `src/platform/prompt_loader.js`, org templates in `org/`.

## Template Inventory

| File | Purpose |
|------|---------|
| `base.txt` | Base preset prompt shared by all agents |
| `compose.txt` | **Assembly template**: defines the final system prompt skeleton and placeholders |
| `root.txt` | Root agent's prompt (the "one requirement, one sub-agent" hard constraint and 4-step flow) |
| `workspace.txt` | Workspace usage guide (file_* tool usage, path rules) |
| `tool_rules.txt` | Tool usage rules |
| `model_selector.txt` | Auto-selection decision prompt |
| `context_status.txt` / `context_warning.txt` / `context_critical.txt` / `context_exceeded.txt` | Context state notices (normal/warning/critical/exceeded) |
| `knowledge_tree.txt` / `knowledge_tree_maintenance.txt` / `knowledge_tree_retrieval.txt` | Knowledge tree extraction/maintenance/retrieval (in `services/knowledge_tree/prompts/`) |

## Assembly Structure

`compose.txt` defines the skeleton:

```
【System preset prompt】
{{BASE}}

【Workspace usage guide】
{{WORKSPACE}}

【Role prompt (runtime)】
{{ROLE}}
{{TASK}}
```

`PromptLoader.compose(parts)` fills the placeholders. The final system prompt, in injection order:

1. The rendered compose template (BASE + WORKSPACE + ROLE + TASK);
2. Dynamic providers registered with SystemPromptManager: skill overview, knowledge tree recall, vector memory recall, todos, context state notices;
3. `agent.systemPromptAppendix` entries (written by the agent itself, appended last).

## Root Constraints

`root.txt` is required reading for understanding org generation:

- **One requirement, one sub-agent (hard constraint)**: each requirement creates exactly 1 direct sub-agent; created ones must be reused;
- Root never executes requirements itself — it only creates roles and agents;
- Fixed 4-step flow: look up templates → create a role (full parameters) → create an agent (full TaskBrief) → send the clarified task statement;
- When a matching org template exists, design roles from it; otherwise write rolePrompt directly;
- When the user doesn't ask for code, interpret the requirement as "perform the behavior, achieve the outcome" — do not default to writing code.

## Org Templates

Each template in `org/<name>/` has two files:

| File | Purpose |
|------|---------|
| `info.md` | Template summary (read by `list_org_template_infos`) |
| `org.md` | Full org design (read by `get_org_template_org`, injected as orgPrompt) |

Built-in templates: `software_develop`, `content-operation`, `information_collector`, `entrepreneur-team`, `courseware`, `editorial-board`, `web-app-learn`, `virtual-world`, `Chinese_chess`.

Templates are stored via `services/org_templates/org_template_repository.js` and managed over `/api/org-templates/*`.

## Notes

1. **Templates are behavior contracts**: changing root.txt constraints changes org generation system-wide — run `test/platform/core/runtime.test.js` and e2e before and after;
2. **Keep placeholders intact**: deleting `{{BASE}}` or its siblings from compose.txt silently drops that content;
3. **Write for the LLM**: descriptions and rules are operating instructions for a model — concrete, unambiguous, with positive and negative examples; no pleasantries;
4. **Length-sensitive**: BASE/WORKSPACE-level content ships with every request from every agent — brevity beats completeness;
5. Record prompt changes in root-level `CHANGELOG_SYSTEM_PROMPT.md` if it exists.

## Memory and Prompts

Three of the seven memory layers act directly on the system prompt (see [Core Concepts](02-concepts.md)):

- orgPrompt (layer 7) → the org part of the ROLE section;
- Role rolePrompt (layer 5) → the ROLE section;
- systemPromptAppendix (layer 1) → appended last.

This chain explains "why the agent thought that": read its ROLE, dynamic injections, and appendix in order to reconstruct its full view.
