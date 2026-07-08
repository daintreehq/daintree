# Destructive Action Safeguards

Living per-action audit and rubric for destructive UI surfaces. Triggered by #7880 (a single-click commit + push button that silently substituted a fallback commit message and required force-push recovery on `origin/develop`). Tracked by #7881.

This document is the **source of truth** for which actions are considered destructive, what safeguard each one currently has, and what should change. CLAUDE.md carries the abbreviated rubric ("Destructive Action Tiers"); this file is the long-form inventory and the index of follow-up issues.

## Rubric

Four tiers, calibrated to **reversibility × blast radius**. The boundary between tiers is not blast-radius count — it is _what the user has to do to get back to where they were_.

| Tier | Reversibility | Required safeguard | Examples |
| --- | --- | --- | --- |
| **D0** | Reversible locally; inverse is one click away | No confirmation. Inverse action (undo, unstage, restore from trash, dock/maximize) must be discoverable. | `git.stageAll`, `git.unstageAll`, `git.commit` (before push), `terminal.trash`, `terminal.background`, `panel.focus`, fleet arm/disarm. |
| **D1** | Local irreversible; git/reflog cannot recover | Explicit `ConfirmDialog` with verb-noun button (`Delete recipe`, not `Delete`). | `terminal.kill`, `terminal.killAll`, `worktree.sessions.endAll`, `worktree.sessions.trashAll`, recipe delete, project remove from list, `keybinding.resetAll`. |
| **D2** | Shared-state mutation; recovery requires coordination (force-push, file restore, external tool) | `ConfirmDialog` + content preview before the mutation fires. Preview must show actual content (diff, message, file list, target branch) — a count alone is insufficient. | `git.push`, `worktree.delete`, `worktree.resource.teardown`, force-push, merge PR, close issue / PR, branch delete on a shared branch. |
| **D3** | Catastrophic blast radius; no recovery path | `ConfirmDialog` with `typedNameTarget` (user types entity name). | Delete repo, delete project with worktrees, teardown cloud environment, bulk delete crossing worktree boundaries. |

**Hard rules** (extracted to CLAUDE.md verbatim — duplicated here for the audit):

