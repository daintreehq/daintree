---
paths:
  - "src/**/*.tsx"
  - "src/**/*.ts"
---

# User-facing copy and signals

## Microcopy

Sentence case. No period on titles, buttons, labels, or single-clause subtitles. Use contractions; drop "we".

- **Error toasts** — verb-noun title + 1-2 sentences of why/fix + exactly **one** contextual recovery action, never "Dismiss".
- **Destructive buttons** — verb-noun ("Delete worktree").
- **Toggle labels** never change with state.
- **Confirm dialogs** — a question naming the entity (`Delete 'foo'?`); the body states the specific consequence, never "Are you sure"; verb-noun button.
- **Recovery verbs** — `Try again` in error boundaries, `Retry` in inline banners.
- **Toast titles** — past-tense verb for a discrete action ("Token saved", never "successfully"), noun phrase for ambient state ("Connection lost"). The body never restates the title.

Action-free error toasts opt out via `// eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok`.

## Empty states

Name the next action, not what's absent. When sidebar and grid are both empty, only the canvas gets the primary CTA. Completed-work states stay quiet — the `user-cleared` variant of `EmptyState.tsx` nulls its action.

Gate `RecipeRunner` on `useRecipeStore`'s `currentProjectId !== null && !isLoading`, **not** on `hasEverLaunchedAgent` — `loadRecipes()` sets `currentProjectId` synchronously before IPC resolves, so without the `isLoading` half it flashes empty. Gate teaching content on `hasEverLaunchedAgent` from `usePanelStore` (mirrors `useGettingStartedChecklist`).

## notify()

Only for events the user could not otherwise observe. Gate: is it timely? does it offer a helpful next step? is it not already visible? If ignoring it changes nothing, `console.warn` instead.

Surfaces, least to most restricted — pick the **least** restricted that conveys the signal:

frame indicator (`panel-state-*`) → grid-bar (`placement: "grid-bar"`) → inbox → toast (the default placement, and the most restricted).

`priority: "low"` means inbox only; `{ type: "error", priority: "low" }` is lint-banned. A `ReactNode` message requires `inboxMessage` (compile-enforced in `src/lib/notify.ts`). Use grid-bar for signals originating outside the visible UI, and a component-owned `InlineStatusBanner` when the signal and its recovery both live in one component.

Routing matrix: `docs/architecture/notification-system.md`. Canonical code: `useAgentWaitingNudge`, `TerminalCountWarning`, `HostCrashBanner`.

## Runtime signal tiers

Use the lowest tier that stays actionable:

T0 silent log → T1 ambient pane chrome (flow pill, toolbar pips) → T2 inline warning banner → T3 inline error banner + recovery → T4 global banner.

Demote if ignoring the signal changes nothing; escalate if it spans multiple terminals. Auto-recovering states stay T1 until recovery stalls beyond 30s or exhausts its retries, then go T3 with a recovery action.

Top-of-app globals contend for **one** slot via `useGlobalBannerPriority` in `GlobalBannerCoordinator.tsx` (mounted in `AppLayout.tsx`) — register there, never as siblings. A suppressible global also routes a `priority: "low"` inbox notify with a project-scoped `supersedeKey`. While host-crash is active, suppress duplicate per-pane error banners.

Tier table: `docs/architecture/notification-system.md`.

## Destructive action tiers

Safeguard scales with reversibility × blast radius (#7880):

- **D0 reversible-local** — no confirm, but a discoverable inverse.
- **D1 local-irreversible** (`terminal.kill`, recipe delete) — `ConfirmDialog` + verb-noun button.
- **D2 shared-state** (`git.push`, `worktree.delete`, merge PR) — confirm + a preview of the **actual** content (diff, message, file list). A count alone is insufficient.
- **D3 catastrophic** (delete repo or project) — `typedNameTarget`.

Hard rules:

1. **No silent fallback defaults.** Any "if X is empty, use Y" on a destructive submit is a review blocker — that was the #7880 root cause.
2. Every wired `ConfirmDialog` carries `danger: "confirm"`, which excludes the action from `repeatLast` and the palette MRU.
3. Direct `window.electron.*` IPC bypasses `ActionService` — wire the confirm in the component and log it in the audit.
4. Bundled multi-step operations need either a preview step or one confirmation naming every operation.

Audit and per-tier lists: `docs/architecture/destructive-action-safeguards.md`.
