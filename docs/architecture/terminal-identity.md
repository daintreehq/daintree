# Terminal Identity

> **There is one PTY-backed panel shape: an agent-capable terminal.** A plain terminal is the dormant runtime state. An agent terminal is the promoted runtime state, inferred from what is running inside the PTY right now.

This document defines the terminal identity model. It deliberately avoids a separate "agent panel" runtime path. A terminal can run `npm`, then `claude`, then return to the shell, then run `codex`; chrome and agent capability follow the live process each time.

See also: [terminal-lifecycle.md](./terminal-lifecycle.md) for process runtime status, and [agent-activity-monitoring.md](./agent-activity-monitoring.md) for activity state detection.

## The Rule

Terminal chrome and agent capability are derived from live runtime identity, with `launchAgentId` acting as exit-gated agent affinity. `deriveChromeAgentIdentity()` (`src/utils/terminalChrome.ts`) resolves in this order:

1. `detectedAgentId` wins. If it is set, the terminal is currently an agent.
2. Otherwise an agent `runtimeIdentity` wins, unless a strong exit signal has been observed.
3. Otherwise `launchAgentId` wins, again unless a strong exit signal has been observed. This is what keeps restored and toolbar-launched agent terminals branded as agents before the transient detector fields rehydrate.
4. Otherwise `detectedProcessId` (or a process `runtimeIdentity`) wins, showing that process icon without agent capability.
5. Otherwise the terminal is plain shell chrome.

`launchAgentId` is durable agent chrome/activity affinity, not just a spawn/restart hint. Live detection takes precedence when present, but the launch identity carries agent chrome until a **strong exit signal** demotes it back to shell (see Exit-Gated Demotion below). The one carve-out: a sticky-but-cleared legacy record — `everDetectedAgent` true with `launchAgentId` set but no live detection and no `agentState` — is treated as non-agent for runtime purposes (`isDemotedExAgent()` in `src/utils/terminalType.ts`).

## Runtime Identity

Renderer state carries a normalized `runtimeIdentity` alongside the raw detection fields:

```ts
interface TerminalRuntimeIdentity {
  kind: "agent" | "process";
  /** Stable runtime id: agent id for agents, process icon id for processes. */
  id: string;
  /** Icon registry id used by terminal chrome. */
  iconId: string;
  /** Present only when the live process is an agent. */
  agentId?: AgentId;
  /** Present when the detector emitted a process icon id. */
  processId?: string;
}
```

It is a single interface (`shared/types/panel.ts`), not a discriminated union: `kind` distinguishes the two cases by convention, but both `agentId` and `processId` are optional on the type.

`deriveTerminalRuntimeIdentity()` and `deriveTerminalChrome()` are the canonical helpers. Components should consume the derived descriptor, not stitch together `launchAgentId`, `detectedAgentId`, `detectedProcessId`, and sticky flags.

Fresh detection fields take precedence over any existing `runtimeIdentity`. This protects promotion paths like `npm run build -> claude`, where stale process identity must not block agent promotion.

## Exit-Gated Demotion

`launchAgentId` (and an agent `runtimeIdentity`) keep agent chrome alive across the gap between renderer restore and live re-detection. That affinity drops back to shell chrome only on a **strong exit signal**. `hasExplicitAgentExit()` (`src/utils/terminalChrome.ts`) defines it as any of:

- `agentState === "exited"`
- `runtimeStatus === "exited"` or `runtimeStatus === "error"`
- `exitCode` set (any number)

When none of these are present, launch/runtime agent affinity holds and the terminal stays branded. When one fires, `deriveChromeAgentIdentity()` stops falling back to `launchAgentId`/`runtimeIdentity`, chrome reverts to process or shell, and the descriptor's `hasExited` is `true`.

A separate legacy path, `isDemotedExAgent()` (`src/utils/terminalType.ts`), covers the sticky-but-cleared case: `everDetectedAgent` true with a `launchAgentId` but no live detection and no `agentState`. Such records still render the launch identity for visual continuity, but `getRuntimeAgentId()` and `isAgentTerminal()` report non-agent so focus fallback, agent grouping, and agent-targeted actions skip them.

