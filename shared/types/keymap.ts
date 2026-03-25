/**
 * Keymap types for configurable keyboard shortcuts
 *
 * These types define the keyboard shortcut system used throughout the application.
 */

import type { AgentKeyAction } from "../config/agentIds.js";
import { BUILT_IN_AGENT_KEY_ACTIONS } from "../config/agentIds.js";

/**
 * Semantic actions that can be triggered by keyboard shortcuts.
 * Actions are namespaced by category for organization.
 */
type WorktreeSwitchIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type WorktreeSwitchAction = `worktree.switch${WorktreeSwitchIndex}`;

export type KeyAction =
  // Navigation actions
  | "nav.up"
  | "nav.down"
  | "nav.left"
  | "nav.right"
  | "nav.pageUp"
  | "nav.pageDown"
  | "nav.home"
  | "nav.end"
  | "nav.expand"
  | "nav.collapse"
  | "nav.primary"
  | "nav.toggleSidebar"
  | "nav.quickSwitcher"
  | "nav.focusRegion.next"
  | "nav.focusRegion.prev"

  // File operations
  | "file.open"
  | "file.copyPath"
  | "file.copyTree"

  // UI actions
  | "ui.refresh"
  | "ui.escape"

  // Git/Worktree actions
  | "git.commit"
  | "git.push"
  | "git.stageAll"
  | "git.toggle"
  | "worktree.next"
  | "worktree.previous"
  | "worktree.panel"
  | WorktreeSwitchAction
  | "worktree.up"
  | "worktree.down"
  | "worktree.upVim"
  | "worktree.downVim"
  | "worktree.home"
  | "worktree.end"
  | "worktree.select"
  | "worktree.selectSpace"
  | "worktree.copyTree"
  | "worktree.openEditor"
  | "worktree.openPalette"
  | "worktree.overview"
  | "worktree.sessions.minimizeAll"
  | "worktree.sessions.maximizeAll"
  | "worktree.sessions.restartAll"
  | "worktree.sessions.endAll"
  | "worktree.sessions.closeCompleted"
  | "worktree.sessions.trashAll"
  | "worktree.sessions.resetRenderers"

  // Tab navigation actions
  | "tab.next"
  | "tab.previous"

  // Terminal actions
  | "terminal.close"
  | "terminal.closeAll"
  | "terminal.killAll"
  | "terminal.restartAll"
  | "terminal.toggleDock"
  | "terminal.toggleDockAll"
  | "terminal.new"
  | "terminal.reopenLast"
  | "terminal.maximize"
  | "terminal.inject"
  | "terminal.focusNext"
  | "terminal.focusPrevious"
  | "terminal.focusUp"
  | "terminal.focusDown"
  | "terminal.focusLeft"
  | "terminal.focusRight"
  | "terminal.focusDock"
  | "terminal.focusIndex1"
  | "terminal.focusIndex2"
  | "terminal.focusIndex3"
  | "terminal.focusIndex4"
  | "terminal.focusIndex5"
  | "terminal.focusIndex6"
  | "terminal.focusIndex7"
  | "terminal.focusIndex8"
  | "terminal.focusIndex9"
  | "terminal.moveLeft"
  | "terminal.moveRight"
  | "terminal.moveUp"
  | "terminal.moveDown"
  | "terminal.moveToDock"
  | "terminal.moveToGrid"
  | "terminal.watch"
  | "terminal.duplicate"
  | "terminal.background"
  | "terminal.contextMenu"
  | "terminal.stashInput"
  | "terminal.popStash"
  | "terminal.scrollToLastActivity"
  | "terminal.sendToAgent"
  | "terminal.bulkCommand"

  // Agent spawning
  | "agent.palette"
  | AgentKeyAction
  | "agent.terminal"
  | "agent.focusNextWaiting"
  | "agent.focusNextWorking"
  | "agent.focusNextAgent"
  | "agent.focusPreviousAgent"
  | "dock.focusNextWaiting"

  // Find/Search
  | "find.inFocusedPanel"

  // Window/Zoom (keybinding targets)
  | "window.zoomIn"
  | "window.zoomOut"
  | "window.zoomReset"

  // Panel management
  | "panel.palette"
  | "panel.toggleDiagnostics"
  | "panel.togglePortal"
  | "panel.diagnosticsLogs"
  | "panel.diagnosticsEvents"
  | "panel.diagnosticsMessages"

  // Portal actions
  | "portal.newTab"
  | "portal.closeTab"
  | "portal.nextTab"
  | "portal.prevTab"

  // Notes actions
  | "notes.openPalette"

  // Action palette
  | "action.palette"
  | "action.palette.open"

  // Project actions
  | "project.switcherPalette"

  // Help/Settings
  | "help.shortcuts"
  | "help.shortcutsAlt"
  | "app.settings"

  // Voice input
  | "voiceInput.toggle"

  // Layout undo/redo
  | "layout.undo"
  | "layout.redo"

  // System actions
  | "app.quit"
  | "app.forceQuit"
  | "modal.close";

