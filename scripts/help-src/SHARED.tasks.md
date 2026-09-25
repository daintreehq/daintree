## Common Tasks

The tools most tasks use, all in `core`. Call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, worktreeId, name })`. Always pass `name` (the tab title); launch the same `agentId` one at a time.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`, one call for many terminals.
- Prompt: `terminal.sendCommand({ terminalId, command })`, one call per terminal.
- Wait: add `notify: true` to a launch or send and end your turn, or `terminal.waitUntilIdleBatch` (60s cap; never chain waits).
- Close: `terminal.close({ terminalId })`. Confirm with the user before closing several terminals.
