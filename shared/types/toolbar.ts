import type { BuiltInAgentId } from "../config/agentIds.js";

/** Unique identifier for toolbar buttons */
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
  leftButtons: ToolbarButtonId[];
  /** Ordered list of button IDs to show on the right side (excluding portal-toggle which is always last) */
  rightButtons: ToolbarButtonId[];
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
  "agent-setup": 2,
  claude: 2,
  gemini: 2,
  codex: 2,
  opencode: 2,
  cursor: 2,
  terminal: 3,
  browser: 3,
  "dev-server": 3,
  "panel-palette": 3,
  settings: 4,
  "notification-center": 4,
  "voice-recording": 1,
  "github-stats": 5,
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
