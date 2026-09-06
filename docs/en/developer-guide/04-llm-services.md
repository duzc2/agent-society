# LLM Service Layer

Everything about talking to large models. Source directory: `src/platform/services/llm/` (with a self-describing `llm.md`); runtime counterparts in `runtime/llm_client_pool.js` and `runtime/retry_coordinator.js`.

## Component Map

```
services/llm/
├── llm_client.js             # Minimal LLM client (OpenAI/Anthropic SDK wrapper)
├── llm_service_registry.js   # Service registry: loads/validates llmservices config
├── model_selector.js         # Model selector: picks a service per role prompt
├── concurrency_controller.js # Concurrency controller
├── llm_retry_service.js      # Request-level retries
├── llm_stream_service.js     # Streaming
├── llm_truncation_service.js # Context/output truncation
├── llm_augment_service.js    # Request augmentation
├── llm_response_service.js   # Response normalization
├── llm_fetch_service.js      # fetch-style calls
├── llm_providers_service.js  # Multi-provider adaptation
├── client_exchange_state.js  # Exchange state
├── message_snip_service.js   # Message snipping
├── tool_result_aging_service.js # Tool result aging
└── utils/message_adapter.js  # Message format adaptation
```

## LlmClient

`llm_client.js` is the single exit point for all calls:

- **Multi-provider**: OpenAI-compatible (`@ai-sdk/openai` / `openai`) and Anthropic (`@anthropic-ai/sdk`), chosen by the configured provider field;
- **Retries**: exponential backoff (`_chatWithRetry`), configurable;
- **Concurrency integration**: requests enter via `ConcurrencyController.executeRequest()`; excess queues automatically;
- **Per-agent cancellation**: `cancelRequest(agentId)` aborts that agent's in-flight request (used by the Abort button and terminate cascades);
- **Metrics**: call duration and token usage logged (`logLlmMetrics`).

## LlmServiceRegistry

Loads `config/llmservices.local.json` (falling back to the default `llm` config):

- Validates entries (id/name/baseURL/model required; capabilities well-formed);
- Query APIs: `getService(id)`, filtering by capability tags / input-output capabilities;
- A single invalid entry is rejected with a log record — the rest still load.

## ModelSelector

Selection flow (`model_selector.js`):

1. Inputs: role prompt + candidate services (with capabilityTags/descriptions);
2. Builds a selection prompt from the `config/prompts/model_selector.txt` template, one LLM call;
3. Parses the returned `serviceId` and reasoning (`_parseSelectionResult`);
4. Validates the serviceId exists; on failure/timeout falls back to the default service.

Triggered when a role first runs and no service was manually pinned. The result is recorded on the role and reused.

## ConcurrencyController

- Global cap (`maxConcurrentRequests` from app.json's `llm` config);
- **Same-agent mutual exclusion**: requests from one agentId serialize, protecting context order;
- Queue management with cancellation (both active and queued requests);
- Statistics (active/queued counts) for diagnostics.

## Retry System

| Level | Location | Strategy |
|-------|----------|----------|
| Request | `llm_retry_service.js` / inside LlmClient | Exponential backoff on network errors/5xx/429 |
| Scheduling | `runtime/retry_coordinator.js` | Global slots stagger agents' retry moments, preventing stampedes |

## Context-related Services

- **llm_truncation_service**: truncates when requests exceed limits;
- **message_snip_service**: snips history messages;
- **tool_result_aging_service**: demotes old tool results to summaries (second line of defense after conversation-layer compression).

## Client Pool (LlmClientPoolManager)

`runtime/llm_client_pool.js` caches LlmClient instances per serviceId, avoiding repeated SDK client construction. Returns null for unknown services (that's tolerance for external config, not null-tolerance of internal components).

## Service Config Fields

```json
{
  "id": "my-service",
  "name": "Display name",
  "baseURL": "https://…/v1",
  "model": "model-id",
  "apiKey": "sk-…",
  "timeout": 600000,
  "maxTokens": 8192,
  "maxConcurrentRequests": 2,
  "stream": true,
  "thinking": { "…": "reasoning-model thinking injection (OpenAI-compatible reasoning config)" },
  "capabilityTags": ["coding"],
  "capabilities": { "input": ["text"], "output": ["text", "tool_calling"] },
  "description": "Description the model selector reads"
}
```

## Related Documents

- User perspective: [Multi-Model Services](../user-guide/08-llm-services.md)
- Context compression: [Conversation & Context](05-conversation.md)
