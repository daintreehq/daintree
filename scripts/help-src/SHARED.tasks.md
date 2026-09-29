## Common Tasks

All in `core`; call them directly, without `actions.search`.

- Launch: `agent.launch({ agentId, prompt, name, notify: true, handback: true, worktreeId? })`, the named agent's built-in id; `worktreeId` defaults to active. Always pass `name`; the same `agentId` one at a time. No task yet: omit `prompt`, `notify` and `handback`. Per launch, no preset: Codex `model: "gpt-6-sol"` (or `gpt-6-astra`, `gpt-6-luna`), `agentLaunchFlags: ["-c", "model_reasoning_effort=high"]` (`low` to `xhigh`). One prompt, several agents: `agent.launchMany({ agentIds, prompt, name, notify: true, handback: true })`; no per-agent model or flags.
- Check: `terminal.getStatus({ terminalIds, includeOutput })`.
- Prompt: `terminal.sendCommand({ terminalId, command })`; one each to several: `terminal.sendCommandMany({ sends: [{ terminalId, command }], notify: true, handback: true })`.
- Replies: for answers due within minutes, `waitForReply: true` on a launch, send or batch returns each reply at its done marker. For longer work pass `notify: true, handback: true` and end your turn; each reply arrives as it prints, even mid-turn. **The reply is always sent: never read a terminal to fetch it**, nor wait or poll; read one only if the quote is cut off. `terminal.waitUntilIdleBatch` only where `notify` is refused.
- Close: `terminal.close({ terminalId })` or `terminal.closeMany({ terminalIds })`. Close only what the user asked to, or yours once reported.
