# Terminal Identity

This document defines the canonical identity model for terminals. It establishes three distinct identity concepts — launch intent, live detection, and capability mode — that were previously conflated across `agentId`, `detectedAgentId`, `everDetectedAgent`, and legacy `type` fields, and documents which field carries which concept across the renderer, main, IPC, and PTY host layers.

See also: [terminal-lifecycle.md](./terminal-lifecycle.md) for the runtime status model.

## Why this exists

Before this model, consumers picked inconsistent subsets of the identity fields:

- `TerminalPane` derived an `effectiveAgentId` from `agentId || type` while ignoring `detectedAgentId`.
- `AgentTrayButton` filtered by `agentId` only, making runtime-detected agents invisible.
- `TerminalProcess.handleAgentDetection()` forced `agentId` to the detected identity so that `AgentStateService` — which routes state events by `agentId` — could see the live process. This write blurred the line between launch intent and live detection.

The fix is a canonical field contract, not a rename: `agentId` stays `agentId`, but its semantic scope is formally narrowed to _launch intent_, and two additional concepts get named slots.

## Three identity concepts

1. **Launch intent** — the agent identity this terminal was spawned as, if any. Sealed at spawn. Drives environment shaping, non-interactive shell configuration, PTY pool selection, scrollback sizing, graceful shutdown, and restart semantics. Persisted so crash recovery respawns the terminal as the same agent.

2. **Live detected identity** — the agent currently running in this PTY as identified by the backend process detector. Volatile UI signal for icon, badge, activity headline, and live state events. Cleared when the detected agent exits. Not persisted; rehydrated from the reconnect payload.

3. **Capability mode** — the agent capability surface this terminal is allowed to participate in (fleet membership, orchestration, hybrid input). Fleet broadcasts through the hybrid-input surface, not by treating every live PTY as a peer terminal. For terminals whose launch intent is a built-in agent, capability is expected to follow launch intent; for plain terminals or terminals spawned with a plugin-provided (non-built-in) `agentId`, capability remains `undefined` by type construction. Derived at read time; not persisted; reserved for future consumers. No production writer exists yet, and the IPC transport pathway (`PtyHostTerminalInfo`, the four snapshot mappers in `electron/ipc/handlers/terminal/snapshots.ts`, and the reconnect builder in `electron/pty-host.ts`) does not yet carry the field either — the type slots on renderer-facing types establish the contract so a future implementer lands writer + transport in one pass without churning the IPC contract again.

## Field mapping

| Field               | Surface                                                                                                                                                                                                                                     | Concept                         | Type             | Writer(s)                                                                         | Persisted | Cleared on                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------- | --------------------------------------------------------------------------------- | --------- | --------------------------------------- |
| `agentId`           | `PtyPanelData`, `TerminalInstance`, `TerminalPublicState`, `TerminalSpawnOptions`, `TerminalState`, `BackendTerminalInfo`, `TerminalReconnectResult`, `TerminalInfoPayload`, `TerminalSnapshot`, `PtyHostTerminalSnapshot`, `PanelSnapshot` | launch intent                   | `AgentId`        | spawn handler; `handleAgentDetection()` bridge write (known violation, see below) | yes       | never (until issue closes bridge write) |
| `detectedAgentId`   | `PtyPanelData`, `TerminalInstance`, `BackendTerminalInfo`, `TerminalReconnectResult`, `TerminalInfoPayload`                                                                                                                                 | live detection                  | `BuiltInAgentId` | backend process detector via IPC snapshot                                         | no        | detected agent exit                     |
| `detectedAgentType` | `TerminalPublicState`, `TerminalInfoPayload`                                                                                                                                                                                                | live detection (internal alias) | `TerminalType`   | `TerminalProcess.handleAgentDetection()`                                          | no        | detected agent exit                     |
| `capabilityAgentId` | `PtyPanelData`, `TerminalInstance`, `TerminalPublicState`, `TerminalSpawnOptions`, `BackendTerminalInfo`, `TerminalReconnectResult`                                                                                                         | capability mode                 | `BuiltInAgentId` | none yet (reserved)                                                               | no        | —                                       |
| `everDetectedAgent` | `PtyPanelData`, `TerminalInstance`, `TerminalPublicState`, `BackendTerminalInfo`, `TerminalReconnectResult`, `TerminalInfoPayload`                                                                                                          | sticky live-session flag        | `boolean`        | `TerminalProcess.handleAgentDetection()`                                          | no        | never within session                    |
| `type`              | `PtyPanelData`, `TerminalInstance`, `TerminalPublicState`, `TerminalSpawnOptions`, `TerminalState`, `BackendTerminalInfo`, `TerminalReconnectResult`, `TerminalInfoPayload`, `TerminalSnapshot`, `PtyHostTerminalSnapshot`, `PanelSnapshot` | legacy conflation               | `TerminalType`   | spawn handler, `handleAgentDetection()`                                           | yes       | — (deprecated; do not use for new code) |

