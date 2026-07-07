// Single source of truth for built-in action IDs registered at runtime.
// Adding an action: append to this array + add the definition in a register*() function.
//
// BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId,
// so keybinding-only IDs (nav.*, tab.*, etc.) are NOT listed here —
// they flow through BuiltInKeyAction in shared/types/keymap.ts.

export const BUILT_IN_ACTION_IDS = [
  // -- terminalQueryActions --
  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",
  "terminal.sendCommand",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.resumeSessions",

  // -- panelActions --
  "panel.list",
  "panel.focus",
  "panel.focusIndex",
  "panel.openPluginPanel",
  "panel.palette",
  "panel.gridLayout.setStrategy",
  "panel.gridLayout.setValue",

  // -- worktreeActions --
  "worktree.list",
  "worktree.getCurrent",
  "worktree.refresh",
  "worktree.reconcileTopology",
  "worktree.refreshPullRequests",
  "worktree.restartService",
  "worktree.retryProjectLoad",
  "worktree.setActive",
  "worktree.create",
  "worktree.delete",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.reveal",
  "worktree.openIssue",
  "worktree.openPR",
  "worktree.copyContext",
  "worktree.inject",
  "worktree.getAvailableBranch",
  "worktree.createWithRecipe",
  "worktree.compareDiff",
  "worktree.reviewReadiness",
  "worktree.switchIndex",
  "worktree.quickCreate",
  "worktree.createDialog.open",
  "worktree.select",
  "worktree.copyTree",
  "worktree.openEditor",
  "worktree.openReviewHub",
  "worktree.overview.open",
  "worktree.overview.close",

  // -- worktreeResourceActions --
  "worktree.resource.provision",
  "worktree.resource.teardown",
  "worktree.resource.resume",
  "worktree.resource.pause",
  "worktree.resource.status",
  "worktree.resource.connect",
  "worktree.resource.config.get",
  "worktree.resource.config.set",

  // -- worktreeLifecycleActions --
  "worktree.lifecycle.retrySetup",

  // -- worktreeSessionActions --
  "worktree.sessions.minimizeAll",
  "worktree.sessions.maximizeAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.resetRenderers",
  "worktree.sessions.closeCompleted",
  "worktree.sessions.trashAll",
  "worktree.sessions.endAll",
  "worktree.sessions.clearHistory",

  // -- worktreeBulkActions (overview multi-select) --
  "worktree.bulk.closeSessions",
  "worktree.bulk.remove",

  // -- workflowActions --
  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",
  "workflow.focusNextAttention",

  // -- systemActions --
  "system.openExternal",
  "system.openPath",
  "system.checkCommand",
  "system.checkDirectory",
  "system.getHomeDir",
  "system.getResourceProfileSnapshot",

  // -- cliAvailabilityActions --
  "cliAvailability.get",
  "cliAvailability.refresh",

  // -- hibernationActions --
  "hibernation.getConfig",
  "hibernation.updateConfig",

  // -- idleTerminalNotifyActions --
  "idleTerminalNotify.getConfig",
  "idleTerminalNotify.updateConfig",
  "idleTerminalNotify.closeProject",
  "idleTerminalNotify.muteProject",

  // -- idleBackgroundAutoCloseActions --
  "idleBackgroundAutoClose.getConfig",
  "idleBackgroundAutoClose.updateConfig",

  // -- agentSettingsActions --
  "agentSettings.get",
  "agentSettings.set",
  "agentSettings.reset",

  // -- keybindingActions --
  "keybinding.getOverrides",
  "keybinding.setOverride",
  "keybinding.removeOverride",
  "keybinding.resetAll",

  // -- terminalConfigActions --
  "terminalConfig.get",
  "terminalConfig.setScrollback",
  "terminalConfig.setPerformanceMode",
  "terminalConfig.setFontSize",
  "terminalConfig.setFontFamily",
  "terminalConfig.setHybridInputEnabled",
  "terminalConfig.setHybridInputAutoFocus",
  "terminalConfig.setScreenReaderMode",
  "terminalConfig.setCachedProjectViews",

  // -- worktreeConfigActions --
  "worktreeConfig.get",
  "worktreeConfig.setPattern",

  // -- fileActions --
  "files.search",
  "file.view",
  "file.openDiff",
  "file.openInEditor",
  "file.openImageViewer",
  "file.showItemInFolder",

  // -- slashCommandsActions --
  "slashCommands.list",

  // -- skillActions --
  "skills.search",
  "skills.load",

  // -- artifactActions --
  "artifact.saveToFile",
  "artifact.applyPatch",

  // -- copyTreeActions --
  "copyTree.generate",
  "copyTree.generateAndCopyFile",
  "copyTree.injectToTerminal",
  "copyTree.isAvailable",
  "copyTree.cancel",
  "copyTree.getFileTree",

  // -- gitActions --
  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.pullRebase",
  "git.markSafeDirectory",
  "git.getStagingStatus",
  "git.snapshotGet",
  "git.snapshotList",
  "git.snapshotRevert",
  "git.snapshotDelete",

  // -- preferencesActions --
  "preferences.showProjectPulse.set",
  "preferences.showDeveloperTools.set",
  "preferences.showGridAgentHighlights.set",
  "preferences.showDockAgentHighlights.set",
  "preferences.showAgentTaskTitles.set",
  "preferences.reduceAnimations.set",

  // -- windowActions --
  "window.toggleFullscreen",
  "window.reload",
  "window.forceReload",
  "window.toggleDevTools",
  "window.zoomIn",
  "window.zoomOut",
  "window.zoomReset",
  "window.close",

  // -- forgeActions (provider-routed) --
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
  "forge.createIssue",
  "forge.closeIssue",
  "forge.reopenIssue",
  "forge.editIssue",
  "forge.addIssueComment",
  "forge.addIssueLabel",
  "forge.removeIssueLabel",
  "forge.validateToken",
  "forge.getRepoStats",
  "forge.listIssues",
  "forge.listPRs",
  "forge.getIssue",
  "forge.getPR",
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",

  // -- projectActions --
  "project.getAll",
  "project.getCurrent",
  "project.add",
  "project.switch",
  "project.update",
  "project.remove",
  "project.close",
  "project.closeActive",
  "project.openDialog",
  "project.getSettings",
  "project.saveSettings",
  "project.muteNotifications",
  "project.silenceNotificationKind",
  "project.detectRunners",
  "project.getStats",
  "project.settings.open",
  "project.cloneRepo",

  // -- appActions --
  "app.pluginManager",
  "app.reloadConfig",
  "app.developerMode.set",
  "app.theme.pick",
  "app.theme.toggle",
  "app.theme.browser.open",

  // -- logActions --
  "logs.openFile",
  "logs.clear",
  "logs.setVerbose",
  "logs.getVerbose",
  "logs.getAll",
  "logs.getSources",
  "logs.setLogLevel",
  "logs.getLevelOverrides",
  "logs.setLevelOverrides",
  "logs.clearLevelOverrides",
  "logs.getRegistry",

  // -- diagnosticsActions --
  "diagnostics.openReview",
  "diagnostics.openWhySlow",

  // -- errorActions --
  "errors.clearAll",
  "errors.openLogs",
  "errors.recent",

  // -- notificationActions --
  "notifications.recent",
  "notifications.toggle",

  // -- eventInspectorActions --
  "eventInspector.getEvents",
  "eventInspector.getFiltered",
  "eventInspector.subscribe",
  "eventInspector.unsubscribe",
  "eventInspector.clear",

  // -- telemetryActions --
  "telemetry.togglePreview",
  "telemetry.clearPreview",

  // -- recipeActions --
  "recipe.run",
  "recipe.list",
  "recipe.editor.open",
  "recipe.editor.openFromLayout",
  "recipe.manager.open",
  "recipe.saveToRepo",
  "recipe.delete",

  // -- agentActions --
  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
  "agent.focusNextAgent",
  "agent.focusPreviousAgent",
  "agent.getState",
  "agent.listToolbar",
  "agentSessionHistory.list",

  // -- app settings (other) --
  "app.settings.openTab",

  // -- actionActions (introspection) --
  "action.palette.open",
  "action.repeatLast",
  "actions.list",
  "actions.getContext",
  "actions.persistedStores",
  "actions.search",
  "actions.getSchema",

  // -- terminalLifecycleActions --
  "terminal.restart",
  "terminal.redraw",
  "terminal.forceResume",
  "terminal.toggleInputLock",
  "terminal.viewInfo",
  "terminal.restartService",
  "watchdog.restart",
  "terminal.new",

  // -- terminalNavigationActions --
  "terminal.moveToDock",
  "terminal.moveToGrid",
  "terminal.toggleDock",
  "terminal.toggleDockAll",
  "terminal.toggleMaximize",
  "terminal.duplicate",
  "terminal.rename",
  "terminal.close",
  "terminal.trash",
  "terminal.kill",
  "terminal.closeAll",
  "terminal.killAll",
  "terminal.moveToWorktree",
  "terminal.moveToNewWorktree",
  "terminal.watch",

  // -- terminalLayoutActions --
  "terminal.gridLayout.setStrategy",
  "terminal.gridLayout.setValue",

  // -- terminalInputActions --
  "terminal.copy",
  "terminal.paste",
  "terminal.copyLink",
  "terminal.contextMenu",
  "terminal.sendToAgent",
  "terminal.inject",
  "terminal.bulkCommand",
  "terminal.stashInput",
  "terminal.popStash",

  // -- terminalArmingActions --
  "terminal.arm",
  "terminal.disarm",
  "terminal.disarmAll",
  "terminal.armByState",
  "terminal.armAll",
  "terminal.armDefault",

  // -- terminalWorktreeActions --
  "terminal.openWorktreeEditor",
  "terminal.openWorktreeIssue",
  "terminal.openWorktreePR",

  // -- terminalInfoActions --
  "terminal.info.open",
  "terminal.info.get",

  // -- browserActions --
  "browser.reload",
  "browser.navigate",
  "browser.openUrl",
  "browser.back",
  "browser.forward",
  "browser.openExternal",
  "browser.copyUrl",
  "browser.setZoomLevel",
  "browser.captureScreenshot",
  "browser.toggleConsole",
  "browser.clearConsole",
  "browser.getConsoleMessages",
  "browser.toggleDevTools",
  "browser.hardReload",

  // -- navActions --
  "nav.toggleFocusMode",
  "nav.quickSwitcher",

  // -- findActions --
  "find.inFocusedPanel",

  // -- portalActions --
  "portal.toggle",
  "portal.closeTab",
  "portal.nextTab",
  "portal.prevTab",
  "portal.newTab",
  "portal.closeAllTabs",
  "portal.activateTab",
  "portal.openLaunchpad",
  "portal.openUrl",
  "portal.goBack",
  "portal.goForward",
  "portal.reload",
  "portal.copyUrl",
  "portal.openExternal",
  "portal.duplicateTab",
  "portal.reloadTab",
  "portal.copyTabUrl",
  "portal.openTabExternal",
  "portal.closeOthers",
  "portal.closeToRight",
  "portal.resetWidth",
  "portal.width.set",
  "portal.setDefaultNewTab",
  "portal.links.add",
  "portal.links.remove",
  "portal.links.update",
  "portal.links.toggle",
  "portal.links.reorder",
  "portal.tabs.reorder",
  "portal.listTabs",
  "portal.toggleDevDashboard",

  // -- helpActions --
  "help.gettingStarted.show",
  "help.displayImage",
  "help.openCommandsFolder",

  // -- uiActions --
  "ui.sidebar.resetWidth",

  // -- devServerActions --
  "devServer.start",
  "devPreview.stop",

  // -- devPreviewActions --
  "devPreview.reloadPreview",
  "devPreview.restart",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
  "devPreview.promoteToPortal",

  // -- envActions --
  "env.global.get",
  "env.global.set",
  "env.project.get",
  "env.project.set",

  // -- fleetActions (runtime-registered) --
  "fleet.accept",
  "fleet.reject",
  "fleet.interrupt",
  "fleet.restart",
  "fleet.kill",
  "fleet.trash",
  "fleet.armAll",
  "fleet.armFocused",
  "fleet.scope.enter",
  "fleet.scope.exit",
  "fleet.armMatchingFilter",
  "fleet.retryFailures",
  "fleet.saveNamedFleet",
  "fleet.recallNamedFleet",
  "fleet.deleteNamedFleet",
  "fleet.getRunStatus",
] as const;

export type BuiltInRuntimeActionId = (typeof BUILT_IN_ACTION_IDS)[number];

// Built-in actions flagged `denyPluginDispatch: true` (terminal input injection,
// fleet command relays) can never be dispatched from a plugin contribution — the
// host refuses the dispatch at runtime. A contribution wired to one of these
// paints a button that is dead on arrival, so the manifest validator rejects it
// at authoring time. `satisfies readonly BuiltInRuntimeActionId[]` is a
// compile-time drift guard: renaming or removing any of these built-ins breaks
// the build instead of silently leaving a stale entry here (#8341).
export const DENY_PLUGIN_DISPATCH_ACTION_IDS = [
  "terminal.sendCommand",
  "terminal.paste",
  "fleet.accept",
  "fleet.reject",
  "fleet.interrupt",
  "fleet.retryFailures",
] as const satisfies readonly BuiltInRuntimeActionId[];
