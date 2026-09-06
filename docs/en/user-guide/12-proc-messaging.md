# Process Collaboration (Proc Protocol)

Agents can launch background processes and communicate with them both ways; processes can also feed data to widgets in your interface. Typical scenario: an agent writes a data service and takes over a live-updating dashboard.

## Capabilities

```
You (dashboard) ◀── live data ─── background process (launched by an agent)
                     ▲
Agent ◀── reports ───┘
   └── commands ──▶ process
```

Three channels:

1. **You ⇄ process**: interface widgets request data from the process (HTTP);
2. **Process → you**: progress and status pushed to the interface;
3. **Agent ⇄ process**: two-way messages — agents send commands, processes report results.

## Usage

No coding on your part — just state the requirement:

```
Build a stock dashboard: fetch data every minute in the background,
refresh the frontend in real time, and put it in my interface
```

The agent handles the entire wiring: launching the background process, generating the interface component, opening the data channel.

## Process management

- **View processes**: Sidebar → Modules → localcmd panel, process list and output console;
- **Start/stop**: just ask ("stop the dashboard process"), or operate in the panel;
- **On exit**, a process's data channels are cleaned up automatically; the rest of the interface is unaffected.

A long-running process is a long-term service: dashboards, scheduled jobs and similar work stay available once an agent sets them up — no rebuild each time.

## Developer notes

The protocol connecting processes to the system is plain HTTP + JSON; any language can implement it. Protocol details and the SDK are in the developer guide's [Proc Messaging Protocol](../developer-guide/10-proc-protocol.md) — developer-facing content; ordinary use does not require it.

## FAQ

**Q: The dashboard stopped refreshing?**
The process may have exited. Check process status in the localcmd panel; restarting the process restores the dashboard.

**Q: Where can I see process output?**
Sidebar → Modules → localcmd panel: process list and output console.

**Q: Can agents manage these processes?**
Yes. Start, stop, check status, send input — all by request.

**Q: Do same-named processes from different tasks conflict?**
They take over each other's connection. Ask agents to use task-distinct names.
