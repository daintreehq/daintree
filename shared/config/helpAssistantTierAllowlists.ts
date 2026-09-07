import type { HelpAssistantTier } from "../types/ipc/maps.js";
import type { BuiltInActionId } from "../types/actions.js";

export const ACTIONS_LIST_TOOL = "actions.list";
const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";

export const WORKBENCH_TIER_TOOLS = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  // Reports the caller's own tool surface as data (#11549) — a read of what
  // `tools/list` already told this session, so it grants nothing the caller
  // does not already hold and belongs at the lowest tier.
  "mcp.surface",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  // Read-only, and the counterpart to the setup state every worktree listing
  // now carries: a caller that can see `running` must be able to wait for it.
  "worktree.waitUntilReady",
  "worktree.resource.status",
  "worktree.compareDiff",
  "worktree.reviewReadiness",

  "files.search",
  "file.view",
  // Read is contained to the project + its worktrees inside the action itself
  // (fileActions.ts) — never an arbitrary-path read.
  "file.read",
  "file.openPanel",

  "copyTree.generate",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",

  // Read-only snapshot of the user's supervised fleet broadcast run (#10930).
  // Observability only — dispatching a broadcast stays off the MCP surface.
  "fleet.getRunStatus",

  "browser.getConsoleMessages",
  "portal.listTabs",

  "agent.getState",
  "agent.listToolbar",
  "agent.listAvailable",
  "agent.listPresets",
  "agentSessionHistory.list",
  // Read-only bookmark metadata (#11288) — same workbench tier as the history
  // listing. The mutations sit at action tier (#11908); listing stays here so a
  // read-only session can still see what has been kept.
  "session.bookmarks.list",

  "agentSettings.get",
  "keybinding.getOverrides",

  "slashCommands.list",

  "skills.search",
  "skills.load",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",

  "forge.getRepoStats",
  "forge.listIssues",
  "forge.listPRs",
  "forge.getIssue",
  "forge.listIssueComments",
  "forge.getChecks",
  "forge.getPR",
  // The plural counterpart, at the same tier as the singular read it replaces
  // for a known set. Admitting one without the other is what produced the
  // N-call fan-out this exists to remove.
  "forge.getPRs",
  "forge.getCIStatus",

  "workflow.prepBranchForReview",

  "system.checkCommand",
  "system.checkDirectory",
  "system.getResourceProfileSnapshot",

  "cliAvailability.get",

  "hibernation.getConfig",

  "notifications.recent",
  "errors.recent",

  // Reads for the plugin-authoring loop (#12214). Both are pure reads — one
  // parses a manifest already on disk, the other reports why a plugin is in the
  // state it is in — and an agent writing a plugin needs them from the lowest
  // tier it might be running at, since the alternative is guessing at a schema
  // it cannot see.
  "plugin.validate",
  "plugin.diagnostics",

  "help.displayImage",
] as const satisfies readonly BuiltInActionId[];

export const ACTION_TIER_ADDONS = [
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",
  // Cleaning up a worktree the assistant just finished with is ordinary
  // orchestration, not a privilege escalation (#12116). Admission is all this
  // tier grants: the action is `danger: "confirm"`, so an unconfirmed dispatch
  // is still sent to the renderer for a native ConfirmDialog, and a force whose
  // live target resolves to D3 still escalates to the typed-name gate (#12115)
  // even under a grant. The one thing that skips the per-call modal is an
  // explicit native automation grant, which is a user pre-authorisation and was
  // never gated on tier. Note this is the UNSCOPED delete: it reaches any
  // eligible worktree in the project, not only ones the session made.
  // `worktree.create` stays at `system` for a reason that does not apply here —
  // see the note on it below.
  "worktree.delete",
  // The session-scoped form of `worktree.delete` (#11909), carried here for the
  // same subset invariant as `terminal.closeOwned`. It tracks the tier of the
  // delete it delegates to, and is the narrower of the two: ownership is
  // verified in main, and `force`, `deleteBranch` and `closeTerminals` are
  // absent from its schema and stripped from the delegated call.
  "worktree.deleteOwned",
  "worktree.resource.provision",
  "worktree.resource.pause",
  "worktree.resource.resume",
  // Sits with its lifecycle siblings rather than above them (#12116). The
  // teardown command is project-defined and may destroy a remote resource, so
  // it keeps `danger: "confirm"` — the tier decides reachability, the danger
  // class decides approval. Worth knowing when reading the deletes above: they
  // run this same teardown implicitly, before removing the tree.
  "worktree.resource.teardown",

  "terminal.inject",
  "terminal.new",
  "terminal.sendCommand",
  "terminal.close",
  // The session-scoped form of the line above (#11909). Redundant for this
  // caller — the assistant already holds the unrestricted `terminal.close` and
  // has a human watching — but the external tier must stay a subset of what the
  // assistant can reach, and that invariant is asserted rather than assumed
  // (`tierAuth.test.ts`, "authorizes nothing the in-app assistant cannot
  // already reach"). Listing it here keeps the direction of the cut honest.
  "terminal.closeOwned",
  "terminal.closeAll",
  "terminal.kill",
  "terminal.killBatch",
  "terminal.killAll",
  "terminal.restart",
  "terminal.moveToDock",
  "terminal.moveToGrid",
  "terminal.moveToWorktree",
  "terminal.toggleDock",
  "terminal.rename",
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  "terminal.waitUntilIdleBatch",

  "recipe.list",
  "recipe.run",
  // Editor handoffs (#11908). Safe because they only put a draft on screen for
  // the user to review — the write half (`recipe.saveToRepo`, `recipe.delete`)
  // is deliberately absent from every tier, so the assistant can propose a
  // recipe but never commit one to `.daintree/recipes/` on its own.
  "recipe.editor.open",
  "recipe.editor.openFromLayout",

  "copyTree.injectToTerminal",

  "file.openInEditor",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
  "agent.focusNextAgent",
  "agent.focusPreviousAgent",

  // Session continuity (#11908). Resume spawns a pane, so it belongs beside the
  // other spawn tools rather than with the workbench-tier listings it reads
  // from. The bookmark mutations are reversible and project-scoped; the two
  // that remove something a person can see — a live pane, a durable bookmark —
  // keep `danger: "confirm"` and are gated by the renderer's own dialog, which
  // the first-party assistant is pinned to a window for.
  "agentSessionHistory.resume",
  "session.bookmarkAndClose",
  "session.bookmark.promote",
  "session.bookmark.rename",
  "session.bookmark.delete",

  "panel.focus",

  "workflow.startWorkOnIssue",
  "workflow.focusNextAttention",

  "browser.navigate",
  "browser.openUrl",
  "browser.captureScreenshot",

  "devPreview.reloadPreview",
  "devPreview.restart",
  "devPreview.promoteToPortal",

  "portal.openUrl",
  "portal.newTab",
  "portal.toggle",
  "portal.toggleDevDashboard",

  "app.theme.pick",
  "app.theme.browser.open",
  "app.theme.toggle",

  "project.update",
  "project.saveSettings",
  "project.muteNotifications",
  // Runs a project-declared command as a real child process. Read-only
  // workbench sessions detect runners but must not execute them.
  "project.runCheck",

  // Re-runs project plugin discovery and reconciliation — the write half of the
  // authoring loop whose reads sit at workbench. It restarts running code, so a
  // read-only session must not reach it, but within a project it does nothing a
  // reopen would not (#12214).
  "plugin.reloadProject",
] as const satisfies readonly BuiltInActionId[];

