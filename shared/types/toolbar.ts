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
  | "plugin-tray"
  | "panel-tray"
  | BuiltInAgentId
  | "terminal"
  | "browser"
  | "file-browser"
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
 * used by `agentSettingsStore.agents[id].pinned`, but the default the missing
 * entry falls back to differs by button kind:
 *
 * Built-in buttons (incl. `agent-tray` / `plugin-tray` / `panel-tray`) default
 * to visible:
 *   - `false`      → user explicitly hid this button
 *   - `undefined`  → visible
 *
 * This map records ONLY explicit user intent, and nothing may ever backfill a
 * default into it (#11667). A built-in that should be absent from a fresh
 * toolbar is expressed by leaving it out of `DEFAULT_LEFT_BUTTONS` /
 * `DEFAULT_RIGHT_BUTTONS` — array membership, which is per-profile and needs no
 * write — never by seeding a `false`.
 *
 * v12 got this wrong: it stamped `file-browser: false` onto every profile, which
 * permanently converted an implicit default into an explicit choice and made a
 * deliberate hide indistinguishable from a seed. v13 deletes that stamp. Seeding
 * a default here again would forfeit the same option a second time, so a
 * built-in's pin entry stays absent until the user acts on it.
 *
 * A `true` therefore only ever appears where the user asked for the button
 * directly — a promoted plugin contribution, or a `panel-tray` button they
 * pinned (`setPanelButtonOnToolbar`). It is a record of an action, never of a
 * default. `toggleButtonVisibility`, which every other built-in uses, still
 * never writes one: for a button that is already a default, `true` would say
 * nothing its array membership doesn't.
 *
 * Plugin contributions default to tray-only (#11304) — they always appear in
 * the plugin tray, and `true` additionally promotes one to its own top-level
 * button rather than making it merely "visible":
 *   - `true`             → tray row + top-level button
 *   - `false`/`undefined` → tray row only
 *
 * Agent-button IDs (entries in `BUILT_IN_AGENT_IDS`) live in
 * `agentSettingsStore`, not here. Only `agent-tray`, `plugin-tray`,
 * `panel-tray`, the non-agent built-ins, and plugin buttons are governed by
 * this map.
 */
export type ToolbarPinnedState = Partial<Record<AnyToolbarButtonId, boolean>>;

/**
 * The built-in panel buttons the panel tray can promote to (or demote from) a
 * top-level toolbar slot (#11667), in the order the tray lists them.
 *
 * `browser` and `dev-server` left `DEFAULT_LEFT_BUTTONS` in v13, so on a fresh
 * profile they sit in neither side array — which means promoting one has to
 * give it a position as well as clear any hide, and has to leave behind an
 * explicit `true` that survives a cross-view array overwrite.
 * `toggleButtonVisibility` does neither: it only ever writes `false` or deletes
 * the key. Every surface that can show or hide one of these buttons must route
 * through `setPanelButtonOnToolbar` instead — the tray, and Settings → Toolbar.
 *
 * One exported list so a fourth surface can't quietly disagree about which ids
 * those are.
 */
export const PANEL_TRAY_BUTTON_IDS = ["file-browser", "browser", "dev-server"] as const;

export type PanelTrayButtonId = (typeof PANEL_TRAY_BUTTON_IDS)[number];

export function isPanelTrayButtonId(id: AnyToolbarButtonId): id is PanelTrayButtonId {
  return (PANEL_TRAY_BUTTON_IDS as readonly string[]).includes(id);
}

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
  "plugin-tray": 2,
  // Same tier as the other trays, and deliberately ahead of the individual
  // panel buttons at 3: on a fresh profile the tray is the only toolbar route
  // to `browser` and `dev-server`, so evicting it before them would strand
  // panels whose own buttons aren't there to fall back to.
  "panel-tray": 2,
  ...(Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => [id, 2 as ToolbarButtonPriority])
  ) as Record<BuiltInAgentId, ToolbarButtonPriority>),
  terminal: 3,
  browser: 3,
  "file-browser": 3,
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
