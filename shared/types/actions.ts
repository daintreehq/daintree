import type { BuiltInKeyAction } from "./keymap.js";
import type { z } from "zod";

export type ActionSource = "user" | "keybinding" | "menu" | "agent" | "context-menu";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type ActionScope = "renderer";

export type BuiltInActionId =
  | BuiltInKeyAction
  // Query actions for App Agent
  | "terminal.list"
  | "terminal.getOutput"
  | "terminal.sendCommand"
  | "panel.list"
  | "worktree.list"
  | "worktree.getCurrent"
  // Parameterized actions (not in KeyAction)
  | "system.openExternal"
  | "system.openPath"
  | "system.checkCommand"
  | "system.checkDirectory"
  | "system.getHomeDir"
  | "cliAvailability.get"
  | "cliAvailability.refresh"
  | "hibernation.getConfig"
  | "hibernation.updateConfig"
  | "idleTerminalNotify.getConfig"
  | "idleTerminalNotify.updateConfig"
  | "agentSettings.get"
  | "agentSettings.set"
  | "agentSettings.reset"
  | "keybinding.getOverrides"
  | "keybinding.setOverride"
  | "keybinding.removeOverride"
  | "keybinding.resetAll"
  | "terminalConfig.get"
  | "terminalConfig.setScrollback"
  | "terminalConfig.setPerformanceMode"
  | "terminalConfig.setFontSize"
  | "terminalConfig.setFontFamily"
  | "terminalConfig.setHybridInputEnabled"
  | "terminalConfig.setHybridInputAutoFocus"
  | "terminalConfig.setScreenReaderMode"
  | "terminalConfig.setCachedProjectViews"
  | "worktreeConfig.get"
  | "worktreeConfig.setPattern"
  | "files.search"
  | "file.view"
  | "file.openInEditor"
  | "file.openImageViewer"
  | "slashCommands.list"
  | "artifact.saveToFile"
  | "artifact.applyPatch"
  | "copyTree.generate"
  | "copyTree.generateAndCopyFile"
  | "copyTree.injectToTerminal"
  | "copyTree.isAvailable"
  | "copyTree.cancel"
  | "copyTree.getFileTree"
  | "git.getProjectPulse"
  | "git.getFileDiff"
  | "git.listCommits"
  | "git.stageFile"
  | "git.unstageFile"
  | "git.stageAll"
  | "git.unstageAll"
  | "git.commit"
  | "git.push"
  | "git.getStagingStatus"
  | "git.snapshotGet"
  | "git.snapshotList"
  | "git.snapshotRevert"
  | "git.snapshotDelete"
  | "preferences.showProjectPulse.set"
  | "preferences.showDeveloperTools.set"
  | "preferences.showGridAgentHighlights.set"
  | "preferences.showDockAgentHighlights.set"
  | "window.toggleFullscreen"
  | "window.reload"
  | "window.forceReload"
  | "window.toggleDevTools"
  | "window.zoomIn"
  | "window.zoomOut"
  | "window.zoomReset"
  | "window.close"
  | "github.openIssues"
  | "github.openPRs"
  | "github.openCommits"
  | "github.openIssue"
  | "github.openPR"
  | "github.getRepoStats"
  | "github.listIssues"
  | "github.listPullRequests"
  | "github.checkCli"
  | "github.getConfig"
  | "github.setToken"
  | "github.clearToken"
  | "github.validateToken"
  | "project.getAll"
  | "project.getCurrent"
  | "project.add"
  | "project.switch"
  | "project.update"
  | "project.remove"
  | "project.close"
  | "project.openDialog"
  | "project.getSettings"
  | "project.saveSettings"
  | "project.detectRunners"
  | "project.getStats"
  | "project.settings.open"
  | "project.cloneRepo"
  | "app.reloadConfig"
  | "app.developerMode.set"
  | "logs.openFile"
  | "logs.clear"
  | "logs.setVerbose"
  | "logs.getVerbose"
  | "logs.getAll"
  | "logs.getSources"
  | "logs.setLogLevel"
  | "logs.getLevelOverrides"
  | "logs.setLevelOverrides"
  | "logs.clearLevelOverrides"
  | "logs.getRegistry"
  | "errors.clearAll"
  | "errors.openLogs"
  | "eventInspector.getEvents"
  | "eventInspector.getFiltered"
  | "eventInspector.subscribe"
  | "eventInspector.unsubscribe"
  | "eventInspector.clear"
  | "worktree.refresh"
  | "worktree.refreshPullRequests"
  | "worktree.setActive"
  | "worktree.create"
  | "worktree.delete"
  | "worktree.listBranches"
  | "worktree.getDefaultPath"
  | "worktree.reveal"
  | "worktree.openIssue"
  | "worktree.openPR"
  | "worktree.openIssueInPortal"
  | "worktree.openPRInPortal"
  | "worktree.copyContext"
  | "worktree.inject"
  | "worktree.getAvailableBranch"
  | "worktree.createWithRecipe"
  | "worktree.sessions.minimizeAll"
  | "worktree.sessions.maximizeAll"
  | "worktree.sessions.restartAll"
  | "worktree.sessions.resetRenderers"
  | "worktree.sessions.closeCompleted"
  | "worktree.sessions.trashAll"
  | "worktree.sessions.endAll"
  | "recipe.run"
  | "recipe.list"
  | "recipe.editor.open"
  | "recipe.editor.openFromLayout"
  | "recipe.manager.open"
  | "recipe.saveToRepo"
  | "panel.focus"
  | "panel.focusIndex"
  | "panel.palette"
  | "worktree.switchIndex"
  | "agent.launch"
  | "app.settings.openTab"
  | "worktree.quickCreate"
  | "worktree.createDialog.open"
  | "worktree.select"
  | "worktree.copyTree"
  | "worktree.openEditor"
  | "worktree.overview.open"
  | "worktree.overview.close"
  | "action.palette.open"
  | "actions.list"
  | "actions.getContext"
  | "actions.persistedStores"
  | "terminal.moveToDock"
  | "terminal.moveToGrid"
  | "terminal.toggleDock"
  | "terminal.toggleDockAll"
  | "terminal.toggleMaximize"
  | "terminal.restart"
  | "terminal.redraw"
  | "terminal.forceResume"
  | "terminal.toggleInputLock"
  | "terminal.duplicate"
  | "terminal.rename"
  | "terminal.trash"
  | "terminal.kill"
  | "terminal.moveToWorktree"
  | "terminal.moveToNewWorktree"
  | "terminal.convertType"
  | "terminal.watch"
  | "terminal.viewInfo"
  | "browser.reload"
  | "browser.navigate"
  | "browser.back"
  | "browser.forward"
  | "browser.openExternal"
  | "browser.copyUrl"
  | "browser.setZoomLevel"
  | "browser.captureScreenshot"
  | "browser.toggleConsole"
  | "browser.clearConsole"
  | "browser.toggleDevTools"
  | "nav.toggleFocusMode"
  | "nav.quickSwitcher"
  | "find.inFocusedPanel"
  | "portal.toggle"
  | "portal.closeTab"
  | "portal.nextTab"
  | "portal.prevTab"
  | "portal.newTab"
  | "portal.closeAllTabs"
  | "portal.activateTab"
  | "portal.openLaunchpad"
  | "portal.openUrl"
  | "portal.goBack"
  | "portal.goForward"
  | "portal.reload"
  | "portal.copyUrl"
  | "portal.openExternal"
  | "portal.duplicateTab"
  | "portal.reloadTab"
  | "portal.copyTabUrl"
  | "portal.openTabExternal"
  | "portal.closeOthers"
  | "portal.closeToRight"
  | "portal.resetWidth"
  | "portal.width.set"
  | "portal.setDefaultNewTab"
  | "portal.links.add"
  | "portal.links.remove"
  | "portal.links.update"
  | "portal.links.toggle"
  | "portal.links.reorder"
  | "portal.tabs.reorder"
  | "portal.listTabs"
  | "ui.sidebar.resetWidth"
  | "terminal.info.open"
  | "terminal.info.get"
  | "panel.gridLayout.setStrategy"
  | "panel.gridLayout.setValue"
  | "terminal.gridLayout.setStrategy"
  | "terminal.gridLayout.setValue"
  | "terminal.openWorktreeEditor"
  | "terminal.openWorktreeIssue"
  | "terminal.openWorktreePR"
  | "notes.openPalette"
  | "notes.create"
  | "notes.list"
  | "notes.read"
  | "notes.delete"
  | "notes.reveal"
  | "devServer.start"
  | "env.global.get"
  | "env.global.set"
  | "env.project.get"
  | "env.project.set"
  | "worktree.compareDiff"
  | "worktree.resource.provision"
  | "worktree.resource.teardown"
  | "worktree.resource.resume"
  | "worktree.resource.pause"
  | "worktree.resource.status"
  | "worktree.resource.connect"
  | "worktree.resource.config.get"
  | "worktree.resource.config.set"
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.copyLink"
  | "terminal.deleteNote"
  | "terminal.contextMenu"
  | "terminal.sendToAgent"
  | "terminal.bulkCommand"
  | "terminal.stashInput"
  | "terminal.popStash"
  | "terminal.restartService"
  | "terminal.arm"
  | "terminal.disarm"
  | "terminal.disarmAll"
  | "terminal.armByState"
  | "terminal.armAll"
  | "terminal.armDefault"
  | "fleet.accept"
  | "fleet.reject"
  | "fleet.interrupt"
  | "fleet.restart"
  | "fleet.kill"
  | "fleet.trash"
  | "fleet.deck.toggle"
  | "fleet.deck.open"
  | "fleet.deck.close"
  | "terminal.focusFleetComposer";

