# Module Extensions

Modules give agents real-world capabilities: browser control, local command execution, remote servers, and more. Each module is a switch — not enabled, not available.

## Enabling and disabling

Sidebar → **Modules** → enable/disable. Some modules load lazily on first use; no restart needed.

> Modules operate real systems. Enable only what you need.

## Built-in modules

| Module | Purpose | Enable when |
|--------|---------|-------------|
| **chrome** | Browser control: navigate, click, fill forms, screenshot, read pages | Web operations, data collection, web testing |
| **localcmd** | Local commands: run scripts, convert files, long tasks | Using local tools (ffmpeg, python…) |
| **ssh** | Remote servers: run commands, transfer files | Managing remote machines, deploying |
| **ui_page** | Instantly generate widgets in your interface | Weather widgets, dashboards built by agents |
| **automation** | Mouse/keyboard control, desktop app operation | Automating desktop software without APIs |
| **document** | Read docx/pdf and other documents | Processing document material |
| **light-ocr** | OCR for images | Scanned documents, text in screenshots |
| **message_tools** | Agents can read each other's conversations | Collaboration transparency (skip if unwanted) |
| **sandbox** | Run commands in an isolated sandbox | Running untrusted code |
| **remote** | Remote process management | Long-running remote tasks, with ssh |

## Usage examples

### Browser (chrome)

After enabling, just state the task:

```
Open the Issues page of the agent_society GitHub repository and
count the open issues
```

The agent opens tabs, navigates, reads content, and reports the result.

### Local commands (localcmd)

```
Use ffmpeg to compress demo.mp4 in the workspace to 720p,
and tell me the output file size when done
```

The agent reads command output itself; during long tasks it keeps following up, and process status changes notify it automatically.

### UI widgets (ui_page)

```
Add a weather widget to the main interface showing
Beijing's three-day forecast
```

The agent builds the component and injects it into your interface; it survives refreshes (manageable in the module panel).

### Remote servers (ssh)

Enable the module, add host details in the ssh panel (address, account), then:

```
Deploy the report in the workspace to the server I configured
```

## Safety

- **localcmd / sandbox / automation / ssh** grant agents real-system access — enable only when needed;
- High-risk local commands require your confirmation first;
- Access to local files outside the workspace requires separate authorization in the file-access panel;
- With **message_tools** enabled, agents can read each other's conversations — don't enable it if you mind.

## FAQ

**Q: Enabled a module but agents say they lack the capability?**
Only roles created after enabling get the new tools by default. For existing roles: org view → open the role details → Config → tool groups, check the new group.

**Q: The chrome module can't open a browser?**
Confirm Chrome is installed; the panel shows connection status. Toggle headless mode in the module manager.

**Q: ssh won't connect?**
Check host details in the ssh panel (address, port, credentials); verify manually with a plain ssh command first.

**Q: An agent is running a command I want stopped?**
Org view → that agent → Abort; the localcmd panel can kill the process directly.

**Q: How do I revoke a module's access?**
Sidebar → Modules → disable. The agent loses those tools immediately.
