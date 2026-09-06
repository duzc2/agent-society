# Proc Messaging Protocol

The Proc Messaging Protocol lets agent-launched processes communicate with agents and web pages. The authoritative spec is `docs/proc-messaging-protocol.md` (v1.2); this chapter is the developer-side summary.

## Implementation Locations

| Component | File |
|-----------|------|
| Session & routing hub | `src/platform/services/proc_messaging/proc_message_hub.js` |
| Channel endpoints | `proc_message_channel_routes.js` |
| HTTP bridge endpoints | `proc_http_bridge_routes.js` |
| Node SDK | `sdk/proc_client.js` |
| Example | `sdk/examples/crawler.js` |
| Protocol tests | `test/platform/proc_message_hub.test.js` etc. |

## Protocol Essentials

- **Transport**: everything runs over the framework HTTP server; processes use zero ports. JSON request/response.
- **Endpoints**:
  | Endpoint | Purpose |
  |----------|---------|
  | `POST <base>/api/proc-messaging/channel/connect` | Establish session (validates the spawn token, returns sessionId) |
  | `POST <base>/api/proc-messaging/channel/poll` | Long-poll downstream (empty polls suspend ≤25s) |
  | `POST <base>/api/proc-messaging/channel/up` | Push one upstream message (msg/event/error/http_result) |
  | `POST <base>/api/proc-messaging/channel/disconnect` | Deregister the session |
  | `ANY <base>/api/proc-http/:procName/*` | Web page ⇄ process HTTP bridge |
- **Upstream types**: `msg` (to an agent) / `event` (to web pages) / `error` / `http_result` (bridge response);
- **Downstream types**: `msg` (agent message) / `http` (bridge request);
- **Addressing**: a registered process is `proc:<name>#<agentId>`; `name` is declared by the process and must be unique (same name takes over the old connection; the displaced side does not reconnect); `agentId` is resolved server-side from the token; agents address processes by the `processId` injected at spawn;
- **Security**: connection permission = spawn-specific token (`SOCIETY_PROC_TOKEN`, injected at spawn, valid for the process lifetime); the sessionId returned by connect is the credential for subsequent calls;
- **SDK reconnection**: exponential backoff 1s→30s; no reconnect after being displaced (prevents takeover storms).

## Session Sequence

```
Process                                     Platform
 │── connect{token,name,processId?} ──▶ │ validates token → resolves owner agentId
 │                                      │ → assigns procId; registers proc:<name>#<agentId>
 │ ◀── {sessionId, as} ──────────────── │
 │── poll{sessionId} ─────────────────▶ │ suspends if queue empty (≤25s)
 │ ◀── [downstream messages…] ───────── │
 │── up{sessionId, type:msg|event,…} ─▶ │ routes to agent conversation / web event channel
```

## HTTP Bridge Sequence

```
Web page                 Platform                         Process
 │─ fetch /api/proc-http/ │                            │
 │   {name}/path… ──────▶ │─ down:http{reqId,path,…} ─▶│ onRequest(req)
 │                        │                            │ returns {status,headers,body}
 │ ◀─ response ────────── │◀─ up:http_result{reqId,…} ─│
```

- Processes without onRequest registered get an automatic 404; handler exceptions produce an automatic 500;
- Requests have timeout protection; bridge calls fail immediately when the process is offline.

## Non-Node Integration

1. Read `SOCIETY_PROC_HTTP_URL` / `SOCIETY_PROC_TOKEN` / `SOCIETY_PROC_PROCESS_ID`;
2. POST connect to get a sessionId;
3. Loop poll for downstream; POST up to send;
4. Handle `http`-type downstream to implement the bridge server side;
5. POST disconnect before exiting.

Implement against the field definitions in the protocol doc; the protocol tests (`test/platform/proc_message_hub.test.js`) are the behavioral baseline.

## Related Documents

- User perspective: [Process Collaboration](../user-guide/12-proc-messaging.md)
- localcmd module (process lifecycle): `modules/localcmd/`
