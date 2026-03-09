import type { SettingsTab } from "./SettingsDialog";

export interface SettingsSearchEntry {
  id: string;
  tab: SettingsTab;
  tabLabel: string;
  /** Optional subtab id to activate when navigating to this result. */
  subtab?: string;
  /** Human-readable subtab label used in search breadcrumbs and haystack. */
  subtabLabel?: string;
  section: string;
  title: string;
  description: string;
  keywords?: string[];
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // General
  {
    id: "general-about",
    tab: "general",
    tabLabel: "General",
    section: "About",
    title: "About Canopy",
    description: "App version and description",
    keywords: ["version", "about", "info", "beta"],
  },
  {
    id: "general-system-status",
    tab: "general",
    tabLabel: "General",
    section: "System Status",
    title: "System Status",
    description: "CLI agent availability — Claude, Gemini, Codex, OpenCode status",
    keywords: ["agents", "cli", "available", "status", "check", "ready"],
  },
  {
    id: "general-hibernation",
    tab: "general",
    tabLabel: "General",
    section: "Auto-Hibernation",
    title: "Auto-Hibernation",
    description:
      "Automatically stop terminals and servers for inactive projects. Reduces system resource usage.",
    keywords: ["hibernate", "sleep", "inactive", "stop", "resources", "idle", "auto"],
  },
  {
    id: "general-hibernation-threshold",
    tab: "general",
    tabLabel: "General",
    section: "Auto-Hibernation",
    title: "Inactivity Threshold",
    description: "How long before a project is hibernated: 12h, 24h, 48h, or 72h",
    keywords: ["hibernate", "threshold", "hours", "timeout", "inactivity"],
  },
  {
    id: "general-project-pulse",
    tab: "general",
    tabLabel: "General",
    section: "Display",
    title: "Project Pulse",
    description: "Show activity heatmap on the empty panel grid",
    keywords: ["heatmap", "activity", "pulse", "display", "visualization"],
  },
  {
    id: "general-developer-tools",
    tab: "general",
    tabLabel: "General",
    section: "Display",
    title: "Developer Tools",
    description: "Show problems panel button in the toolbar",
    keywords: ["developer", "debug", "problems", "panel", "toolbar"],
  },

  // Keyboard Shortcuts
  {
    id: "keyboard-shortcuts",
    tab: "keyboard",
    tabLabel: "Keyboard",
    section: "Keyboard Shortcuts",
    title: "Keyboard Shortcuts",
    description:
      "View and customize keyboard bindings for all actions. Search and override shortcuts.",
    keywords: ["keybindings", "shortcuts", "hotkeys", "bindings", "key", "remap"],
  },
  {
    id: "keyboard-profiles",
    tab: "keyboard",
    tabLabel: "Keyboard",
    section: "Keyboard Shortcuts",
    title: "Shortcut Profiles",
    description: "Import and export shortcut profile configurations",
    keywords: ["profile", "import", "export", "backup", "keybindings"],
  },
  {
    id: "keyboard-reset",
    tab: "keyboard",
    tabLabel: "Keyboard",
    section: "Keyboard Shortcuts",
    title: "Reset All Shortcuts",
    description: "Reset all keyboard shortcuts to their default bindings",
    keywords: ["reset", "default", "shortcuts", "restore", "keybindings"],
  },

  // Terminal (Panel Grid)
  {
    id: "terminal-performance-mode",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Performance Mode",
    title: "Performance Mode",
    description:
      "Reduces scrollback and disables animations for maximum performance on low-end hardware",
    keywords: ["performance", "speed", "low-end", "memory", "animation", "disable"],
  },
  {
    id: "terminal-hybrid-input",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Hybrid Input Bar",
    title: "Hybrid Input Bar",
    description: "Show the multi-line input bar on agent terminals",
    keywords: ["input", "hybrid", "bar", "multi-line", "agent", "textarea"],
  },
  {
    id: "terminal-hybrid-autofocus",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Hybrid Input Bar",
    title: "Auto-Focus Input",
    description: "Selecting a pane focuses the input bar or the terminal (xterm)",
    keywords: ["focus", "autofocus", "input", "pane", "select"],
  },
  {
    id: "terminal-two-pane-split",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Two-Pane Split Layout",
    title: "Two-Pane Split Layout",
    description: "When exactly two panels are open, display them with a resizable divider",
    keywords: ["split", "two pane", "layout", "divider", "resize", "ratio"],
  },
  {
    id: "terminal-scrollback",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Scrollback History",
    title: "Scrollback History",
    description: "Set base scrollback lines for terminal history: 1,000, 5,000, or 10,000 lines",
    keywords: ["scrollback", "history", "lines", "buffer", "memory", "terminal"],
  },
  {
    id: "terminal-grid-layout",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Grid Layout Strategy",
    title: "Grid Layout Strategy",
    description: "Control how panels arrange in the grid: automatic, fixed columns, or fixed rows",
    keywords: ["grid", "layout", "columns", "rows", "panels", "arrangement", "strategy"],
  },

