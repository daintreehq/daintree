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
  | "launcher"
  | "plugin-tray"
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
 * Built-in buttons (incl. `launcher` / `plugin-tray`) default to visible:
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
 * directly — a promoted plugin contribution, or a launcher panel button they
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
 * `agentSettingsStore`, not here. Only `launcher`, `plugin-tray`, the non-agent
 * built-ins, and plugin buttons are governed by this map.
 */
export type ToolbarPinnedState = Partial<Record<AnyToolbarButtonId, boolean>>;

/**
 * The built-in panel buttons the launcher can promote to (or demote from) a
 * top-level toolbar slot (#11667, extended in #11680), in the order the
 * launcher's Panels section lists them.
 *
 * `browser` and `dev-server` left `DEFAULT_LEFT_BUTTONS` in v13, so on a fresh
 * profile they sit in neither side array — which means promoting one has to
 * give it a position as well as clear any hide, and has to leave behind an
 * explicit `true` that survives a cross-view array overwrite.
 * `toggleButtonVisibility` does neither: it only ever writes `false` or deletes
 * the key. Every surface that can show or hide one of these buttons must route
 * through `setPanelButtonOnToolbar` instead — the launcher, and Settings →
 * Toolbar.
 *
 * `terminal` and `file-browser` join the list in #11680 even though both still
 * ship in `DEFAULT_LEFT_BUTTONS`. Membership here is about which setter owns the
 * id, not about whether it has a default slot: the launcher gives every Panels
 * row the same pin affordance, so every one of them has to write through the
 * same action or the four visibility rules the issue set out to collapse simply
 * move around. `isPanelButtonOnToolbar`'s array fall-through already reads a
 * default-array member as on, so their shipped behavior is unchanged.
 *
 * One exported list so a fourth surface can't quietly disagree about which ids
 * those are.
 */
export const LAUNCHER_PANEL_BUTTON_IDS = [
  "terminal",
  "file-browser",
  "browser",
  "dev-server",
] as const;

export type LauncherPanelButtonId = (typeof LAUNCHER_PANEL_BUTTON_IDS)[number];

export function isLauncherPanelButtonId(id: AnyToolbarButtonId): id is LauncherPanelButtonId {
  return (LAUNCHER_PANEL_BUTTON_IDS as readonly string[]).includes(id);
}

/**
 * Whether a launcher panel button currently has its own top-level toolbar
 * button.
 *
 * Three states, in priority order. An explicit `false` is a hide and wins over
 * any position. An explicit `true` is a promotion the user made, and reads as on
 * even in the window between a stale cross-view write dropping the position and
 * `restorePromotedPanelButtons` rebuilding it. Otherwise the position decides:
 * that is the legacy profile, which carries `browser`/`dev-server` in its arrays
 * with no pin entry at all and must keep reading as promoted so an existing
 * user's toolbar looks untouched. It is also what keeps `terminal` and
 * `file-browser` reading as on out of the box — both ship in
 * `DEFAULT_LEFT_BUTTONS` and carry no pin entry until the user acts.
 *
 * Lives here rather than beside `isToolbarButtonVisible` because it is the only
 * resolver that reads the side arrays, and every surface that shows one of these
 * buttons has to agree with the launcher: the launcher itself, and Settings →
 * Toolbar. `isToolbarButtonVisible` cannot answer this — without the arrays a
 * fresh profile's absent `browser` pin reads as visible when the button isn't
 * there.
 */
export function isPanelButtonOnToolbar(
  id: LauncherPanelButtonId,
  pinnedButtons: ToolbarPinnedState,
  leftButtons: AnyToolbarButtonId[],
  rightButtons: AnyToolbarButtonId[]
): boolean {
  if (pinnedButtons[id] === false) return false;
  if (pinnedButtons[id] === true) return true;
  return leftButtons.includes(id) || rightButtons.includes(id);
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
  // Deliberately ahead of the individual panel buttons at 3: on a fresh profile
  // the launcher is the only toolbar route to the agents and to `browser` /
  // `dev-server`, so evicting it before them would strand everything whose own
  // button isn't there to fall back to (#11680).
  launcher: 2,
  "plugin-tray": 2,
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