export type ActionId = BuiltInActionId | (string & {});

export interface ActionContext {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  activeWorktreeId?: string;
  activeWorktreeName?: string;
  activeWorktreePath?: string;
  activeWorktreeBranch?: string;
  activeWorktreeIsMain?: boolean;
  focusedWorktreeId?: string;
  focusedTerminalId?: string;
  focusedTerminalKind?: string;
  focusedTerminalType?: string;
  focusedTerminalTitle?: string;
  isSettingsOpen?: boolean;
}

export type InferActionArgs<S extends z.ZodTypeAny | undefined> = [S] extends [z.ZodTypeAny]
  ? z.infer<S>
  : void;

export interface ActionDefinition<
  S extends z.ZodTypeAny | undefined = undefined,
  Result = unknown,
> {
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  scope: ActionScope;
  argsSchema?: S;
  resultSchema?: z.ZodType<Result>;
  isEnabled?: (ctx: ActionContext) => boolean;
  disabledReason?: (ctx: ActionContext) => string | undefined;
  run: (args: InferActionArgs<S>, ctx: ActionContext) => Promise<Result>;
  /**
   * Opt-in allowlist of top-level arg keys that are safe to include in Sentry
   * action breadcrumbs. Args are omitted by default — populate this only with
   * keys whose values never carry secrets, file paths, or PII. Listed keys are
   * copied verbatim (no further sanitization), so the allowlist is the policy.
   */
  safeBreadcrumbArgs?: readonly string[];
}

