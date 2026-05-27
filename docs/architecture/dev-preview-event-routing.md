# Dev Preview Event Routing

Canonical routing table for every user-visible dev-preview lifecycle event. Seven open PRs (#9090, #9091, #9093, #9094, #9097, #9101, #9102) each introduce one or more lifecycle signals; this document is the single source of truth so downstream call sites don't re-derive notification policy and reviewers have a fixed reference to check against. Precedent rows (#8274/#8275, #9088) are included for consistency with already-decided routing.

CLAUDE.md carries the abbreviated Runtime Signals tier ladder; this file is the per-event audit and the rationale traceable to the `notify()` four-question gate.

## Runtime Signal Tiers

Five tiers, calibrated to **actionability × observability**. The boundary between tiers is whether the user can take a different action than they would by ignoring the signal.

| Tier | Surface | User action | Recovery |
| --- | --- | --- | --- |
| **T0** | Silent log | None. The UI state change is the receipt. | n/a |
| **T1** | Ambient indicator (`panel-state-*` border, toolbar pip, frame state) | Aware but passive. No immediate action. | Inbox for durable cross-session cues; frame state for live signals. |
| **T2** | Inline warning banner | Optional recovery in the same pane. Warning, not failure. | Banner carries the action (Cancel, Retry, Open in Browser). |
| **T3** | Inline error banner | Required. Pane-local failure with explicit recovery context. | Retry, Restart, Open External, or adjust config. |
| **T4** | Global banner (host-crash) | Required. Multi-pane or host-level failure. | Host restart or factory reset. |

Tier 4 is never appropriate for pane-local dev-preview failures. When the global host-crash banner is active (`backendStatus !== "connected"`), per-pane duplicate error banners with no distinct recovery path are suppressed. The `panel-state-*` border classes are the canonical Tier 1 surface: `panel-state-working` (35% opacity, active), `panel-state-waiting` (75%, agent waiting), `panel-state-hibernated` (60%, passive). None animate, per WCAG COGA.

## Event Routing Table

Columns:

- **Event** — the lifecycle transition or signal
- **Issue** — the PR or issue introducing it; `NEW` = planned, not yet assigned
- **Tier** — from the ladder above
- **Surface** — the concrete delivery mechanism in the UI
- **Rationale** — why this tier and surface, traceable to the four-question gate

| Event | Issue | Tier | Surface | Rationale |
| --- | --- | --- | --- | --- |
| Port allocated (normal start) | [#9090](https://github.com/daintreehq/daintree/issues/9090) | T0 | Silent log | User invoked Start; the running indicator IS the receipt. The four-question gate fails on visibility: the success is already self-evident in the panel chrome. |
| Port allocated (persisted port collided, new one picked) | [#9090](https://github.com/daintreehq/daintree/issues/9090) | T1 | Frame pip + tooltip | Cookies and localStorage were lost on the partition swap. User can't act on it but should know. A toast would interrupt without recovery value; the pip is ambient and inspectable on hover. |
| Port-conflict (persistent port unavailable) | [#9090](https://github.com/daintreehq/daintree/issues/9090) | T2 | Inline banner | Pane-local failure with explicit recovery context: the user can free the port, choose a different one, or wait. The banner carries the conflicting port number and the retry surface. |
| Session restored from relaunch (`restored-stopped`) | [#9094](https://github.com/daintreehq/daintree/issues/9094) | T1 | Frame state + inbox | Panel chrome IS the receipt on launch (the stopped state is visible). Inbox carries the durable cue when multiple sessions restore across worktrees so the user sees the full set without scanning every panel. |
| Idle-stop imminent (countdown) | NEW | T2 | Inline banner with Cancel | Tied to a recovery action (Cancel). The countdown creates a time-limited decision; the banner is the only surface that can carry the Cancel button inline with the warning text. |
| Idle-stop executed | NEW | T1 | Frame state + inbox | Same shape as `restored-stopped`: the panel state IS the receipt. Inbox makes the stop discoverable if the user was away. |
| Restart-vocab transition | [#8274](https://github.com/daintreehq/daintree/issues/8274) / [#8275](https://github.com/daintreehq/daintree/issues/8275) | T1 | Frame `panel-state-*` border | Already ambient and wired. The border change from `working` to a transient state is the signal; no additional surface needed. |
| Crash-loop guard trip | [#9093](https://github.com/daintreehq/daintree/issues/9093) | T3 | Inline error banner | Pane-local failure with recovery context: the banner offers restart, disable auto-restart, or inspect logs. The guard itself enforces a bounded retry — surfacing after N attempts, not an indefinite loop. |
| Exit cause classified `oom` | [#9091](https://github.com/daintreehq/daintree/issues/9091) | T3 | Inline error banner | The process exited because it ran out of memory. User must act: retry with extra heap, reduce resource usage, or adjust the dev server config. The banner carries the specific exit cause so the recovery action is self-documenting. |
| Exit cause classified `user-cancel` | [#9091](https://github.com/daintreehq/daintree/issues/9091) | T0 | Silent log | User pressed Ctrl+C or clicked Stop. The panel state IS the receipt — the process exited on their explicit instruction. A notification would be noise. |
| WebSocket HMR handshake failed | [#9097](https://github.com/daintreehq/daintree/issues/9097) | T1 | Frame state | Ambient, feeds the readiness signal. Not independently actionable: the user can't fix a WebSocket handshake. It informs the stuck-tier escalation path but doesn't surface on its own. |
| Port released after stop | [#9088](https://github.com/daintreehq/daintree/issues/9088) | T0 | Silent log | Post-stop verification; the port release is an internal cleanup detail. The panel state already shows stopped. |
| Open-in-real-browser bootstrap minted | [#9101](https://github.com/daintreehq/daintree/issues/9101) | T0 | Silent log | The system browser opening IS the receipt. The user sees the new tab appear; a toast would be redundant and the four-question gate fails on visibility. |
| Promote-to-Portal session migration started | [#9102](https://github.com/daintreehq/daintree/issues/9102) | T1 | Frame state during migration | The new Portal tab IS the outcome. Frame state during migration signals that work is in progress; a transient inline banner only surfaces on failure (the migration-error path). |

## Hard Rules

Non-negotiables for any dev-preview signal call site. These are derived from CLAUDE.md Runtime Signals and the `notify()` four-question gate, scoped to dev-preview.

1. **No toast for normal running/stopped/start transitions.** The panel chrome IS the receipt. A toast on `running` or `stopped` is redundant with the `panel-state-*` border and the toolbar status pill. Tier 0 or Tier 1 only.

2. **No Tier 4 global banner for pane-local failures.** Tier 4 is reserved for host-level crashes that affect every panel. A dev-preview crash, OOM, or port conflict is pane-local — use Tier 2 (warning with recovery) or Tier 3 (error with recovery).

3. **No `notify({ type: "error", priority: "low" })`.** CLAUDE.md explicitly bans this because the toast is silently dropped while the error is still real. The lint rule `no-restricted-syntax` enforces this at `src/lib/notify.ts`. If the error is actionable, it needs `priority: "high"` and a Tier 2 or Tier 3 surface. If it truly can't be acted on, it's Tier 0 (silent log), not a low-priority notification.

4. **Tier 2 (warning) for failures with explicit recovery context in the same pane.** When the user can fix the problem without leaving the panel — freeing a port, clicking Retry, canceling an idle-stop countdown — use an inline warning banner. The banner carries the action.

5. **Tier 3 (error) for failures requiring user action where inaction means data loss or permanent breakage.** Crash-loop guard trip, OOM exit, persistent connection failure after retries exhausted. The error banner carries the recovery action (restart, inspect logs, adjust config).

6. **Tier 1 (frame state + inbox) when the user should be passively aware but has no immediate action.** Port-collision partition loss, session restored from relaunch, idle-stop executed. The inbox entry makes the event durable across sessions; the frame state carries the live signal.

7. **Tier 0 (silent log) for successful user-invoked actions where the UI state change is the receipt.** Port allocated on start, user-cancel exit, port released after stop, system browser opened. The four-question gate fails on "Visible another way" — the outcome is already self-evident.

8. **The `notify()` four-question gate must pass before any call site emits a toast.** The gate: (1) Timely — does the user need to know now? (2) Helpful — is there a concrete next step? (3) Visible another way — is the result already self-evident in the UI? (4) Ignorable — if the user ignores it, can they still finish the current task? If yes to #3 or #4, demote. If no to #1, demote. If no to #2, demote. Only emit when all four are unambiguous passes.

9. **No unbounded retry loops that delay surfacing a signal.** The crash-loop guard (#9093) and connection-refused retry (#4896) patterns both enforce a cap before surfacing. An event that fires after N retries must surface at the tier of the terminal failure, not the retry. A retry loop without a bound is a silent failure.

10. **Every lifecycle transition that changes routing state must produce a signal at its tier, even if that signal is Tier 0.** Silent failures — where a state change occurs but nothing is logged — create invisible bugs (#4687, #4604, #4896). A `console.log` or `logger.info` at Tier 0 is sufficient; the point is auditability.

## Decision Checklist

For each new dev-preview event, answer these before choosing a tier and surface. Adapted from the CLAUDE.md `notify()` four-question gate.

1. **Does the event require immediate user action?** If no → Tier 0 or Tier 1. If yes and the action is in the same pane → Tier 2 or Tier 3.

2. **Is the failure pane-local?** If yes → Tier 2 (warning) or Tier 3 (error). Never Tier 4. Tier 4 is only for host-level failures that affect multiple panes.

3. **Is the panel state already the receipt?** If the outcome is self-evident in the panel chrome (running indicator changed, process exited, browser tab opened) → the four-question gate fails on "Visible another way." Demote to Tier 0.

4. **Would a toast interrupt without adding recovery value?** If the user sees the toast, reads it, and can take no different action than they would have without it → demote to Tier 1 (inbox) or Tier 0. Toasts are the most restricted surface; use them only when interruption is warranted.

5. **Is the event durable across relaunch?** If yes → inbox entry (`priority: "low"`) in addition to the frame state. The inbox survives session restart; the `panel-state-*` border does not.

6. **Does the event affect multiple worktrees or panes?** If yes → consider escalation. A single-pane port conflict is Tier 2; a port conflict that blocks every dev server in the project may warrant Tier 3 with a broader recovery message. The escalation test: does the user need to act differently because more than one pane is affected?

7. **Is the event caused by the user's own action?** If yes and the action succeeded → Tier 0. The user who pressed Start, Stop, or Ctrl+C already knows what they did. The panel state change confirms it.

## Reference

- **CLAUDE.md** — "Runtime Signals" tier ladder (Tier 0–4), `notify()` four-question gate, `panel-state-*` CSS vocabulary, and the `notify()` Usage checklist.
- **`src/lib/notify.ts`** — `EVENT_POLICY` manifest (lines 75–132): `baseInterruption`, `preferredSurface`, `defaultDurationMs` per `NotificationEventKind`. `resolveEventPolicyDefaults()` (line 181) fills gaps only — explicit caller fields always win. `priority: "low"` routes inbox-only, never toasts. The `type: "error"` + `priority: "low"` combination is lint-banned.
- **`src/index.css`** — `panel-state-working`, `panel-state-waiting`, `panel-state-hibernated` CSS classes (lines ~1786–1905). Each uses `color-mix` with a semantic token at a fixed opacity + concentric ring/outer layers. Suppressed under `prefers-reduced-motion` and given `forced-colors` fallbacks.
- **`src/components/DevPreview/useDevPreviewLoadLifecycle.ts`** — Seven state signals (`isWebviewReady`, `isLoading`, `isSlowLoad`, `webviewLoadError`, `webviewCrashed`, `reconnectAttempt`) and nine webview event listeners that feed the lifecycle events in the routing table.
- **`src/components/DevPreview/DevPreviewPane.tsx`** — Signal surface wiring: `panel-state-working` CSS class, `DevPreviewStuckBanner`, reconnect indicator, load error overlay, `BlockedNavBanner`, crash banner, unresponsive banner, force-kill banner, console auto-open on error/stall.
- **`src/hooks/useDevServer.ts`** — Dev server status states, `stuckTier`, `phaseLabel`, `forceKilled`.
- **`src/components/Terminal/InlineStatusBanner.tsx`** — Reusable Tier 2/3 banner primitive used by `DevPreviewStuckBanner` and the crash/unresponsive/force-kill banners.
- **`docs/architecture/destructive-action-safeguards.md`** — The structural template for this document: rubric, audit table, hard rules, known bypasses.

## Maintenance

- This document is the source of truth for dev-preview event routing. Every PR that adds a new dev-preview lifecycle signal must add its row to the Event Routing Table and run the Decision Checklist.
- When a row's issue is closed, the `NEW` placeholder is replaced with the merge commit or closed issue reference.
- Cross-reference: `CLAUDE.md` "Runtime Signals" carries the abbreviated tier ladder; this file carries the per-event audit.
