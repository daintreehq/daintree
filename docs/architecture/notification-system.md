# Notification, banner & signal-routing system

How a runtime signal reaches the user. `CLAUDE.md` spends two of its longest rule blocks ("notify() Usage" and "Runtime Signals") defining a five-surface taxonomy and a Tier 0–4b escalation model; this doc maps those rules to the machinery that enforces them. The rules are the policy, the code below is the mechanism — when they drift, the code wins and the rule should be corrected.

## The five delivery surfaces

Ordered least-restricted → most-restricted. The policy is to pick the lowest-visibility surface that keeps the signal actionable.

| Surface | Producer | Renderer | Durable? |
| --- | --- | --- | --- |
| Frame indicator | `panel-state-*` class on the grid panel container | `ContentPanel` (`src/components/Panel/ContentPanel.tsx`) | no — ambient, derived from agent state |
| Grid-bar inline | `notify({ placement: "grid-bar" })` | `GridNotificationBar` (`src/components/Terminal/GridNotificationBar.tsx`) — single slot | history entry only (the bar itself is ephemeral) |
| Component banner | component owns it directly | `InlineStatusBanner` (`src/components/Terminal/InlineStatusBanner.tsx`) | no — lives with its component |
| Notification inbox | `notify()` writes a history entry | `NotificationCenter` (`src/components/Notifications/NotificationCenter.tsx`) | yes — persisted bell + history |
| Toast | `notify()` default placement | `useNotificationStore` → toaster | yes (inbox entry); the toast itself is time-limited |

Two of these (grid-bar, toast) are produced through the single `notify()` entry point; the frame indicator and the component banner are produced directly by the surface that owns the state.

### Frame indicator (ambient, `panel-state-*`)

The lowest tier. A grid panel's border colour encodes its agent state — no `notify()` call, no history, no dismissal. `ContentPanel` selects one of these classes in a ternary (`src/components/Panel/ContentPanel.tsx:468-477`):

- `panel-state-waiting` — agent waiting for input (`--color-activity-waiting`)
- `panel-state-working` — agent working (static border; the old 4s breathe was removed as a WCAG-COGA fatigue trigger, see CSS comment at `src/index.css:1870`)
- `panel-state-hibernated` — passive, user-uninitiated (`--color-activity-idle`)
- `panel-state-compiling` — framework compile activity, neutral `--color-border-subtle` (accent-restraint)
- `panel-state-arming` — voice-dictation pre-audio window, the one panel-state class that uses the accent token because it is the single load-bearing focus signal for ~200ms

The CSS lives in `src/index.css:1851-1914`, with edge geometry vars at `src/index.css:653-655` and dedicated `forced-colors` / `prefers-contrast` overrides (`src/index.css:2643-2664`, `:2764`). These borders coexist with the voice-lock border by design — a panel can be both working and dictation-locked.

### Grid-bar inline (single-slot)

`placement: "grid-bar"` pins a signal inline above the content grid. It **bypasses priority routing** (it renders even when the toast gate would suppress it) but still writes a history entry. The contract is single-slot: only one grid-bar notification is visible at a time. Selection is `selectGridBarNotification()` (`src/store/notificationStore.ts:141`):

- score = `PRIORITY_WEIGHTS[priority] + GRID_BAR_TYPE_WEIGHTS[type]`, highest wins; ties break to oldest `firstShownAt`.
- `PRIORITY_WEIGHTS` (`watch: 100, high: 10, low: 0`) are spaced so no type bonus (max 3) can lift a lower priority above a higher one.
- A `lockedId` (the currently-visible notification) is held for `GRID_BAR_DWELL_FLOOR_MS` (5000ms, `src/store/notificationStore.ts:98`) so a higher-severity newcomer cannot preempt mid-read.

`GridNotificationBar` owns the dwell timer, the entry/exit animation, and a VoiceOver live-region buffer flush on swap (clear → `LIVE_REGION_SWAP_DELAY` → repopulate, which is an AT concern and is _not_ gated on reduced-motion). It is rendered in all five content-grid layout variants — `ContentGridDefault`, `ContentGridTwoPaneSplit`, `ContentGridMaximizedGroup`, `ContentGridMaximizedSingle`, `ContentGridFleetScope` — **above** the component-owned `TerminalCountWarning`/`InlineStatusBanner` instances (e.g. `ContentGridDefault.tsx:68-69`). That stacking order is a convention; future producers must not invert it.

