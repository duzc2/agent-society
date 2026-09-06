# Multi-Model Configuration

Connect multiple LLM services simultaneously: strong models for planning decisions, fast models for routine work, vision-capable models for images. Each role automatically gets a suitable model.

## Use cases

- Saving cost: routine tasks (file organization, format conversion) on a cheap model;
- Quality: architecture design and complex analysis on a stronger model;
- Images/audio in tasks: models with the corresponding input capabilities;
- A service is rate-limited or down: other services remain available.

A single service supports all functionality; multiple models are an optimization.

## Adding a service

Sidebar → **Settings** → LLM services → Add:

| Field | What to enter |
|-------|---------------|
| ID | Service identifier (English), e.g. `gpt4`, `local-qwen` |
| Name | Display name, e.g. "GPT-4", "Local Qwen" |
| Base URL | API address ending in `/v1` |
| Model | e.g. `gpt-4o`, `qwen2.5-7b-instruct` |
| API Key | Required for cloud services; `NOT_NEEDED` for local |
| Capabilities | What it accepts / outputs (see below) |
| Description | One line on what this model is good at |

After adding, you can set it as the **default service**; tasks where auto-selection doesn't apply use the default.

## Capabilities

**Input capabilities** (what the model accepts):

| Option | Meaning |
|--------|---------|
| `text` | Text (always on) |
| `vision` | Images |
| `audio` | Audio |
| `file` | Files |

**Output capabilities** (what the model produces):

| Option | Meaning |
|--------|---------|
| `text` | Text replies (always on) |
| `tool_calling` | Tool use (**working roles must get a model with this**) |

What wrong settings cause: a model without image input receives your image as an auto-generated text description handled by another model; a model without `tool_calling` is never assigned to roles that need to act.

## Automatic model selection

With multiple services configured, the system picks a model per role based on the role description. **The more specific the role description, the better the match**: "an engineer writing React components" matches better than "writes code".

To pin a role to a specific model: org view → role details → LLM service → set manually. Pinned roles stop auto-selecting.

## Verification

- The services list in Settings shows all services and their status;
- Org view → role details: which model the role currently uses and why.

## FAQ

**Q: Added a service but nothing changed?**
Selection results are recorded on roles; existing roles keep their old service. New requirements and new roles use the new configuration — or switch manually in role details.

**Q: Error "service unavailable / timeout"?**
Check the service status in Settings; for local services confirm it's running (e.g. LM Studio is up); for cloud services check the API key and balance.

**Q: A role's tasks keep failing?**
Check whether the role's model supports tool calling (`tool_calling`); if not, switch to one that does.

**Q: Requests often wait in a queue?**
Raise the concurrency limit in Settings; or the service itself is rate-limiting, in which case requests queue up one by one.
