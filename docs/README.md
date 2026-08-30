# Daintree documentation

Human-facing reference for the Daintree IDE's internals. This is the entry point for `docs/`.

The agent-facing working contract is the root [`CLAUDE.md`](../CLAUDE.md) plus the path-scoped rules in `.claude/rules/`, which load when an agent touches matching files — the day-to-day design rules (accent restraint, motion timing, destructive-action tiers, notify() usage) live in `.claude/rules/design-system.md` and `.claude/rules/user-signals.md`. `docs/` is the long-form reference a human reads. Where an agent rule carries an abbreviated ladder, the matching `docs/` file owns the full rationale and the per-item audit — when the two drift, the code wins and the agent rule should be corrected.

## Start here

New contributor reading order:

1. [vision.md](./vision.md) — what Daintree is and the workflow it serves.
2. [development.md](./development.md) — commands, IPC pattern, debugging, the two-box on-ramp.
3. [architecture/process-and-window-model.md](./architecture/process-and-window-model.md) — the real multi-process topology behind that on-ramp.
4. [architecture/state-management.md](./architecture/state-management.md) — how the renderer's ~110 stores fit together.
5. [architecture/action-system.md](./architecture/action-system.md) — the central dispatch layer most features touch.

From there, follow the architecture doc nearest the surface you're changing. Each doc cross-links its neighbours.

## Getting started

| Doc | Purpose |
| --- | --- |
| [development.md](./development.md) | Commands, IPC pattern, debugging, compiler-bailout tooling — the practical on-ramp. |
| [keyboard-shortcuts.md](./keyboard-shortcuts.md) | Default keyboard shortcuts (generated — `npm run codegen:keybindings`). |
| [vision.md](./vision.md) | What Daintree is, the agent-orchestration workflow, and where it sits. |
| [feature-curation.md](./feature-curation.md) | What Daintree is and isn't — the rubric for deciding what not to build. |

## Architecture

| Doc | Purpose |
| --- | --- |
| [process-and-window-model.md](./architecture/process-and-window-model.md) | Multi-process topology, IPC transports, multi-window isolation. |
| [state-management.md](./architecture/state-management.md) | The renderer store layer — two store flavors, panel listeners, persistence. |
| [store-init-order.md](./architecture/store-init-order.md) | Cross-store accessor module and the ESM init ordering that avoids TDZ cycles. |
| [ipc-services.md](./architecture/ipc-services.md) | The backend/bridge surface — services, IPC handlers, `window.electron` namespaces, clients. |
| [action-system.md](./architecture/action-system.md) | Central typed dispatch for menus, keybindings, context menus, and agent automation. |
| [mcp-server.md](./architecture/mcp-server.md) | The local MCP HTTP server that lets agents drive the IDE via built-in actions — including how to connect an external client. |
| [mcp-context-condensation.md](./architecture/mcp-context-condensation.md) | Authoring standard and CI budgets for the prose and schemas the MCP surface sends a model every turn. |
| [assistant-native-host.md](./architecture/assistant-native-host.md) | The structured `utilityProcess` boundary for the Daintree Assistant runtime — contract defined, runtime deferred. |
| [notification-system.md](./architecture/notification-system.md) | How a runtime signal reaches the user — the five-surface taxonomy and routing machinery. |
| [destructive-action-safeguards.md](./architecture/destructive-action-safeguards.md) | Living per-action audit and rubric for destructive UI surfaces. |
| [dev-preview-event-routing.md](./architecture/dev-preview-event-routing.md) | Per-event routing audit for dev-preview lifecycle signals. |
| [terminal-identity.md](./architecture/terminal-identity.md) | The single PTY-backed panel shape — plain vs agent terminal as runtime states. |
| [terminal-lifecycle.md](./architecture/terminal-lifecycle.md) | Runtime lifecycle status for terminals across renderer, main, and PTY host. |
| [pty-host-fabric.md](./architecture/pty-host-fabric.md) | Per-project PTY host shards behind `DAINTREE_PTY_FABRIC` — placement, port routing, crash isolation, idle retirement. |
| [terminal-paint-fabric.md](./architecture/terminal-paint-fabric.md) | The paint-plane fabric: sharding terminal parse/paint across render surfaces behind the compositor seam. |
| [agent-activity-monitoring.md](./architecture/agent-activity-monitoring.md) | How a live agent terminal is judged working / waiting / completed / exited. |
| [agent-state-tracking-strategy.md](./architecture/agent-state-tracking-strategy.md) | Why activity is tracked via passive PTY observation, and the rubric for new proposals. |
| [resource-governance.md](./architecture/resource-governance.md) | Adaptive profiles, memory pressure, view eviction, and PTY hibernation. |
| [fatal-error-spine.md](./architecture/fatal-error-spine.md) | The on-exit marker contract (`running.lock`) and the synchronous fatal-error path. |
| [crash-recovery-and-safe-mode.md](./architecture/crash-recovery-and-safe-mode.md) | Detecting a dead/wedged session, safe mode, crash-loop backoff, host-failure handling. |
| [persistence-and-migrations.md](./architecture/persistence-and-migrations.md) | Where local state lives across the two store engines, and how each migrates. |
| [forge-provider-abstraction.md](./architecture/forge-provider-abstraction.md) | The forge (GitHub/GitLab/…) plugin contract and GitHub rehomed as the first plugin. |

