---
paths:
  - "shared/config/agents/**"
  - "shared/config/agentRegistry.ts"
  - "shared/utils/agentFsm.ts"
  - "electron/services/pty/**"
  - "electron/services/Agent*.ts"
  - "electron/services/canopy/**"
  - "electron/services/pluginAgentMcp/**"
  - "docs/plugins/agent-extensions.md"
  - "shared/types/agent*.ts"
  - "shared/utils/canopy*.ts"
  - "electron/pty-host/**"
  - "src/hooks/useAgentLauncher.ts"
  - "src/utils/agent*.ts"
  - "src/utils/terminalAgentDisplayState.ts"
  - "src/components/Terminal/**"
  - "src/components/Canopy/**"
---

# Agent integration

## Never modify user-owned agent config

`~/.claude/`, `~/.gemini/`, `~/.codex/`, user hooks, and CLAUDE.md/AGENTS.md files in the user's own projects are off limits — not even additive CLI injection like `--settings`. If a capability needs it, the capability is out of scope; use passive observation instead (output parsing, OSC titles, process tree, `AgentPatternDetector`-style regex). Precedent #4100.

Two sanctioned exceptions:

- A **display-only** launch switch declared as a registry capability with a user-facing setting (`inlineModeFlag`/`altScreenFlag`, `decorations`).
- Handing an agent Daintree's **own** MCP servers beside the user's through `capabilities.launchMcp` — additive only, nothing written into the repo or the agent's config dir (`docs/plugins/agent-extensions.md`, "Reaching an agent").

## Observed state

Agent state comes from passive PTY output heuristics (`AgentStateService`, FSM in `shared/utils/agentFsm.ts`) and is frequently wrong. `running` is a runtime status, not an agent state. The one exception to "observations, not interpretations" is Canopy, the opt-in local-model reader, which may suggest an attention bucket beside the observed state but never replace it (`docs/architecture/agent-state-tracking-strategy.md`, "Canopy").
