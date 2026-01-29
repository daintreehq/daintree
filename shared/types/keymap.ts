/**
 * Keymap types for configurable keyboard shortcuts
 *
 * These types define the keyboard shortcut system used throughout the application.
 */

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

  // File operations
  | "file.open"
  | "file.copyPath"
  | "file.copyTree"

  // UI actions
  | "ui.refresh"
  | "ui.escape"

  // Git/Worktree actions
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

  // Tab navigation actions
  | "tab.next"
  | "tab.previous"

  // Terminal actions
  | "terminal.close"
  | "terminal.closeAll"
  | "terminal.killAll"
  | "terminal.restartAll"
  | "terminal.minimize"
  | "terminal.minimizeAll"
  | "terminal.restore"
  | "terminal.restoreAll"
  | "terminal.new"
  | "terminal.spawnPalette"
  | "terminal.palette"
  | "terminal.reopenLast"
  | "terminal.maximize"
  | "terminal.inject"
  | "terminal.focusNext"
  | "terminal.focusPrevious"
  | "terminal.focusUp"
  | "terminal.focusDown"
  | "terminal.focusLeft"
  | "terminal.focusRight"
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

  // Agent spawning
  | "agent.palette"
  | "agent.claude"
  | "agent.gemini"
  | "agent.codex"
  | "agent.opencode"
  | "agent.terminal"
  | "agent.focusNextWaiting"
  | "agent.focusNextFailed"
  | "agent.commandBar"

  // Assistant panel
  | "assistant.open"

  // Panel management
  | "panel.palette"
  | "panel.toggleDock"
  | "panel.toggleDockAlt"
  | "panel.dockCycleMode"
  | "panel.dockSetExpanded"
  | "panel.dockSetSlim"
  | "panel.dockSetHidden"
  | "panel.dockToggleAutoHide"
  | "panel.toggleDiagnostics"
  | "panel.toggleSidecar"
  | "panel.diagnosticsLogs"
  | "panel.diagnosticsEvents"
  | "panel.diagnosticsMessages"

  // Sidecar actions
  | "sidecar.newTab"
  | "sidecar.closeTab"
  | "sidecar.nextTab"
  | "sidecar.prevTab"

  // Notes actions
  | "notes.openPalette"

  // Project actions
  | "project.switcherPalette"

  // Help/Settings
  | "help.shortcuts"
  | "help.shortcutsAlt"
  | "app.settings"

  // System actions
  | "app.quit"
  | "app.forceQuit"
  | "modal.close";

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