export const SYSTEM_TIER_ADDONS = [
  // Deliberately above `worktree.createWithRecipe`, which is heavier but
  // confined to the current project because it derives its own root. This one
  // takes an explicit root that is not validated against the session's
  // project, so an action-tier overlay could create a tree in another repo.
  // System keeps it there, so every help agent — the Daintree Assistant
  // included — reaches it only at an explicitly selected `system` tier or
  // through a scoped grant (#11880, #11907).
  "worktree.create",

  "terminal.arm",
  "terminal.disarm",
  "terminal.disarmAll",

  "copyTree.generateAndCopyFile",

  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.fetch",

  "forge.openIssues",
  "forge.openPRs",
  "forge.openCommits",
  "forge.openIssue",
  "forge.openPR",
  "forge.assignIssue",
  "forge.unassignIssue",
  "forge.approvePR",
  "forge.requestChanges",
  "forge.dismissReview",
  "forge.requestReviewers",
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",
  "forge.createIssue",
  "forge.closeIssue",
  "forge.reopenIssue",
  "forge.editIssue",
  "forge.addIssueComment",
  "forge.addIssueLabel",
  "forge.removeIssueLabel",
  // `forge.validateToken` is deliberately absent from every tier. It takes a
  // raw forge access token as an argument, and a tool argument IS model
  // context: even though ActionService redacts it from audit summaries and
  // logs, admitting the tool means the credential has to be composed in the
  // model channel to be sent. Token entry stays a UI-owned flow — the Test
  // button in the provider settings tab dispatches it directly as
  // `source: "user"`, which no tier gates. The action is also
  // `mcpVisibility: "hidden"` so a future allowlist edit cannot re-advertise it
  // by accident.
] as const satisfies readonly BuiltInActionId[];

/**
 * Tools added at each tier on top of the previous one. Useful for the
 * blast-radius preview UI which shows the incremental capability change.
 */
export const HELP_TIER_INCREMENTAL: Record<HelpAssistantTier, readonly string[]> = {
  workbench: WORKBENCH_TIER_TOOLS,
  action: ACTION_TIER_ADDONS,
  system: SYSTEM_TIER_ADDONS,
};

/**
 * Cumulative static allow-list per tier — every tool that tier permits before
 * a live grant widens the session.
 */
export const HELP_TIER_CUMULATIVE: Record<HelpAssistantTier, readonly string[]> = {
  workbench: WORKBENCH_TIER_TOOLS,
  action: [...WORKBENCH_TIER_TOOLS, ...ACTION_TIER_ADDONS],
  system: [...WORKBENCH_TIER_TOOLS, ...ACTION_TIER_ADDONS, ...SYSTEM_TIER_ADDONS],
};

/**
 * Tools whose blast radius is high enough that the UI pins them at the top of a
 * tier's preview so users don't miss them in a long list.
 *
 * Operational risk, not minimum tier. The preview intersects this list with the
 * tier being previewed, so the same tool is called out wherever it first
 * becomes reachable — which is why #12116 could not leave this keyed to
 * `system`: promoting the worktree deletes would otherwise have made them
 * invisible at the tier that newly grants them, which is the one tier where a
 * user is deciding whether to grant them at all.
 */
export const HIGH_BLAST_RADIUS_TOOLS: readonly string[] = [
  "git.push",
  "git.commit",
  // All three run project-defined teardown — arbitrary commands from
  // `.daintree/config.json`, and resource teardown that can destroy a remote
  // devbox. The two delete variants then remove the tree as well.
  "worktree.delete",
  "worktree.deleteOwned",
  "worktree.resource.teardown",
];