/**
 * All valid KeyAction values as a runtime set for validation.
 * Used by import/export to filter unknown action IDs.
 */
export const KEY_ACTION_VALUES: ReadonlySet<string> = new Set<string>([
  "nav.up",
  "nav.down",
  "nav.left",
  "nav.right",
  "nav.pageUp",
  "nav.pageDown",
  "nav.home",
  "nav.end",
  "nav.expand",
  "nav.collapse",
  "nav.primary",
  "nav.toggleSidebar",
  "nav.quickSwitcher",
  "nav.focusRegion.next",
  "nav.focusRegion.prev",
  "file.open",
  "file.copyPath",
  "file.copyTree",
  "ui.refresh",
  "ui.escape",
  "git.commit",
  "git.push",
  "git.stageAll",
  "git.toggle",
  "worktree.next",
  "worktree.previous",
  "worktree.panel",
  "worktree.switch1",
  "worktree.switch2",
  "worktree.switch3",
  "worktree.switch4",
  "worktree.switch5",
  "worktree.switch6",
  "worktree.switch7",
  "worktree.switch8",
  "worktree.switch9",
  "worktree.up",
  "worktree.down",
  "worktree.upVim",
  "worktree.downVim",
  "worktree.home",
  "worktree.end",
  "worktree.select",
  "worktree.selectSpace",
  "worktree.copyTree",
  "worktree.openEditor",
  "worktree.openPalette",
  "worktree.overview",
  "worktree.sessions.minimizeAll",
  "worktree.sessions.maximizeAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.endAll",
  "worktree.sessions.closeCompleted",
  "worktree.sessions.trashAll",
  "worktree.sessions.resetRenderers",
  "tab.next",
  "tab.previous",
  "terminal.close",
  "terminal.closeAll",
  "terminal.killAll",
  "terminal.restartAll",
  "terminal.toggleDock",
  "terminal.toggleDockAll",
  "terminal.new",
  "terminal.reopenLast",
  "terminal.maximize",
  "terminal.inject",
  "terminal.focusNext",
  "terminal.focusPrevious",
  "terminal.focusUp",
  "terminal.focusDown",
  "terminal.focusLeft",
  "terminal.focusRight",
  "terminal.focusDock",
  "terminal.focusIndex1",
  "terminal.focusIndex2",
  "terminal.focusIndex3",
  "terminal.focusIndex4",
  "terminal.focusIndex5",
  "terminal.focusIndex6",
  "terminal.focusIndex7",
  "terminal.focusIndex8",
  "terminal.focusIndex9",
  "terminal.moveLeft",
  "terminal.moveRight",
  "terminal.moveUp",
  "terminal.moveDown",
  "terminal.moveToDock",
  "terminal.moveToGrid",
  "terminal.watch",
  "terminal.duplicate",
  "terminal.contextMenu",
  "terminal.stashInput",
  "terminal.popStash",
  "terminal.scrollToLastActivity",
  "terminal.sendToAgent",
  "terminal.bulkCommand",
  "agent.palette",
  ...BUILT_IN_AGENT_KEY_ACTIONS,
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
  "agent.focusNextAgent",
  "agent.focusPreviousAgent",
  "dock.focusNextWaiting",
  "find.inFocusedPanel",
  "window.zoomIn",
  "window.zoomOut",
  "window.zoomReset",
  "panel.palette",
  "panel.toggleDiagnostics",
  "panel.togglePortal",
  "panel.diagnosticsLogs",
  "panel.diagnosticsEvents",
  "panel.diagnosticsMessages",
  "portal.newTab",
  "portal.closeTab",
  "portal.nextTab",
  "portal.prevTab",
  "notes.openPalette",
  "action.palette",
  "action.palette.open",
  "project.switcherPalette",
  "help.shortcuts",
  "help.shortcutsAlt",
  "app.settings",
  "voiceInput.toggle",
  "layout.undo",
  "layout.redo",
  "app.quit",
  "app.forceQuit",
  "modal.close",
]);

/**
 * Available keymap presets.
 * - 'standard': Default keybindings (arrow keys, etc.)
 * - 'vim': Vim-style keybindings (hjkl navigation, etc.)
 */
export type KeymapPreset = "standard" | "vim";

/**
 * Configuration for keyboard shortcuts.
 * Supports preset-based configuration with optional overrides.
 */
export interface KeyMapConfig {
  /**
   * Preset keymap to use as a base.
   * The preset provides default bindings that can be customized via overrides.
   */
  preset?: KeymapPreset;

  /**
   * Override specific key bindings.
   * Maps actions to arrays of key strings (e.g., { 'nav.up': ['j', 'up'] }).
   * Multiple keys can be bound to the same action.
   */
  overrides?: Partial<Record<KeyAction, string[]>>;
}