  // Appearance
  {
    id: "appearance-theme",
    tab: "terminalAppearance",
    tabLabel: "Appearance",
    section: "App Theme",
    title: "App Theme",
    description: "Choose the application color theme",
    keywords: ["theme", "dark", "light", "color", "scheme", "appearance", "mode"],
  },
  {
    id: "appearance-color-scheme",
    tab: "terminalAppearance",
    tabLabel: "Appearance",
    section: "Terminal Color Scheme",
    title: "Terminal Color Scheme",
    description: "Choose the terminal color scheme and palette",
    keywords: ["color", "scheme", "terminal", "colors", "palette", "theme"],
  },
  {
    id: "appearance-font-size",
    tab: "terminalAppearance",
    tabLabel: "Appearance",
    section: "Font Size",
    title: "Font Size",
    description: "Set terminal font size from 8px to 24px",
    keywords: ["font", "size", "text", "px", "terminal", "larger", "smaller"],
  },
  {
    id: "appearance-font-family",
    tab: "terminalAppearance",
    tabLabel: "Appearance",
    section: "Font Family",
    title: "Font Family",
    description: "Choose terminal font: JetBrains Mono or system monospace",
    keywords: ["font", "family", "mono", "JetBrains", "monospace", "typeface"],
  },

  // Worktree Paths
  {
    id: "worktree-path-pattern",
    tab: "worktree",
    tabLabel: "Worktree",
    section: "Worktree Path Pattern",
    title: "Worktree Path Pattern",
    description:
      "Customize where worktrees are created using variables: {base-folder}, {branch-slug}, {repo-name}, {parent-dir}",
    keywords: ["worktree", "path", "pattern", "branch", "folder", "directory", "location", "git"],
  },

  // CLI Agents
  {
    id: "agents-enable",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Agent Runtime Settings",
    title: "Enable / Disable Agent",
    description: "Enable or disable individual CLI agents: Claude, Gemini, Codex, OpenCode",
    keywords: ["agent", "enable", "disable", "claude", "gemini", "codex", "opencode", "select"],
  },
  {
    id: "agents-skip-permissions",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Agent Runtime Settings",
    title: "Skip Permissions",
    description: "Auto-approve all agent actions without confirmation prompts",
    keywords: ["permissions", "auto-approve", "confirm", "prompts", "dangerous", "allow", "bypass"],
  },
  {
    id: "agents-inline-mode",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Agent Runtime Settings",
    title: "Inline Mode",
    description: "Disable fullscreen TUI for better resize handling and scrollback",
    keywords: ["inline", "mode", "tui", "fullscreen", "resize", "tty"],
  },
  {
    id: "agents-clipboard",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Agent Runtime Settings",
    title: "Share Clipboard Directory",
    description: "Allow Gemini to read pasted clipboard images",
    keywords: ["clipboard", "images", "share", "gemini", "paste", "screenshot"],
  },
  {
    id: "agents-custom-args",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Agent Runtime Settings",
    title: "Custom Arguments",
    description: "Extra CLI flags appended when launching agents",
    keywords: ["args", "arguments", "flags", "cli", "custom", "launch", "options"],
  },
  {
    id: "agents-installation",
    tab: "agents",
    tabLabel: "CLI Agents",
    section: "Installation",
    title: "Agent Installation",
    description: "Install and set up CLI agents. Run setup wizard to install.",
    keywords: ["install", "setup", "wizard", "cli", "download", "npm", "brew"],
  },

  // GitHub Integration
  {
    id: "github-token",
    tab: "github",
    tabLabel: "GitHub",
    section: "Personal Access Token",
    title: "GitHub Personal Access Token",
    description: "Configure GitHub authentication token. Required scopes: repo, read:org",
    keywords: ["github", "token", "authentication", "auth", "PAT", "access", "scopes", "API"],
  },

