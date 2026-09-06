# Configuration

Most configuration happens in the **Settings** dialog (sidebar → Settings) — no file editing needed. This chapter covers the cases where you edit config files directly.

## Configuration methods

1. **Recommended**: use the Settings dialog; changes save automatically;
2. **Manual**: edit the `.local.json` files under `config/` → restart the server;
3. Never edit the template files without `.local` — they are system-provided templates.

| File | Controls |
|------|----------|
| `config/app.local.json` | Port, context limits, skills, memory, system parameters |
| `config/llmservices.local.json` | LLM service list |
| `config/modules.enabled.json` | Module enable/disable list |
| `config/modules/<name>.json` | Per-module parameters |
| `config/logging.json` | Log levels |

If a `.local.json` doesn't exist, it is generated from the template on first launch.

## Common settings

### Port

The `httpPort` field in `app.local.json` (default 3000). Restart after editing; or use `--port` at launch for a one-off override.

### Context length

The `contextLimit` field in `app.local.json`; set `maxTokens` to match your model's context window.

Long conversations are compressed automatically — no action needed; leave the compression thresholds as they are.

### Logging

`defaultLevel` in `logging.json` controls log verbosity. For troubleshooting, temporarily set it to `debug`; logs go to both the console and the logs directory.

## LLM services

See [Multi-Model Configuration](08-llm-services.md) — normally done in the Settings dialog.

## Module configuration

- Enable/disable: sidebar → **Modules**;
- Parameters (e.g. browser headless mode, proxy): in the module manager.

## FAQ

**Q: My config change didn't take effect?**
Manual file edits require a restart; changes made in the interface apply immediately.

**Q: The startup log says an LLM service entry is invalid?**
That entry is skipped; the rest load normally. Fix the fields per the log message and restart.

**Q: I broke a config file?**
Delete the corresponding `.local.json` and restart — the system regenerates it from the template (note: the LLM service list resets to template state and must be re-entered).

**Q: How do I confirm which config is in effect?**
The top of the Settings dialog shows the active config source (local/default).