## Plugins

| Doc | Purpose |
| --- | --- |
| [plugins/README.md](./plugins/README.md) | Sub-index for the plugin system — start here for everything plugin-author-facing. |

The plugin sub-index links onward to getting-started, manifest reference, contribution points, host API, agent extensions, distribution, the dev loop, trust model, architecture, and the [1.0 freeze plan](./plugins/freeze-plan.md) (the roadmap to a stable, freezeable plugin API).

## Themes

| Doc | Purpose |
| --- | --- |
| [themes/theme-system.md](./themes/theme-system.md) | The three-layer pipeline: palette → semantic tokens → component vars. |
| [themes/theme-tokens.md](./themes/theme-tokens.md) | Complete semantic token reference; every theme must provide all tokens. |
| [themes/visual-guide.md](./themes/visual-guide.md) | Maps tokens to what the user sees, surface by surface — evaluate themes without running the app. |
| [themes/interaction-state-recipes.md](./themes/interaction-state-recipes.md) | Canonical Tailwind class strings per interactive component role. |
| [themes/component-contract.md](./themes/component-contract.md) | Which primitive, which colour vocabulary, which scale — and the rules enforcing each. |
| [themes/status-success-policy.md](./themes/status-success-policy.md) | When green is allowed to stand, when it goes neutral, and the occurrence-level guard holding the line. |

## Distribution

| Doc | Purpose |
| --- | --- |
| [release.md](./release.md) | Release and code-signing — the three per-OS workflows and release-notes format. |
| [distribution/asar-integrity.md](./distribution/asar-integrity.md) | Embedded ASAR integrity validation (macOS / Windows) via the electron-builder fuse. |
| [distribution/microsoft-store.md](./distribution/microsoft-store.md) | Microsoft Store `.appx` build, certification, and the parallel NSIS path. |

## Testing

| Doc | Purpose |
| --- | --- |
| [e2e-testing.md](./e2e-testing.md) | Playwright E2E setup, buckets, and how to run a single spec. |
| [activity-testing.md](./activity-testing.md) | Manual verification process for agent activity (working/waiting) accuracy. |

## Brand & vision

| Doc | Purpose |
| --- | --- |
| [brand/digital-ecology.md](./brand/digital-ecology.md) | The "digital ecology" brand metaphor that guides illustration and icon choices. |
| [sound-design.md](./sound-design.md) | How notification earcons are procedurally synthesized, and how to add new ones. |
| [voice-input.md](./voice-input.md) | The voice dictation / streaming transcription pipeline across both processes. |
| [assistant-custom-commands.md](./assistant-custom-commands.md) | User-authored commands/skills for assistant sessions — source folders, per-agent mapping, sync mechanics. |

## Companion pairs

Some topics split a human "how to verify / why" doc from an "how it's built" doc. Read both:

- [activity-testing.md](./activity-testing.md) ↔ [architecture/agent-activity-monitoring.md](./architecture/agent-activity-monitoring.md) — manual verification vs. the detection architecture.
- [architecture/agent-activity-monitoring.md](./architecture/agent-activity-monitoring.md) ↔ [architecture/agent-state-tracking-strategy.md](./architecture/agent-state-tracking-strategy.md) — the implementation vs. the strategy and rejected alternatives.
- [architecture/fatal-error-spine.md](./architecture/fatal-error-spine.md) ↔ [architecture/crash-recovery-and-safe-mode.md](./architecture/crash-recovery-and-safe-mode.md) — the on-exit marker contract vs. the runtime recovery/liveness subsystem.
- [architecture/state-management.md](./architecture/state-management.md) ↔ [architecture/store-init-order.md](./architecture/store-init-order.md) — the store layer vs. the cross-store init ordering.
- [voice-input.md](./voice-input.md) ↔ [architecture/ipc-services.md](./architecture/ipc-services.md) — the feature flow vs. the IPC layer it rides on.
