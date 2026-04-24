# Terminal Identity

> **There is only one kind of PTY panel: a terminal.** Agent-ness is a dynamic
> state of a terminal, inferred from what's running inside it right now.

This document defines the identity model. It replaces an earlier three-field
contract (`agentId` / `detectedAgentId` / `capabilityAgentId`) that tried to
distinguish "cold-launched agent" from "shell running an agent" as structurally
different things. They aren't. Both are the same thing: a terminal whose live
process is an agent.

See also: [terminal-lifecycle.md](./terminal-lifecycle.md) for the runtime
status model.

## The rule

Everything UI-facing — icon, title, brand color, hybrid-input bar, fleet
membership, focus routing, state badges, context menus — derives from **one
field**: `detectedAgentId`. When it's set, the terminal is an agent terminal.
When it's cleared, the terminal is a plain shell. Demotion and promotion are
free and instant.

## The two fields

| Field               | Purpose                        | Type             | Writer                          | Persisted |
| ------------------- | ------------------------------ | ---------------- | ------------------------------- | --------- |
| `detectedAgentId`   | live chrome identity           | `BuiltInAgentId` | PTY host process detector (IPC) | no        |
| `everDetectedAgent` | sticky "has ever hosted agent" | `boolean`        | PTY host process detector (IPC) | no        |

Both are transient. Both are authored exclusively by the backend process
detector and pushed through IPC. Neither is persisted — on reconnect/hydrate
the backend replays the current truth.

## The launch hint

`PtyPanelData.launchAgentId` exists but is **not an identity**. It records
which agent command was injected at spawn time. Its only consumers are:

- **Spawn & restart** — knows which command to inject.
- **Session resume** — looks up the agent's resume flags.
- **Persisted agent settings** — model, preset, launch flags are keyed by it.

Chrome never reads `launchAgentId`. Fleet never reads it. Hybrid input never
reads it. Focus routing never reads it. Anyone reading it for UI classification
is a bug.

## The chrome resolver

One helper answers "what does the user see right now?":

```ts
resolveChromeAgentId(panel); // or: (detectedAgentId, launchAgentId?, everDetectedAgent?)
```

Behavior: **`chrome agent id === detectedAgentId`.** That's the only rule.

- If `detectedAgentId` is set → return it. Chrome shows the agent.
- Otherwise → return `undefined`. Chrome is a plain terminal.

`launchAgentId` and `everDetectedAgent` are accepted by the function signature
for call-site compatibility, but they are intentionally **ignored** by the
resolver. Chrome is a pure function of the live process inside the PTY. Nothing
else.

Consequence: during the ~1–2 seconds between a cold-launched spawn and the
first detection commit, chrome reads as a plain terminal. It flips the instant
the detector commits. This is the same code path as typing `claude` into a
plain terminal — there is no spawn-time special case.

Every chrome consumer uses this helper. No consumer reads `launchAgentId` for
display decisions.

## Title ownership

`PtyPanelData.title` has two modes tracked by `titleMode`:

- `"default"` (or absent) — title is derived from `resolveChromeAgentId`:
  `getAgentConfig(chromeId)?.name ?? "Terminal"`. Promotion/demotion freely
  rewrites it.
- `"custom"` — the user renamed the panel. The renderer stores the typed
  title and never overwrites it.

The store listener that syncs `detectedAgentId` is also responsible for
updating `title` when `titleMode === "default"`. Any rename action sets
`titleMode = "custom"` and writes the user's text.

## What got deleted

- `PtyPanelData.capabilityAgentId` — the sealed-at-spawn "is this a full agent
  terminal" flag. Gone. No tiering. Every terminal participates in
  fleet/hybrid-input/focus equally, gated on live `detectedAgentId`.
- `PtyPanelData.type` (legacy `TerminalType`) — the pre-unification "terminal"
  vs "claude"/"gemini"/etc. classifier. Gone. All PTY panels are `kind:
"terminal"`.
- The observational chip / "Restart as agent" CTA — gone. There's nothing to
  promote to; the live agent already has full chrome.
- `terminal.convertType` action — gone. Nothing to convert.
- `isAgentTerminal` discriminator in the PTY spawn path — gone. All terminals
  spawn the same way (interactive shell, generic env).
- The pre-command `printf '\x1b[H\x1b[2J\x1b[3J'` clear-screen preamble (both
  cold-spawn and pool-acquire paths) — gone. No visible escape noise on start.
- `resolveEffectiveAgentId` with its `detectedAgentId ?? agentId` fallback —
  replaced by `resolveChromeAgentId` with the demotion rule above.

## Persistence

`launchAgentId`, `title`, `titleMode`, `command`, `agentLaunchFlags`,
`agentModelId`, `agentPresetId`, `agentPresetColor`, `originalPresetId`,
`agentSessionId` — all persisted. Enough to rebuild the command on restart.

`detectedAgentId`, `everDetectedAgent`, `detectedProcessId`, `agentState`,
`runtimeStatus`, `flowStatus` — all transient. Rehydrated from the backend
reconnect payload.

## The PTY-side name

PTY-internal state (`TerminalPublicState` in `electron/services/pty/types.ts`)
uses `detectedAgentId: BuiltInAgentId | undefined` — same name as the
renderer-facing types. There is no name translation at the IPC boundary.
(Earlier versions had `detectedAgentType: TerminalType` that got narrowed.
Since legacy `type` is retired, the conflation is resolved.)

## Reader guidance

- **Is there an agent running right now?** `detectedAgentId !== undefined`.
- **What agent should the tab show as the icon/title/color?**
  `resolveChromeAgentId(...)`.
- **What command should restart use?** `command` (regenerated from
  `launchAgentId` settings if needed).
- **Which agent's session resume should this restart use?**
  `detectedAgentId ?? launchAgentId`.
- **Should fleet / hybrid-input / focus trust this as an agent?**
  `detectedAgentId !== undefined`. Never `launchAgentId`.

If you find yourself branching on "was this spawn-time or runtime-promoted?",
you're doing the old model. Delete the branch.