## Live Identity Sources

The live identity fields (`detectedAgentId`, `detectedProcessId`) are produced by two components in the PTY host. **ProcessDetector** is the primary producer — it polls the process tree and merges shell-command evidence from the secondary producer at a single merge point. **IdentityWatcher** is the secondary producer — it captures keystrokes, parses submitted commands, and injects shell-command evidence into ProcessDetector.

For process-tree evidence, ProcessDetector requires consecutive agreeing polls before committing an identity change. This hysteresis guards against one-poll blips from short-lived subprocesses. Shell-sourced evidence fast-commits without hysteresis — it is already debounced by IdentityWatcher. Shell-command evidence injected by IdentityWatcher carries a sticky TTL so that transient `ps` blindness does not demote a committed agent. Evidence-source tags on every detection result distinguish process-tree observations from shell-command observations — the demotion path branches on these tags.

IdentityWatcher waits a short commit window after a command is submitted before injecting evidence: long enough for the process to start, short enough that fast-exit commands have already returned a prompt. On prompt-return (detected via shell prompt patterns, confirmed by consecutive polls), the watcher demotes its own shell-command evidence. A foreground-process-group probe gates this demotion — if the agent child process still owns the terminal foreground, the shell is not truly idle and demotion is held.

**HOLD semantics.** The detection system treats `unknown` (cache error with no children and no shell evidence) and `ambiguous` (both producers identify different agent IDs) as no-op states that do not mutate committed identity. This is a deliberate design choice: uncertain events must not drive state transitions. The consumer can therefore treat `detectedAgentId` as authoritative — the producers have already filtered noise, and uncertainty is silently held rather than driving spurious demotions.

See [terminal-lifecycle.md](./terminal-lifecycle.md) for the broader PTY lifecycle that these producers operate within.

## Fields

| Field | Purpose | Writer | Persisted |
| --- | --- | --- | --- |
| `detectedAgentId` | Live agent identity | PTY detector via IPC | No |
| `detectedProcessId` | Live non-agent process icon | PTY detector via IPC | No |
| `runtimeIdentity` | Normalized live identity descriptor | Renderer IPC listener | No |
| `everDetectedAgent` | Sticky "has hosted an agent" flag for lifecycle preservation | PTY detector via IPC | No |
| `launchAgentId` | Spawn/restart command hint **and** exit-gated agent chrome/activity affinity | Launcher/hydration | Yes |

`deriveTerminalChrome()` returns a `hasExited` flag on the descriptor (`src/utils/terminalChrome.ts`). It is `true` when a strong exit signal was observed during derivation, and is distinct from `!isAgent`: chrome can be non-agent because the agent exited _or_ because no agent identity has committed yet. The agent state inputs (`agentState`, `runtimeStatus`, `exitCode`) feed the exit gate but are documented in [agent-activity-monitoring.md](./agent-activity-monitoring.md).

## Agent-Capable Terminal

Every terminal is wired as if it might become an agent:

- The PTY host starts `ProcessDetector` for every terminal.
- The shell-command watcher can inject typed command evidence for every plain terminal.
- Spawn-time commands are also seeded into the detector, so toolbar-launched `claude` and typed `claude` use the same promotion path.
- Renderer terminal instances always have dormant parser, title, Enter-key, resize, hibernation, and scrollback hooks.
- Those hooks activate based on `runtimeAgentId`, which is updated from live detection and cleared on demotion.

This means a standard terminal is not a different implementation. It is the same terminal with no live agent identity.

## Activity And Fleet

Agent-specific UI is gated by runtime agent identity:

- Activity indicators render only when derived chrome says `isAgent === true`.
- Fleet broadcast membership uses live PTY eligibility, so normal terminals can participate. Agent-specific Fleet actions still use runtime agent identity.
- Worktree sidebar rows use the same derived chrome descriptor and only show agent state when the row is currently an agent.
- Plain process icons such as `npm` never enter the agent state machine.

