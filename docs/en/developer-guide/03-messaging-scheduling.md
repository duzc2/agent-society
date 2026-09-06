# Messaging & Scheduling

How messages flow and get scheduled. Source references: `core/message_bus.js`, `runtime/runtime_messaging.js`, `runtime/turn_engine.js`, `runtime/compute_scheduler.js`, `runtime/agent_cancel_manager.js`.

## MessageBus

`core/message_bus.js`, deliberately minimal:

- **Per-recipient queues**: `_queues: Map<agentId, Message[]>`;
- **Delayed messages**: `_delayedMessages` sorted by `deliverAt`, delivered when due, firing `_deliveryListeners`;
- **Waiter mechanism**: `waitForMessage` / `receiveNext` let consumers suspend until a message arrives;
- No persistence — messages are transient; durable records live in conversation history and workspace documents.

## Message Processing Loop (RuntimeMessaging)

`runtime/runtime_messaging.js` implements the producer-consumer loop:

- `startProcessing()` launches a resident background loop (non-blocking);
- **Concurrency model**: different agents process in parallel; the same agent processes **serially** (per-agent mutual exclusion);
- **Interruptions**: messages arriving while the target is busy enter that agent's interruption queue (`runtime_state.interruptionQueues`), injected by the turn engine at a suitable boundary;
- **Exception isolation**: one agent's failure doesn't affect others;
- `stopRequested` supports graceful stop.

## TurnEngine

`runtime/turn_engine.js` abstracts "process one inbound message" as a **Turn**, advanced coroutine-style:

```
Turn lifecycle:
enqueue(agentId, ctx, messages)     # messages become a turn
  └─ step() ──▶ { action: "need_llm" | "need_tool" | "send" | "done" | "noop" }
       ├─ need_llm: needs an LLM decision → scheduler launches async call
       ├─ need_tool: needs a tool run → scheduler launches async execution
       ├─ send: outbound message (to user or another agent)
       └─ done: turn finished
```

**Design constraints** (stated in the source comments):

1. Only TurnEngine writes an agent's conversation history (single writer), preventing concurrent ordering bugs;
2. `step()` must be non-blocking — never `await` LLM/tools directly; the external scheduler launches async operations and callbacks on completion.

## ComputeScheduler

`runtime/compute_scheduler.js` is the system-level scheduler:

- Pulls messages from the MessageBus → enqueues them as Turns;
- **Round-robin time slices**: each round advances at most 1 atomic action per active agent;
- Long operations use "start async → completion callback enqueues", never occupying the loop;
- Every round yields the event loop, starving nothing.

This "coroutine state machine + time-slice scheduling" is what lets hundreds of agents run concurrently without blocking each other.

## LLM Interaction Loop (RuntimeLlm)

`runtime/runtime_llm.js` wraps the LLM step inside a turn:

1. **Context building** (ContextBuilder + SystemPromptManager): system preset prompts (assembled from the `config/prompts/compose.txt` template: BASE + workspace guide + role prompt + task) + skill overview + knowledge tree recall + vector memory recall + todos + conversation history;
2. Calls `LlmClient.chat()` (see [LLM Service Layer](04-llm-services.md));
3. Parses the response: text → outbound message; `tool_calls` → ToolExecutor;
4. Tool results appended to the conversation → turn steps again (until done or `maxToolRounds`);
5. Error handling: LLM errors are notified to the agent itself (self-aware failure) and scheduled via RetryCoordinator.

## Cancellation & Interruption

- **AgentCancelManager**: cancels in-flight LLM requests by agentId (the UI's Abort button lands here);
- **Interruption injection**: interrupting messages never abort the current LLM call; they enter the context at the next step boundary;
- **Terminate cascade**: terminating an agent makes LifecycleRegistry clean up everything it holds (browser instances, subprocesses, memory instances).

## Retry Coordination (RetryCoordinator)

`runtime/retry_coordinator.js` fixes the "thundering herd": agents independently backing off after simultaneous 429s can sync up their backoff windows and stampede the service again. The coordinator staggers retries via global slots (`maxSlots`).

## Related Documents

- [LLM Service Layer](04-llm-services.md)
- [Core Concepts & Data Model](02-concepts.md)