### Component banner (`InlineStatusBanner`)

A component owns its own banner when the signal _originates_ in that component and the recovery action _lives_ in or near it (the IBM-Carbon inline-vs-toast / Atlassian component-vs-system axis). It is not routed through `notify()`. `InlineStatusBanner` (`src/components/Terminal/InlineStatusBanner.tsx`) enforces the Title-Message-Action rule at the type level: an `error` severity banner accepts at most one `action` (`actions?: never` in `ErrorActionProps`), while non-error severities may pass an `actions[]`. Demoted affordances go through `trailingSlot`. Canonical instance: `TerminalCountWarning` (`src/components/Terminal/TerminalCountWarning.tsx`).

### Notification inbox (`NotificationCenter`)

The durable surface. Every non-`transient` `notify()` writes a `NotificationHistoryEntry` (`src/store/slices/notificationHistorySlice.ts`). It is the WCAG 2.2.1 conforming alternative for the time-limited toast — anything a user misses as a toast is recoverable here. The center renders All / Unread / Snoozed / Archived views and the bell badge. See [Stores](#stores-renderer) for retention and snooze mechanics.

### Toast (most-restricted default)

The default `notify()` placement and the _most-restricted_ surface despite being the default of convenience. Gated by focus + priority (see [Routing](#routing-the-notify-pipeline)). `useNotificationStore` caps the visible stack at `MAX_VISIBLE_TOASTS` (3) and prefers evicting the oldest non-error toast so an error survives a flurry of successes (`src/store/notificationStore.ts:240-260`, issue #5861). Evicted toasts are re-marked unseen in the inbox so they aren't lost.

## `notify()` — the single renderer entry point

`src/lib/notify.ts` (~1170 LOC) is the only public API for creating any notification. Every call (1) writes a persistent history entry and (2) routes display output by priority + focus.

### The payload union and the ReactNode constraint

`NotifyPayload` (`src/lib/notify.ts:345`) is a discriminated union on the message shape:

- a `string` `message` keeps `inboxMessage` optional (the string is reused as the inbox row text);
- a `ReactNode` `message` **requires** `inboxMessage` — a compile error otherwise.

This is the load-bearing invariant: a rich toast cannot exist without a plain-text inbox fallback, so the durable WCAG-conforming row is never silently dropped. `CoalesceOptions` (`src/lib/notify.ts:247`) mirrors the same union for the coalesce patch path so a `buildMessage` returning a ReactNode is forced to supply `buildInboxMessage`.

### Priority routing matrix

`priority` is `"high" | "low" | "watch"` (`src/store/notificationStore.ts:13`). The routing matrix (documented at `src/lib/notify.ts:783`):

| Focus   | Priority | Toast | OS native | History |
| ------- | -------- | ----- | --------- | ------- |
| focused | high     | yes   | no        | yes     |
| focused | low      | no    | no        | yes     |
| blurred | high     | no    | no        | yes     |
| blurred | low      | no    | no        | yes     |
| any     | watch    | yes   | yes       | yes     |

`grid-bar` placement bypasses this entirely. `watch` is the only priority that fires the OS-native banner (`window.electron.notification.showNative`).

### EVENT_POLICY — declarative routing defaults

Rather than every call site re-running the four-question checklist, a kind-based manifest fills routing defaults. `resolveEventPolicyDefaults()` (`src/lib/notify.ts:183`) runs first in `notify()` and fills only the gaps the caller left — explicit fields always win. The taxonomy `NotificationEventKind` (`completed`, `waiting`, `workingPulse`, `uiFeedback`, `agent`, `git`, `host`, `recovery`, `settings`, `connectivity` — `src/lib/notify.ts:31`) is kept a _closed_ union for compile-time completeness on `EVENT_POLICY` and `EVENT_KIND_LABEL`. Each kind declares a `baseInterruption` (`passive | active | time-sensitive | critical`) mapped to a priority by `INTERRUPTION_TO_PRIORITY` (`src/lib/notify.ts:169`: `passive→low`, `active/time-sensitive→high`, `critical→watch`), an optional `defaultDurationMs`, and an optional `userOverrideKey` (the persisted silence toggle). `EVENT_KIND_TO_SETTING_KEY` is derived from the manifest so it stays the single source of truth.

### The banned combination

`notify({ type: "error", priority: "low" })` is **lint-banned** (`eslint.config.js:424-426`, issue #6885): a low-priority error skips the toast and lands inbox-only, silently dropping an error the user needs to see now. Use `console.warn` for diagnostic-only failures, or raise the priority. A second rule (`eslint.config.js:443-445`, issue #8097) flags _action-free_ error notifications: an `error` notify with no `action`/`actions` must either wire a recovery action (Title-Message-Action) or carry the documented `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok` escape hatch when the surrounding UI is itself the recovery surface.

### Suppression, dedup, escalation, rate-limiting

`notify()` layers several gates between the priority decision and the toast write:

- **Active-context suppression** (`src/lib/notify.ts:417-430`, `:1091`): a focused high-priority notification whose origin surface (matching `context.worktreeId`/`panelId`) is already visible is suppressed and recorded inbox-only. A 500ms grace (`SUPPRESS_GRACE_MS`) catches navigate-away and window-blur races — if the user leaves before it expires, the suppressed event is promoted to a real toast. Accessors are wired at boot in `src/store/rendererStoreOrchestrator.ts` via `setActiveContextAccessors`.
- **Transient-error escalation** (`src/lib/notify.ts:491`): auto-retryable errors (EBUSY/EAGAIN/etc.) route to `low` by default; when the same normalized error repeats past a threshold within a window (local-resource 3/5s, network 3/120s) the next instance escalates to a toast, one-shot per group with a 60-min cooldown.
- **Per-source token-bucket rate-limit** (`src/lib/notify.ts:640`): catches slow-dripping noisy producers outside the coalesce window. 3 tokens, refill 1/10s; on overflow the would-be toast is dropped and an in-place `priority: "low"` summary inbox row ("{N} more events") tracks the count. Bypassed for `priority:"low"`, `transient`, `placement:"grid-bar"`, `urgent`, and `coalesce` (each is its own gate or has no inbox fallback).
- **Coalesce** (`src/lib/notify.ts:1003`): same `coalesce.key` within ~2s collapses into a single updating toast with a count badge.
- **Thread re-promotion** (`shouldReToast`, `src/lib/notificationSeverity.ts`): a child notification sharing a `correlationId` re-toasts only when it escalates the thread's worst severity or un-snoozes an archived thread; routine same-severity updates stay inbox-silent and clear any stale snooze before the write.
- **Quiet gates**: `_quietUntil` (session mute, module-level hot-path cache) and `isScheduledQuietHours()` (the persisted schedule) suppress non-`urgent` toasts. `urgent: true` bypasses the startup quiet period and quiet hours.

`TOAST_DURATION` (`src/lib/notify.ts:225`) sets per-type auto-dismiss (error/warning 8s, info 6s, success 5s); action-bearing toasts default to sticky (`duration: 0`) so the action stays reachable.

## Stores (renderer)

| Store | File | Owns |
| --- | --- | --- |
| `useNotificationStore` | `src/store/notificationStore.ts` | live toasts + grid-bar; `MAX_VISIBLE_TOASTS`, entity-collapse by `correlationId`, grid-bar selection |
| `useNotificationHistoryStore` | `src/store/slices/notificationHistorySlice.ts` | persisted inbox entries, unread count, snooze map |
| `useNotificationSettingsStore` | `src/store/notificationSettingsStore.ts` | `enabled`, per-kind toggles, quiet-hours schedule, session `quietUntil`, mirrored OS-DND state |

The history store is `persist`-wrapped (key `daintree-notification-history`, version 2) with a debounced safe-JSON storage. Retention: read entries age out after `READ_RETENTION_MS` (7d), archived after `ARCHIVED_RETENTION_MS` (30d), **unread entries are kept indefinitely** (subject to the 200-entry `MAX_ENTRIES` cap) — losing a missed error to a clock is exactly the failure mode the inbox exists to prevent. `pruneNotificationEntries()` runs age-pruning before the cap so unread entries survive a burst storm. `useNotificationHistoryPruning` (`src/hooks/app/useNotificationHistoryPruning.ts`) ticks the prune hourly for long-lived renderers.

Persist v1→v2 (`migrate` at `src/store/slices/notificationHistorySlice.ts:618`) adds the `snoozedThreads` map (issue #9200); `merge` re-sanitizes every entry off the wire (`sanitizePersistedEntry` forces `message` to a string and rejects implausible timestamps) so a corrupt blob can't crash React on render.

`supersedeKey` retires a prior inbox row when a later notify carries the same key (resolving-event pairs like "disconnected" → "reconnected"); `correlationId` threads conversational entries. They are independent axes.

**Quiet hours** are backfilled by store **migration 017** (`electron/services/migrations/017-add-notification-quiet-hours.ts`, version 17) which adds `quietHoursEnabled/StartMin/EndMin/Weekdays` to `notificationSettings`. The renderer mirrors them into `useNotificationSettingsStore` and evaluates `isScheduledQuietNow` (`shared/utils/quietHours.ts`) in `notify()`.

## Main-process services

The renderer `notify()` covers in-app surfaces. The main process owns OS-native banners, taskbar/badge counts, and the background producers that _originate_ completion/idle signals.

| Service | File | Responsibility |
| --- | --- | --- |
| `notificationService` | `electron/services/NotificationService.ts` | Window title `(N) Daintree` + macOS dock badge; OS-native banner via `Notification`; click-to-navigate `showWatchNotification` |
| `AgentNotificationService` | `electron/services/AgentNotificationService.ts` | Completion/waiting notifications + working-pulse / all-clear sounds from agent-state events; debounce/burst/boot grace windows; consults quiet hours + OS-DND |
| `IdleTerminalNotificationService` | `electron/services/IdleTerminalNotificationService.ts` | Fires when an agent sits idle past a per-project threshold (15–1440 min); coordinates with `SystemSleepService` |
| `WindowsStoreNotifierService` | `electron/services/WindowsStoreNotifierService.ts` | Polls the update feed (~8h) for Store builds and surfaces an update-available signal |
| `OsDndService` | `electron/services/OsDndService.ts` | Surfaces OS Do-Not-Disturb / Focus state to the renderer |

**OS-DND is display-only and a sound gate — never a toast suppressor.** `OsDndService` probes macOS Focus via `~/Library/DoNotDisturb/DB/Assertions.json` and the private `_NSDoNotDisturbEnabled/Disabled` Darwin notifications; Windows/Linux are left `undefined` (fail-soft). It is consumed in exactly two places: the working-pulse audio gate in `AgentNotificationService` and the read-only toolbar tooltip. The OS already silences its own native banners, so gating in-app toasts on it would double-suppress (`src/store/notificationSettingsStore.ts:23-26`, `electron/services/OsDndService.ts` class JSDoc).

Session mute crosses the process boundary: `setSessionQuietUntil` (`src/lib/notify.ts:738`) writes the module-level `_quietUntil`, mirrors to `useNotificationSettingsStore` for the toolbar bell, and calls `window.electron.notification.setSessionMuteUntil` so main-side completion notifications and working-pulse sounds honour the same window.

## Global banner coordinator (Tier 4a)

Top-of-app global banners all contend for a **single slot** through `GlobalBannerCoordinator` (`src/components/Recovery/GlobalBannerCoordinator.tsx`), mounted once (lazily) in `src/components/Layout/AppLayout.tsx`. `useGlobalBannerPriority` (`src/components/Recovery/useGlobalBannerPriority.ts`) resolves the highest-priority active banner:

```
host-crash          backendStatus !== "connected"        (backend unusable now)
  ↓
watchdog-disabled   watchdogStatus === "disabled"         (deadlock detector down)
  ↓
safe-mode           safeMode && !dismissed                (panels not restored after crash loop)
  ↓
restore-confirmation restoreVisible                       (session-recovered, auto-dismiss timer)
  ↓
forge-token         tokenUnhealthy                        (expired creds; forge data broken now)
  ↓
cloud-sync          cloudSyncService !== null             (environmental warning)
  ↓
rosetta             rosettaVisible                        (x64 build translated on Apple Silicon)
```

Rationale for the order lives inline in `useGlobalBannerPriority.ts`: watchdog sits below host-crash (a live host failure outranks a downed monitor) and above safe-mode (the watchdog protects against the _next_ crash; safe-mode is a consequence of the _previous_ one); `restore-confirmation` stays above `forge-token` because its auto-dismiss timer only runs while mounted, so it must keep that window; `forge-token` outranks `cloud-sync` because an expired token is an active failure while cloud-sync is a persistent environmental condition; `rosetta` sits last because nothing in the app can change it — any more actionable banner deserves the slot first.

**Suppressed banners unmount — they are not CSS-hidden.** The coordinator returns exactly one component; the losers are removed from the tree. This is deliberate: mount-driven effects (most notably `RestoreConfirmationBanner`'s auto-dismiss timer) must not run while the banner is invisible. A CSS-hide would leave those timers ticking behind a higher-priority banner.

**Low-priority inbox fallback.** Because a live global banner can be suppressed by a higher-priority one, any suppressible banner whose signal must stay findable also routes a `priority: "low"` inbox `notify()` with a project-scoped `supersedeKey`. The canonical example is `useCloudSyncWarning` (`src/hooks/app/useCloudSyncWarning.tsx`): it sets the `CloudSyncBanner` live surface _and_ fires a one-per-project inbox entry (`supersedeKey: cloud-sync:<projectId>`, `countable: false`, `context.eventKind: "host"`, explicit `priority: "low"` to override the host kind's time-sensitive default). When the banner loses the slot, the audit trail survives in the inbox.

New top-of-app global banners belong in this coordinator, not as additional layout siblings. Region-scoped globals (settings, worktree dashboard — Tier 4b) mount within their own region and do not contend for the slot.

## Tier model → enforcing code

`CLAUDE.md`'s "Runtime Signals" Tier 0–4b model, mapped to the machinery:

| Tier | Meaning | Surface / enforcing code |
| --- | --- | --- |
| **0** | Silent log — user can't act differently | `console.warn` / log only; e.g. FD-leak warning (`src/store/listeners/panel/fdLeakWarning.ts`, demoted in c41d0ab50) |
| **1** | Ambient indicator — observable, non-blocking | `panel-state-*` frame borders (`ContentPanel`); toolbar pips; flow-status pill |
| **2** | Inline warning banner — risk/threshold, no failure yet | `InlineStatusBanner` warning severity; `TerminalCountWarning` |
| **3** | Inline error banner — pane-local failure + recovery | `InlineStatusBanner` error severity (single-action enforced by `ErrorActionProps`); `TerminalErrorBanner`/`SpawnErrorBanner`/`ReconnectErrorBanner` |
| **4a** | Coordinator-arbitrated global | `GlobalBannerCoordinator` + `useGlobalBannerPriority`; suppressed banners unmount; suppressible ones add a `priority:"low"` inbox fallback |
| **4b** | Region-scoped global | Banner mounted within its own region (settings, worktree dashboard); no top-of-app slot contention |

Cross-cutting routing inside `notify()` (suppression, escalation, rate-limit, quiet gates) sits _underneath_ this — it decides whether a Tier-2/3 _toast or inbox_ signal actually fires, independent of where on the tier ladder the producer chose to sit. Promote/demote heuristics (auto-recovering states stay Tier 1; a stuck state >30s or exhausted retries promotes to Tier 3; multi-terminal failures escalate to Tier 4) are policy in `CLAUDE.md`, not encoded in a single switch — they guide where a producer wires its signal.

## Pointers

- Entry point: `src/lib/notify.ts` — read `notify()` (`:812`) top-to-bottom for the full routing order.
- Payload contract: `NotifyPayload` (`src/lib/notify.ts:345`) and the `CoalesceOptions` mirror (`:247`).
- Grid-bar selection: `selectGridBarNotification` (`src/store/notificationStore.ts:141`).
- History/retention/snooze: `src/store/slices/notificationHistorySlice.ts`.
- Banner precedence: `src/components/Recovery/useGlobalBannerPriority.ts`.
- Lint enforcement: `eslint.config.js:424` (banned error+low) and `:443` (action-free error).

## Related docs

- [Fatal-error spine](./fatal-error-spine.md) — the crash/dirty-exit path that feeds `host-crash` / `safe-mode` / `restore-confirmation` into the banner coordinator.
- [Destructive action safeguards](./destructive-action-safeguards.md) — the parallel confirm-dialog tier model for destructive actions.