The backend starts the activity monitor when an agent is detected at runtime. The renderer seeds `agentState: "idle"` on promotion if no state event has arrived yet, so the UI has a stable dormant-to-active transition.

## Launch Hint

`launchAgentId` records which agent command the user asked to launch. It is kept for:

- Command generation and restart.
- Session resume flags.
- Preset/model/settings lookup.
- Command replay after app restart.
- Durable agent chrome/activity affinity until a strong exit signal demotes it.

Live detection (`detectedAgentId`, then an agent `runtimeIdentity`) still takes precedence: while an agent is detected, `launchAgentId` is never what's driving chrome. Its affinity role only fills the gap before detection commits or after detection clears without an exit — see Exit-Gated Demotion. It does not by itself unlock the legacy `isDemotedExAgent()` case, which `getRuntimeAgentId()` and `isAgentTerminal()` treat as non-agent.

## Title Ownership And Composition

A terminal's human-facing title has three layers, resolved at render time — components never concatenate title strings themselves:

- **Identity** (`panel.title`) — "what is this?" The registry name ("Claude"), a preset brand ("Claude [Z.ai]"), a launch `name`, or an automation rename. Persisted.
- **Task** (`lastObservedTitle`) — "what is it doing?" The agent's own OSC 0/2 window title, captured in `TerminalListenerInstaller`, filtered by `isUselessTitle`, glyph-stripped for display by `cleanTaskTitle` (`shared/utils/taskTitle.ts`). Live and always replaceable; cleared when a new agent process is detected so a relaunched or different agent never inherits a stale task.
- **User lock** — a human rename freezes the title entirely.

Ownership is the `titleMode` ladder (`shared/types/panel.ts`): `"default"` (identity derived, detection may rewrite, task composes) < `"custom"` (explicitly named by a preset, launch `name`, or MCP/assistant `terminal.rename`; detection may not rewrite, task still composes) < `"user"` (human rename; nothing rewrites it, composition off, automation renames bounce). `titleMode` persists with the panel snapshot, which is what keeps pinned titles stable across restart (#10738). An empty rename resets to `"default"`.

`getTerminalDisplayTitle(panel, variant)` (`src/utils/terminalTitleDisplay.ts`) is the single render-time source of truth: `"full"` (grid headers, tooltips, palettes) → `"Claude: fix auth tests"`; `"compact"` (~100px tab strips) → task-first, since the tab icon already carries identity; `"base"` (dock) → identity only. Composition is gated on a live detected agent and the `showAgentTaskTitles` preference (default on). Session-history records prefer `lastObservedTitle` on every close path, so resume rows read the same as the live tab did.

**Identity echoes.** Agents set their OSC title to their own product name at startup (Claude Code emits `"Claude Code"`), which naive composition renders as `"Claude: Claude Code"`. An observed title whose every token matches the agent's identity (panel title, registry name, binary) or generic product filler (`code`, `cli`, …), with at least one genuine identity token, is classified as an identity echo, not a task: a `"default"` identity yields to the richer self-description (header shows `"Claude Code"`), while a `"custom"` preset identity (`"Claude [Z.ai]"`) outranks the echo and renders alone. The echo needs at least one identity token that isn't itself filler — a title that is pure filler (`"Ready"`, or `"Code CLI"` under "Qwen Code", whose identity contributes the filler word `code`) is treated as useless. Real tasks that merely contain the agent's name (`"Claude Code refactor plan"`) still compose normally.

## Reader Guidance

- **What icon/color/title should I show?** Use `deriveTerminalChrome(panel)` for chrome; `getTerminalDisplayTitle(panel, variant)` for the title string.
- **Is this terminal currently an agent?** Use `deriveTerminalChrome(panel).isAgent` or `getRuntimeAgentId(panel)`.
- **Should agent activity UI be visible?** Only when runtime chrome is agent.
- **What command should restart use?** Use persisted command/launch hint fields.
- **Should a typed agent in a plain terminal be first-class?** Yes. Runtime detection promotes it through the same path as a toolbar-launched agent.

If code branches on "was this born as an agent terminal?", it is probably using the old model. The runtime question is only "what is running in the PTY now?"
