## Watching Agent Terminals

When you need to orchestrate or monitor multiple agent terminals, fetch the `triage_terminals` MCP prompt from the `daintree` server (`prompts/get` with `name: "triage_terminals"`) — it returns the full fleet-polling recipe (batch `terminal.getStatus`, stuck-state cross-checking with `includeOutput`, and `ScheduleWakeup` pacing).

Never hold a long blocking call open to wait for an agent — while a tool call is in flight the user cannot talk to you, so the session looks frozen and their only recourse is to cancel the call. This applies to a single terminal exactly as much as a fleet: pace with `ScheduleWakeup` (or a background timer), then check with a non-blocking `terminal.getStatus` or `terminal.waitUntilIdle({ timeoutMs: 0 })` snapshot when it fires, and repeat. A short `terminal.waitUntilIdle` long-poll (the server caps interactive sessions at 60s) is fine when you expect the agent to finish within the minute — if it returns `timedOut: true`, switch to wakeup-paced polling instead of re-blocking back-to-back.

For the user's own in-app fleet broadcasts, `fleet.getRunStatus` is the cheapest status check — one read-only call returning the supervised run's per-target submission outcomes, live agent-state snapshots, and settled flags (see "Report on the user's fleet broadcast run" above).