export interface ActionManifestEntry {
  id: ActionId;
  /**
   * MCP-friendly alias for `id`.
   * Prefer `name` when presenting tools to LLMs.
   */
  name: string;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled: boolean;
  disabledReason?: string;
  requiresArgs: boolean;
}

export interface ActionDispatchSuccess<Result = unknown> {
  ok: true;
  result: Result;
}

export interface ActionDispatchError {
  ok: false;
  error: ActionError;
}

export type ActionDispatchResult<Result = unknown> =
  | ActionDispatchSuccess<Result>
  | ActionDispatchError;

export type ActionErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "DISABLED"
  | "RESTRICTED"
  | "CONFIRMATION_REQUIRED"
  | "EXECUTION_ERROR";

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}

export interface ActionDispatchOptions {
  source?: ActionSource;
  /**
   * For actions with danger: "confirm", this must be true to execute.
   * Agent sources MUST explicitly set this flag to confirm destructive actions.
   */
  confirmed?: boolean;
  /**
   * Override the action context instead of using current UI state.
   * Used by agent dispatch to bind context at dispatch time and prevent confused-deputy attacks.
   */
  contextOverride?: ActionContext;
}

export interface ActionDispatchPayload {
  actionId: ActionId;
  args?: unknown;
  context: ActionContext;
  source: ActionSource;
  timestamp: number;
}

export interface ActionFrecencyEntry {
  id: string;
  score: number;
  lastAccessedAt: number;
}
