# Conversation & Context

The conversation service maintains each agent's LLM dialogue history: management, statistics, compression, persistence. Source directory: `src/platform/services/conversation/` (with `conversation.md`).

## ConversationManager

`conversation_manager.js` is the core:

- **Containers**: per-agent message lists (OpenAI message format: system/user/assistant/tool);
- **Token statistics**: tracks per-call usage, estimating context occupancy;
- **Context state machine**: `normal / warning / critical / exceeded`, thresholds from `app.json`'s `contextLimit`;
- **Persistence**: history written (debounced) to `<dataDir>/runtime/state/`; restored via `loadAllConversations()` at startup, with consistency validation (`history_persistence_compatibility.test.js` covers compatibility).

## Auto-compression (AutoCompressionManager)

`auto_compression_manager.js` — zero-config, always on:

1. Triggers when context occupancy reaches `criticalThreshold` (default 0.7);
2. Uses the default LLM to produce a **structured summary** of old history;
3. Mutates the message array: the summary replaces the compressed span; system and recent messages are preserved;
4. Threshold states are surfaced to the agent via prompts — `config/prompts/context_warning.txt`, `context_critical.txt`, `context_exceeded.txt`, `context_status.txt` — so agents are aware of their own context situation.

## Tool Call Pair Compressor (ToolCallPairCompressor)

`tool_call_pair_compressor.js` — zero-cost compression without LLM calls:

- Strategy: leave the last N rounds untouched; in earlier rounds, all tool message results are truncated to compact summaries;
- Processes "tool call pairs" (assistant tool_call + matching tool result) to keep the message structure legal (OpenAI format requires pairing).

## Compression Decision Flow

```
Context occupancy
  ├─ < warningThreshold(0.6)      → normal, no action
  ├─ ≥ warningThreshold           → warning: notice injected (agent self-throttles)
  ├─ ≥ criticalThreshold(0.7)     → critical: LLM summary compression triggers
  └─ ≥ hardLimitThreshold(0.8)    → exceeded: forced compression + stronger notice
```

## Interplay with Other Layers

- **TurnEngine single writer**: only the turn engine writes history; the compressor runs at turn boundaries, avoiding races;
- **LLM-layer aging**: `tool_result_aging_service.js` demotes old tool results before requests — a second reduction mechanism beyond compression;
- **Memory systems**: content worth keeping long-term is absorbed by agent_memory / knowledge_tree (compression manages the window; memory manages sedimentation).

## Developer Notes

1. Any code touching the message array must keep the OpenAI structure legal (every tool message needs its matching tool_call_id);
2. New persisted fields must stay backward-compatible with old state files (follow `history_persistence_compatibility` test patterns);
3. The compressor must not make business judgments — it only looks at occupancy and round counts; semantic triage belongs to the summary LLM.
