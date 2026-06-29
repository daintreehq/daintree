import type { HelpAssistantTier } from "../types/ipc/maps.js";
import type { BuiltInActionId } from "../types/actions.js";

export const ACTIONS_LIST_TOOL = "actions.list";
const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";

export const WORKBENCH_TIER_TOOLS = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",
  "actions.search",
  "actions.getSchema",

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

  "files.search",
  "file.view",

  "copyTree.generate",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",

  "browser.getConsoleMessages",
  "portal.listTabs",

  "agent.getState",
  "agent.listToolbar",

  "agentSettings.get",
  "keybinding.getOverrides",

  "slashCommands.list",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.snapshotGet",
  "git.snapshotList",

  "forge.getRepoStats",
  "forge.listIssues",
  "forge.listPRs",
  "forge.getIssue",
  "forge.getPR",

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
  "terminal.closeAll",
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.moveToDock",
  "terminal.moveToGrid",
  "terminal.toggleDock",
  "terminal.rename",
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  "terminal.waitUntilIdleBatch",

  "recipe.list",
  "recipe.run",

  "copyTree.injectToTerminal",

  "file.openInEditor",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
  "agent.focusNextAgent",
  "agent.focusPreviousAgent",

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
] as const satisfies readonly BuiltInActionId[];

export const SYSTEM_TIER_ADDONS = [
  "worktree.delete",
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
  "git.snapshotRevert",
  "git.snapshotDelete",

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
 * Cumulative allow-list per tier — every tool the assistant can call
 * without prompting at that tier.
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