  // Sidecar Links
  {
    id: "sidecar-default-agent",
    tab: "sidecar",
    tabLabel: "Sidecar",
    section: "Default New Tab Agent",
    title: "Default New Tab Agent",
    description: "Choose which agent opens when you click the + button in the sidecar",
    keywords: ["sidecar", "agent", "default", "new tab", "browser"],
  },
  {
    id: "sidecar-default-links",
    tab: "sidecar",
    tabLabel: "Sidecar",
    section: "Default Links",
    title: "Default Links",
    description: "System-provided links shown in the sidecar panel",
    keywords: ["sidecar", "links", "default", "browser", "bookmarks"],
  },
  {
    id: "sidecar-custom-links",
    tab: "sidecar",
    tabLabel: "Sidecar",
    section: "Custom Links",
    title: "Custom Links",
    description: "Add custom URLs and links to the sidecar panel",
    keywords: ["sidecar", "custom", "links", "url", "add", "bookmark"],
  },
  {
    id: "sidecar-width",
    tab: "sidecar",
    tabLabel: "Sidecar",
    section: "Default Width",
    title: "Sidecar Default Width",
    description: "Set the default width of the sidecar panel",
    keywords: ["sidecar", "width", "size", "panel", "resize"],
  },

  // Toolbar Customization
  {
    id: "toolbar-left-buttons",
    tab: "toolbar",
    tabLabel: "Toolbar",
    section: "Left Side Buttons",
    title: "Left Toolbar Buttons",
    description: "Drag to reorder, uncheck to hide left toolbar buttons",
    keywords: ["toolbar", "buttons", "left", "reorder", "customize", "hide"],
  },
  {
    id: "toolbar-right-buttons",
    tab: "toolbar",
    tabLabel: "Toolbar",
    section: "Right Side Buttons",
    title: "Right Toolbar Buttons",
    description: "Drag to reorder, uncheck to hide right toolbar buttons",
    keywords: ["toolbar", "buttons", "right", "reorder", "customize", "hide"],
  },
  {
    id: "toolbar-launcher",
    tab: "toolbar",
    tabLabel: "Toolbar",
    section: "Launcher Palette",
    title: "Launcher Palette Settings",
    description: "Configure the default panel type in the launcher. Always show dev server option.",
    keywords: ["launcher", "palette", "default", "panel", "dev server", "open"],
  },
  {
    id: "toolbar-reset",
    tab: "toolbar",
    tabLabel: "Toolbar",
    section: "Toolbar Customization",
    title: "Reset Toolbar to Defaults",
    description: "Reset all toolbar button positions and visibility to defaults",
    keywords: ["reset", "default", "toolbar", "restore"],
  },

  // Notifications
  {
    id: "notifications-completed",
    tab: "notifications",
    tabLabel: "Notifications",
    section: "Agent Notifications",
    title: "Agent Completed Notification",
    description: "Show a notification when an agent finishes its task",
    keywords: ["notification", "alert", "complete", "done", "agent", "finish"],
  },
  {
    id: "notifications-waiting",
    tab: "notifications",
    tabLabel: "Notifications",
    section: "Agent Notifications",
    title: "Agent Waiting for Input",
    description: "Show a notification when an agent needs input",
    keywords: ["notification", "waiting", "input", "agent", "prompt", "pause"],
  },
  {
    id: "notifications-failed",
    tab: "notifications",
    tabLabel: "Notifications",
    section: "Agent Notifications",
    title: "Agent Failed Notification",
    description: "Show a notification when an agent encounters an error",
    keywords: ["notification", "error", "failed", "agent", "alert"],
  },
  {
    id: "notifications-sound",
    tab: "notifications",
    tabLabel: "Notifications",
    section: "Sound",
    title: "Notification Sound",
    description:
      "Play a sound when notifications fire. Choose from chime, ping, complete, waiting, or error sounds.",
    keywords: ["sound", "audio", "chime", "ping", "notification", "alert", "volume"],
  },

  // Editor Integration
  {
    id: "editor-external",
    tab: "editor",
    tabLabel: "Editor",
    section: "External Editor",
    title: "External Editor",
    description:
      "Configure external editor: VS Code, Cursor, Windsurf, Zed, Neovim, WebStorm, Sublime Text, or custom",
    keywords: [
      "editor",
      "vscode",
      "cursor",
      "zed",
      "neovim",
      "webstorm",
      "sublime",
      "external",
      "open",
      "ide",
      "windsurf",
    ],
  },

