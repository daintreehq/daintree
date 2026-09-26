## Common Tasks

All in `core`; call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, name, notify: true, handback: true, worktreeId? })`, the named agent's built-in id; no `worktreeId` means the active worktree. Always pass `name`; the same `agentId` one at a time. No task yet: omit `prompt`, `notify` and `handback`. One prompt, several agents: `agent.launchMany({ agentIds, prompt, name, notify: true, handback: true })`.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`.
- Prompt: `terminal.sendCommand({ terminalId, command })`; one each to several: `terminal.sendCommandMany({ sends: [{ terminalId, command }], notify: true, handback: true })`.
- Replies: add `waitForReply: true` to a launch, send or batch for answers due within minutes (a question, a vote): it returns each agent's reply once its done marker prints. For longer work pass `notify: true, handback: true` and end your turn; Daintree sends each reply the moment it prints, even mid-turn. **The reply is always sent: never read a terminal to fetch it**, nor wait or poll; read one only if the quote is cut off. `terminal.waitUntilIdleBatch` only where `notify` is refused.
- Close: `terminal.close({ terminalId })` or `terminal.closeMany({ terminalIds })`. Confirm with the user before closing several terminals.
