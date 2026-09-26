## Common Tasks

The tools most tasks use, all in `core`. Call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, name, notify: true, handback: true, worktreeId? })` by the built-in id of each agent named, without listing; no `worktreeId` means the user's active worktree. Always pass `name`; the same `agentId` one at a time. Several agents, one prompt: `agent.launchMany({ agentIds, prompt, name, notify: true, handback: true })`.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`, one call for many terminals.
- Prompt: `terminal.sendCommand({ terminalId, command })`. A message each to several: `terminal.sendCommandMany({ sends: [{ terminalId, command }], notify: true, handback: true })`.
- Wait: `notify: true, handback: true`, then end your turn. When an agent prints its done marker Daintree sends its reply at once, even mid-turn, quoting its screen (`replyLines`, default 40). **The reply is always sent: never read a terminal to fetch it**, nor wait or poll; read one only if its quote is cut off. `terminal.waitUntilIdleBatch` (60s cap) only where `notify` is refused.
- Close: `terminal.close({ terminalId })`, or several with `terminal.closeMany({ terminalIds })`. Confirm with the user before closing several terminals.
