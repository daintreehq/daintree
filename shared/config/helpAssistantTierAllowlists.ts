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
  "forge.getCIStatus",

  "workflow.prepBranchForReview",

  "system.checkCommand",
  "system.checkDirectory",
  "system.getResourceProfileSnapshot",

  "cliAvailability.get",

  "hibernation.getConfig",

  "notifications.recent",
  "errors.recent",

  "help.displayImage",
] as const satisfies readonly BuiltInActionId[];

export const ACTION_TIER_ADDONS = [
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",
  "worktree.resource.provision",
  "worktree.resource.pause",
  "worktree.resource.resume",

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
  "worktree.delete",
  // The session-scoped form of `worktree.delete` (#11909), carried here for the
  // same subset invariant as `terminal.closeOwned`. It sits at system rather
  // than action because the delete it delegates to does.
  "worktree.deleteOwned",
  "worktree.resource.teardown",

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
  "forge.validateToken",
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
 * Cumulative allow-list per tier — every tool the assistant can call at that
 * tier.
 */
export const HELP_TIER_CUMULATIVE: Record<HelpAssistantTier, readonly string[]> = {
  workbench: WORKBENCH_TIER_TOOLS,
  action: [...WORKBENCH_TIER_TOOLS, ...ACTION_TIER_ADDONS],
  system: [...WORKBENCH_TIER_TOOLS, ...ACTION_TIER_ADDONS, ...SYSTEM_TIER_ADDONS],
};

/**
 * Tools whose blast radius is high enough that the UI pins them at the top
 * of the system-tier preview so users don't miss them in a long list.
 */
export const SYSTEM_TIER_HIGH_BLAST_RADIUS: readonly string[] = [
  "git.push",
  "git.commit",
  "worktree.delete",
];