1. **No silent fallback defaults.** Never substitute a derived value (commit message, branch name, file path) without showing it to the user first. Commit submission gates on an explicitly authored message — not "ai-note OR last-commit-message" silent chain. This is the #7880 root cause; any "if X is empty, use Y" path on a destructive submission is a review blocker.
2. **`danger` metadata classifies the action's target tier, not just current wiring.** Setting `danger:"confirm"` asserts "this action is destructive enough to need a confirm gate" and produces two real behavioral effects: exclusion from `ActionService.repeatLast` eligibility (`src/services/ActionService.ts:301`) and from the `useActionPalette` MRU rail (`src/hooks/useActionPalette.ts:99`). The matching `ConfirmDialog` at the call site is the **wiring**, tracked separately in this audit's "UI confirm" column. Direction: **classification leads wiring.** If a `ConfirmDialog` is wired, the metadata MUST be `danger:"confirm"` (else the action leaks into MRU). The reverse — that every `danger:"confirm"` already has a dialog — is the _goal state_ the audit drives toward; gaps appear as TBD follow-ups, not silent contradictions.
3. **Direct `window.electron.*` IPC calls bypass `ActionService`.** When a component calls IPC directly for any D1–D3 action, the confirm dialog must be wired in the component. These bypass paths must be listed in this audit (see [Known bypasses](#known-bypasses)) and called out at review.
4. **Bundled multi-step operations** (e.g., stage + commit + push) require either a preview/edit step between each phase, or an explicit "commit and push" confirmation that names both operations and shows the commit message and diff. Never a single button that chains writes silently.
5. **Destructive primitive conventions.** Every destructive `ConfirmDialog` inherits the following from the primitive layer (`AppDialog` + `ConfirmDialog` + `TypedNameConfirmInput`) — consumers do not opt in:
   - **`role="alertdialog"`** on destructive variants (vs `role="dialog"`) so screen readers interrupt the speech queue. `aria-labelledby` / `aria-describedby` continue to wire the title and description.
   - **Initial focus on Cancel** for `variant="destructive"`. The Cancel button carries `data-confirm-role="cancel"` and the Confirm button carries `data-confirm-role="confirm"`; `AppDialog`'s focus effect targets the marker, falling back to the first tabbable element if the consumer renders custom Footer `children`. Override with `initialFocus="first" | "confirm" | "none"` when the destructive surface demands it.
   - **Cancel-left, Primary-right** button order (Apple HIG / modern web). Daintree deliberately diverges from Fluent 2's Primary-left layout — the destructive button is never the first thing the keyboard or pointer lands on.
   - **Typed-name gate** uses `aria-required="true"` and `aria-invalid` when the value is non-empty and unmatched, so assistive tech announces the gate state during the type-to-confirm flow.
   - **Dev-only microcopy guards.** `ConfirmDialog` `warnOnce`s on `title` starting with "Are you sure" and on body text containing "cannot be undone" / "can't be undone". Both rules sit on the entity-naming / specific-consequence requirements from CLAUDE.md and fire once per session.

## Audit table

Columns:

- **Action / call site** — action ID where it exists, otherwise the component path performing the operation
- **Current** — `danger` value in the action definition (or `(bypass)` for direct IPC calls)
- **UI confirm** — does the calling component wire a `ConfirmDialog` today?
- **Consent in breadcrumb** — does the action emit a `confirmed` value into the `ActionBreadcrumb`? `danger:"confirm"` actions emit a boolean (`true` when an agent explicitly confirmed, absent when user-source — `source:"user"` itself carries sufficient signal for dialog-confirmed actions). `danger:"safe"` actions emit `n/a` (field absent). Bypass paths: `n/a` (not routed through `ActionService`).
- **Reversibility** — local-undo / local-irreversible / shared-state / catastrophic
- **Blast** — typical scope per invocation
- **Tier** — recommended tier from the rubric
- **Recommendation** — leave alone / add confirm / add preview / split / spin off
- **Follow-up** — issue tracking the fix (TBD = to be filed after merge)

### Git operations

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `git.stageFile` / `git.unstageFile` | safe | n/a | n/a | local-undo (inverse exists) | one file | D0 | Leave | — |
| `git.stageAll` / `git.unstageAll` | safe | n/a | n/a | local-undo (inverse exists) | worktree | D0 | Leave | — |
| `git.commit` (action) | safe | n/a (caller-supplied msg required) | n/a | local-undo (amend / reset until push) | one commit | D0 | Leave action; but every commit _submission_ call site must gate on authored, non-fallback message (see follow-ups) | — |
| `git.push` (action) | **confirm** (updated #7881) | yes — `GitPushConfirmDialog` (deferred-Promise gate via `gitPushConfirmStore`; the action `run()` awaits confirmation, dialog previews target branch + recent local commits, #8242) | Boolean via dispatch | shared-state (force-push to undo) | one branch on origin | D2 | Done (#8242) — palette/keybinding push gates on the same D2 preview | — |
| `ReviewHubContent.tsx` `handleCommitAndPush(message)` | (bypass — chains `commit` + `runPush`) | yes (`CommitPanel` push confirm — every remote push gates on `ConfirmDialog` with branch pill + commit message preview + per-worktree opt-out, #8025) | Boolean via dispatch | shared-state | one branch on origin | D2 | Leave — wired model for bundled commit-and-push | — |
| `ForcePushConfirmDialog.tsx` `forcePushWithLease` | (bypass, but **dialog already wired**) | yes (`ForcePushConfirmDialog`) | n/a (bypass) | shared-state, recoverable only by lease check | one branch on origin | D2 | Leave — current implementation is the model for D2 confirms | — |
| `ReviewHubContent.tsx:896` `pullRebase` | (bypass, but **dialog now wired**) | yes — `ConfirmDialog` previews local-ahead vs incoming-behind divergence on the current branch before rebase (#8242); `git.pullRebase` action reclassified `safe`→`confirm` | Boolean via dispatch | local-irreversible until pushed (rebase can clobber) | one worktree | D1 | Done (#8242) — confirm + divergence preview wired at the ReviewHub call site | — |
| `ReviewHubContent.tsx:733` `abortRepositoryOperation` | (bypass) | none | n/a (bypass) | local-undo (abort is the recovery) | one worktree | D0 | Leave (abort _is_ the recovery path) | — |
| `ReviewHubContent.tsx:778` `checkoutOursTheirs` | (bypass, but **dialog now wired**) | yes — `ConfirmDialog` in `ConflictPanel` previews the file path + side (rebase-aware) before overwriting the conflict buffer (#8242) | n/a (bypass) | local-irreversible (overwrites conflict resolution) | one file | D1 | Done (#8242) — every conflict-buffer overwrite gates on a per-file confirm | — |

### Worktree operations

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `worktree.create` / `worktree.quickCreate` / `worktree.createDialog.open` | safe | n/a (creation) | n/a | reversible (delete the worktree) | one new worktree | D0 | Leave | — |
| `worktree.delete` | confirm | yes (`WorktreeDeleteDialog`) | Boolean via dispatch | shared-state (working tree + branch on disk) | one worktree, optionally one branch | D2 | Leave — preview shows file count split (tracked vs untracked, see #4927) | — |
| `worktree.delete` with `force: true` | confirm | yes; force flag is a separate toggle in the dialog, escalates to typed-name gate | Boolean via dispatch | shared-state, may discard uncommitted work | one worktree | D2 → escalates to D3 when worktree has uncommitted tracked changes | Done (#8023) — `WorktreeDeleteDialog.isHighTier` escalates to the typed-name gate when `force && hasTrackedChanges` (in addition to protected branch / main worktree); uses `hasTrackedChanges` not `hasChanges` so untracked-only deletes don't escalate (#4927) | — |
| `worktree.resource.provision` | safe | n/a | n/a | reversible (teardown) | one resource | D0 | Leave | — |
| `worktree.resource.teardown` | **confirm** (updated #8023) | yes (`ConfirmDialog` via `useWorktreeActions` / `WorktreeCard`) — preview lists the actual teardown commands | Boolean via dispatch | shared-state (cloud resource destroyed) | one resource | D2 | Done (#8023) — confirm shows the resolved teardown command list before dispatch | — |
| `worktree.resource.pause` / `worktree.resource.resume` | safe | n/a | n/a | reversible | one resource | D0 | Leave | — |

### Worktree sessions

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `worktree.sessions.minimizeAll` / `maximizeAll` | safe | n/a | n/a | reversible | one worktree | D0 | Leave | — |
| `worktree.sessions.restartAll` | **confirm** (updated #8245) | yes (`TerminalDestructiveActionConfirmDialog` via `useTerminalPendingDestructiveActionStore`) — fires only when the target worktree has a running agent session | Boolean via dispatch | local-irreversible (scrollback lost) | one worktree | D1 | Done (#8245) | — |
| `worktree.sessions.resetRenderers` | safe | n/a | n/a | reversible (just re-renders) | one worktree | D0 | Leave | — |
| `worktree.sessions.closeCompleted` | safe | n/a | n/a | local-irreversible (trashed terminals lose scrollback) | one worktree | D0 | Leave — only targets completed/exited terminals | — |
| `worktree.sessions.trashAll` | confirm | yes (`useWorktreeActions.ts` `handleCloseAll`, updated #8245) — verb-noun "Trash all sessions" with consequence preview | Boolean via dispatch | local-irreversible (scrollback lost; trashed) | one worktree | D1 | Done (#8245) | — |
| `worktree.sessions.endAll` | confirm | yes (`useWorktreeActions.ts:130-148`) — call-site only; `run()` ends every session immediately with no in-run gate, so the action is `palette: { mode: "hidden" }` to stop a `source:"user"` palette pick from bypassing the dialog (palette-runner audit) | Boolean via dispatch | local-irreversible | one worktree | D1 | Done — call-site confirm + palette-hidden to close the bypass | — |
| `worktree.bulk.closeSessions` (bypass — `WorktreeOverviewModal` fans out `bulkCloseByWorktree`) | confirm | yes (`ConfirmDialog`, default variant) — names blast radius "Close sessions for N worktrees" before running | Modal-local (selection-driven) | local-irreversible (scrollback lost) | every selected worktree | D1 | Done (#8655) — action metadata is classification-only; the modal's bulk action bar wires the dialog | — |
| `worktree.bulk.remove` (bypass — `useWorktreeBulkRemove` calls `worktreeClient.delete` directly through a p-queue) | confirm | yes (`ConfirmDialog`, destructive variant) — typed-name gate `"N worktrees"`, full target list with per-worktree dirty / unpushed warnings, main worktrees excluded inside confirm step | Modal-local (selection-driven) | shared-state (working trees + branch worktree associations) | every non-main selected worktree | D3 | Done (#8655) — partial-failure surfaced via warning toast naming success/total ratio; selection cleared regardless of outcome (modal is the retry surface) | — |

### Terminal lifecycle

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `terminal.close` / `terminal.trash` | safe | n/a | n/a | reversible (restore from trash before next gc) | one terminal | D0 | Leave | — |
| `terminal.background` | safe | n/a | n/a | reversible (foreground / focus) | one terminal | D0 | Leave | — |
| `terminal.kill` | **confirm** (updated #8245) | yes — context menu (local `ConfirmDialog`) and keybinding/palette (app-level `TerminalDestructiveActionConfirmDialog`); fires only when the terminal has a running agent session (`terminalHasRunningAgentSession`), bare PTY stays D0 | Boolean via dispatch | local-irreversible (PTY killed, scrollback lost) | one terminal | D1 | Done (#8245) | — |
| `terminal.killAll` | **confirm** (updated #8245) | yes (`TerminalDestructiveActionConfirmDialog`) — fires when any non-ephemeral terminal has a running agent; label shows total terminals + running-agent count | Boolean via dispatch | local-irreversible | every non-ephemeral terminal | D1 | Done (#8245) | — |
| `terminal.closeAll` | safe | none | n/a | reversible (trash, not kill) | every active-worktree terminal | D0 | Leave | — |
| `TrashContainer.tsx` "Empty trash" button | (bypass) | yes — colocated `ConfirmDialog` (destructive variant) with verb-noun "Empty trash" + preview list of panel titles | n/a (bypass) | local-irreversible (PTY killed, scrollback lost) | every trashed panel | D1 | Done (#8962) — confirm wired at the popover header call site | — |
| `terminal.restart` | **confirm** (updated #8245) | yes — context menu + keybinding/palette dialog hosts; fires only when terminal has a running agent session | Boolean via dispatch | local-irreversible (scrollback lost; process re-spawned) | one terminal | D1 | Done (#8245) | — |
| `terminal.restartAll` | **confirm** (updated #8245) | yes (`TerminalDestructiveActionConfirmDialog`) — fires when any non-trash terminal has a running agent | Boolean via dispatch | local-irreversible | many terminals | D1 | Done (#8245) | — |
| `terminal.restartService` | safe | n/a | n/a | local-irreversible (all PTY processes restart) | every terminal in the window | D1 | Action is gated on `backendStatus === "disconnected"`; the gate already implies an error state, so leave as-is | — |

### Artifacts

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `artifact.applyPatch` | **confirm** (updated #10020) | yes — `ConfirmDialog` in `ArtifactOverlay.tsx` with full per-line diff preview of the patch content; the dispatch lives in `useArtifacts.ts`, so the action is on `BYPASS_WIRED` (ID not co-located with the dialog) | Boolean via dispatch (agents must pass `confirmed: true`) | shared-state (writes worktree files via `git apply`; recovery is a manual git checkout) | files touched by one patch | D2 | Done (#10020) — single apply gates on a diff-content preview | — |
| `ArtifactOverlay.tsx` "Apply All Patches" (fans out `artifact.applyPatch` via `useArtifacts.applyAllPatches`) | routes through `artifact.applyPatch` | yes — single `ConfirmDialog` previews the snapshotted patch list (filename + per-patch `+N −N` line stats); the confirm passes the same snapshot to the apply loop so patches detected while the dialog is open are never applied unseen | Boolean via dispatch | shared-state (sequential `git apply`; a mid-list failure leaves earlier patches applied) | files touched by every detected patch | D2 | Done (#10020) — snapshot-at-request prevents the TOCTOU gap between preview and apply | — |
| `artifact.saveToFile` | safe | n/a — the native save dialog is itself the consent surface (user picks the destination path) | n/a | reversible (delete the saved file) | one new file | D0 | Leave | — |

### Dev preview

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `devPreview.stop` | safe | n/a | n/a | local-undo (re-start) | one dev server | D0 | Leave | — |

### Fleet operations

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fleet.accept` | safe | n/a (sends affirmative to a prompt) | n/a | local-irreversible per prompt | armed waiting agents | D0 | Leave — affirmative response to an already-displayed prompt | — |
| `fleet.reject` | safe | conditional confirm in `run()` body when 5+ targets | n/a | local-irreversible per prompt | armed waiting agents | D0 | Leave — internal confirm is sufficient; `n\r` is the safe default | — |
| `fleet.interrupt` | safe | conditional confirm in `run()` body when 3+ targets | n/a | local-recoverable (re-arm/continue) | armed working agents | D0 | Leave | — |
| `fleet.restart` | **confirm** (updated #7881) | yes (internal confirm via `useFleetPendingActionStore`) | Boolean via dispatch | local-irreversible (scrollback + session lost) | armed agents | D1 | Leave — internal confirm pattern is the canonical example for actions that aren't surfaced via `danger`-driven gates | — |
| `fleet.kill` | **confirm** (updated #7881) | yes (internal confirm) | Boolean via dispatch | local-irreversible | armed terminals | D1 | Leave | — |
| `fleet.trash` | **confirm** (updated #7881) | yes (internal confirm; threshold 5+) | Boolean via dispatch | local-irreversible (scrollback lost) | armed terminals | D1 | Leave; consider lowering threshold to 3+ in a follow-up | TBD |
| `fleet.armMatchingFilter` / `fleet.armFocused` / `fleet.armAll` | safe | n/a | n/a | reversible (disarm) | armed set | D0 | Leave | — |
| `terminal.arm` | safe | n/a — agent/MCP-exposed broadcast-set edit, `palette: { mode: "hidden" }` (user arming goes through the fleet ribbon `toggleId`/`armAll`) | n/a | reversible (`terminal.disarm`/`terminal.disarmAll`) | armed set | D0 | Leave — arming only edits which terminals receive the _next_ broadcast input; it mutates nothing on its own and is fully reversible by disarming, so it carries no confirm gate (the earlier #10695 agent-dispatch confirm was removed as over-heavy for a light, reversible interaction). Echoes the resulting armed set in its result | — |
| `terminal.disarm` / `terminal.disarmAll` (#10695) | safe | n/a — agent/MCP-exposed de-escalation, no confirm | n/a | reversible (re-arm) | armed set | D0 | Leave — disarming is the recovery path; gating it would make an accidentally-armed fleet harder to clear. Both echo the resulting armed set in their result | — |
| `fleet.saveNamedFleet` | safe | n/a | n/a | reversible (delete fleet) | one saved fleet | D0 | Leave | — |
| `fleet.recallNamedFleet` | safe | n/a | n/a | reversible (re-arm) | armed set | D0 | Leave | — |
| `fleet.deleteNamedFleet` | **confirm** (updated #8023) | yes (`ConfirmDialog` hoisted to `FleetArmingRibbon`, outside the dropdown tree) | Boolean via dispatch | local-irreversible (settings entry gone) | one saved fleet | D1 | Done (#8023) — confirm state lifted above the Radix `DropdownMenu` so the dialog survives the menu closing (#2828) | — |
| `fleet.retryFailures` | safe | n/a | n/a | local-undo (just re-fires the last broadcast) | failed broadcast targets | D0 | Leave | — |
| `fleet.broadcast` (Enter-broadcast / `tryFleetBroadcastFromEditor`) | **safe (deliberate, #9722)** | no — removed in #9722; arming a 2+ fleet is the explicit opt-in, and the raw-terminal broadcast path (`broadcastFleetRawInput`) has always fanned out without a confirm, so the two paths now match. Per-target overrides/skips set in the drafting popover are still honored via the Enter-time snapshot. Broadcast awareness lives in the top-bar fleet indicator (ribbon commit flash via `noteBroadcastCommit`), not a blocking dialog | n/a (bypass — direct fan-out, not `ActionService`) | shared-state (sends a command to N PTYs; already-dispatched IPC writes cannot be revoked) | N armed panes | D1 | Done (#9722) — deliberate removal: the #8689/#8725 confirm gate (which reworked #7880's silent-fallback concern) is dropped because "once a fleet is armed, submit just submits." The destructive-command case is intentionally unconfirmed here, matching the raw-input path precedent; arming is the consent boundary | — |

### Project / window

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `project.add` / `project.cloneRepo` / `project.openDialog` | safe | n/a | n/a | reversible | one project | D0 | Leave | — |
| `project.switch` / `project.switcherPalette` | safe | n/a | n/a | reversible (switch back) | one project | D0 | Leave | — |
| `project.update` / `project.saveSettings` | safe | n/a | n/a | reversible (re-edit) | one project | D0 | Leave | — |
| `project.remove` | **confirm** (updated #8247) | yes (`confirmRemoveProject` in `useProjectSwitcherPalette.ts`; all four entry points funnel through it) | Boolean via dispatch | local-irreversible (removed from list; worktrees on disk remain) | one project | D1 | Done (#8247) | #8247 |
| `project.close` / `project.closeActive` | safe | yes — `callbacks.onConfirmCloseActiveProject` routes through a confirm flow | n/a | local-irreversible (terminals killed) | one project | D1 | Leave — confirm flow already exists | — |
| `project.freeMemory` | **confirm** (added #10833) | yes — `ConfirmDialog` in `ProjectSwitcherPalette.tsx` (dispatched via `useProjectSwitcherPalette.ts`) with a live process/agent-count preview; shown only when live processes exist, immediate otherwise | n/a (direct-IPC `window.electron.project.freeMemory` via `projectClient`, ActionService bypass — confirm wired in component) | local-irreversible (PTY terminals killed; sessions + layout preserved so project reopens; renderer view + workspace-host evicted) | one project | D1 (D0 when nothing running) | Done (#10833) — confirm wired in component | #10829 |
| `window.close` | safe | OS-native warning when unsaved work present | n/a | local-irreversible (window state lost) | one window | D0 | Leave — OS provides confirm | — |
| `window.forceReload` | safe | n/a | n/a | local-irreversible (in-flight UI state lost) | one window | D0 | Acceptable: developer affordance; would only escalate if discoverable from non-dev menus | — |

### GitHub-side

The forge action set now exposes issue write operations to MCP agents (#10653) alongside the read-only queries and token validation. Credential save/clear still goes through the `forge:set-credential` / `forge:clear-credential` IPC surface (or the GitHub plugin's direct client calls), not `ActionService`. PR merge and dismiss-review remain unwired.

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `forge.validateToken` / credential save & clear (direct IPC, see above) | safe | n/a | n/a | reversible (re-enter) | local credential | D0 | Leave | — |
| `forge.openPR` / `forge.openIssue` / `forge.openCommits` / list / get queries | safe | n/a | n/a | reversible (navigation only) | navigation | D0 | Leave | — |
| `forge.createIssue` / `forge.reopenIssue` / `forge.addIssueComment` / `forge.addIssueLabel` / `forge.removeIssueLabel` | safe | n/a | n/a | additive or reversible (re-add label, re-close, delete comment) | one issue on origin | D0–D1 | Leave | — |
| `forge.closeIssue` / `forge.editIssue` (#10653) | `danger:"confirm"` | n/a — agent/MCP-only, no user-side dispatch | gated on `confirmed:true` for agent dispatch | shared-state (close hides work; edit overwrites body with no git/reflog copy) | one issue on origin | D2 | Leave — BYPASS_WIRED (agent-dispatch gate, no UI dialog) | — |
| Merge PR / dismiss review (future) | n/a — not yet exposed | n/a | n/a | shared-state | one PR on origin | D2 | When wired, must be `danger:"confirm"` from day one and ship with target-naming preview | open as needed |

### Recipes / plugins

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `recipe.run` | **confirm** (updated #9557) | agent-dispatch only — no user-side `ConfirmDialog` (the runner is the first-run discovery path); the `danger:"confirm"` classification gates only the agent source so a single MCP/agent dispatch can't fan out many terminals unprompted | Boolean via dispatch | local-irreversible (spawns processes; not a content mutation) | one recipe → many terminals | D0 (user) → D1 (agent-dispatched fan-out) | Done — bounds MCP/agent blast radius; `recipe.run` is in `EXPECTED_CONFIRM_DANGER` (regression test asserts the classification, agent-dispatch block, and non-empty `dangerRationale`) but stays off `CONFIRMED_WIRED` since user dispatch is intentionally un-gated | — |
| `recipe.editor.open` / `recipe.manager.open` | safe | n/a | n/a | reversible | UI | D0 | Leave | — |
| `recipe.saveToRepo` (with `deleteOriginal: true`) | safe | yes (`RecipeManager.tsx` ConfirmDialog) | n/a | local-irreversible (original deleted) | one recipe | D1 | Leave — current pattern is correct | — |
| `recipe.delete` | **confirm** (added #8247) | yes (`ConfirmDialog` in `RecipeManager.tsx` + `RecipesTab.tsx`; both dispatch through the action) | Boolean via dispatch | local-irreversible | one recipe | D1 | Done (#8247) | #8247 |
| `useRecipeRunner.ts` `handleDelete` (RecipeRunner context menu) | routes through `recipe.delete` (fixed #9147) | yes (`ConfirmDialog` in `RecipeRunner.tsx`; dispatches the action with `confirmed: true`) | Boolean via dispatch | local-irreversible | one recipe | D1 | Done (#9147) — `handleDelete` now arms a `ConfirmDialog` and dispatches `recipe.delete` instead of calling the store directly | #9147 |
| Plugin install / uninstall (future) | n/a — not yet wired | n/a | n/a | shared-state (filesystem + plugin host restart) | one plugin | D1 | When wired, `danger:"confirm"` + show plugin metadata before install/uninstall | open as needed |
| Plugin-contributed actions (user/keybinding/menu/context-menu source) | **`effectiveDanger`** — host-computed in `PluginService.registerPluginAction` from manifest capabilities; raise-only (plugin's self-declared `danger` is advisory and can never lower it) | yes — `pluginConfirmStore` + `PluginConfirmDialog`, intercepted in `usePluginActions.toSyntheticDefinition` `run()` closure; renderer reads `effectiveDanger` (fail-safe `?? "confirm"`) for the synthetic `definition.danger`, so MRU exclusion + `repeatLast` ineligibility follow automatically | Boolean via dispatch | varies (plugin-defined) | one plugin's actions | D1 | Done (#8321) — classification leads wiring: a plugin holding `shell:exec`/`git:write`/`fs:project-write`/`fs:user-data-write`/`agent:invoke` forces `confirm`. Agent-source dispatch skips the dialog (MCP bridge already confirmed; `ActionContext.dispatchSource` signals this) | #8321 |
| Plugin-MCP inbound tool call (`tools/call` from plugin's stdio MCP server, `readOnlyHint:true`) | (bypass — `PluginMcpConsentService`, classified D0 by `deriveDangerTier`) | yes — `PluginMcpConfirmDialog` on first-use (TOFU pin); subsequent calls auto-approve while the fingerprint matches | n/a (bypass — supervisor #9233 routes through `PluginMcpConsentService`, never `ActionService`) | local-undo (read-only by host classification) | one plugin tool call | D0 | Done (#9234) — D0 still prompts on first-use to surface the tool surface; the TOFU pin defends against MCP03 rug-pull by re-prompting on any raw-bytes change | #9234 |
| Plugin-MCP inbound tool call (no destructive hint) | (bypass — `PluginMcpConsentService`, classified D1 by `deriveDangerTier`) | yes — `PluginMcpConfirmDialog` with sanitised description, declared capabilities, and TOFU pin option | n/a (bypass) | local-irreversible (plugin-defined; host cannot model the side-effect) | one plugin tool call | D1 | Done (#9234) | #9234 |
| Plugin-MCP inbound tool call (`destructiveHint:true`) | (bypass — `PluginMcpConsentService`, classified D2 by `deriveDangerTier`; **denied outright** when plugin lacks a write capability) | yes — `PluginMcpConfirmDialog` (destructive variant) with redacted single-level `argsSummary` preview; raw args never cross IPC | n/a (bypass) | shared-state (plugin-defined; recovery is whatever the side-effect mutated) | one plugin tool call | D2 | Done (#9234) — capability cap is enforced before the prompt: a plugin without `fs:project-write` / `fs:user-data-write` / `git:write` / `shell:exec` cannot reach D2 and the call is denied with `PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED`, no silent downgrade | #9234 |
| Plugin-MCP `initialize` client capabilities | (bypass — `pluginMcpClientOptions.buildPluginMcpClientOptions`) | n/a — default-deny `{ capabilities: {} }` rejects `sampling` and `elicitation` at protocol level | n/a (bypass) | n/a — the gate prevents the server from initiating sidechannel flows that would bypass the host consent UI | every plugin-MCP session | D0 (the gate itself is silent; misuse would surface as a protocol error) | Done (#9234) — wired by the supervisor (#9233) at every `Client` construction | #9234 |

### Portal / browser

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `portal.links.add` / `update` / `toggle` / `reorder` | safe | n/a | n/a | reversible | one link | D0 | Leave | — |
| `portal.links.remove` | **confirm** (updated #8023) | yes (`ConfirmDialog` in `PortalSettingsTab`) | Boolean via dispatch | local-irreversible (link gone) | one link | D1 | Done (#8023) — confirm wired at the Custom links delete control | — |
| `portal.closeAllTabs` / `closeOthers` | safe (metadata unchanged — runtime escalation only) | yes — `portalPendingCloseStore` + `PortalCloseConfirmDialog`, escalated in `run()` via `deriveEffectiveTier` when 3+ tabs would close | n/a — `danger:"safe"` so no breadcrumb consent gate; the confirm re-dispatches with a `confirmed: true` **arg** (not `options.confirmed`) which the gate reads but the breadcrumb does not record | local-irreversible (tab history lost) | 3..N tabs | D0 (≤2) → D1 (3+) | Done (#8416) — first `deriveEffectiveTier` consumers; metadata stays `safe` so the single/2-tab case keeps MRU eligibility; `nonRepeatable: true` blocks `repeatLast` replay of a confirmed close | — |
| `portal.closeTab` / `closeToRight` | safe (metadata unchanged — runtime escalation only) | `closeToRight`: yes — `portalPendingCloseStore` + `PortalCloseConfirmDialog`, escalated in `run()` via `deriveEffectiveTier` when 3+ tabs would close. `closeTab`: none (single tab) | n/a — `danger:"safe"`; the confirm re-dispatches `closeToRight` with a `confirmed: true` **arg** the gate reads | local-irreversible (tab history lost) | 1..N tabs | D0 (single) → D1 (bulk) | Done (#9147) — `closeTab` stays D0; `closeToRight` now mirrors `closeAllTabs`/`closeOthers`: `deriveEffectiveTier` escalation + `nonRepeatable: true` + `closeToRight` case in `PortalCloseConfirmDialog` | #9147 |
| `portal.duplicateTab` / `reload` / `goBack` / `goForward` | safe | n/a | n/a | reversible | one tab | D0 | Leave | — |

### Keybindings / preferences

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `keybinding.setOverride` / `removeOverride` | safe | n/a | n/a | reversible (reset to default) | one binding | D0 | Leave | — |
| `keybinding.resetAll` | **confirm** (updated #8247) | yes (`ConfirmDialog` at `KeyboardShortcutsTab.tsx:184`, dispatches with `confirmed:true`) — call-site only; `run()` resets immediately, so the action is `palette: { mode: "hidden" }` to stop a `source:"user"` palette pick from bypassing the dialog (palette-runner audit) | Boolean via dispatch | local-irreversible (all overrides lost) | every override | D1 | Done (#8247); palette-hidden to close the bypass | #8247 |
| `agentSettings.reset` | **confirm** (updated — palette-runner audit) | none — no user-facing dispatch path; Settings resets via `agentSettingsClient.reset()` directly, and the action is `palette: { mode: "hidden" }` so it cannot be picked-and-run from the command palette | Boolean via dispatch | local-irreversible (omitting `agentId` resets every agent's model/flag overrides; no undo) | every configured agent | D1 | Done — agent/MCP-dispatch gated by `danger:"confirm"`; on `BYPASS_WIRED` (no co-located dialog because there is no UI dispatch site) | — |

### Dev preview

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `useDevServer.ts:299` `devPreview.restart` (direct IPC) | safe | none — hook calls IPC directly | n/a | local-irreversible (PTY killed, dev-server scrollback lost; rebuilds on respawn) | one panel | D1 | Document bypass; sibling UI issue migrates the button to the `devPreview.restart` action so the danger rating can gate it | TBD (UI issue) |
| `devPreview.restartAndClearCache` | **confirm** | yes (`DevPreviewDestructiveConfirmDialog` at `DevPreviewPane.tsx`, dispatches with `confirmed:true`) — preview lists each cache dir with existence, mtime, and async-loaded size (#9086). The confirm is component-only (not in `run()`), so the action is `palette: { mode: "hidden" }` — a `source:"user"` palette pick would otherwise bypass the dialog (palette-runner audit) | Boolean via dispatch | local-irreversible (framework build caches `.next`/`.vite`/`.turbo` wiped; regenerate on next build) | one panel | D1 | Done (#9086); palette-hidden to close the bypass | #9086 |
| `devPreview.reinstallAndRestart` | **confirm** | yes (`DevPreviewDestructiveConfirmDialog` at `DevPreviewPane.tsx`) — preview shows `node_modules` path, mtime, async-loaded size, detected package manager, lockfile name, and a pnpm caveat softening the reinstall framing (#9086). Component-only confirm, so `palette: { mode: "hidden" }` to prevent a palette pick from bypassing it (palette-runner audit) | Boolean via dispatch | shared-state (`node_modules` removed; recovery requires a full reinstall, network + lockfile dependent) | one panel | D2 | Done (#9086); palette-hidden to close the bypass | #9086 |

### Recovery page (bypass — static HTML)

The emergency recovery page (`public/recovery.html`) is a zero-React surface loaded after a crash loop. It cannot use the React `ConfirmDialog` primitive — React itself may be the thing that's broken — so the confirm gate is implemented as a vanilla-JS Disclosure pattern (ARIA `aria-expanded` + `aria-controls` + the `inert` attribute) inline on the page. Focus moves to Cancel on expand and returns to the trigger on cancel.

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `public/recovery-renderer.js` `btn-reset` → `RECOVERY_RESET_AND_RELOAD` | (bypass — static HTML, no `ActionService`) | **Yes** — inline Disclosure confirm section with panel-count + backup-timestamp preview (#8697) | n/a (bypass) | local-irreversible (`appState` overwritten; `cachedBackupSnapshot` nulled; backup file on disk survives) | one window's sessions + layout | D1 | Done (#8697) — confirm wired at the JS call site; IPC fires only after explicit confirm button click | — |

### MCP server

The MCP server is a shared surface: while it's running, external clients (Claude Code, Cursor, custom scripts) hold live sessions against it. Disabling it severs those sessions, which is a Tier-D2 shared-state mutation _only when external clients are connected_ — with zero external clients it's reversible-local (D0, flip the toggle back on). Both disable paths call IPC directly and bypass `ActionService`. On the server side, `httpLifecycle.stop()` now drains in-flight requests (`server.close()` + `closeIdleConnections()`, racing a 3s deadline before force-closing) instead of eagerly destroying every socket (#8779).

| Action / call site | Current | UI confirm | Consent in breadcrumb | Reversibility | Blast | Tier | Recommendation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `McpServerSettingsTab.tsx` `handleToggle` → `mcpServer.setEnabled(false)` (bypass — direct IPC) | confirm-when-connected | **Yes** — `ConfirmDialog` (default variant) names each connected external client (user-agent + relative connect time) before the stop fires; gated on `listActiveClients().length > 0`, zero clients disables immediately (#8779) | n/a (bypass) | shared-state (live external sessions severed; recovery is re-enable + each client reconnects) | every connected external client | D2 (D0 when no external clients) | Done (#8779) — confirm wired at the toggle call site; the named-client preview satisfies the "content, not count" rule; in-flight calls drain gracefully on the server side | — |
| `DaintreeAssistantSettingsTab.tsx` `toggleDaintreeControl` → `helpAssistant.setSettings({ daintreeControl: false })` (bypass — direct IPC) | safe | n/a — turning off Daintree control does not stop the MCP server (the auto-couple is one-directional: turning it _on_ enables MCP, turning it _off_ leaves the server up for any other clients) | n/a (bypass) | reversible (toggle back on) | the assistant's own consumer only | D0 | Leave — no MCP side-effect on disable, so no clients are severed and no confirm is warranted (#8779) | — |

## External launch surfaces (`shell.openExternal` / `shell.openPath` / `execFile`)

These open URLs, files, or processes outside the app. The blast radius isn't app state — it's whatever the OS does with renderer-influenced input, so the gate is an **allowlist**, not a `ConfirmDialog`. The standing invariant: **every `shell.openExternal` call routes through `openExternalUrl`** (`electron/utils/openExternal.ts`), which rejects any protocol outside the platform-conditional `ALLOWED_PROTOCOLS` set (`http:`, `https:`, `mailto:` everywhere; `ms-windows-store:` / `ms-settings:` on win32; `x-apple.systempreferences:` on darwin). No call site may call `shell.openExternal` directly — the regression check is `grep -rn "shell\.openExternal" electron/` returning only `openExternal.ts` itself (#9155).

`shell.openPath` takes a filesystem path (not a URL), so the protocol allowlist doesn't apply; the gate there is that every path is app-derived (log files, the app's own log dir) or validated absolute before the call. `execFile` callers that aren't reachable from the renderer (clone/version probes, smoke tests) are out of scope for this audit.

| Call site | Sink | Input source | Gate | Tier |
| --- | --- | --- | --- | --- |
| `electron/services/OAuthLoopbackService.ts` `startOAuthLoopback` | `openExternalUrl` | renderer-supplied `authUrl` (webview) | protocol allowlist (`https:` etc.); disallowed scheme settles `open-external-failed` (#9155) | D2 |
| `electron/ipc/handlers/github.ts` `handleGitHubOpenPR` | `openExternalUrl` | renderer-supplied `prUrl` | allowlist **plus** inline `github.com` / `*.github.com` hostname gate (second layer, preserved) | D1 |
| `electron/ipc/handlers/github.ts` open issues / prs / commits / issue | `openExternalUrl` | `getRepoUrl(cwd)` (git-derived) | protocol allowlist | D1 |
| `electron/ipc/handlers/forge.ts` open issues / prs / commits / issue | `openExternalUrl` | `ForgeProvider.build*Url()` (git-derived; typed `string`) | protocol allowlist | D1 |
| `electron/ipc/handlers/voiceInput.ts` `openMicSettings` | `openExternalUrl` | hardcoded `x-apple.systempreferences:` (darwin) / `ms-settings:` (win32) | platform-conditional allowlist; rejection logged via `logDebug` | D0 |
| `electron/menu.ts` "Learn More" | `openExternalUrl` | hardcoded `https://github.com/daintreehq/daintree` | protocol allowlist | D0 |
| `electron/setup/protocols.ts`, `electron/window/createWindow.ts`, `electron/window/ProjectViewManager.ts`, `electron/services/PortalManager.ts`, `electron/ipc/handlers/systemShell.ts` | `openExternalUrl` | navigation / link intercepts | protocol allowlist (already funneled pre-#9155) | D1 |
| `electron/ipc/handlers/logs.ts`, `electron/ipc/errorHandlers.ts`, `electron/ipc/handlers/recovery.ts` | `shell.openPath` | app log file/dir paths | app-derived path (no URL surface) | D0 |
| `electron/ipc/handlers/systemShell.ts`, `electron/services/EditorService.ts` | `shell.openPath` | validated absolute path | absolute-path check before call | D0 |

## Known bypasses

Direct `window.electron.*` IPC calls that skip `ActionService`. These are the highest-risk locations because the action's `danger` rating cannot gate them — the confirmation must live in the component itself.

| File | Operation | Has UI confirm? |
| --- | --- | --- |
| `src/components/Worktree/ReviewHub/ReviewHubContent.tsx` | `stageAll`, `unstageAll`, `stageFile`, `commit` block | Authored-message gate on commit; no top-level dialog |
| `src/components/Worktree/ReviewHub/ReviewHubContent.tsx` | `handleCommitAndPush` (bundled `commit` + `push`) | **Yes** — `CommitPanel` push confirm with branch pill + commit message preview + per-worktree opt-out (#8025); only user-initiated remote push path |
| `src/components/Worktree/ReviewHub/ReviewHubContent.tsx` | `pullRebase` | **Yes** — `ConfirmDialog` with ahead/behind divergence preview (#8242) |
| `src/components/Worktree/ReviewHub/ReviewHubContent.tsx` | `checkoutOursTheirs` | **Yes** — per-file `ConfirmDialog` in `ConflictPanel` (#8242) |
| `src/components/Worktree/ReviewHub/ForcePushConfirmDialog.tsx` | `forcePushWithLease` | **Yes** — model implementation |
| `src/hooks/useDevServer.ts:299` | `devPreview.restart` (dev-preview restart button) | **No** — hook invokes IPC directly; sibling UI issue migrates to the `devPreview.restart` action |
| `src/components/Recovery/SafeModeBanner.tsx` | `app.resetAndRelaunch` (safe-mode restart) | **Yes** — `ConfirmDialog` with destructive variant + `logs.openFile` recovery (#8685) |
| `public/recovery-renderer.js` | `recovery:reset-and-reload` (emergency recovery page) | **Yes** — inline vanilla-JS Disclosure confirm with panel count + backup timestamp preview; React is unavailable on this surface (#8697) |
| `src/components/Fleet/fleetEnterBroadcast.ts` | `fleet.broadcast` (Enter-broadcast → `executeFleetBroadcast` → `terminalClient.submit`) | **No (deliberate, #9722)** — confirm removed; arming the 2+ fleet is the opt-in, matching the always-unconfirmed raw-input path (`broadcastFleetRawInput`). Per-target overrides/skips still applied via the Enter-time snapshot |
| `src/components/Settings/McpServerSettingsTab.tsx` | `mcpServer.setEnabled(false)` (server toggle) | **Yes** — `ConfirmDialog` naming each connected external client; fires only when `listActiveClients()` is non-empty, else disables immediately (#8779) |
| `src/components/Settings/DaintreeAssistantSettingsTab.tsx` | `helpAssistant.setSettings({ daintreeControl: false })` (assistant toggle) | **No** — disabling Daintree control has no MCP stop side-effect, so no external clients are severed; D0, no confirm needed (#8779) |

## Palette pre-warn layers

The action palette renders confirm-tier rows (`danger:"confirm"`) with a non-chromatic pre-warn so the destructive classification is visible before the user presses Enter. These signals supplement the `ConfirmDialog` wired at the call site — they do not replace it. The accent color stays reserved for the 2px selection bar; pre-warn relies on shape, position, and opacity only.

Five layers ride on the existing manifest data (`danger`, `dangerRationale`); no per-action wiring is required:

1. **Title ellipsis** — render-time `…` (`…`) suffix on the title text node. The action definition's `title` is never mutated. Apple HIG convention: an ellipsis on a label means activation requires further input or confirmation.
2. **`TriangleAlert` icon** — monochrome Lucide glyph right-aligned next to the keybinding hint, at `text-daintree-text/40 group-aria-selected:text-daintree-text/50`. Parallels the keybinding hint opacity so it reads as secondary metadata, not as an alert chrome.
3. **`dangerRationale` second line** — dimmed italic span inside the row's content column. CSS-hidden by default (`hidden group-aria-selected:block`) so unselected rows stay single-line; expands inline when the row is the active selection. The span carries a stable `id` (`${item.id}-danger-rationale`) so `aria-describedby` can point at a real DOM node.
4. **`aria-haspopup="dialog"`** — set on every confirm-tier row regardless of selection state, so assistive tech announces that activation opens a dialog.
5. **`aria-describedby`** — set on the row element only when the row is the active selection AND a rationale is present, so screen readers read title → rationale on the selected row without leaking unrelated rationale text on other rows.

Implementation lives in `src/components/ActionPalette/ActionPaletteItem.tsx`; the data plumbing is in `src/hooks/useActionPalette.ts` (`ActionPaletteItem` interface + `toActionPaletteItem` mapper copy `dangerRationale` through from the manifest entry).

This is a separate signal from the MRU exclusion documented in Hard rule #2 — confirm-tier actions are simultaneously excluded from the "Recently used" rail and from `ActionService.repeatLast`, and surfaced with pre-warn chrome when they appear via search.

## Maintenance

- This document is the source of truth for which actions are considered destructive and what tier they belong to. Updates are part of any PR that adds a new destructive action, changes an `ActionDanger` value, or wires a new `ConfirmDialog`.
- When filing follow-up issues, link them in the **Follow-up** column. Closed follow-ups can be replaced with the merge commit SHA.
- Regression guard: `src/services/actions/__tests__/actionDefinitions.quality.test.ts` asserts that the actions listed in the test's `EXPECTED_CONFIRM_DANGER` set carry `danger:"confirm"`. Adding a new destructive action means updating that set and updating this table.
- Cross-reference: CLAUDE.md "Destructive Action Tiers" rule carries the abbreviated rubric; this document carries the full inventory.
