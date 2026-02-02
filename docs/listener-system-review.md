# Listener System Review (Assistant / Terminal State)

Date: 2026-02-01

## Scope

This review covers the assistant listener flow and terminal waiting-state detection that drives it. Key files:

- `electron/services/assistant/ListenerManager.ts`
- `electron/services/assistant/TerminalStateListenerBridge.ts`
- `electron/services/assistant/listenerTools.ts`
- `electron/ipc/handlers/assistant.ts`
- `src/hooks/useAssistantStreamProcessor.ts`
- `electron/services/pty/AgentStateService.ts`
- `electron/services/ActivityMonitor.ts`
- `electron/services/pty/TerminalProcess.ts`
- `shared/types/listener.ts`
- `docs/assistant-listeners.md`

## Current Behavior (End-to-End)

### 1) How waiting state is detected

- Agent terminals run an `ActivityMonitor` (`TerminalProcess`) that watches output, prompt patterns, and silence.
- When the monitor decides the agent is idle, it calls `AgentStateService.handleActivityState(..., "idle")`.
- `AgentStateService` maps that to an agent state transition and emits `agent:state-changed` on the event bus.
- For agent terminals, the waiting state is inferred from quiet output + prompt detection; it is heuristic and can be wrong.

### 2) How listeners are registered

- The assistant can call `register_listener({ eventType, filter })` (via tools in `listenerTools.ts`).
- Listeners are stored in-memory by `ListenerManager` and scoped to the assistant `sessionId`.
- Filters are exact-match only, and only support primitive values (string/number/boolean/null).

### 3) How listener events are delivered

- `TerminalStateListenerBridge` subscribes to multiple event types:
  - `agent:state-changed` → translated to `terminal:state-changed` for the assistant
  - `agent:completed`, `agent:failed`, `agent:killed` → passed through as-is
- For each matched listener, it emits a `listener_triggered` chunk to the renderer via `CHANNELS.ASSISTANT_CHUNK`.
- `useAssistantStreamProcessor` handles the event and adds an event-role message to the conversation.

### 4) What the chat does with listener events

- Listener events do NOT pause or block assistant streaming.
- Events are stored in a pending event queue (in-memory).
- Pending events are automatically injected into the system prompt on the next assistant request.
- If the listener has `autoResume` configured, the system automatically starts a new assistant request with the provided prompt, making the continuation immediate.

## Direct Answers to Your Questions

### Q: If an agent created a terminal and listened for waiting, does chat pause or continue?

- It continues. The listener event is asynchronous and is rendered as a separate message. It does not pause streaming or block the assistant.

### Q: Can the agent wait for a response and then continue working later?

- Yes, using the `autoResume` feature. When registering a listener, you can provide `autoResume: { prompt, context }`.
- When the listener triggers, the assistant is automatically re-invoked with the provided prompt. Context is available for tracking (via `metadata`, `plan`, or `lastToolCalls`) but not directly injected into the model.
- This enables "launch → listen → auto-continue" workflows without requiring user messages.

### Q: Is there a queue of listener events for later processing?

- Yes, an in-memory pending event queue stores triggered events per session (max 100 events).
- Events are automatically injected into the system prompt on the next request to guarantee the model sees them.
- Queue is not durable - events are lost on reload or crash, but survive across normal chat interactions.

### Q: Do I foresee it working as-is?

- Yes, for user-facing notifications ("agent is waiting") and manual intervention.
- Yes, for autonomous "launch → wait → resume" workflows using `autoResume` on listener registration.

## Gaps / Risks

1. Event type support

- `register_listener` currently supports: `terminal:state-changed`, `agent:completed`, `agent:failed`, `agent:killed`.
- The tool schema enforces this list, preventing registration of unsupported event types.

2. Auto-resume available

- `autoResume` option on `register_listener` enables automatic model re-invocation when listeners trigger.
- When a listener with `autoResume` fires, the system automatically starts a new assistant request with the provided prompt and context.

3. No event queue or ack

- Events are not buffered for later. If the conversation session changes or the renderer is not listening, events are lost.

4. Listener lifecycle leaks

- Listeners persist until explicitly removed or `clearSession()` is called.
- Navigation triggers `assistantService.cancelAll()` but does not clear listeners unless that session has an active stream.

5. Missing context in the notification

- The translated event does not include trigger/confidence or prompt content.
- For "waiting" detection (heuristic), this makes it hard to decide if user input is truly required.

6. UI rendering

- Listener notifications use `role: "event"` to distinguish them from assistant messages.
- Auto-resume status updates use `role: "system"` for clear visual separation from model output.

7. Terminal state event bridging

- `terminal:state-changed` is an assistant-facing event type created by the bridge from `agent:state-changed`.
- Not emitted on the event bus directly - exists only in the listener system for backward compatibility.

## Implementation Status

### Completed features

1. **One-shot listeners** ✅
   - `once: true` auto-removes listeners after first trigger.

2. **Richer event context** ✅
   - `trigger` and `confidence` fields included in terminal:state-changed events.

3. **Pending-event queue** ✅
   - `list_pending_events()` and `acknowledge_event()` tools available.
   - Events are stored and delivered to the assistant on next request.

4. **Explicit await tool** ✅
   - `await_listener({ listenerId, timeoutMs })` blocks until triggered (max 5 minutes).

5. **Auto-resume policy** ✅
   - `register_listener` accepts `autoResume: { prompt, context }` to auto-start a new assistant run.
   - `ContinuationManager` stores continuation state.
   - `useAssistantStreamProcessor` handles auto_resume chunks and triggers new model calls.

### Remaining improvements

1. Event type expansion

- Current support: `terminal:state-changed`, `agent:completed`, `agent:failed`, `agent:killed`.
- Future: Add bridges for additional event types as needed and document supported filters per event.

### Future enhancements

1. Event-driven task runner

- Store a "continuation" (plan + prompt) tied to a listener, then dispatch it automatically when triggered.
- Integrate with a durable store so events survive reloads.

2. Waiting detection improvements

- Expose the detection source (prompt vs silence vs pattern) and guardrails for false positives.
- Allow per-agent tuning in `agentRegistry` for prompt patterns and debounce thresholds.

## Bottom Line

- The listener system works as both a notification pipeline and an autonomous workflow enabler.
- **Auto-resume is now supported**: Register listeners with `autoResume: { prompt, context }` for non-blocking workflows.
- **Recommended pattern**: Launch ONE agent → register with autoResume → respond immediately → system handles continuation.
- Use `await_listener` only for short, bounded waits (<30 seconds) where blocking is acceptable.
