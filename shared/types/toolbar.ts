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
  | "sidecar-toggle";

/** Configuration for which toolbar buttons are visible and their order */
export interface ToolbarLayout {
  /** Ordered list of button IDs to show on the left side (excluding sidebar-toggle which is always first) */
  leftButtons: ToolbarButtonId[];
  /** Ordered list of button IDs to show on the right side (excluding sidecar-toggle which is always last) */
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

/** Complete toolbar preferences configuration */
export interface ToolbarPreferences {
  /** Layout configuration (button visibility and ordering) */
  layout: ToolbarLayout;
  /** Launcher palette defaults */
  launcher: LauncherDefaults;
}
