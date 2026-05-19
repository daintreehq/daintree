import type { HelpAssistantTier } from "../types/ipc/maps.js";
import type { BuiltInActionId } from "../types/actions.js";

const ACTIONS_LIST_TOOL = "actions.list";
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

  "files.search",
  "file.view",

  "copyTree.generate",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",

  "agent.getState",

  "agentSettings.get",
  "keybinding.getOverrides",

  "slashCommands.list",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.snapshotGet",
  "git.snapshotList",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.getIssueByNumber",

  "workflow.prepBranchForReview",

  "system.checkCommand",
  "system.checkDirectory",

  "notifications.recent",
  "errors.recent",
] as const satisfies readonly BuiltInActionId[];

export const ACTION_TIER_ADDONS = [
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",

  "terminal.inject",
  "terminal.new",
  "terminal.sendCommand",
  "terminal.close",
  "terminal.closeAll",
  "terminal.kill",
  "terminal.killAll",
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,

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

  "workflow.startWorkOnIssue",
  "workflow.focusNextAttention",

  "app.theme.pick",
  "app.theme.browser.open",
  "app.theme.toggle",

  "project.update",
  "project.saveSettings",
  "project.muteNotifications",
] as const satisfies readonly BuiltInActionId[];

export const SYSTEM_TIER_ADDONS = [
  "worktree.delete",

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
  "forge.assignIssue",
  "forge.validateToken",
  "github.openPR",
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
