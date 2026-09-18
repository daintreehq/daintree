## Common Tasks

These cover most operational requests, and all of them sit in the default `action` tier. Call them directly: an operation named here needs no `actions.search` or `actions.list` pass first. For anything else, see **Finding the Right Tool** below.

### Launch agents

1. `agent.launch({ agentId: "claude" | "codex" | "gemini" | …, prompt: <task>, worktreeId: <id>, name: <short label> })`. The `prompt` becomes the agent's first message, so don't send it again. **Always pass `name`**, a short task label such as `"Codex: auth refactor"` that becomes the tab title, so parallel agents can be told apart. Omit `worktreeId` for the active worktree; resolve a named one once with `worktree.list`.
2. Launch agents with the same `agentId` one at a time: a call that overlaps a launch of the same kind still starting is refused with `launched: false` and creates nothing. Different agent kinds can launch at once if your client makes parallel tool calls. Either way, don't check status between launches.
3. Read each result. `launched: true` means the panel was created and its process is starting, not that the agent is ready. `launched: false` means this call started no agent. With `spawnStatus: "missing-cli"` the CLI can't run (not installed, or installed but unusable) and Daintree opened a setup diagnostic instead; point the user to it rather than polling it.
4. Once all are dispatched, one `terminal.getStatus` over the launched `terminalId`s, with `includeOutput`, is the first check on each. A new agent reads `working` from the start, so only its output shows it took the prompt; if that isn't visible yet, report startup as unconfirmed rather than sending the prompt again. Handle a startup dialog as **Agents You Launch** below describes.

### Check on agents

`terminal.getStatus({ terminalIds: [<id>, …], includeOutput: { lines: 20 } })` returns each terminal's `agentState`, `waitingReason`, and recent output in one call. Find ids you don't have with `terminal.list`. Prefer terminal ids over `agent.getState` when more than one agent of a kind is running.

### Send a follow-up

`terminal.sendCommand({ terminalId, command })` submits text as the agent's next prompt. It returns once the text is queued, not delivered: pass the returned `submissionToken` to `terminal.getStatus` with `terminalIds` to confirm. After an ambiguous failure, check before re-sending, since a retry can submit twice. The same prompt to several agents is one call per terminal.

### Wait for agents

`terminal.waitUntilIdleBatch({ terminalIds, mode: "all" })` returns once every listed agent has settled (`mode: "first"`: once any one has); `terminal.waitUntilIdle` waits on one. Interactive sessions cap a wait at 60s, and the user cannot talk to you while it is open. `timedOut: true` means the wait ended first: unless the user asked you to see them through, check `terminal.getStatus`, report where they are, and end your turn instead of chaining waits. Settled is not finished: an agent stopped on a question settles, and so does a closed terminal, so read each row's `waitingReason` and `trackingState` before calling it done. `timeoutMs: 0` takes a snapshot without blocking.

### Close terminals

`terminal.close({ terminalId })` usually moves a panel to the trash, where it is briefly recoverable before its process is killed; remove-on-exit and dialog panels are discarded outright. Always name the panel. `terminal.kill` destroys a panel and its process permanently, needs the user's confirmation, and is only for a terminal that close didn't stop. Confirm with the user before `terminal.closeAll` or `terminal.killAll`.

### Picking between similar tools

- An AI agent working on a task → `agent.launch`. `terminal.new` and `agent.terminal` open plain shells, not agents.
- A prompt for an agent that is already running → `terminal.sendCommand`.
- Project context into a terminal → `terminal.inject({ terminalId })`, only when the user asks for it.
