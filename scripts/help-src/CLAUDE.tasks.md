## Common Tasks

These cover ~90% of what the assistant is asked to do. They all live in the default `action` tier — no escalation required.

### Read what one agent is doing

1. `terminal.list` to find the target terminal (filter by `worktreeId` or focus state).
2. `terminal.getStatus({ terminalIds: [<id>] })` — returns `agentState`, `waitingReason`, `lastTransitionAt`. Add `includeOutput: { lines: 30 }` when you also need scrollback.
3. `agent.getState({ agentId })` is the agent-keyed alternative — useful only when there's a single agent of that kind in the project. With multiple Claude/Codex terminals it's ambiguous; prefer `terminal.getStatus` keyed by terminal ID.

### Snapshot multiple terminals at once

1. `terminal.list` to enumerate the fleet (or filter by `worktreeId`/`location`).
2. `terminal.getStatus({ terminalIds: [<id1>, <id2>, …], includeOutput: { lines: 30 } })` — single round-trip. Returns each terminal's `agentState`, `waitingReason`, `lastTransitionAt`, and recent output.
3. Summarize for the user by state group (`working`, `waiting`, `completed`, `exited`). Don't fan out N `terminal.getOutput` calls — that's N round-trips for what `getStatus` does in one.

### Send a prompt to one running agent

1. `terminal.list` (or remember the `terminalId` from a prior `agent.launch`).
2. `terminal.sendCommand({ terminalId, command: <text> })` — sends the text and presses Enter. The terminal must be PTY-backed and not trashed.
3. Poll `terminal.getStatus` to confirm the agent picked it up before reporting back.

### Broadcast a command to multiple terminals

`terminal.bulkCommand` (the in-app fleet broadcast) is not exposed via MCP. To broadcast over the control plane:

1. `terminal.list` to enumerate target terminals (filter by `worktreeId`, agent kind, or whatever the user asked for).
2. Fan out **parallel** `terminal.sendCommand({ terminalId, command })` calls — one per terminal. Broadcast semantics imply "same prompt, independent terminals," and serializing makes the user wait for no reason. Sequential only when the user asks for ordering or commands depend on each other. If a `sendCommand` call errors, check `terminal.getStatus` for that terminal before re-sending — a retry after an ambiguous failure can double-submit the prompt.
3. Confirm with one batch `terminal.getStatus({ terminalIds, includeOutput: { lines: 20 } })` so you can report which terminals picked up the prompt.

### Report on the user's fleet broadcast run

When the user broadcasts from the in-app fleet UI, Daintree supervises the run past submission. `fleet.getRunStatus` (no args, read-only) returns it in one call: run `status` (`submitting` / `watching` / `completed` / `cancelled` / `failed` / `superseded`), aggregate counts, and per-target entries — submission outcome (`sent`, `failed` with `permanent` vs `transient` classification, `skipped` on cancel), a live `agentState` snapshot, and `settled` flags (`waiting` counts as settled: the agent stopped for the user). Use it to answer "how's the fleet run going" instead of reconstructing the picture from raw `terminal.getStatus`; drop to `terminal.getStatus({ includeOutput })` when you need ground truth on one terminal before acting. It never dispatches anything, and it reports the run of the window that handles the call.

### Spawn an agent on a task

1. `agent.launch({ agentId: "claude" | "codex" | "gemini" | …, prompt: <task>, worktreeId: <id>, name: <short label> })` — single round-trip per agent. The `prompt` field becomes the agent's first message; you don't need to send it separately. **Always pass `name`** — a short task-descriptive label (e.g. `"Claude: auth refactor"`) that becomes the terminal tab title so the user can tell parallel agents apart at a glance. The name is pinned, so agent detection won't overwrite it. Each call returns a `terminalId` you can map back to the prompt you sent.
2. **Fan out in parallel batches of up to 4.** For N agents, fire up to 4 `agent.launch` calls in parallel within a single message. The Claude Code harness executes multi-tool turns concurrently, so the calls land at the backend together. For N > 4, chunk into multiple messages of ≤ 4 so the user sees natural progress between batches. Do **not** insert `terminal.getStatus` round-trips between launches — that's the slow loop we're avoiding.
3. Once every batch is dispatched, do **one** `terminal.getStatus({ terminalIds: [<all ids>], includeOutput: { lines: 20 } })` to confirm each terminal picked up its prompt, then report a state summary grouped by `working` / `waiting` / `completed` / `exited`. Sequential one-at-a-time pacing is only appropriate when the user explicitly asks for it.

### Close terminals

- `terminal.close({ terminalId })` — graceful shutdown. The agent gets a chance to clean up. Default choice.
- `terminal.kill({ terminalId })` — for stuck terminals where graceful close hangs. Use after `terminal.close` has failed or the terminal is unresponsive.
- `terminal.closeAll` / `terminal.killAll` — close every terminal in scope. **Always confirm with the user before bulk close** — these are not undoable.
- To close a subset, fan out parallel `terminal.close({ terminalId })` calls just like broadcast.

## When to Use Which

Action tier exposes several spawn/send tools that look similar. Pick by what you need:

- **Spawn an AI agent with a task** → `agent.launch` (single round-trip, takes `prompt` and a `name` for the tab title). Use for "run /research on X", "have Claude work on issue #123", etc. Always set `name` to a short task label so parallel agents are distinguishable.
- **Spawn a plain shell** → `terminal.new` or `agent.terminal` (aliases — both spawn a non-agent shell). Use only when the user wants a raw terminal, not an agent.
- **Send a prompt to a running agent** → `terminal.sendCommand` (raw text + Enter). Use for follow-ups.
- **Inject project context into the focused terminal** → `terminal.inject` (no args; dumps the project's prepared CopyTree context). Use only when the user explicitly asks to inject context — not a general-purpose prompt sender.
- **Inject context into a specific terminal** → `copyTree.injectToTerminal({ terminalId })`. Same as above, targeted.

If the right tool isn't in this list, you probably need a higher tier — explain that to the user rather than improvising.

For sustained monitoring loops over many agents (stuck-state detection, `ScheduleWakeup` pacing across rounds), see the **Watching Multiple Agent Terminals** section below.
