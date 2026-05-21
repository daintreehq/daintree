import { lazy, type ReactNode } from "react";
import {
  Blocks,
  Command,
  FileCode,
  GitBranch,
  LayoutGrid,
  Mic,
  PanelRight,
  Keyboard,
  SquareTerminal,
  Settings as SettingsIcon,
  Settings2,
  LifeBuoy,
  Bell,
  KeyRound,
  Shield,
} from "lucide-react";
import { DaintreeIcon, FolderGit2, Plug, McpServerIcon, Workflow } from "@/components/icons";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { GeneralTab } from "./GeneralTab";

// ── Entry types ─────────────────────────────────────────────────────────

export interface SettingsSectionMeta {
  /** DOM-anchor id when present; otherwise a stable virtual id for search/cache. */
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly subtab?: string;
  readonly subtabLabel?: string;
  readonly requiresEnabled?: {
    readonly settingId: string;
    readonly label: string;
  };
}

export interface SettingsTabEntry {
  readonly id: string;
  readonly scope: "global" | "project";
  readonly group: string;
  readonly label: string;
  readonly headerTitle?: string;
  readonly icon: ReactNode;
  readonly importKind: "eager" | "lazy";
  readonly searchNavDescription?: string;
  readonly searchNavKeywords?: readonly string[];
  readonly sections?: readonly SettingsSectionMeta[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous component storage
type AnyComponent = React.ComponentType<any>;

export interface LazySettingsTabEntry extends SettingsTabEntry {
  readonly importKind: "lazy";
  readonly importer: () => Promise<unknown>;
  readonly LazyComponent: AnyComponent;
  readonly needsSubtabs?: boolean;
  readonly needsOnClose?: boolean;
  readonly needsOnSettingsChange?: boolean;
  readonly needsProjectForm?: boolean;
  readonly needsOnNavigateToTab?: boolean;
}

export interface EagerSettingsTabEntry extends SettingsTabEntry {
  readonly importKind: "eager";
  readonly Component: AnyComponent;
}

export type AnySettingsTabEntry = LazySettingsTabEntry | EagerSettingsTabEntry;

export interface ProjectSettingsTabSearchMeta {
  readonly tabLabel: string;
  readonly searchNavDescription: string;
  readonly searchNavKeywords: readonly string[];
  readonly sections?: readonly SettingsSectionMeta[];
}

// ── Lazy import thunks (module-level for referential stability) ─────────

const importAgentSettings = () => import("./AgentSettings");
const importTerminalSettingsTab = () => import("./TerminalSettingsTab");
const importTerminalAppearanceTab = () => import("./TerminalAppearanceTab");
const importTroubleshootingTab = () => import("./TroubleshootingTab");
const importCodeForgeSettingsTab = () => import("./CodeForgeSettingsTab");
const importNotificationSettingsTab = () => import("./NotificationSettingsTab");
const importPortalSettingsTab = () => import("./PortalSettingsTab");
const importKeyboardShortcutsTab = () => import("./KeyboardShortcutsTab");
const importWorktreeSettingsTab = () => import("./WorktreeSettingsTab");
const importToolbarSettingsTab = () => import("./ToolbarSettingsTab");
const importIntegrationsTab = () => import("./IntegrationsTab");
const importVoiceInputSettingsTab = () => import("./VoiceInputSettingsTab");
const importMcpServerSettingsTab = () => import("./McpServerSettingsTab");
const importDaintreeAssistantSettingsTab = () => import("./DaintreeAssistantSettingsTab");
const importEnvironmentSettingsTab = () => import("./EnvironmentSettingsTab");
const importPrivacyDataTab = () => import("./PrivacyDataTab");
const importProjectGeneralTab = () => import("@/components/Project/GeneralTab");
const importProjectContextTab = () => import("@/components/Project/ContextTab");
const importProjectVariablesTab = () => import("@/components/Project/EnvironmentVariablesEditor");
const importProjectAutomationTab = () => import("@/components/Project/AutomationTab");
const importProjectRecipesTab = () => import("@/components/Project/RecipesTab");
const importProjectCommandsTab = () => import("./CommandOverridesTab");
const importProjectNotificationsTab = () => import("@/components/Project/ProjectNotificationsTab");
const importProjectCodeForgeTab = () => import("@/components/Project/CodeForgeTab");

// ── Lazy components (module-level — React requires stable lazy() refs) ──

const LazyAgentSettings = lazy(() =>
  importAgentSettings().then((m) => ({ default: m.AgentSettings }))
);
const LazyTerminalSettingsTab = lazy(() =>
  importTerminalSettingsTab().then((m) => ({ default: m.TerminalSettingsTab }))
);
const LazyTerminalAppearanceTab = lazy(() =>
  importTerminalAppearanceTab().then((m) => ({ default: m.TerminalAppearanceTab }))
);
const LazyTroubleshootingTab = lazy(() =>
  importTroubleshootingTab().then((m) => ({ default: m.TroubleshootingTab }))
);
const LazyNotificationSettingsTab = lazy(() =>
  importNotificationSettingsTab().then((m) => ({ default: m.NotificationSettingsTab }))
);
const LazyPortalSettingsTab = lazy(() =>
  importPortalSettingsTab().then((m) => ({ default: m.PortalSettingsTab }))
);
const LazyKeyboardShortcutsTab = lazy(() =>
  importKeyboardShortcutsTab().then((m) => ({ default: m.KeyboardShortcutsTab }))
);
const LazyWorktreeSettingsTab = lazy(() =>
  importWorktreeSettingsTab().then((m) => ({ default: m.WorktreeSettingsTab }))
);
const LazyToolbarSettingsTab = lazy(() =>
  importToolbarSettingsTab().then((m) => ({ default: m.ToolbarSettingsTab }))
);
const LazyIntegrationsTab = lazy(() =>
  importIntegrationsTab().then((m) => ({ default: m.IntegrationsTab }))
);
const LazyCodeForgeSettingsTab = lazy(() =>
  importCodeForgeSettingsTab().then((m) => ({ default: m.CodeForgeSettingsTab }))
);
const LazyVoiceInputSettingsTab = lazy(() =>
  importVoiceInputSettingsTab().then((m) => ({ default: m.VoiceInputSettingsTab }))
);
const LazyMcpServerSettingsTab = lazy(() =>
  importMcpServerSettingsTab().then((m) => ({ default: m.McpServerSettingsTab }))
);
const LazyDaintreeAssistantSettingsTab = lazy(() =>
  importDaintreeAssistantSettingsTab().then((m) => ({ default: m.DaintreeAssistantSettingsTab }))
);
const LazyEnvironmentSettingsTab = lazy(() =>
  importEnvironmentSettingsTab().then((m) => ({ default: m.EnvironmentSettingsTab }))
);
const LazyPrivacyDataTab = lazy(() =>
  importPrivacyDataTab().then((m) => ({ default: m.PrivacyDataTab }))
);
const LazyProjectGeneralTab = lazy(() =>
  importProjectGeneralTab().then((m) => ({ default: m.GeneralTab }))
);
const LazyProjectContextTab = lazy(() =>
  importProjectContextTab().then((m) => ({ default: m.ContextTab }))
);
const LazyProjectVariablesTab = lazy(() =>
  importProjectVariablesTab().then((m) => ({ default: m.EnvironmentVariablesEditor }))
);
const LazyProjectAutomationTab = lazy(() =>
  importProjectAutomationTab().then((m) => ({ default: m.AutomationTab }))
);
const LazyProjectRecipesTab = lazy(() =>
  importProjectRecipesTab().then((m) => ({ default: m.RecipesTab }))
);
const LazyProjectCommandsTab = lazy(() =>
  importProjectCommandsTab().then((m) => ({ default: m.CommandOverridesTab }))
);
const LazyProjectNotificationsTab = lazy(() =>
  importProjectNotificationsTab().then((m) => ({ default: m.ProjectNotificationsTab }))
);
const LazyProjectCodeForgeTab = lazy(() =>
  importProjectCodeForgeTab().then((m) => ({ default: m.CodeForgeTab }))
);

// ── Voice requiresEnabled gates (referenced repeatedly) ─────────────────

const VOICE_REQUIRES_ENABLED = {
  settingId: "voice-enable",
  label: "Voice input",
} as const;

const VOICE_AI_REQUIRES_ENABLED = {
  settingId: "voice-ai-correction-enable",
  label: "AI text correction",
} as const;

const MCP_REQUIRES_ENABLED = {
  settingId: "mcp-server-enable",
  label: "MCP server",
} as const;

// ── Registry (module-level const — stable identity for Fuse.js WeakMap) ─

export const SETTINGS_REGISTRY = [
  // ═══ Global — General ═══
  {
    id: "general",
    scope: "global",
    group: "General",
    label: "General",
    icon: <Settings2 className="w-4 h-4" />,
    importKind: "eager",
    Component: GeneralTab,
    searchNavDescription: "About, system status, hibernation, and display settings",
    searchNavKeywords: ["general", "settings", "about", "status"],
    sections: [
      {
        id: "general-about",
        subtab: "overview",
        subtabLabel: "Overview",
        section: "About",
        title: "About Daintree",
        description: "App version and description",
        keywords: ["version", "about", "info", "beta"],
      },
      {
        id: "general-system-status",
        subtab: "overview",
        subtabLabel: "Overview",
        section: "System status",
        title: "System status",
        description: "Installed agents and their operational status",
        keywords: ["agents", "cli", "available", "status", "check", "ready"],
      },
      {
        id: "general-update-channel",
        subtab: "overview",
        subtabLabel: "Overview",
        section: "Update channel",
        title: "Update channel",
        description: "Switch between stable and nightly update channels",
        keywords: ["update", "channel", "stable", "nightly", "releases"],
      },
      {
        id: "general-hibernation",
        subtab: "hibernation",
        subtabLabel: "Hibernation",
        section: "Auto-hibernation",
        title: "Auto-hibernation",
        description:
          "Automatically stop terminals and servers for inactive projects. Reduces system resource usage.",
        keywords: ["hibernate", "sleep", "inactive", "stop", "resources", "idle", "auto"],
      },
      {
        id: "general-hibernation-threshold",
        subtab: "hibernation",
        subtabLabel: "Hibernation",
        section: "Auto-hibernation",
        title: "Inactivity threshold",
        description: "How long before a project is hibernated: 12h, 24h, 48h, or 72h",
        keywords: ["hibernate", "threshold", "hours", "timeout", "inactivity"],
      },
      {
        id: "general-idle-terminal-notify",
        subtab: "hibernation",
        subtabLabel: "Hibernation",
        section: "Idle terminal notifications",
        title: "Idle terminal notifications",
        description:
          "Notify when background project terminals have been idle past a threshold. Includes Close Them / Mute project actions.",
        keywords: ["idle", "notify", "terminal", "background", "reminder", "inactive", "close"],
      },
      {
        id: "general-idle-terminal-threshold",
        subtab: "hibernation",
        subtabLabel: "Hibernation",
        section: "Idle terminal notifications",
        title: "Idle threshold",
        description: "Minutes of inactivity before notifying: 30m, 1h, 2h, or 4h",
        keywords: ["idle", "threshold", "minutes", "notify", "inactivity", "background"],
      },
      {
        id: "general-project-pulse",
        subtab: "display",
        subtabLabel: "Display",
        section: "Display",
        title: "Project pulse",
        description: "Show activity heatmap on the empty panel grid",
        keywords: ["heatmap", "activity", "pulse", "display", "visualization"],
      },
      {
        id: "general-developer-tools",
        subtab: "display",
        subtabLabel: "Display",
        section: "Display",
        title: "Developer tools",
        description: "Show problems panel button in the toolbar",
        keywords: ["developer", "debug", "problems", "panel", "toolbar"],
      },
      {
        id: "general-grid-agent-highlights",
        subtab: "display",
        subtabLabel: "Display",
        section: "Display",
        title: "Grid panel agent highlights",
        description: "Show waiting and working state borders on grid panels",
        keywords: ["agent", "highlight", "border", "waiting", "working", "grid", "panel", "state"],
      },
      {
        id: "general-dock-agent-highlights",
        subtab: "display",
        subtabLabel: "Display",
        section: "Display",
        title: "Dock item agent highlights",
        description: "Show waiting state borders on dock items",
        keywords: ["agent", "highlight", "border", "waiting", "dock", "item", "state"],
      },
    ],
  } satisfies EagerSettingsTabEntry,

  {
    id: "terminalAppearance",
    scope: "global",
    group: "General",
    label: "Appearance",
    icon: <SquareTerminal className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTerminalAppearanceTab,
    LazyComponent: LazyTerminalAppearanceTab,
    needsSubtabs: true,
    needsOnClose: true,
    searchNavDescription: "Theme, terminal colors, font size, and font family",
    searchNavKeywords: ["general", "appearance", "theme", "colors", "font"],
    sections: [
      {
        id: "appearance-theme",
        subtab: "app",
        subtabLabel: "App",
        section: "App theme",
        title: "App theme",
        description: "Choose the application color theme",
        keywords: ["theme", "dark", "light", "color", "scheme", "appearance", "mode"],
      },
      {
        id: "appearance-color-vision",
        subtab: "app",
        subtabLabel: "App",
        section: "Color vision",
        title: "Color vision",
        description: "Adjust colors for color vision deficiency (colorblind mode)",
        keywords: [
          "colorblind",
          "color vision",
          "deuteranopia",
          "protanopia",
          "tritanopia",
          "accessibility",
          "CVD",
          "red-green",
          "blue-yellow",
        ],
      },
      {
        id: "appearance-dock-density",
        subtab: "app",
        subtabLabel: "App",
        section: "Dock density",
        title: "Dock density",
        description: "Control dock bar height: compact, normal, or comfortable",
        keywords: ["dock", "density", "compact", "comfortable", "height", "size", "spacing"],
      },
      {
        id: "appearance-color-scheme",
        subtab: "terminal",
        subtabLabel: "Terminal",
        section: "Terminal color scheme",
        title: "Terminal color scheme",
        description: "Choose the terminal color scheme and palette",
        keywords: ["color", "scheme", "terminal", "colors", "palette", "theme"],
      },
      {
        id: "appearance-font-size",
        subtab: "terminal",
        subtabLabel: "Terminal",
        section: "Font size",
        title: "Font size",
        description: "Set terminal font size from 8px to 24px",
        keywords: ["font", "size", "text", "px", "terminal", "larger", "smaller"],
      },
      {
        id: "appearance-font-family",
        subtab: "terminal",
        subtabLabel: "Terminal",
        section: "Font family",
        title: "Font family",
        description: "Choose terminal font: JetBrains Mono or system monospace",
        keywords: ["font", "family", "mono", "JetBrains", "monospace", "typeface"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "keyboard",
    scope: "global",
    group: "General",
    label: "Keyboard",
    headerTitle: "Keyboard Shortcuts",
    icon: <Keyboard className="w-4 h-4" />,
    importKind: "lazy",
    importer: importKeyboardShortcutsTab,
    LazyComponent: LazyKeyboardShortcutsTab,
    searchNavDescription: "View and customize keyboard shortcut bindings",
    searchNavKeywords: ["general", "keyboard", "keybindings", "hotkeys", "shortcuts"],
    sections: [
      {
        id: "keyboard-shortcuts",
        section: "Keyboard shortcuts",
        title: "Keyboard shortcuts",
        description:
          "View and customize keyboard bindings for all actions. Search and override shortcuts.",
        keywords: ["keybindings", "shortcuts", "hotkeys", "bindings", "key", "remap"],
      },
      {
        id: "keyboard-profiles",
        section: "Keyboard shortcuts",
        title: "Shortcut profiles",
        description: "Import and export shortcut profile configurations",
        keywords: ["profile", "import", "export", "backup", "keybindings"],
      },
      {
        id: "keyboard-reset",
        section: "Keyboard shortcuts",
        title: "Reset all shortcuts",
        description: "Reset all keyboard shortcuts to their default bindings",
        keywords: ["reset", "default", "shortcuts", "restore", "keybindings"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "notifications",
    scope: "global",
    group: "General",
    label: "Notifications",
    icon: <Bell className="w-4 h-4" />,
    importKind: "lazy",
    importer: importNotificationSettingsTab,
    LazyComponent: LazyNotificationSettingsTab,
    searchNavDescription: "Agent notification alerts and sound settings",
    searchNavKeywords: ["general", "notifications", "alerts", "sounds"],
    sections: [
      {
        id: "notifications-completed",
        section: "Agent notifications",
        title: "Agent completed notification",
        description: "Show a notification when an agent finishes its task",
        keywords: ["notification", "alert", "complete", "done", "agent", "finish"],
      },
      {
        id: "notifications-waiting",
        section: "Agent notifications",
        title: "Agent waiting for input",
        description: "Show a notification when an agent needs input",
        keywords: ["notification", "waiting", "input", "agent", "prompt", "pause"],
      },
      {
        id: "notifications-sound",
        section: "Sound",
        title: "Notification sound",
        description:
          "Play a sound when notifications fire. Choose from chime, ping, complete, waiting, or error sounds.",
        keywords: ["sound", "audio", "chime", "ping", "notification", "alert", "volume"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "privacy",
    scope: "global",
    group: "General",
    label: "Privacy & Data",
    icon: <Shield className="w-4 h-4" />,
    importKind: "lazy",
    importer: importPrivacyDataTab,
    LazyComponent: LazyPrivacyDataTab,
    needsSubtabs: true,
    searchNavDescription: "Telemetry level, log retention, data folder, cache, and factory reset",
    searchNavKeywords: ["privacy", "data", "telemetry", "reset", "cache", "logs"],
    sections: [
      {
        id: "privacy-telemetry-level",
        subtab: "telemetry",
        subtabLabel: "Telemetry",
        section: "Telemetry & diagnostics",
        title: "Telemetry level",
        description: "Control what data is collected: Off, Errors Only, or Full Usage analytics",
        keywords: [
          "telemetry",
          "crash",
          "reporting",
          "analytics",
          "privacy",
          "sentry",
          "diagnostics",
        ],
      },
      {
        id: "privacy-log-retention",
        subtab: "storage",
        subtabLabel: "Data & Storage",
        section: "Log retention",
        title: "Log retention",
        description: "Auto-prune log files older than 7, 30, or 90 days on startup",
        keywords: ["log", "retention", "prune", "cleanup", "days", "storage"],
      },
      {
        id: "privacy-data-folder",
        subtab: "storage",
        subtabLabel: "Data & Storage",
        section: "Data folder",
        title: "Data folder",
        description: "View and open the app data folder in your file manager",
        keywords: ["data", "folder", "path", "storage", "finder", "explorer"],
      },
      {
        id: "privacy-clear-cache",
        subtab: "storage",
        subtabLabel: "Data & Storage",
        section: "Clear cache",
        title: "Clear cache",
        description: "Clear HTTP disk cache and code caches without affecting settings",
        keywords: ["cache", "clear", "disk", "http", "cleanup"],
      },
      {
        id: "privacy-reset-data",
        subtab: "storage",
        subtabLabel: "Data & Storage",
        section: "Reset all app data",
        title: "Reset all app data",
        description:
          "Permanently delete all settings, API keys, session data, and logs. Factory reset.",
        keywords: ["reset", "wipe", "factory", "delete", "all", "data", "fresh"],
      },
      {
        id: "troubleshooting-crash",
        subtab: "telemetry",
        subtabLabel: "Telemetry",
        section: "Telemetry & diagnostics",
        title: "Crash reporting",
        description: "Configure crash reporting and telemetry level in Privacy & Data settings",
        keywords: ["crash", "reporting", "telemetry", "error", "stack trace", "sentry"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Terminal ═══
  {
    id: "terminal",
    scope: "global",
    group: "Terminal",
    label: "Panel Grid",
    icon: <LayoutGrid className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTerminalSettingsTab,
    LazyComponent: LazyTerminalSettingsTab,
    needsSubtabs: true,
    searchNavDescription: "Panel grid layout, scrollback, split pane, and performance settings",
    searchNavKeywords: ["terminal", "panel", "grid", "layout", "panes"],
    sections: [
      {
        id: "terminal-performance-mode",
        subtab: "performance",
        subtabLabel: "Performance",
        section: "Performance mode",
        title: "Performance mode",
        description:
          "Reduces scrollback and disables animations for maximum performance on low-end hardware",
        keywords: ["performance", "speed", "low-end", "memory", "animation", "disable"],
      },
      {
        id: "terminal-panel-limits",
        subtab: "performance",
        subtabLabel: "Performance",
        section: "Panel limits",
        title: "Panel limits",
        description:
          "Hardware-aware panel limits with soft warning, confirmation, and hard limit thresholds",
        keywords: [
          "panel",
          "limit",
          "warning",
          "hardware",
          "RAM",
          "memory",
          "disable",
          "threshold",
          "confirm",
        ],
      },
      {
        id: "terminal-panel-warnings-toggle",
        subtab: "performance",
        subtabLabel: "Performance",
        section: "Panel limits",
        title: "Panel warnings",
        description:
          "Turn off soft warning banner and confirmation dialog while keeping the hard limit",
        keywords: ["disable", "warning", "panel", "nag", "dismiss", "suppress"],
      },
      {
        id: "terminal-hybrid-input",
        subtab: "input",
        subtabLabel: "Input",
        section: "Hybrid input bar",
        title: "Hybrid input bar",
        description: "Show the multi-line input bar on agent terminals",
        keywords: ["input", "hybrid", "bar", "multi-line", "agent", "textarea"],
      },
      {
        id: "terminal-hybrid-autofocus",
        subtab: "input",
        subtabLabel: "Input",
        section: "Hybrid input bar",
        title: "Auto-focus input",
        description: "Selecting a pane focuses the input bar or the terminal (xterm)",
        keywords: ["focus", "autofocus", "input", "pane", "select"],
      },
      {
        id: "terminal-two-pane-split",
        subtab: "layout",
        subtabLabel: "Layout",
        section: "Two-pane split layout",
        title: "Two-pane split layout",
        description: "When exactly two panels are open, display them with a resizable divider",
        keywords: ["split", "two pane", "layout", "divider", "resize", "ratio"],
      },
      {
        id: "terminal-scrollback",
        subtab: "scrollback",
        subtabLabel: "Scrollback",
        section: "Scrollback history",
        title: "Scrollback history",
        description:
          "Set base scrollback lines for terminal history: 500, 1,000, 2,500, or 5,000 lines",
        keywords: ["scrollback", "history", "lines", "buffer", "memory", "terminal"],
      },
      {
        id: "terminal-grid-layout",
        subtab: "layout",
        subtabLabel: "Layout",
        section: "Grid layout strategy",
        title: "Grid layout strategy",
        description:
          "Control how panels arrange in the grid: automatic, fixed columns, or fixed rows",
        keywords: ["grid", "layout", "columns", "rows", "panels", "arrangement", "strategy"],
      },
      {
        id: "terminal-screen-reader",
        subtab: "accessibility",
        subtabLabel: "Accessibility",
        section: "Screen reader mode",
        title: "Screen reader mode",
        description:
          "Enable screen reader support for terminal output. Auto mode follows OS accessibility state.",
        keywords: [
          "screen reader",
          "accessibility",
          "a11y",
          "voiceover",
          "jaws",
          "nvda",
          "screenReaderMode",
          "assistive",
        ],
      },
      {
        id: "terminal-preview-layout",
        subtab: "layout",
        subtabLabel: "Layout",
        section: "Two-pane split layout",
        title: "Preview-focused layout",
        description:
          "Give more space to browser or dev-preview panels (65/35 split) vs balanced layout (50/50)",
        keywords: ["preview", "browser", "focused", "ratio", "split", "layout", "two pane"],
      },
      {
        id: "terminal-default-ratio",
        subtab: "layout",
        subtabLabel: "Layout",
        section: "Two-pane split layout",
        title: "Default split ratio",
        description: "Set the default left/right split ratio for two-pane layout",
        keywords: ["ratio", "split", "default", "percentage", "slider", "two pane"],
      },
      {
        id: "terminal-reset-ratios",
        subtab: "layout",
        subtabLabel: "Layout",
        section: "Two-pane split layout",
        title: "Reset all worktree split ratios",
        description: "Clear all per-worktree split ratio overrides and return to the default ratio",
        keywords: ["reset", "worktree", "ratio", "split", "default", "clear"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "worktree",
    scope: "global",
    group: "Terminal",
    label: "Worktree",
    headerTitle: "Worktree Paths",
    icon: <FolderGit2 className="w-4 h-4" />,
    importKind: "lazy",
    importer: importWorktreeSettingsTab,
    LazyComponent: LazyWorktreeSettingsTab,
    searchNavDescription: "Configure where git worktrees are created",
    searchNavKeywords: ["terminal", "worktree", "paths", "git", "directory"],
    sections: [
      {
        id: "worktree-path-pattern",
        section: "Worktree path pattern",
        title: "Worktree path pattern",
        description:
          "Customize where worktrees are created using variables: {base-folder}, {branch-slug}, {repo-name}, {parent-dir}",
        keywords: [
          "worktree",
          "path",
          "pattern",
          "branch",
          "folder",
          "directory",
          "location",
          "git",
        ],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "toolbar",
    scope: "global",
    group: "Terminal",
    label: "Toolbar",
    headerTitle: "Toolbar Customization",
    icon: <SettingsIcon className="w-4 h-4" />,
    importKind: "lazy",
    importer: importToolbarSettingsTab,
    LazyComponent: LazyToolbarSettingsTab,
    searchNavDescription: "Reorder, show, and hide toolbar buttons and launcher settings",
    searchNavKeywords: ["terminal", "toolbar", "buttons", "customize"],
    sections: [
      {
        id: "toolbar-left-buttons",
        section: "Left side buttons",
        title: "Left toolbar buttons",
        description: "Drag to reorder, uncheck to hide left toolbar buttons",
        keywords: ["toolbar", "buttons", "left", "reorder", "customize", "hide"],
      },
      {
        id: "toolbar-right-buttons",
        section: "Right side buttons",
        title: "Right toolbar buttons",
        description: "Drag to reorder, uncheck to hide right toolbar buttons",
        keywords: ["toolbar", "buttons", "right", "reorder", "customize", "hide"],
      },
      {
        id: "toolbar-launcher",
        section: "Launcher palette",
        title: "Launcher palette settings",
        description:
          "Configure the default panel type highlighted when opening the launcher. Always show dev server option.",
        keywords: ["launcher", "palette", "default", "panel", "dev server", "open", "selection"],
      },
      {
        id: "toolbar-reset",
        section: "Toolbar customization",
        title: "Reset toolbar to defaults",
        description: "Reset all toolbar button positions and visibility to defaults",
        keywords: ["reset", "default", "toolbar", "restore"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "environment",
    scope: "global",
    group: "Terminal",
    label: "Environment",
    headerTitle: "Environment Variables",
    icon: <KeyRound className="w-4 h-4" />,
    importKind: "lazy",
    importer: importEnvironmentSettingsTab,
    LazyComponent: LazyEnvironmentSettingsTab,
    searchNavDescription: "Per-project environment variables injected into all terminals",
    searchNavKeywords: [
      "terminal",
      "environment",
      "variables",
      "env",
      "project",
      "inject",
      "secrets",
    ],
    sections: [
      {
        id: "environment-variables",
        section: "Environment variables",
        title: "Project environment variables",
        description:
          "Add, edit, and delete key/value environment variables for the current project. Injected into new terminals at spawn time.",
        keywords: [
          "env",
          "environment",
          "variables",
          "project",
          "api key",
          "secret",
          "token",
          "password",
          "PATH",
          "inject",
          "terminal",
          "encryption",
          "dotenv",
        ],
      },
    ],
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Assistant ═══
  {
    id: "assistant",
    scope: "global",
    group: "Assistant",
    label: "Daintree Assistant",
    icon: <DaintreeIcon className="w-4 h-4" size={16} />,
    importKind: "lazy",
    importer: importDaintreeAssistantSettingsTab,
    LazyComponent: LazyDaintreeAssistantSettingsTab,
    searchNavDescription: "Tools, security, and audit logging for the help assistant",
    searchNavKeywords: [
      "assistant",
      "daintree",
      "help",
      "claude",
      "audit",
      "permissions",
      "doc search",
      "mcp",
    ],
    sections: [
      {
        id: "assistant-doc-search",
        section: "Behavior",
        title: "Search documentation",
        description:
          "Let the assistant search Daintree documentation and changelog while answering",
        keywords: ["assistant", "docs", "documentation", "search", "help", "behavior"],
      },
      {
        id: "assistant-daintree-control",
        section: "Behavior",
        title: "Daintree control",
        description: "Let the assistant call Daintree actions through the local MCP server",
        keywords: ["assistant", "control", "mcp", "actions", "tools", "behavior"],
      },
      {
        id: "assistant-skip-permissions",
        section: "Security",
        title: "Skip permission prompts",
        description: "Bypass Claude Code's confirmation gate for help sessions",
        keywords: [
          "assistant",
          "permissions",
          "skip",
          "dangerously",
          "confirm",
          "security",
          "bypass",
        ],
      },
      {
        id: "assistant-audit-retention",
        section: "Privacy",
        title: "Audit log retention",
        description: "How long help-session logs are kept on this machine",
        keywords: [
          "assistant",
          "audit",
          "log",
          "retention",
          "privacy",
          "history",
          "logging",
          "days",
        ],
      },
      {
        id: "assistant-mcp-status",
        section: "Connection",
        title: "MCP connection",
        description:
          "Status of the local MCP server, copy the config snippet, and regenerate the API key",
        keywords: [
          "assistant",
          "mcp",
          "connection",
          "regenerate",
          "key",
          "snippet",
          "config",
          "external",
          "client",
        ],
      },
    ],
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Integrations ═══
  {
    id: "agents",
    scope: "global",
    group: "Integrations",
    label: "CLI agents",
    icon: <Plug className="w-4 h-4" />,
    importKind: "lazy",
    importer: importAgentSettings,
    LazyComponent: LazyAgentSettings,
    needsSubtabs: true,
    needsOnSettingsChange: true,
    searchNavDescription: "Configure CLI agent settings",
    searchNavKeywords: [
      "integrations",
      "agents",
      ...BUILT_IN_AGENT_IDS.flatMap((id) =>
        [id, AGENT_REGISTRY[id]?.name?.toLowerCase()].filter((s): s is string => Boolean(s))
      ),
    ],
    sections: [
      {
        id: "agents-default-agent",
        subtab: "general",
        subtabLabel: "General",
        section: "Global agent settings",
        title: "Default agent",
        description:
          'Agent used for the help dock button (⌘⇧H) and automated workflows ("What\'s Next?", onboarding, project explanations). Distinct from the Portal "Default new tab agent".',
        keywords: [
          "default",
          "agent",
          "workflow",
          "automated",
          "whats next",
          "onboarding",
          "help",
          "dock",
          "launch",
          "keyboard shortcut",
          ...BUILT_IN_AGENT_IDS,
        ],
      },
      {
        id: "agents-enable",
        subtab: "claude",
        subtabLabel: "Claude",
        section: "Agent runtime settings",
        title: "Enable / disable agent",
        description: "Enable or disable individual CLI agents",
        keywords: ["agent", "enable", "disable", ...BUILT_IN_AGENT_IDS, "select"],
      },
      {
        id: "agents-skip-permissions",
        subtab: "claude",
        subtabLabel: "Claude",
        section: "Agent runtime settings",
        title: "Skip permissions",
        description: "Auto-approve all agent actions without confirmation prompts",
        keywords: [
          "permissions",
          "auto-approve",
          "confirm",
          "prompts",
          "dangerous",
          "allow",
          "bypass",
        ],
      },
      {
        id: "agents-inline-mode",
        subtab: "claude",
        subtabLabel: "Claude",
        section: "Agent runtime settings",
        title: "Inline mode",
        description: "Disable fullscreen TUI for better resize handling and scrollback",
        keywords: ["inline", "mode", "tui", "fullscreen", "resize", "tty"],
      },
      {
        id: "agents-clipboard",
        subtab: "gemini",
        subtabLabel: "Gemini",
        section: "Agent runtime settings",
        title: "Share clipboard directory",
        description: "Allow Gemini to read pasted clipboard images",
        keywords: ["clipboard", "images", "share", "gemini", "paste", "screenshot"],
      },
      {
        id: "agents-custom-args",
        subtab: "claude",
        subtabLabel: "Claude",
        section: "Agent runtime settings",
        title: "Custom arguments",
        description: "Extra CLI flags appended when launching agents",
        keywords: ["args", "arguments", "flags", "cli", "custom", "launch", "options"],
      },
      {
        id: "agents-installation",
        subtab: "claude",
        subtabLabel: "Claude",
        section: "Installation",
        title: "Agent installation",
        description: "Install and set up CLI agents. Run setup wizard to install.",
        keywords: ["install", "setup", "wizard", "cli", "download", "npm", "brew"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "code-forge",
    scope: "global",
    group: "Integrations",
    label: "Code Forge",
    headerTitle: "Code Forge",
    icon: <GitBranch className="w-4 h-4" />,
    importKind: "lazy",
    importer: importCodeForgeSettingsTab,
    LazyComponent: LazyCodeForgeSettingsTab,
    needsSubtabs: true,
    searchNavDescription:
      "Configure forge providers (GitHub, GitLab, Gitea, ...) and authentication",
    searchNavKeywords: [
      "forge",
      "provider",
      "code",
      "github",
      "gitlab",
      "gitea",
      "bitbucket",
      "authentication",
      "token",
      "default",
      "integrations",
    ],
    sections: [
      {
        id: "github-token",
        subtab: "github",
        subtabLabel: "GitHub",
        section: "Personal access token",
        title: "GitHub personal access token",
        description: "Configure GitHub authentication token. Required scopes: repo, read:org",
        keywords: ["github", "token", "authentication", "auth", "PAT", "access", "scopes", "API"],
      },
      {
        id: "forge-default-provider",
        subtab: "general",
        subtabLabel: "General",
        section: "Default forge provider",
        title: "Default forge provider",
        description:
          "Choose the forge provider used for newly opened projects when no per-project setting wins.",
        keywords: [
          "forge",
          "provider",
          "default",
          "global",
          "github",
          "gitlab",
          "gitea",
          "auto-detect",
          "hostname",
        ],
      },
      {
        id: "forge-active-project-routing",
        subtab: "general",
        subtabLabel: "General",
        section: "Active project routing",
        title: "Active project routing",
        description:
          "Inspect which forge provider each remote of the active project routes to and why.",
        keywords: [
          "forge",
          "remote",
          "routing",
          "provider",
          "match",
          "hostname",
          "override",
          "active project",
        ],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "integrations",
    scope: "global",
    group: "Integrations",
    label: "Integrations",
    icon: <Blocks className="w-4 h-4" />,
    importKind: "lazy",
    importer: importIntegrationsTab,
    LazyComponent: LazyIntegrationsTab,
    searchNavDescription: "External editor, image viewer, and other tool integrations",
    searchNavKeywords: [
      "integrations",
      "editor",
      "vscode",
      "cursor",
      "ide",
      "image",
      "viewer",
      "photo",
    ],
    sections: [
      {
        id: "editor-external",
        section: "External editor",
        title: "External editor",
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
      {
        id: "image-viewer",
        section: "Image viewer",
        title: "Image viewer",
        description:
          "Configure image viewer: use OS default (Preview, Photos) or a custom command (Photoshop, GIMP)",
        keywords: [
          "image",
          "viewer",
          "photo",
          "picture",
          "preview",
          "png",
          "jpg",
          "svg",
          "gif",
          "open",
          "photoshop",
          "gimp",
        ],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "voice",
    scope: "global",
    group: "Integrations",
    label: "Voice Input",
    icon: <Mic className="w-4 h-4" />,
    importKind: "lazy",
    importer: importVoiceInputSettingsTab,
    LazyComponent: LazyVoiceInputSettingsTab,
    searchNavDescription: "Speech-to-text transcription and AI text correction settings",
    searchNavKeywords: [
      "voice",
      "microphone",
      "speech",
      "dictation",
      "openai",
      "whisper",
      "transcription",
    ],
    sections: [
      {
        id: "voice-enable",
        section: "Speech-to-text",
        title: "Voice input enable",
        description: "Enable or disable voice input for speech-to-text transcription",
        keywords: ["voice", "microphone", "dictate", "speech", "recording", "enable", "mic"],
      },
      {
        id: "voice-stt-openai-key",
        section: "Speech-to-text",
        title: "OpenAI API key",
        description: "Configure your OpenAI API key for realtime speech recognition",
        keywords: ["openai", "api", "key", "speech-to-text", "stt", "whisper"],
        requiresEnabled: VOICE_REQUIRES_ENABLED,
      },
      {
        id: "voice-language",
        section: "Speech-to-text",
        title: "Transcription language",
        description: "Select the language for speech transcription",
        keywords: ["language", "locale", "english", "multilingual", "transcription"],
        requiresEnabled: VOICE_REQUIRES_ENABLED,
      },
      {
        id: "voice-paragraph-breaks",
        section: "Speech-to-text",
        title: "Paragraph breaks",
        description: "Insert paragraph breaks via spoken commands",
        keywords: ["paragraph", "break", "enter", "formatting", "spoken"],
        requiresEnabled: VOICE_REQUIRES_ENABLED,
      },
      {
        id: "voice-custom-dictionary",
        section: "Speech-to-text",
        title: "Custom dictionary",
        description: "Add domain-specific terms to improve recognition accuracy",
        keywords: ["dictionary", "terms", "domain", "vocabulary", "recognition", "custom"],
        requiresEnabled: VOICE_REQUIRES_ENABLED,
      },
      {
        id: "voice-ai-correction-enable",
        section: "AI text correction",
        title: "AI text correction",
        description: "Enable AI-powered post-processing to clean up transcribed text",
        keywords: ["correction", "ai", "cleanup", "post-process", "filler"],
        requiresEnabled: VOICE_REQUIRES_ENABLED,
      },
      {
        id: "voice-correction-model",
        section: "AI text correction",
        title: "Correction model",
        description: "Choose the OpenAI model used for text correction",
        keywords: ["gpt", "model", "correction", "openai"],
        requiresEnabled: VOICE_AI_REQUIRES_ENABLED,
      },
      {
        id: "voice-custom-instructions",
        section: "AI text correction",
        title: "Custom instructions",
        description: "Add project-specific rules for AI text correction",
        keywords: ["instructions", "prompt", "rules", "custom", "project-specific"],
        requiresEnabled: VOICE_AI_REQUIRES_ENABLED,
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "portal",
    scope: "global",
    group: "Integrations",
    label: "Portal",
    headerTitle: "Portal Links",
    icon: <PanelRight className="w-4 h-4" />,
    importKind: "lazy",
    importer: importPortalSettingsTab,
    LazyComponent: LazyPortalSettingsTab,
    searchNavDescription: "Default and custom links for the portal browser panel",
    searchNavKeywords: ["integrations", "portal", "links", "browser", "bookmarks"],
    sections: [
      {
        id: "portal-default-agent",
        section: "Default new tab agent",
        title: "Default new tab agent",
        description: "Choose which agent opens when you click the + button in the portal",
        keywords: ["portal", "agent", "default", "new tab", "browser"],
      },
      {
        id: "portal-default-links",
        section: "Default links",
        title: "Default links",
        description: "System-provided links shown in the portal panel",
        keywords: ["portal", "links", "default", "browser", "bookmarks"],
      },
      {
        id: "portal-custom-links",
        section: "Custom links",
        title: "Custom links",
        description: "Add custom URLs and links to the portal panel",
        keywords: ["portal", "custom", "links", "url", "add", "bookmark"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  {
    id: "mcp",
    scope: "global",
    group: "Integrations",
    label: "MCP Server",
    icon: <McpServerIcon className="w-4 h-4" />,
    importKind: "lazy",
    importer: importMcpServerSettingsTab,
    LazyComponent: LazyMcpServerSettingsTab,
    searchNavDescription: "Local MCP server for AI agent automation",
    searchNavKeywords: ["integrations", "mcp", "server", "automation", "api"],
    sections: [
      {
        id: "mcp-server-enable",
        section: "MCP server",
        title: "Enable MCP server",
        description:
          "Start a local MCP server so AI agents can invoke Daintree actions (open terminals, inject context, switch worktrees, etc.)",
        keywords: ["mcp", "server", "agent", "local", "tools", "automation", "api", "enable"],
      },
      {
        id: "mcp-server-config",
        section: "Connection",
        title: "Copy MCP config",
        description:
          "Copy the MCP server config snippet (JSON) to paste into your MCP client configuration",
        keywords: ["mcp", "config", "copy", "snippet", "json", "client", "cursor", "claude"],
        requiresEnabled: MCP_REQUIRES_ENABLED,
      },
      {
        id: "mcp-server-port",
        section: "Port",
        title: "Server port",
        description:
          "Set a fixed port for the MCP server or leave empty for automatic ephemeral port assignment",
        keywords: ["mcp", "port", "fixed", "ephemeral", "network", "bind"],
        requiresEnabled: MCP_REQUIRES_ENABLED,
      },
      {
        id: "mcp-server-auth",
        section: "Authentication",
        title: "API key authentication",
        description:
          "Generate a bearer token to secure MCP connections. Clients must include the token in the Authorization header.",
        keywords: ["mcp", "api", "key", "auth", "token", "bearer", "security", "password"],
        requiresEnabled: MCP_REQUIRES_ENABLED,
      },
    ],
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Support ═══
  {
    id: "troubleshooting",
    scope: "global",
    group: "Support",
    label: "Troubleshooting",
    icon: <LifeBuoy className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTroubleshootingTab,
    LazyComponent: LazyTroubleshootingTab,
    searchNavDescription: "System health, logs, diagnostics, and developer mode",
    searchNavKeywords: ["support", "troubleshooting", "debug", "logs", "health"],
    sections: [
      {
        id: "troubleshooting-gpu-acceleration",
        section: "Hardware acceleration",
        title: "Hardware acceleration",
        description:
          "Disable GPU hardware acceleration if you experience blank panels or rendering issues",
        keywords: [
          "gpu",
          "hardware",
          "acceleration",
          "blank",
          "white",
          "crash",
          "rendering",
          "graphics",
        ],
      },
      {
        id: "troubleshooting-health",
        section: "System health check",
        title: "System health check",
        description: "Verify Git, Node.js, npm installation and system dependencies",
        keywords: ["health", "check", "git", "node", "npm", "system", "verify", "diagnosis"],
      },
      {
        id: "troubleshooting-logs",
        section: "Application logs",
        title: "Application logs",
        description: "Open log file and clear application logs",
        keywords: ["logs", "debug", "log file", "clear", "application", "output"],
      },
      {
        id: "troubleshooting-devmode",
        section: "Developer mode",
        title: "Developer mode",
        description:
          "Enable developer mode, auto-open diagnostics, verbose logging, persistent verbose logging",
        keywords: [
          "developer",
          "debug",
          "verbose",
          "logging",
          "diagnostics",
          "devtools",
          "DAINTREE_DEBUG",
        ],
      },
      {
        id: "troubleshooting-auto-diagnostics",
        section: "Developer mode",
        title: "Auto-open diagnostics dock",
        description: "Automatically open the diagnostics panel on app startup",
        keywords: ["diagnostics", "dock", "auto", "startup", "open", "developer"],
      },
      {
        id: "troubleshooting-focus-events",
        section: "Developer mode",
        title: "Focus events tab",
        description: "Default to the Events tab when the diagnostics panel opens",
        keywords: ["events", "focus", "diagnostics", "tab", "developer"],
      },
      {
        id: "troubleshooting-verbose-logging",
        section: "Developer mode",
        title: "Verbose logging",
        description: "Enable verbose logging for this session only. Resets on app restart.",
        keywords: ["verbose", "logging", "debug", "log level", "session"],
      },
    ],
  } satisfies LazySettingsTabEntry,

  // ═══ Project — Project ═══
  {
    id: "project:general",
    scope: "project",
    group: "Project",
    label: "General",
    icon: <SettingsIcon className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectGeneralTab,
    LazyComponent: LazyProjectGeneralTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:context",
    scope: "project",
    group: "Project",
    label: "Context",
    icon: <FileCode className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectContextTab,
    LazyComponent: LazyProjectContextTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:variables",
    scope: "project",
    group: "Project",
    label: "Variables",
    icon: <KeyRound className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectVariablesTab,
    LazyComponent: LazyProjectVariablesTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:automation",
    scope: "project",
    group: "Project",
    label: "Worktree Setup",
    icon: <GitBranch className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectAutomationTab,
    LazyComponent: LazyProjectAutomationTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:recipes",
    scope: "project",
    group: "Project",
    label: "Recipes",
    icon: <Workflow className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectRecipesTab,
    LazyComponent: LazyProjectRecipesTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:commands",
    scope: "project",
    group: "Project",
    label: "Commands",
    icon: <Command className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectCommandsTab,
    LazyComponent: LazyProjectCommandsTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:notifications",
    scope: "project",
    group: "Project",
    label: "Notifications",
    icon: <Bell className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectNotificationsTab,
    LazyComponent: LazyProjectNotificationsTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "project:code-forge",
    scope: "project",
    group: "Project",
    label: "Code Forge",
    icon: <GitBranch className="w-4 h-4" />,
    importKind: "lazy",
    importer: importProjectCodeForgeTab,
    LazyComponent: LazyProjectCodeForgeTab,
    needsProjectForm: true,
  } satisfies LazySettingsTabEntry,
] as const satisfies readonly AnySettingsTabEntry[];

// ── Tab id types (derived from registry by scope) ───────────────────────

type ProjectScopedEntry = Extract<(typeof SETTINGS_REGISTRY)[number], { scope: "project" }>;
type GlobalScopedEntry = Extract<(typeof SETTINGS_REGISTRY)[number], { scope: "global" }>;

export type ProjectSettingsTab = ProjectScopedEntry["id"];
export type GlobalSettingsTab = GlobalScopedEntry["id"];
export type SettingsTab = GlobalSettingsTab | ProjectSettingsTab;
export type SettingsScope = "global" | "project";

// ── Project tab search metadata (parallel to SETTINGS_REGISTRY entries) ──

export const PROJECT_SETTINGS_SECTIONS: Readonly<
  Record<ProjectSettingsTab, ProjectSettingsTabSearchMeta>
> = {
  "project:general": {
    tabLabel: "General",
    searchNavDescription: "Project name, emoji, color, icon, and dev server configuration",
    searchNavKeywords: ["project", "name", "emoji", "color", "icon", "dev server"],
    sections: [
      {
        id: "project-name",
        section: "Project Identity",
        title: "Project Name",
        description: "Display name for the project",
        keywords: ["name", "title", "label"],
      },
      {
        id: "project-dev-server",
        section: "Dev Server",
        title: "Dev Server Command",
        description: "Command to start the development server for live preview",
        keywords: ["dev", "server", "preview", "start", "command"],
      },
      {
        id: "project-in-repo-settings",
        section: "In-Repo Settings",
        title: "In-Repo Settings",
        description: "Store project settings in the repository for team sharing",
        keywords: ["repo", "repository", "shared", "team", "daintree.json"],
      },
    ],
  },
  "project:context": {
    tabLabel: "Context",
    searchNavDescription: "Excluded paths and copy tree settings",
    searchNavKeywords: ["project", "context", "exclude", "paths", "copy tree"],
    sections: [
      {
        id: "project-excluded-paths",
        section: "Excluded Paths",
        title: "Excluded Paths",
        description: "Paths to exclude from context tree and file operations",
        keywords: ["exclude", "ignore", "paths", "gitignore", "filter"],
      },
      {
        id: "project-copy-tree",
        section: "Copy Tree",
        title: "Copy Tree Settings",
        description:
          "Configure context size limits, file size limits, and include/exclude patterns",
        keywords: ["copy", "tree", "context", "size", "limit", "include", "exclude"],
      },
    ],
  },
  "project:variables": {
    tabLabel: "Variables",
    searchNavDescription: "Project environment variables injected into terminals",
    searchNavKeywords: ["project", "variables", "environment", "env", "secrets", "inject"],
    sections: [
      {
        id: "project-env-vars",
        section: "Environment Variables",
        title: "Environment Variables",
        description: "Project-specific environment variables injected into terminals",
        keywords: ["env", "environment", "variables", "secrets", "inject"],
      },
    ],
  },
  "project:automation": {
    tabLabel: "Worktree Setup",
    searchNavDescription:
      "Configure worktree paths, run commands, branch prefix, and terminal defaults",
    searchNavKeywords: [
      "project",
      "automation",
      "run",
      "commands",
      "worktree",
      "terminal",
      "branch",
    ],
    sections: [
      {
        id: "project-run-commands",
        section: "Run Commands",
        title: "Run Commands",
        description: "Named commands to run in worktree terminals on creation",
        keywords: ["run", "commands", "startup", "init", "worktree"],
      },
      {
        id: "project-branch-prefix",
        section: "Branch Prefix",
        title: "Branch Prefix",
        description: "Automatic prefix for new branch names (none, username, or custom)",
        keywords: ["branch", "prefix", "username", "git", "naming"],
      },
      {
        id: "project-terminal-settings",
        section: "Terminal Settings",
        title: "Terminal Settings",
        description: "Project-specific shell, shell args, working directory, and scrollback",
        keywords: ["terminal", "shell", "bash", "zsh", "scrollback", "cwd"],
      },
      {
        // Historical id retained (kept as `tab-nav-project:environments` for
        // backward-compatible deep links); the entry is a regular section
        // surfaced inside the Worktree Setup tab, not a separate project tab.
        id: "tab-nav-project:environments",
        section: "Resource Environments",
        title: "Resources",
        description: "Remote resource definitions and default worktree mode",
        keywords: ["project", "resources", "environments", "remote", "docker", "akash", "worktree"],
      },
    ],
  },
  "project:recipes": {
    tabLabel: "Recipes",
    searchNavDescription: "Manage terminal recipes and pin a default recipe for new worktrees",
    searchNavKeywords: ["project", "recipes", "template", "terminal", "default", "worktree", "pin"],
    sections: [
      {
        id: "project-default-recipe",
        section: "Terminal Recipes",
        title: "Default worktree recipe",
        description: "Pin a recipe to run automatically when creating new worktrees",
        keywords: ["default", "recipe", "worktree", "auto", "launch", "startup", "pin"],
      },
    ],
  },
  "project:commands": {
    tabLabel: "Commands",
    searchNavDescription: "Project-specific command overrides",
    searchNavKeywords: ["project", "commands", "overrides", "alias"],
  },
  "project:notifications": {
    tabLabel: "Notifications",
    searchNavDescription: "Project-specific notification overrides",
    searchNavKeywords: ["project", "notifications", "alerts", "sounds", "overrides"],
  },
  "project:code-forge": {
    tabLabel: "Code Forge",
    searchNavDescription: "Per-project forge remote configuration for issues, PRs, and pulse data",
    searchNavKeywords: [
      "project",
      "forge",
      "code",
      "github",
      "remote",
      "origin",
      "repository",
      "pull requests",
      "issues",
    ],
    sections: [
      {
        id: "project-code-forge-remote",
        section: "Forge Remote",
        title: "Forge Remote",
        description: "Select which git remote to use for forge integration",
        keywords: [
          "forge",
          "code",
          "github",
          "remote",
          "origin",
          "git",
          "repository",
          "fetch",
          "push",
        ],
      },
    ],
  },
};

export const PROJECT_TAB_IDS: readonly ProjectSettingsTab[] = SETTINGS_REGISTRY.filter(
  (e): e is ProjectScopedEntry => e.scope === "project"
).map((e) => e.id);

// ── Derived maps ────────────────────────────────────────────────────────

const _entryMap = new Map(SETTINGS_REGISTRY.map((e) => [e.id, e]));

export function getSettingsTabEntry(id: string): AnySettingsTabEntry | undefined {
  return _entryMap.get(id);
}

export const globalTabTitles = Object.fromEntries(
  (SETTINGS_REGISTRY as readonly AnySettingsTabEntry[])
    .filter((e) => e.scope === "global")
    .map((e) => [e.id, e.headerTitle ?? e.label])
) as Record<GlobalSettingsTab, string>;

export const globalTabIcons: Record<GlobalSettingsTab, ReactNode> = {
  general: <Settings2 className="w-5 h-5 text-text-secondary" />,
  keyboard: <Keyboard className="w-5 h-5 text-text-secondary" />,
  terminal: <LayoutGrid className="w-5 h-5 text-text-secondary" />,
  terminalAppearance: <SquareTerminal className="w-5 h-5 text-text-secondary" />,
  worktree: <FolderGit2 className="w-5 h-5 text-text-secondary" />,
  agents: <Plug className="w-5 h-5 text-text-secondary" />,
  assistant: <DaintreeIcon className="w-5 h-5 text-text-secondary" size={20} />,
  "code-forge": <GitBranch className="w-5 h-5 text-text-secondary" />,
  portal: <PanelRight className="w-5 h-5 text-text-secondary" />,
  toolbar: <SettingsIcon className="w-5 h-5 text-text-secondary" />,
  notifications: <Bell className="w-5 h-5 text-text-secondary" />,
  integrations: <Blocks className="w-5 h-5 text-text-secondary" />,
  voice: <Mic className="w-5 h-5 text-text-secondary" />,
  mcp: <McpServerIcon className="w-5 h-5 text-text-secondary" />,
  environment: <KeyRound className="w-5 h-5 text-text-secondary" />,
  privacy: <Shield className="w-5 h-5 text-text-secondary" />,
  troubleshooting: <LifeBuoy className="w-5 h-5 text-text-secondary" />,
};

export const projectTabTitles = Object.fromEntries(
  (SETTINGS_REGISTRY as readonly AnySettingsTabEntry[])
    .filter((e) => e.scope === "project")
    .map((e) => [e.id, e.headerTitle ?? e.label])
) as Record<ProjectSettingsTab, string>;

export const projectTabIcons: Record<ProjectSettingsTab, ReactNode> = {
  "project:general": <SettingsIcon className="w-5 h-5 text-text-secondary" />,
  "project:context": <FileCode className="w-5 h-5 text-text-secondary" />,
  "project:variables": <KeyRound className="w-5 h-5 text-text-secondary" />,
  "project:automation": <GitBranch className="w-5 h-5 text-text-secondary" />,
  "project:recipes": <Workflow className="w-5 h-5 text-text-secondary" />,
  "project:commands": <Command className="w-5 h-5 text-text-secondary" />,
  "project:notifications": <Bell className="w-5 h-5 text-text-secondary" />,
  "project:code-forge": <GitBranch className="w-5 h-5 text-text-secondary" />,
};

export function scopeForTab(tab: SettingsTab): SettingsScope {
  return tab.startsWith("project:") ? "project" : "global";
}

export function isSettingsTab(value: string): value is SettingsTab {
  return _entryMap.has(value);
}

export function preloadAllSettingsTabs(): void {
  for (const entry of SETTINGS_REGISTRY) {
    if (entry.importKind === "lazy") {
      void entry.importer();
    }
  }
}

// ── Nav group ordering ──────────────────────────────────────────────────

export interface SettingsNavGroup {
  label: string;
  scope: SettingsScope;
  entries: AnySettingsTabEntry[];
}

const GLOBAL_GROUP_ORDER = ["General", "Terminal", "Assistant", "Integrations", "Support"];

const _globalGroups: SettingsNavGroup[] = GLOBAL_GROUP_ORDER.map((label) => ({
  label,
  scope: "global" as const,
  entries: SETTINGS_REGISTRY.filter((e) => e.scope === "global" && e.group === label),
})).filter((g) => g.entries.length > 0);

const _projectGroups: SettingsNavGroup[] = [
  {
    label: "Project",
    scope: "project" as const,
    entries: SETTINGS_REGISTRY.filter((e) => e.scope === "project"),
  },
].filter((g) => g.entries.length > 0);

export function getSettingsNavGroups(scope: SettingsScope): SettingsNavGroup[] {
  return scope === "global" ? _globalGroups : _projectGroups;
}
