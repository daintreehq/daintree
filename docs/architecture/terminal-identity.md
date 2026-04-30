# Terminal Identity

> **There is one PTY-backed panel shape: an agent-capable terminal.** A plain
> terminal is the dormant runtime state. An agent terminal is the promoted
> runtime state, inferred from what is running inside the PTY right now.

This document defines the terminal identity model. It deliberately avoids a
separate "agent panel" runtime path. A terminal can run `npm`, then `claude`,
then return to the shell, then run `codex`; chrome and agent capability follow
the live process each time.

See also: [terminal-lifecycle.md](./terminal-lifecycle.md) for process
runtime status.

## The Rule

Terminal chrome and agent capability are derived from live runtime identity:

1. `detectedAgentId` wins. If it is set, the terminal is currently an agent.
2. Otherwise `detectedProcessId` wins. If it is set, the terminal shows that
   process icon without agent capability.
3. Otherwise the terminal is plain shell chrome.

`launchAgentId` is never chrome identity. It is only the spawn/restart hint for
the command that was requested.

## Runtime Identity

Renderer state carries a normalized `runtimeIdentity` alongside the raw
detection fields:

```ts
type TerminalRuntimeIdentity =
  | {
      kind: "agent";
      id: string;
      iconId: string;
      agentId: string;
      processId?: string;
    }
  | {
      kind: "process";
      id: string;
      iconId: string;
      processId: string;
    };
```

`deriveTerminalRuntimeIdentity()` and `deriveTerminalChrome()` are the canonical
helpers. Components should consume the derived descriptor, not stitch together
`launchAgentId`, `detectedAgentId`, `detectedProcessId`, and sticky flags.

Fresh detection fields take precedence over any existing `runtimeIdentity`.
This protects promotion paths like `npm run build -> claude`, where stale
process identity must not block agent promotion.

## Fields

| Field               | Purpose                                                      | Writer                | Persisted |
| ------------------- | ------------------------------------------------------------ | --------------------- | --------- |
| `detectedAgentId`   | Live agent identity                                          | PTY detector via IPC  | No        |
| `detectedProcessId` | Live non-agent process icon                                  | PTY detector via IPC  | No        |
| `runtimeIdentity`   | Normalized live identity descriptor                          | Renderer IPC listener | No        |
| `everDetectedAgent` | Sticky "has hosted an agent" flag for lifecycle preservation | PTY detector via IPC  | No        |
| `launchAgentId`     | Spawn/restart command hint                                   | Launcher/hydration    | Yes       |

## Agent-Capable Terminal

Every terminal is wired as if it might become an agent:

- The PTY host starts `ProcessDetector` for every terminal.
- The shell-command watcher can inject typed command evidence for every plain
  terminal.
- Spawn-time commands are also seeded into the detector, so toolbar-launched
  `claude` and typed `claude` use the same promotion path.
- Renderer terminal instances always have dormant parser, title, Enter-key,
  resize, hibernation, and scrollback hooks.
- Those hooks activate based on `runtimeAgentId`, which is updated from live
  detection and cleared on demotion.

This means a standard terminal is not a different implementation. It is the
same terminal with no live agent identity.

## Activity And Fleet

Agent-specific UI is gated by runtime agent identity:

- Activity indicators render only when derived chrome says `isAgent === true`.
- Fleet broadcast membership uses live PTY eligibility, so normal terminals can
  participate. Agent-specific Fleet actions still use runtime agent identity.
- Worktree sidebar rows use the same derived chrome descriptor and only show
  agent state when the row is currently an agent.
- Plain process icons such as `npm` never enter the agent state machine.

The backend starts the activity monitor when an agent is detected at runtime.
The renderer seeds `agentState: "idle"` on promotion if no state event has
arrived yet, so the UI has a stable dormant-to-active transition.

## Launch Hint

`launchAgentId` records which agent command the user asked to launch. It is
kept for:

- Command generation and restart.
- Session resume flags.
- Preset/model/settings lookup.
- Command replay after app restart.

It must not decide chrome, agent-specific fleet actions, status badges,
worktree sidebar agent rows, or activity indicators.

## Reader Guidance

- **What icon/color/title should I show?** Use `deriveTerminalChrome(panel)`.
- **Is this terminal currently an agent?** Use `deriveTerminalChrome(panel).isAgent`
  or `getRuntimeAgentId(panel)`.
- **Should agent activity UI be visible?** Only when runtime chrome is agent.
- **What command should restart use?** Use persisted command/launch hint fields.
- **Should a typed agent in a plain terminal be first-class?** Yes. Runtime
  detection promotes it through the same path as a toolbar-launched agent.

If code branches on "was this born as an agent terminal?", it is probably using
the old model. The runtime question is only "what is running in the PTY now?"
