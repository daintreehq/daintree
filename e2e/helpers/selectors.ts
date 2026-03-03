export const SEL = {
  toolbar: {
    toggleSidebar: '[aria-label="Toggle Sidebar"]',
    openTerminal: '[aria-label="Open Terminal"]',
    openSettings: '[aria-label="Open settings"]',
    openBrowser: '[aria-label="Open Browser"]',
    copyContext: '[aria-label="Copy Context"]',
    notesButton: '[aria-label="Notes"]',
    projectSwitcherTrigger: '[data-testid="project-switcher-trigger"]',
    sidecarToggle: '[aria-label="Toggle Sidecar"]',
  },
  sidebar: {
    resizeHandle: '[aria-label="Resize sidebar"]',
  },
  settings: {
    heading: 'h2:has-text("Settings")',
    closeButton: '[aria-label="Close settings"]',
    navSidebar: ".w-48",
  },
  panel: {
    gridPanel: '[data-panel-location="grid"]',
    dockPanel: '[data-panel-location="dock"]',
    anyPanel: "[data-panel-id]",
    close: '[data-testid="panel-close"]',
    maximize: '[aria-label*="Maximize"]',
    exitFocus: '[aria-label*="Exit Focus"]',
    minimize: '[aria-label*="Minimize to dock"]',
    restoreFromDock: '[aria-label*="Restore from dock"]',
  },
  terminal: {
    xtermRows: ".xterm-rows",
    cmEditor: ".cm-content",
  },
  worktree: {
    card: (branch: string) => `[data-worktree-branch="${branch}"]`,
    actionsMenu: '[data-testid="worktree-actions-menu"]',
    newDialog: '[data-testid="new-worktree-dialog"]',
    branchNameInput: '[data-testid="branch-name-input"]',
    createButton: '[data-testid="create-worktree-button"]',
    deleteDialog: '[data-testid="delete-worktree-dialog"]',
    deleteConfirm: '[data-testid="delete-worktree-confirm"]',
  },
  dock: {
    container: "#dock-container",
  },
  browser: {
    addressBar: '[data-testid="browser-address-bar"]',
  },
  projectSwitcher: {
    palette: '[data-testid="project-switcher-palette"]',
    addButton: '[data-testid="project-add-button"]',
  },
  trash: {
    container: '[data-testid="trash-container"]',
  },
  notes: {
    palette: '[data-testid="notes-palette"]',
  },
  welcome: {
    openFolder: 'button:has-text("Open Folder")',
  },
  onboarding: {
    heading: 'h2:has-text("Set up your project")',
    projectNameInput: '[aria-label="Project Name"]',
    finishButton: 'button:has-text("Finish")',
  },
  agent: {
    panel: '[aria-label^="Claude agent:"]',
    startButton: '[aria-label="Start Claude Agent"]',
  },
} as const;