## Internal name translation

`TerminalPublicState` (inside `electron/services/pty/types.ts`) uses `detectedAgentType?: TerminalType` for the live-detection concept. IPC-facing types (`BackendTerminalInfo`, `TerminalReconnectResult`, `PtyPanelData`) use `detectedAgentId?: BuiltInAgentId`. The translation happens at the IPC boundary in `electron/pty-host.ts` via `narrowDetectedAgentId()`, which narrows the wider `TerminalType` (`"terminal" | BuiltInAgentId`) to the concrete `BuiltInAgentId` when a real agent is detected.

Both names refer to the same concept. New renderer-side code should read `detectedAgentId`. PTY-side code that already uses `detectedAgentType` can keep the name; a future issue may unify them.

## Known violations

- `electron/services/pty/TerminalProcess.ts` — `handleAgentDetection()` writes `terminal.agentId = result.agentType` on runtime detection (and clears it on agent exit). This violates the "launch intent is sealed" rule. The `AgentStateService.updateAgentState` path already accepts `detectedAgentType` as a fallback (`terminal.agentId ?? terminal.detectedAgentType`, per issue #5773), but two sibling emitters — `emitAgentCompleted` and `emitAgentKilled` — still gate strictly on `terminal.agentId`, and several renderer consumers (`AgentTrayButton`, `TerminalPane.effectiveAgentId`) read `agentId` directly with no fallback. Until those paths accept `detectedAgentId` as an alternate routing key, runtime-promoted plain terminals need `agentId` bridged so completion/kill events reach the renderer and so tray aggregation sees the live agent. A follow-on issue will remove the bridge write by closing those remaining dependencies.
- `electron/pty-host.ts` — `narrowDetectedAgentId()` performs the `detectedAgentType` → `detectedAgentId` translation. This is expected; it is a layer boundary, not a violation.

## Persistence semantics

- `agentId` is persisted in `TerminalState` so crash recovery can respawn the terminal as the same agent.
- `detectedAgentId` is **not** persisted; it is rehydrated from the backend reconnect payload after a renderer reconnects to a live PTY.
- `everDetectedAgent` is **not** persisted; same rehydration path as `detectedAgentId`.
- `capabilityAgentId` is **not** persisted; it is a read-time derivation reserved for future consumers.
- Legacy `type` is persisted in `TerminalState`. Do not use for new identity decisions.

## Diagnostics

`TerminalInfoPayload` — the diagnostics dialog payload consumed by `TerminalInfoDialog.tsx` — intentionally omits `capabilityAgentId`. The dialog displays `agentId` and `detectedAgentId` separately, and adding a third identity field with no runtime writer would confuse the display. `capabilityAgentId` will be added to the diagnostics payload when a runtime writer exists.

## Reader guidance

- Use `agentId` when asking: _"was this terminal spawned as an agent, and if so which one?"_ This is the right field for persistence, hydration, and spawn-sealed behavior.
- Use `detectedAgentId` when asking: _"is there an agent running right now?"_ This is the right field for icons, badges, activity headlines, and live state events.
- Use `capabilityAgentId` (when consumers start populating it) when asking: _"what agent-capability features is this terminal allowed to use?"_ This is the right field for fleet membership, orchestration gating, and hybrid input.
- Do **not** use legacy `type` for new identity decisions. It is retained only for compatibility with persisted state and the `TerminalPane` legacy read.
