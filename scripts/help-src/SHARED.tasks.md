## Common Tasks

The tools most tasks use, all in `core`. Call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, worktreeId, name, notify: true, handback: true })`. Always pass `name` (the tab title); launch the same `agentId` one at a time.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`, one call for many terminals.
- Prompt: `terminal.sendCommand({ terminalId, command })`, one call per terminal.
- Wait: `notify: true` on a launch or send, then end your turn. The notice quotes each agent's last screen lines (`replyLines`, default 40; with `handback` it ends at the marker), which is usually its whole reply, so don't read it again, wait or poll as well. `terminal.waitUntilIdleBatch` (60s cap) only where `notify` is refused.
- Close: `terminal.close({ terminalId })`. Confirm with the user before closing several terminals.
