## Common Tasks

The tools most tasks use, all in `core`. Call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, name, notify: true, handback: true, worktreeId? })`, by the built-in id of each agent the user named, without listing first; without `worktreeId` it lands in the user's active worktree. Always pass `name`; the same `agentId` one at a time.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`, one call for many terminals.
- Prompt: `terminal.sendCommand({ terminalId, command })`, one call per terminal.
- Wait: `notify: true, handback: true` on a launch or send, then end your turn. When the agent prints its done marker, Daintree sends you its reply at once, even mid-turn, quoting its screen up to the marker (`replyLines`, default 40). **The reply is always sent: never read a terminal to fetch it**, and don't wait or poll; read one only if its quote is cut off. `terminal.waitUntilIdleBatch` (60s cap) only where `notify` is refused.
- Close: `terminal.close({ terminalId })`. Confirm with the user before closing several terminals.
