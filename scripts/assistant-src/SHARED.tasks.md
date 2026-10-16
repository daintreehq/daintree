## Common Tasks

All in `core`; call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, name, notify: true, handback: true, worktreeId?, model?, agentLaunchFlags? })`, the built-in agent id; `worktreeId` defaults to active. Always pass `name`; the same `agentId` one at a time. No task: omit `prompt`, `notify` and `handback`. Per launch, no preset: Codex `model: "gpt-6-sol"` (or `gpt-6-astra`, `gpt-6-luna`), `agentLaunchFlags: ["-c", "model_reasoning_effort=high"]`. Several: `agent.launchMany({ agentIds, ... })`, no per-agent model or flags.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`.
- Prompt: `terminal.sendCommand({ terminalId, command })`; several: `terminal.sendCommandMany({ sends: [{ terminalId, command }], notify: true })`. A slash command or skill takes no `handback` (it'd join the arguments), so one notice per arm: re-arm `terminal.notifyWhenIdle` when it resumes. Its marker or screen shows the end; an earlier stop is no reason to nudge.
- Replies: `waitForReply: true` gets a quick answer; otherwise pass `notify: true` and end your turn. **A notice is fast but can be missed**: each turn, check every agent you await with `terminal.getStatus`; name any still running as you end it. `terminal.waitUntilIdleBatch` only where `notify` is refused.
- Close: `terminal.close({ terminalId })` or `terminal.closeMany({ terminalIds })`. Close only what the user asked to, or yours once reported.
