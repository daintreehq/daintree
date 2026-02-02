# Open Issues Review (Listener System Readiness)

Date: 2026-02-01

## Source

Pulled via `gh issue list --state open` in this repo. 8 open issues found.

## Open Issues (Current)

1. #2091 - Document listener system capabilities in assistant system prompt
2. #2090 - Add listener lifecycle management and cleanup on navigation
3. #2089 - Render listener notifications as system events instead of assistant messages
4. #2088 - Include trigger and confidence in listener event payloads
5. #2087 - Add one-shot listener support with auto-cleanup
6. #2086 - Add pending event queue for reliable listener event delivery
7. #2085 - Bridge core agent lifecycle events to listener system
8. #2084 - Restrict listener event types to actually bridged events

## Do these issues get us “where we need to be”? (Assumption)

Assuming “where we need to be” means: a listener system that reliably supports agent workflows that pause, wait for terminal state, and then continue autonomously.

### What these issues DO cover

- Correct event scope and documentation (#2084, #2091)
- Clearer UI signaling (#2089)
- Better event semantics (#2088)
- Basic listener hygiene (#2087, #2090)
- More event coverage (#2085)
- Delivery reliability (queue) (#2086)

### What is still missing to reach true “wait → resume” autonomy

Even if all 8 issues ship, the system still lacks:

1. Model re-entry or “await” semantics

- There is no tool that blocks and returns when a listener fires.
- There is no auto-resume policy that re-invokes the model on event.

2. Continuation storage

- There is no persisted continuation (plan + prompt + pending tool calls) to resume work after a wait.
- A queue without a continuation only improves delivery, not autonomy.

3. Event routing into the model

- Listener events land as UI messages, not model input.
- Without automatic injection into the next model call, the model can miss events.

4. Idempotency and de-duplication

- No built-in event IDs or ack mechanism; repeated events or retries could confuse workflows.

5. Ownership + scoping rules

- The listener is session-scoped, but there’s no explicit “agent owns this listener” or binding to a terminal lifecycle.
- Edge cases (session reset, app reload, terminal restart) still lack robust recovery semantics.

6. Tooling for follow-up actions

- There’s no built-in pattern for “when waiting, fetch output, classify, then respond.”
- This could be codified as a small orchestration helper or a standardized policy for waiting states.

## Recommendation

Implementing all 8 issues is necessary but not sufficient for autonomous wait/resume. To reach that goal, we need at least one of the following strategies:

A) `await_listener` tool

- Server-side blocking with timeout and cancellation
- Returns event payload directly to the model

B) Auto-resume policy

- When a listener triggers, schedule a new model call with an injected synthetic event message
- Requires continuation storage (plan + context + last tool state)

C) Durable workflow runner

- A task runner that binds listeners to steps and can resume after reloads

## Short Missing-Issues List (Suggested)

- Add `await_listener({ listenerId, timeoutMs })` tool
- Add session event queue with ack + stable event IDs
- Add continuation storage for “wait and resume” workflows
- Add auto-resume policy (opt-in) on listener trigger
- Add prompt/response classifier or standardized “waiting handler” helper

## Bottom Line

Implementing all open issues will make the listener system cleaner, more reliable, and better documented — but it will still be a notification system. To reach autonomous waiting/resume behavior, we need explicit await/continuation mechanics or auto-resume wiring.
