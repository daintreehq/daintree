import {
  HOST_CALL_TOOL,
  HOST_LIST_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
} from "../types/hostControl.js";

/**
 * The one Daintree Assistant an installation may run outside any project
 * (#14159). It is not a project lane: it has no project, no view and no slot
 * of the project model, so nothing that sweeps lanes by project or by view
 * can reach it. The id is an opaque workspace id — a spawn naming it resolves
 * to no Project, so it never inherits the active one.
 */
export const GLOBAL_ASSISTANT_ID = "daintree:global-assistant";

/** The lane its resume pointer is stored under, in the project hibernation store. */
export const GLOBAL_ASSISTANT_SLOT = 0;

/** Folder under userData whose path stands in for the project path, so its session directory is stable. */
export const GLOBAL_ASSISTANT_DIR_NAME = "global-assistant";

export function isGlobalAssistantId(projectId: string): boolean {
  return projectId === GLOBAL_ASSISTANT_ID;
}

/**
 * Everything the global assistant may call directly (#14161). It names no
 * project, so every project tool reaches it only through `host.call`, where
 * the target host admits it as it would another machine's assistant: the owned
 * tools alone act, on what it launched there or was handed, save that a prompt,
 * keys and an interrupt also reach an agent it didn't launch (#14551). `host.ensureProject`
 * acts on the caller's own project, which it has none of. `host.settings`
 * names hosts, never a project, and every change it makes the person approves.
 * `host.watch` names a host and only listens, so the coordinator that held
 * work for one hears when it comes back (#14463).
 */
export const GLOBAL_ASSISTANT_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_CALL_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
]);

/**
 * The tool its readiness probe looks for in `tools/list` (#14483). Its set has
 * no `actions.getContext`, and `host.list` is listed from its start.
 */
export const GLOBAL_ASSISTANT_READINESS_TOOL = HOST_LIST_TOOL;

/**
 * The tools the global assistant may run through `host.call` (#14161). An
 * allow-list, so a tool added to the relay surface later is refused until it
 * is placed here or in {@link GLOBAL_WITHHELD_TOOLS}: reads, launches of its
 * own, and the owned forms that reach only what it launched or was handed.
 * The target widens `terminal.sendCommandOwned`, `terminal.sendKeysOwned` and
 * `terminal.interruptOwned` to any agent worker for it (#14551), held to the
 * run it names and never over a person's input; every other owned form keeps
 * the ledger.
 * `worktree.resource.teardown` and `recipe.run` are here on purpose: both are
 * `danger: "confirm"`, so the person approves each run. So are the user-preset
 * writes (#16047), each previewed as the exact change.
 */
export const GLOBAL_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  "actions.list",
  "mcp.surface",
  "workspace.list",
  "worktree.list",
  "worktree.getCurrent",
  "worktree.reviewReadiness",
  "worktree.createWithRecipe",
  "worktree.waitUntilReady",
  "worktree.waitForPullRequest",
  "worktree.deleteOwned",
  "worktree.retireOwned",
  "worktree.resource.status",
  "worktree.resource.teardown",
  "recipe.list",
  "recipe.run",
  "agent.launch",
  "agent.launchMany",
  "agent.launchInNewWorktree",
  "agent.listAvailable",
  "agent.listPresets",
  "agent.listModels",
  "agent.readQuota",
  "agentSessionHistory.list",
  "assistant.list",
  "assistant.start",
  "terminal.list",
  "terminal.getStatus",
  "terminal.getOutput",
  "terminal.readLastMessageOwned",
  "terminal.new",
  "terminal.sendCommandOwned",
  "terminal.sendCommandMany",
  "terminal.sendKeysOwned",
  "terminal.injectOwned",
  "terminal.interruptOwned",
  "terminal.closeOwned",
  "terminal.closeMany",
  "terminal.waitForExit",
  "terminal.restartOnPresetOwned",
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
  "terminal.revealOwned",
  "terminal.placeOwned",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.notifyWhenIdle",
  "slashCommands.list",
  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",
  "project.detectRunners",
  "git.getProjectPulse",
  "forge.getPR",
  "forge.getPRs",
  "forge.listPRs",
  "forge.getIssue",
  "forge.listIssueComments",
  "forge.listIssues",
  "forge.getCIStatus",
  "forge.getChecks",
  "copyTree.generate",
  "skills.search",
  "skills.load",
  "fleet.getRunStatus",
  "browser.getConsoleMessages",
  "errors.recent",
  "notifications.recent",
  "plugin.validate",
  "plugin.diagnostics",
  "plugin.capturePanel",
]);
/**
 * Tools a project's assistant may reach that the global assistant may not:
 * each acts on something it neither launched nor was handed (a project's
 * commands, dev server, plugins, worktree state and view, a pane named by id,
 * the user's own agent sessions, the clipboard), or is an unscoped form a relay
 * never holds. Listed so the
 * guard test can tell a deliberate refusal from a tool nobody placed.
 */
export const GLOBAL_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  "project.runCommand",
  "project.runCheck",
  "project.openOnHost",
  "worktree.setActive",
  "worktree.setLabelColor",
  "worktree.setCustomTitle",
  "worktree.resource.provision",
  "worktree.resource.pause",
  "worktree.resource.resume",
  "terminal.moveToWorktree",
  "terminal.rename",
  "terminal.setClientMetadata",
  "devPreview.restart",
  "devPreview.reloadPreview",
  "plugin.reloadProject",
  "plugin.reloadPanel",
  "copyTree.generateAndCopyFile",
  "terminal.sendCommand",
  "terminal.sendKeys",
  "terminal.inject",
  "terminal.close",
  "terminal.kill",
  "terminal.restart",
  "terminal.startHeld",
  "terminal.closeAll",
  "worktree.delete",
  "copyTree.injectToTerminal",
  "diagnostics.openReview",
  // Brings the user's backgrounded pane forward or relaunches their conversation,
  // and the pane it opens is never recorded as the assistant's.
  "agentSessionHistory.resume",
]);

/**
 * Whether the global assistant may run `tool` in a project through `host.call`.
 * The sender refuses anything else before it leaves; a target reads the same
 * answer for a session it knows is the global assistant's (#14545).
 */
export function globalAssistantMayRelay(tool: string): boolean {
  return GLOBAL_ALLOWED_TOOLS.has(tool);
}
