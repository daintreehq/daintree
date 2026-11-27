import {
  HOST_BRING_BACK_TOOL,
  HOST_CALL_TOOL,
  HOST_LIST_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_SSH_HOST_KEYS_TOOL,
  HOST_START_AGENT_SIGN_IN_TOOL,
  HOST_STATUS_TOOL,
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

export {
  GLOBAL_ASSISTANT_SESSION_AGENT_IDS,
  GLOBAL_ASSISTANT_SESSION_LIMIT,
  GLOBAL_ASSISTANT_SLOT,
  GLOBAL_ASSISTANT_SLOTS,
  VIEWLESS_ASSISTANT_AGENT_IDS,
  globalAssistantSessionNumber,
  isGlobalAssistantSlot,
  type GlobalAssistantSlot,
} from "./globalAssistantSessions.js";

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
 * keys and an interrupt also reach an agent it didn't launch (#14551), a
 * reveal shows the person that agent's panel (#16096), and a close reaches one
 * that has finished (#16750). `host.ensureProject`
 * acts on the caller's own project, which it has none of. `host.settings`
 * names hosts, never a project, and every change it makes the person approves.
 * `host.watch` names a host and only listens, so the coordinator that held
 * work for one hears when it comes back (#14463), and `host.bringBack` names
 * one to wake or start where the person set that up (#16170). `host.status`
 * reads `terminal.getStatus` in many projects on many hosts at once, each as
 * `host.call` would read it there (#16191). `host.startAgentSignIn` names a
 * host, never a project, and opens an agent CLI's own sign-in there in the
 * window showing it, for the person to finish (#18197). `host.sshHostKeys`
 * reads one connected host's SSH host public keys over the link, with the
 * trust that link rests on (#18258). `mcp.surface` reports its own
 * session, `role` included, so it can tell when the `daintree` server it
 * reached took it for something other than the global assistant (#16765).
 * `assistant.list` and `terminal.sendCommand` are the one channel between
 * this machine's two global sessions (#18280): the listing names the session
 * itself and the other one, and the send reaches that other session and no
 * terminal else.
 */
export const GLOBAL_ASSISTANT_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_CALL_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
  HOST_BRING_BACK_TOOL,
  HOST_STATUS_TOOL,
  HOST_START_AGENT_SIGN_IN_TOOL,
  HOST_SSH_HOST_KEYS_TOOL,
  "mcp.surface",
  "assistant.list",
  "terminal.sendCommand",
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
 * run it names and never over a person's input, and its send runs a slash
 * command only as one of the agent's fixed forms (#16101); `terminal.revealOwned`
 * reaches the same workers through the same checks, which writes nothing and so
 * waits on no one (#16096); `terminal.applyClaudeUpdateOwned` reaches them
 * through the same checks too, and types only `/restart`, once, after the
 * person approves (#17908); `terminal.closeOwned` and `terminal.closeMany`
 * close an agent it didn't launch only with nothing typed in it: one whose
 * stop handed the work back once the person's Daintree confirmations or the
 * person say yes, and one stopped on an error only on the person's own yes
 * (#16750); every other owned form keeps the ledger.
 * `worktree.resource.teardown` and `recipe.run` are here on purpose: both are
 * `danger: "confirm"`, so the person approves each run. So are the user-preset
 * writes (#16047), each previewed as the exact change, and the account add
 * (#17079), each account a row naming its folder.
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
  // Reopens a session in a pane recorded as the assistant's (#16341), unlike
  // `agentSessionHistory.resume`, withheld below.
  "agent.resumeOwned",
  "agentSessionHistory.list",
  "assistant.list",
  "assistant.resume",
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
  "terminal.restartOnAccountOwned",
  "terminal.applyClaudeUpdateOwned",
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
  "agent.listAccounts",
  "agent.addAccount",
  "terminal.revealOwned",
  "terminal.placeOwned",
  "terminal.setHoldOnRestartOwned",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.notifyWhenIdle",
  "terminal.cancelQueuedSend",
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
  "canopy.openWindow",
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
  // A project's own links are its own assistant's to keep (#17091).
  "project.links.list",
  "project.links.add",
  "project.links.update",
  "project.links.remove",
]);

/**
 * Whether the global assistant may run `tool` in a project through `host.call`.
 * The sender refuses anything else before it leaves; a target reads the same
 * answer for a session it knows is the global assistant's (#14545).
 */
export function globalAssistantMayRelay(tool: string): boolean {
  return GLOBAL_ALLOWED_TOOLS.has(tool);
}

/**
 * `host.call`'s own operations on a project's plugin agent tools (#18254):
 * `plugin.tools` lists what the project's plugins offer its Assistant, and
 * `plugin.callTool` calls one. Only a global Assistant that coordinates has
 * them: on this machine's projects, answered by its in-process relay, or on
 * a host's, answered by that host's relay under its own consent and Agent
 * tools answer (#18256). They are no Daintree tool, so no other session
 * reaches them.
 */
export const GLOBAL_PLUGIN_TOOLS_LIST = "plugin.tools";
export const GLOBAL_PLUGIN_TOOL_CALL = "plugin.callTool";

export function isGlobalPluginToolOperation(tool: string): boolean {
  return tool === GLOBAL_PLUGIN_TOOLS_LIST || tool === GLOBAL_PLUGIN_TOOL_CALL;
}

/**
 * What a global assistant session that isn't coordinating may still run
 * through `host.call` (#18143): reads that start, address, type to and wait
 * on nothing, so it can see the work another session now leads without
 * advancing any of it. Owned forms are left out even where they only read,
 * since what they reach is the coordinator's. An allow-list, like
 * {@link GLOBAL_ALLOWED_TOOLS}: a tool added later is refused here until placed.
 */
export const GLOBAL_STANDBY_TOOLS: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.search",
  "actions.getSchema",
  "mcp.surface",
  "workspace.list",
  "worktree.list",
  "worktree.getCurrent",
  "assistant.list",
  "terminal.list",
  "terminal.getStatus",
  "terminal.getOutput",
  // A throwaway run's own reads, still held to the runs this session started.
  "throwaway.status",
  "throwaway.output",
]);

/** Whether a global assistant session that isn't coordinating may run `tool` through `host.call`. */
export function globalStandbyMayRelay(tool: string): boolean {
  return GLOBAL_STANDBY_TOOLS.has(tool);
}