  // Troubleshooting
  {
    id: "troubleshooting-health",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "System Health Check",
    title: "System Health Check",
    description: "Verify Git, Node.js, npm installation and system dependencies",
    keywords: ["health", "check", "git", "node", "npm", "system", "verify", "diagnosis"],
  },
  {
    id: "troubleshooting-logs",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Application Logs",
    title: "Application Logs",
    description: "Open log file and clear application logs",
    keywords: ["logs", "debug", "log file", "clear", "application", "output"],
  },
  {
    id: "troubleshooting-crash",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Crash Reporting",
    title: "Crash Reporting",
    description: "Enable crash reporting to collect error messages and stack traces",
    keywords: ["crash", "reporting", "telemetry", "error", "stack trace", "sentry"],
  },
  {
    id: "troubleshooting-devmode",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Developer Mode",
    title: "Developer Mode",
    description:
      "Enable developer mode, auto-open diagnostics, verbose logging, persistent verbose logging",
    keywords: [
      "developer",
      "debug",
      "verbose",
      "logging",
      "diagnostics",
      "devtools",
      "CANOPY_DEBUG",
    ],
  },
  {
    id: "troubleshooting-auto-diagnostics",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Developer Mode",
    title: "Auto-Open Diagnostics Dock",
    description: "Automatically open the diagnostics panel on app startup",
    keywords: ["diagnostics", "dock", "auto", "startup", "open", "developer"],
  },
  {
    id: "troubleshooting-focus-events",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Developer Mode",
    title: "Focus Events Tab",
    description: "Default to the Events tab when the diagnostics panel opens",
    keywords: ["events", "focus", "diagnostics", "tab", "developer"],
  },
  {
    id: "troubleshooting-verbose-logging",
    tab: "troubleshooting",
    tabLabel: "Troubleshooting",
    section: "Developer Mode",
    title: "Enable Verbose Logging",
    description: "Enable verbose logging for this session only. Resets on app restart.",
    keywords: ["verbose", "logging", "debug", "log level", "session"],
  },

  // Terminal sub-controls
  {
    id: "terminal-preview-layout",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Two-Pane Split Layout",
    title: "Preview-Focused Layout",
    description:
      "Give more space to browser or dev-preview panels (65/35 split) vs balanced layout (50/50)",
    keywords: ["preview", "browser", "focused", "ratio", "split", "layout", "two pane"],
  },
  {
    id: "terminal-default-ratio",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Two-Pane Split Layout",
    title: "Default Split Ratio",
    description: "Set the default left/right split ratio for two-pane layout",
    keywords: ["ratio", "split", "default", "percentage", "slider", "two pane"],
  },
  {
    id: "terminal-reset-ratios",
    tab: "terminal",
    tabLabel: "Terminal",
    section: "Two-Pane Split Layout",
    title: "Reset All Worktree Split Ratios",
    description: "Clear all per-worktree split ratio overrides and return to the default ratio",
    keywords: ["reset", "worktree", "ratio", "split", "default", "clear"],
  },

  // MCP Server
  {
    id: "mcp-server-enable",
    tab: "mcp",
    tabLabel: "MCP Server",
    section: "MCP Server",
    title: "Enable MCP Server",
    description:
      "Start a local MCP server so AI agents can invoke Canopy actions (open terminals, inject context, switch worktrees, etc.)",
    keywords: ["mcp", "server", "agent", "local", "tools", "automation", "api", "enable"],
  },
  {
    id: "mcp-server-config",
    tab: "mcp",
    tabLabel: "MCP Server",
    section: "Connection",
    title: "Copy MCP Config",
    description:
      "Copy the MCP server config snippet (JSON) to paste into your MCP client configuration",
    keywords: ["mcp", "config", "copy", "snippet", "json", "client", "cursor", "claude"],
  },
  {
    id: "mcp-server-port",
    tab: "mcp",
    tabLabel: "MCP Server",
    section: "Port",
    title: "Server Port",
    description:
      "Set a fixed port for the MCP server or leave empty for automatic ephemeral port assignment",
    keywords: ["mcp", "port", "fixed", "ephemeral", "network", "bind"],
  },
  {
    id: "mcp-server-auth",
    tab: "mcp",
    tabLabel: "MCP Server",
    section: "Authentication",
    title: "API Key Authentication",
    description:
      "Generate a bearer token to secure MCP connections. Clients must include the token in the Authorization header.",
    keywords: ["mcp", "api", "key", "auth", "token", "bearer", "security", "password"],
  },
];
