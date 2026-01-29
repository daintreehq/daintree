import type { KeyAction } from "./keymap.js";
import type { z } from "zod";

export type ActionSource = "user" | "keybinding" | "menu" | "agent" | "context-menu";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type ActionScope = "renderer";

export type ActionId =
  | KeyAction
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
  | "worktreeConfig.get"
  | "worktreeConfig.setPattern"
  | "files.search"
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
  | "preferences.showProjectPulse.set"
  | "preferences.showDeveloperTools.set"
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
  | "app.developerMode.set"
  | "logs.openFile"
  | "logs.clear"
  | "logs.setVerbose"
  | "logs.getVerbose"
  | "logs.getAll"
  | "logs.getSources"
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
  | "worktree.openIssueInSidecar"
  | "worktree.openPRInSidecar"
  | "worktree.copyContext"
  | "worktree.inject"
  | "worktree.sessions.minimizeAll"
  | "worktree.sessions.maximizeAll"
  | "worktree.sessions.restartAll"
  | "worktree.sessions.resetRenderers"
  | "worktree.sessions.closeCompleted"
  | "worktree.sessions.closeFailed"
  | "worktree.sessions.trashAll"
  | "worktree.sessions.endAll"
  | "recipe.run"
  | "recipe.editor.open"
  | "recipe.editor.openFromLayout"
  | "panel.focusIndex"
  | "worktree.switchIndex"
  | "agent.launch"
  | "app.settings.openTab"
  | "worktree.createDialog.open"
  | "worktree.select"
  | "worktree.copyTree"
  | "worktree.openEditor"
  | "worktree.overview.open"
  | "worktree.overview.close"
  | "actions.list"
  | "actions.getContext"
  | "terminal.moveToDock"
  | "terminal.moveToGrid"
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
  | "terminal.convertType"
  | "terminal.viewInfo"
  | "browser.reload"
  | "browser.navigate"
  | "browser.back"
  | "browser.forward"
  | "browser.openExternal"
  | "browser.copyUrl"
  | "browser.setZoomLevel"
  | "nav.toggleFocusMode"
  | "sidecar.toggle"
  | "sidecar.closeTab"
  | "sidecar.nextTab"
  | "sidecar.prevTab"
  | "sidecar.newTab"
  | "sidecar.closeAllTabs"
  | "sidecar.activateTab"
  | "sidecar.openLaunchpad"
  | "sidecar.openUrl"
  | "sidecar.goBack"
  | "sidecar.goForward"
  | "sidecar.reload"
  | "sidecar.copyUrl"
  | "sidecar.openExternal"
  | "sidecar.duplicateTab"
  | "sidecar.reloadTab"
  | "sidecar.copyTabUrl"
  | "sidecar.openTabExternal"
  | "sidecar.closeOthers"
  | "sidecar.closeToRight"
  | "sidecar.setLayoutMode"
  | "sidecar.resetWidth"
  | "sidecar.width.set"
  | "sidecar.setDefaultNewTab"
  | "sidecar.links.add"
  | "sidecar.links.remove"
  | "sidecar.links.update"
  | "sidecar.links.toggle"
  | "sidecar.links.reorder"
  | "sidecar.links.rescan"
  | "sidecar.tabs.reorder"
  | "ui.sidebar.resetWidth"
  | "terminal.info.open"
  | "terminal.info.get"
  | "terminal.gridLayout.setStrategy"
  | "terminal.gridLayout.setValue"
  | "terminal.openWorktreeEditor"
  | "terminal.openWorktreeIssue"
  | "terminal.openWorktreePR"
  | "notes.openPalette"
  | "notes.create"
  | "notes.delete"
  | "notes.reveal"
  | "devServer.start"
  | "agent.commandBar";

export interface ActionContext {
  projectId?: string;
  activeWorktreeId?: string;
  focusedWorktreeId?: string;
  focusedTerminalId?: string;
  isTerminalPaletteOpen?: boolean;
  isSettingsOpen?: boolean;
}

export interface ActionDefinition<Args = unknown, Result = unknown> {
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  scope: ActionScope;
  argsSchema?: z.ZodType<Args>;
  resultSchema?: z.ZodType<Result>;
  isEnabled?: (ctx: ActionContext) => boolean;
  disabledReason?: (ctx: ActionContext) => string | undefined;
  run: (args: Args, ctx: ActionContext) => Promise<Result>;
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
}

export interface ActionDispatchPayload {
  actionId: ActionId;
  args?: unknown;
  context: ActionContext;
  source: ActionSource;
  timestamp: number;
}
