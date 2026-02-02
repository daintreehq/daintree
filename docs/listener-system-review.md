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

- `TerminalStateListenerBridge` subscribes to `agent:state-changed`.
- It translates the payload into a "terminal:state-changed" record and asks `ListenerManager` for matches.
- For each match, it emits a `listener_triggered` chunk to the renderer via `CHANNELS.ASSISTANT_CHUNK`.
- `useAssistantStreamProcessor` adds a normal assistant message containing a short notification string.

### 4) What the chat does with listener events

- Listener events do NOT pause or block assistant streaming.
- Listener events are NOT delivered to the model automatically.
- The event is only injected into the UI conversation as a new assistant message.
- The model only "sees" the event if the user sends another message later (since the chat history is sent on the next request).

## Direct Answers to Your Questions

### Q: If an agent created a terminal and listened for waiting, does chat pause or continue?

- It continues. The listener event is asynchronous and is rendered as a separate message. It does not pause streaming or block the assistant.

### Q: Can the agent wait for a response and then continue working later?

- Not automatically. There is no mechanism to "await" a listener and resume the same assistant run.
- The listener only posts a notification to the UI. The model does not resume until a new user message triggers a new request.

### Q: Is there a queue of listener events for later processing?

- No durable queue. Events are emitted immediately and dropped if the session ID does not match the active conversation.
- Listeners are stored in memory; events are not persisted across reloads or crashes.

### Q: Do I foresee it working as-is?

- Yes, for user-facing notifications ("agent is waiting") and manual intervention.
- No, for autonomous "pause -> wait -> resume" workflows without additional automation.

## Gaps / Risks

1. Event type mismatch

- `register_listener` accepts any event type from `ALL_EVENT_TYPES`, but only `terminal:state-changed` is actually bridged.
- Listeners for any other event type will never fire.

2. No auto-resume or model re-entry

- `listener_triggered` is UI-only. The model is not re-invoked automatically.

3. No event queue or ack

- Events are not buffered for later. If the conversation session changes or the renderer is not listening, events are lost.

4. Listener lifecycle leaks

- Listeners persist until explicitly removed or `clearSession()` is called.
- Navigation triggers `assistantService.cancelAll()` but does not clear listeners unless that session has an active stream.

5. Missing context in the notification

- The translated event does not include trigger/confidence or prompt content.
- For "waiting" detection (heuristic), this makes it hard to decide if user input is truly required.

6. UI ordering ambiguity

- A listener notification can arrive while the assistant is still streaming a response.
- The notification is inserted as a normal assistant message, which can look like model output.

7. "terminal:state-changed" exists only for assistant bridging

- The event is defined in `events.ts` but not emitted on the bus. The bridge creates it as an assistant-facing shape only.

## What Needs Updating to Make It Workable for Agent Autonomy

### Short-term fixes (low risk)

1. Restrict or clarify event types

- Option A: Restrict `register_listener` to `terminal:state-changed` only.
- Option B: Add bridges for other event types and document supported filters per event.

2. Add one-shot listeners

- Add `once: true` or `maxMatches: 1` to auto-remove listeners after first trigger.

3. Include richer event context

- Add `trigger`, `confidence`, and possibly a short prompt snippet or "waiting reason" to the payload.

4. Improve UI semantics

- Render listener notifications as "system" or "event" entries instead of normal assistant messages.

### Medium-term (enables real workflows)

5. Add a pending-event queue per session

- Store recent listener events and expose `list_pending_events()` + `ack_event()` tools.
- Deliver events to the assistant on the next request to guarantee it sees them.

6. Add an explicit "await" tool

- Provide `await_listener({ listenerId, timeoutMs })` that blocks server-side and returns when triggered.
- This needs careful timeouts and cancellation to avoid hanging streams.

7. Auto-resume policy

- Add a session flag that allows the app to auto-start a new assistant run when a listener triggers.
- This can inject a short synthetic "event" message to the model and continue a stored plan.

### Long-term (robust orchestration)

8. Event-driven task runner

- Store a "continuation" (plan + prompt) tied to a listener, then dispatch it automatically when triggered.
- Integrate with a durable store so events survive reloads.

9. Revisit waiting detection reliability

- Expose the detection source (prompt vs silence vs pattern) and guardrails for false positives.
- Allow per-agent tuning in `agentRegistry` for prompt patterns and debounce thresholds.

## Bottom Line

- The listener system works today as a notification pipeline for the UI.
- It does not yet support autonomous "wait and resume" behavior.
- To make that workable, we need (1) event delivery guarantees, (2) model re-entry or await semantics, and (3) better context in listener payloads.
