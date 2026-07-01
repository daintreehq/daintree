import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "../config/agentIds.js";

/**
 * Identifier for plugin-contributed toolbar buttons. Canonical namespace is
 * `{pluginId}.{buttonId}` (matches `PluginActionDescriptor.id`). The legacy
 * `plugin.{pluginId}.{buttonId}` form was retired in #9281; persisted user
 * pin preferences carrying the old prefix are renamed by the
 * `toolbarPreferencesStore` v9 migration.
 *
 * The template literal `${string}.${string}` keeps the dotted-namespace
 * shape in the type system without re-introducing a hard-coded prefix —
 * the renderer distinguishes plugin from built-in buttons by membership in
 * the broadcast `configs` map, not by string parsing.
 */
export type PluginToolbarButtonId = `${string}.${string}`;

/** Identifier for any toolbar button (built-in or plugin-contributed) */
export type AnyToolbarButtonId = ToolbarButtonId | PluginToolbarButtonId;

/**
 * Unique identifier for built-in toolbar buttons.
 *
 * Agent button IDs are derived from `BUILT_IN_AGENT_IDS` so that adding a new
 * agent to the registry automatically makes it a valid toolbar button ID
 * without touching this union.
 */
export type ToolbarButtonId =
  | "sidebar-toggle"
  | "agent-tray"
  | BuiltInAgentId
  | "terminal"
  | "browser"
  | "dev-server"
  | "voice-recording"
  | "forge-stats"
  | "copy-tree"
  | "command-palette"
  | "resume-sessions"
  | "settings"
  | "problems"
  | "notification-center"
  | "assistant-toggle"
  | "portal-toggle";

/**
 * Sparse pin-state map for toolbar buttons. Mirrors the tri-state semantics
 * used by `agentSettingsStore.agents[id].pinned`:
 *
 *   - `false`      → user explicitly hid this button
 *   - `true`       → user explicitly pinned this button (currently unused for
 *                    non-agent buttons since defaults are visible, reserved
 *                    for future "pin-as-universal" extensions)
 *   - `undefined`  → follow default visibility (visible)
 *
 * Agent-button IDs (entries in `BUILT_IN_AGENT_IDS`) live in
 * `agentSettingsStore`, not here. Only `agent-tray`, the non-agent built-ins,
 * and plugin buttons are governed by this map.
 */
export type ToolbarPinnedState = Partial<Record<AnyToolbarButtonId, boolean>>;

/** Configuration for which toolbar buttons are visible and their order */
export interface ToolbarLayout {
  /** Ordered list of button IDs to show on the left side (excluding sidebar-toggle which is always first) */
  leftButtons: AnyToolbarButtonId[];
  /** Ordered list of button IDs to show on the right side (excluding assistant-toggle and portal-toggle which are always last) */
  rightButtons: AnyToolbarButtonId[];
  /**
   * Per-button visibility overrides. `false` hides the button; missing
   * entries fall through to the default. Ordering stays in
   * `leftButtons`/`rightButtons`.
   */
  pinnedButtons: ToolbarPinnedState;
}

/** Launcher palette default behaviors */
export interface LauncherDefaults {
  /** Always show dev server option in palette, even if devServerCommand not configured */
  alwaysShowDevServer: boolean;
  /** Default panel type to highlight when palette opens */
  defaultSelection?: "terminal" | BuiltInAgentId | "browser" | "dev-server";
  /** Default agent for automated workflows like "What's Next?" */
  defaultAgent?: BuiltInAgentId;
}

/** Overflow priority (1 = always visible, 5 = overflow first) */
export type ToolbarButtonPriority = 1 | 2 | 3 | 4 | 5;

export const TOOLBAR_BUTTON_PRIORITIES: Record<ToolbarButtonId, ToolbarButtonPriority> = {
  "sidebar-toggle": 1,
  "assistant-toggle": 1,
  "portal-toggle": 1,
  "forge-stats": 1,
  "voice-recording": 1,
  "agent-tray": 2,
  ...(Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => [id, 2 as ToolbarButtonPriority])
  ) as Record<BuiltInAgentId, ToolbarButtonPriority>),
  terminal: 3,
  browser: 3,
  "dev-server": 3,
  "command-palette": 4,
  "resume-sessions": 4,
  settings: 5,
  "notification-center": 5,
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
