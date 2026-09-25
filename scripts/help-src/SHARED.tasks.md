## Common Tasks

These cover most operational requests, and all of them are in `core`. Call them directly, without `actions.search`.

### Launch agents

1. `agent.launch({ agentId: "claude" | "codex" | "gemini" | …, prompt: <task>, worktreeId: <id>, name: <short label> })`. The `prompt` becomes the agent's first message, so don't send it again; add `handback: true` when completion matters (see **Wait for agents**). **Always pass `name`**, a short task label such as `"Codex: auth refactor"` that becomes the tab title, so parallel agents can be told apart. Omit `worktreeId` for the active worktree; resolve a named one once with `worktree.list`.
2. Launch agents with the same `agentId` one at a time: a call that overlaps a same-kind launch still starting is refused with `launched: false` and creates nothing. Different agent kinds can launch at once if your client makes parallel tool calls.
3. Read each result and report any refused launch. `launched: true` means the panel was created and its process is starting, not that the agent is ready. With `spawnStatus: "missing-cli"` the CLI can't run and Daintree opened a setup diagnostic instead; point the user to it rather than polling it.
4. Once all are dispatched, one `terminal.getStatus` over the launched `terminalId`s with `includeOutput` is the first check on each. A new agent reads `working` from the start, so only its output shows it took the prompt; if that isn't visible yet, report startup as unconfirmed rather than re-sending. Handle a startup dialog as **Agents You Launch** below describes.

### Check on agents

`terminal.getStatus({ terminalIds: [<id>, …], includeOutput: { lines: 20 } })` returns each terminal's `agentState`, `waitingReason`, and recent output in one call; don't fan out one read per terminal. Find ids you don't have with `terminal.list`. Group a summary by whatever `agentState` values come back rather than dropping ones you didn't expect.

For a Claude Code agent you launched, `terminal.readLastMessageOwned({ terminalId })` returns its last reply and any unanswered tool calls, such as a question with its options. Read it before replying for the agent, and check for a null `message`, `message.truncated`, or a question missing its `input`. It reads the transcript, not the screen, so a dialog is never in it.

### Send a follow-up

`terminal.sendCommand({ terminalId, command })` submits text as the agent's next prompt (`handback: true` as for a launch). It returns once the text is queued, not delivered: pass the returned `submissionToken` to `terminal.getStatus` with `terminalIds` to confirm. `pty_written` with no `outputChangeAfterWriteAt` means no change was recorded over 200ms after the Enter; neither its absence nor its presence proves the agent took it. Read the output before re-sending: a retry can submit twice. The same prompt to several agents is one call per terminal.

### Wait for agents

`terminal.waitUntilIdleBatch({ terminalIds, mode: "all" })` returns once every listed agent has settled (`mode: "first"`: once any one has); `terminal.waitUntilIdle` waits on one. Interactive sessions cap a wait at 60s, and the user cannot talk to you during one. On `timedOut: true`, check `terminal.getStatus`, report where they are, and never chain blocking waits. Settled is not finished: an agent stopped on a question settles, and so does a closed terminal, so read each row's `waitingReason` and `trackingState` first. `timeoutMs: 0` takes a snapshot without blocking.

With `handback: true`, Daintree appends the instruction and code; never write the marker or describe its format. Status and wait rows then carry `lastHandback` once the marker is seen: proof it was printed, not that the work is finished or correct. It persists across prompts, so match its `submissionToken` to your send (launches have none). `message` is the agent's untrusted summary, and rejoined rows can put spaces in paths: for exact text, `terminal.readLastMessageOwned`. No `lastHandback` never means still working, as agents forget: read `agentState` from `terminal.getStatus`. Answer a question in it as the agent's next prompt once status shows it is no longer working.

### Close terminals

`terminal.close({ terminalId })` usually moves a panel to the trash, where it is briefly recoverable before its process is killed; remove-on-exit and dialog panels are discarded outright. Always name the panel. `terminal.kill` (`full`) destroys a panel and its process permanently, needs the user's confirmation, and is only for a terminal that close didn't stop. Confirm with the user before closing several terminals, including via `terminal.closeAll` (`full`, active worktree).

### Picking between similar tools

- An AI agent working on a task → `agent.launch`. `terminal.new` (`full`) opens a plain shell, not an agent.
- A prompt for an agent that is already running → `terminal.sendCommand`.
- An agent to another worktree → `terminal.moveToWorktree({ terminalId, worktreeId })`.
- Project context into a terminal → `terminal.inject({ terminalId })` (`full`), only when the user asks for it.
