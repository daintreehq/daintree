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
  "terminal.sendCommandOwned",
  "terminal.sendCommandMany",
  "terminal.closeMany",
  "terminal.waitForExit",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.readLastMessageOwned",
  "terminal.resumeSessions",

  // -- terminalNotifyActions --
  "terminal.notifyWhenIdle",

  // -- terminalMetaActions --
  "terminal.setClientMetadata",

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
  "worktree.deleteOwned",
  "worktree.retireOwned",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.reveal",
  "worktree.openIssue",
  "worktree.openPR",
  "worktree.copyContext",
  "worktree.inject",
  "worktree.getAvailableBranch",
  "worktree.waitUntilReady",
  "worktree.waitForPullRequest",
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
  "worktree.markReviewed",
  "worktree.clearReviewMark",
  "worktree.openFileBrowser",
  "worktree.openFileBrowserPanel",
  "worktree.openChanges",
  "worktree.overview.open",
  "worktree.overview.close",
  "worktree.setLabelColor",
  "worktree.setCustomTitle",

  // -- worktreeResourceActions --
  "worktree.resource.provision",
  "worktree.resource.teardown",
  "worktree.resource.resume",
  "worktree.resource.pause",
  "worktree.resource.status",
  "worktree.resource.connect",
  "worktree.resource.openOnHost",
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

  // -- sessionRestoreActions --
  "sessionRestore.getConfig",
  "sessionRestore.updateConfig",

  // -- windowOpeningActions --
  "windowOpening.getConfig",
  "windowOpening.updateConfig",

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
  "file.read",
  "file.openDiff",
  "file.openInEditor",
  "file.openInBrowser",
  "file.openImageViewer",
  "file.showItemInFolder",
  "file.trash",
  "file.openPanel",

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
  "git.discardFileChanges",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.pullRebase",
  "git.fetch",
  "git.rebaseOntoBase",
  "git.mergeBaseIntoBranch",
  "git.abortRepositoryOperation",
  "git.continueRepositoryOperation",
  "git.forcePushWithLease",
  "git.markSafeDirectory",
  "git.retryAuthFetch",
  "git.getStagingStatus",

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
  "forge.openRepo",
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
  "forge.listIssueComments",
  "forge.getChecks",
  "forge.getPR",
  "forge.getPRs",
  "forge.getCIStatus",
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.enableAutoMerge",
  "forge.disableAutoMerge",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",

  // -- projectActions --
  "pilot.toggle",
  "pilot.openProject",
  "pilot.openRun",

  // -- canopyActions --
  "canopy.toggle",
  "canopy.markAllRead",
  "project.getAll",
  "project.getCurrent",
  "project.add",
  "project.openInNewWindow",
  "project.switch",
  "project.update",
  "project.toggleNeverAutoSleep",
  "project.sleep",
  "project.restart",
  "project.sleepIdle",
  "project.remove",
  "project.archive",
  "project.unarchive",
  "project.setGroup",
  "project.listGroups",
  "project.createGroup",
  "project.close",
  "project.closeActive",
  "project.openDialog",
  "project.getSettings",
  "project.saveSettings",
  "project.muteNotifications",
  "project.silenceNotificationKind",
  "project.detectRunners",
  "project.runCheck",
  "project.runCommand",

  // -- workspaceActions --
  "workspace.list",

  // -- pluginActions --
  "plugin.validate",
  "plugin.diagnostics",
  "plugin.reloadProject",
  "plugin.reloadPanel",
  "plugin.capturePanel",
  "plugin.reloadWindow",
  "plugin.openSettings",
  "plugin.backupDatabases",
  "plugin.setNotificationsSilenced",
  "project.getStats",
  "project.settings.open",
  "project.cloneRepo",

  // -- scheduleActions --
  "schedules.open",
  "schedules.runNow",

  // -- hostActions (registered only where Remote Hosts is supported) --
  "host.switch",
  "host.add",
  "host.overview.open",
  "project.openOnHost",
  "host.forwardPort",

  // -- appActions --
  "app.pluginManager",
  "app.reloadConfig",
  "app.exportConfig",
  "app.importConfig",
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

  // -- layoutActions --
  "layout.apply",

  // -- agentActions --
  "agent.launch",
  "agent.launchMany",
  "agent.launchInNewWorktree",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
  "agent.focusNextAgent",
  "agent.focusPreviousAgent",
  "agent.getState",
  "agent.listToolbar",
  "agent.listAvailable",
  "agent.listPresets",
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
  "agent.listModels",
  "agentSessionHistory.list",
  "agentSessionHistory.resume",
  // -- session bookmarks (#11288) --
  "session.bookmarkAndClose",
  "session.bookmark.promote",
  "session.bookmark.rename",
  "session.bookmark.delete",
  "session.bookmarks.list",

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
  "mcp.surface",

  // -- terminalLifecycleActions --
  "terminal.restart",
  "terminal.restartOnPreset",
  "terminal.restartOnPresetOwned",
  "terminal.startHeld",
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
  "terminal.closeOwned",
  "terminal.revealOwned",
  "terminal.placeOwned",
  "terminal.trash",
  "terminal.kill",
  "terminal.killBatch",
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
  "terminal.injectOwned",
  "terminal.bulkCommand",
  "terminal.interrupt",
  "terminal.interruptOwned",
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
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
  "terminal.sessionFile.get",
  "terminal.setHoldOnRestart",

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
  "nav.showProjectHome",
  "nav.showProjectSplit",
  "nav.showGrid",

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
  "help.tour.show",
  "help.tour.status",
  "help.displayImage",
  "help.openCommandsFolder",
  "help.newSessionWithAgent",
  "help.resumePastSession",

  // -- assistantControlActions --
  "assistant.list",
  "assistant.start",
  "agent.readQuota",

  // -- hostControlActions (registered only where Remote Hosts is supported) --
  "host.list",
  "host.call",
  "host.ensureProject",
  "host.settings",
  "host.watch",

  // -- uiActions --
  "ui.sidebar.resetWidth",

  // -- sidebarActions --
  "ui.sidebar.switchView",
  "ui.sidebar.showWorktrees",

  // -- devServerActions --
  "devServer.start",
  "devPreview.stop",
  "devPreview.toggleTool",
  "devPreview.toggleElementPicker",

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
  "plugin.reloadWindow",
  // Plugins reload their own views through the rationed `requestReload` prop;
  // this would reach any panel, unrationed (#12611).
  "plugin.reloadPanel",
  // Plugins never read another panel's pixels (#13384).
  "plugin.capturePanel",
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
  // Plugins read terminal text through `host.terminals.readScreen` (#13155),
  // not by reading it out of an action or the clipboard.
  "terminal.getOutput",
  "terminal.copy",
  "terminal.injectOwned",
  // Main checks ownership before dispatching it; nothing in its `run()` does.
  "terminal.placeOwned",
  "terminal.setClientMetadata",
  "terminal.paste",
  "project.runCheck",
  // Runs a shell command the caller names; held to Daintree's own assistants.
  "project.runCommand",
  // Launches an agent with a schedule's preset, which a plugin's launch may not choose (#15978).
  "schedules.runNow",
  // Reloading a project's plugins unloads and re-runs every one of them,
  // including whichever plugin made the call. Nothing a plugin declares grants
  // it authority over its siblings, and self-unloading mid-dispatch is not a
  // capability so much as a way to lose the call (#12214).
  "plugin.reloadProject",
  // Raises a native save dialog for any plugin's data; only a person asks for that.
  "plugin.backupDatabases",
  // Turns off what a plugin can tell the user, so a plugin could lift its own
  // silence or silence a rival's (#13818).
  "plugin.setNotificationsSilenced",
  "fleet.accept",
  "fleet.reject",
  "fleet.interrupt",
  "fleet.retryFailures",
  "terminal.interrupt",
  "terminal.interruptOwned",
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
  "terminal.sendCommandMany",
  "terminal.closeMany",
  "agent.launchMany",
  // Runs its create, wait and launch as single calls through main's MCP gate.
  "agent.launchInNewWorktree",
  "terminal.readLastMessageOwned",
  // Main checks ownership before dispatching it; nothing in its `run()` does.
  "terminal.restartOnPresetOwned",
  // Main-process only, keyed on the caller's MCP credential: a plugin dispatch
  // has no pane to notify.
  "terminal.notifyWhenIdle",
  // Main-process only, keyed on what the caller's MCP credential closed (#15728):
  // a plugin dispatch closed nothing to wait for.
  "terminal.waitForExit",
  // Main-process only, keyed on what the caller's MCP credential created
  // (#15737): a plugin dispatch created no worktree to retire.
  "worktree.retireOwned",
  // Main-process only, for an assistant caller: a plugin is no assistant (#13496).
  "assistant.list",
  "assistant.start",
  "agent.readQuota",
  // Main-process only, for one of this machine's own assistants (#13493).
  "host.list",
  "host.call",
  "host.ensureProject",
  "host.settings",
  "host.watch",
  // Replays the user's last action as a keybinding, which would carry a plugin
  // past every other entry in this list (#13494).
  "action.repeatLast",
  // Persists custom flags, bypass mode and presets into every later launch of
  // that agent: the configuration a plugin's own agent.launch is refused (#13762).
  "agentSettings.set",
  // The same configuration one preset at a time (#16047).
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
] as const satisfies readonly BuiltInRuntimeActionId[];
