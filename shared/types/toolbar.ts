import type { BuiltInAgentId } from "../config/agentIds.js";

/** Identifier for plugin-contributed toolbar buttons (namespaced as plugin.name.buttonId) */
export type PluginToolbarButtonId = `plugin.${string}`;

/** Identifier for any toolbar button (built-in or plugin-contributed) */
export type AnyToolbarButtonId = ToolbarButtonId | PluginToolbarButtonId;

/** Unique identifier for built-in toolbar buttons */
export type ToolbarButtonId =
  | "sidebar-toggle"
  | "agent-setup"
  | "claude"
  | "gemini"
  | "codex"
  | "opencode"
  | "cursor"
  | "terminal"
  | "browser"
  | "dev-server"
  | "voice-recording"
  | "github-stats"
  | "notes"
  | "copy-tree"
  | "settings"
  | "problems"
  | "notification-center"
  | "panel-palette"
  | "portal-toggle";

/** Configuration for which toolbar buttons are visible and their order */
export interface ToolbarLayout {
  /** Ordered list of button IDs to show on the left side (excluding sidebar-toggle which is always first) */
  leftButtons: AnyToolbarButtonId[];
  /** Ordered list of button IDs to show on the right side (excluding portal-toggle which is always last) */
  rightButtons: AnyToolbarButtonId[];
  /** Button IDs that are hidden from the toolbar. Ordering is preserved in leftButtons/rightButtons. */
  hiddenButtons: AnyToolbarButtonId[];
}

/** Launcher palette default behaviors */
export interface LauncherDefaults {
  /** Always show dev server option in palette, even if devServerCommand not configured */
  alwaysShowDevServer: boolean;
  /** Default panel type to highlight when palette opens */
  defaultSelection?:
    | "terminal"
    | "claude"
    | "gemini"
    | "codex"
    | "opencode"
    | "cursor"
    | "browser"
    | "dev-server";
  /** Default agent for automated workflows like "What's Next?" */
  defaultAgent?: BuiltInAgentId;
}

/** Overflow priority (1 = always visible, 5 = overflow first) */
export type ToolbarButtonPriority = 1 | 2 | 3 | 4 | 5;

export const TOOLBAR_BUTTON_PRIORITIES: Record<ToolbarButtonId, ToolbarButtonPriority> = {
  "sidebar-toggle": 1,
  "portal-toggle": 1,
  "github-stats": 1,
  "voice-recording": 1,
  "agent-setup": 2,
  claude: 2,
  gemini: 2,
  codex: 2,
  opencode: 2,
  cursor: 2,
  terminal: 3,
  browser: 3,
  "dev-server": 3,
  "panel-palette": 4,
  settings: 5,
  "notification-center": 5,
  notes: 5,
  "copy-tree": 5,
  problems: 5,
};

/** Complete toolbar preferences configuration */
export interface ToolbarPreferences {
  /** Layout configuration (button visibility and ordering) */
  layout: ToolbarLayout;
  /** Launcher palette defaults */
  launcher: LauncherDefaults;
}
