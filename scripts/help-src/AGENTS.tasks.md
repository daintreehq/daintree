## Common Tasks

These cover most operational requests, and all of them sit in the default `action` tier. Call them directly: an operation named here needs no `actions.search` or `actions.list` pass first. For anything else, see **Finding the Right Tool** below.

### Launch agents

1. `agent.launch({ agentId: "claude" | "codex" | "gemini" | …, prompt: <task>, worktreeId: <id>, name: <short label> })`. The `prompt` becomes the agent's first message, so don't send it again. **Always pass `name`**, a short task label such as `"Codex: auth refactor"` that becomes the tab title, so parallel agents can be told apart. Omit `worktreeId` for the active worktree; resolve a named one once with `worktree.list`.
2. For several agents, issue up to 4 launches at once if your client makes parallel tool calls, otherwise back to back, with no status check in between.
3. Read each result. `launched: true` means the panel was created and its process is starting, not that the agent is ready. `launched: false` means no agent is running; with `spawnStatus: "missing-cli"` Daintree opened a setup diagnostic instead, so tell the user to install that CLI rather than polling it.
4. Once all are dispatched, one `terminal.getStatus` over the launched `terminalId`s, with `includeOutput`, confirms each picked up its prompt. Handle a startup dialog as **Agents You Launch** below describes.

### Check on agents

`terminal.getStatus({ terminalIds: [<id>, …], includeOutput: { lines: 20 } })` returns each terminal's `agentState`, `waitingReason`, and recent output in one call. Find ids you don't have with `terminal.list`. Prefer terminal ids over `agent.getState` when more than one agent of a kind is running.

### Send a follow-up

`terminal.sendCommand({ terminalId, command })` submits text as the agent's next prompt. It returns once the text is queued, not delivered: pass the returned `submissionToken` to `terminal.getStatus` with `terminalIds` to confirm. After an ambiguous failure, check before re-sending, since a retry can submit twice. The same prompt to several agents is one call per terminal.

### Wait for agents

`terminal.waitUntilIdleBatch({ terminalIds, mode: "all" })` returns once every listed agent stops working (`mode: "first"`: once any one does); `terminal.waitUntilIdle` waits on one. Interactive sessions cap a wait at 60s, and the user cannot talk to you while it is open. `timedOut: true` means still working: unless the user asked you to see them through, report where they are and end your turn instead of chaining waits. A closed terminal settles too, so read `trackingState` before calling one finished. `timeoutMs: 0` takes a snapshot without blocking.

### Close terminals

`terminal.close({ terminalId })` moves a panel to the trash, where it is briefly recoverable; always name the panel. `terminal.kill` destroys a panel and its process permanently, needs the user's confirmation, and is only for a terminal that close didn't stop. Confirm with the user before `terminal.closeAll` or `terminal.killAll`.

### Picking between similar tools

- An AI agent working on a task → `agent.launch`. `terminal.new` and `agent.terminal` open plain shells, not agents.
- A prompt for an agent that is already running → `terminal.sendCommand`.
- Project context into a terminal → `terminal.inject({ terminalId })`, only when the user asks for it.
