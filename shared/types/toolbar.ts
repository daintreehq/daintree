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

/**
 * Identifier for a launcher row that has no toolbar button id of its own: a
 * plugin or user-defined agent, a panel kind outside the fixed four, or a
 * recipe (#12217).
 *
 * One prefix for all three categories rather than three sibling prefixes,
 * because `sweepStalePluginPinnedButtons` has to be taught to leave these keys
 * alone and one thing to teach it is one thing that can go stale. The category
 * is the second segment, so a caller that needs it still gets it without a
 * second guard.
 *
 * Deliberately NOT the launcher's own `DockLaunchItem.key`, which happens to
 * carry the same `agent:`/`panel:`/`recipe:` shape. Those are presentation row
 * keys — free to change with the launcher's rendering — while these are
 * persisted user intent. Deriving one from the other would silently orphan
 * every pin the first time a row key is re-spelled.
 */
export type LauncherItemToolbarButtonId =
  | `${typeof LAUNCHER_ITEM_BUTTON_PREFIX}agent:${string}`
  | `${typeof LAUNCHER_ITEM_BUTTON_PREFIX}panel:${string}`
  | `${typeof LAUNCHER_ITEM_BUTTON_PREFIX}recipe:${string}`;

/** Identifier for any toolbar button (built-in, plugin, or launcher item) */
export type AnyToolbarButtonId =
  ToolbarButtonId | PluginToolbarButtonId | LauncherItemToolbarButtonId;

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
 * Launcher items (#12217 — plugin/user-defined agents, panel kinds outside the
 * fixed four, recipes) read the same way and for the same reason: they reach
 * the user through the launcher, so a top-level button is opt-in and only an
 * explicit `true` grants one. Their key is only ever matched against the live
 * launcher catalog, so an entry left behind by a deleted recipe or an
 * uninstalled plugin renders nothing.
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
 * Panel-kind id → the toolbar button that kind pins to.
 *
 * The two vocabularies are not the same words. A launcher built from
 * `panelKindRegistry` knows kinds; the toolbar knows button ids; and they agree
 * on three of four names by coincidence rather than by contract — dev preview is
 * the kind `dev-preview` and the button `dev-server`. Anything testing
 * `isLauncherPanelButtonId(kindId)` therefore drops that one row silently, which
 * is exactly the bug this map exists to make impossible.
 *
 * Deliberately a lookup rather than a filter: a kind that is absent here owns
 * none of these four fixed button ids. Since #12217 that no longer means the
 * kind can't be pinned — review, file and every plugin kind pin through
 * `launcherItemToolbarButtonId("panel", kindId)` instead — so "no entry" now
 * means "not one of the four", and the caller falls through to that id rather
 * than giving up.
 */
export const LAUNCHER_PANEL_KIND_TO_BUTTON_ID: Readonly<Record<string, LauncherPanelButtonId>> = {
  terminal: "terminal",
  "file-browser": "file-browser",
  browser: "browser",
  "dev-preview": "dev-server",
};

/** The toolbar button a panel kind pins to, or undefined when it has none. */
export function getLauncherPanelButtonIdForKind(kindId: string): LauncherPanelButtonId | undefined {
  return Object.prototype.hasOwnProperty.call(LAUNCHER_PANEL_KIND_TO_BUTTON_ID, kindId)
    ? LAUNCHER_PANEL_KIND_TO_BUTTON_ID[kindId]
    : undefined;
}

/**
 * Namespace every launcher-item button id carries.
 *
 * Load-bearing in one specific place: `sweepStalePluginPinnedButtons` finds
 * plugin keys with a bare `key.includes(".")`, and a launcher item's source id
 * can itself contain a dot — a plugin-contributed recipe's id is `publisher.name`
 * (see `TerminalRecipe.provenance`). The prefix is what lets that sweep skip
 * these keys instead of mistaking one for a plugin button it no longer knows.
 */
export const LAUNCHER_ITEM_BUTTON_PREFIX = "launcher:" as const;

/** Which launcher category a launcher-item button id came from. */
export type LauncherItemCategory = "agent" | "panel" | "recipe";

/**
 * Build the persisted toolbar button id for a launcher row that has none of its
 * own. `sourceId` is the agent id, panel kind id, or recipe id — taken verbatim,
 * because it is only ever compared against a live catalog, never re-parsed into
 * its parts.
 */
export function launcherItemToolbarButtonId(
  category: LauncherItemCategory,
  sourceId: string
): LauncherItemToolbarButtonId {
  return `${LAUNCHER_ITEM_BUTTON_PREFIX}${category}:${sourceId}` as LauncherItemToolbarButtonId;
}

/**
 * Takes a bare `string`, not an `AnyToolbarButtonId`: the callers that most need
 * it are iterating raw `pinnedButtons` keys, and narrowing the parameter would
 * make each of them assert its way in — which the lint ratchet scores per rule.
 * A `AnyToolbarButtonId` argument still narrows, since the predicate's type is a
 * member of that union.
 */
export function isLauncherItemToolbarButtonId(id: string): id is LauncherItemToolbarButtonId {
  return decodeLauncherItemToolbarButtonId(id) !== null;
}

/**
 * The category and source id behind a launcher-item button id, or `null` when
 * the string isn't one.
 *
 * Splits on the first two colons only and takes the rest as the source id, so a
 * recipe id containing `:` or `.` round-trips unchanged. An empty source id is
 * rejected: nothing in the launcher has one, and accepting it would mint a key
 * that can never match a catalog entry.
 */
export function decodeLauncherItemToolbarButtonId(
  id: string
): { category: LauncherItemCategory; sourceId: string } | null {
  if (!id.startsWith(LAUNCHER_ITEM_BUTTON_PREFIX)) return null;
  const rest = id.slice(LAUNCHER_ITEM_BUTTON_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const category = rest.slice(0, separator);
  const sourceId = rest.slice(separator + 1);
  if (sourceId.length === 0) return null;
  if (category !== "agent" && category !== "panel" && category !== "recipe") return null;
  return { category, sourceId };
}

/**
 * Whether a launcher item currently has its own top-level toolbar button.
 *
 * Only an explicit `true` counts, matching plugin contributions rather than the
 * built-in panel buttons above: a launcher item has no default slot to fall
 * through to, so array membership can only ever be the residue of a pin. The
 * `false` an unpin writes and the absence a never-pinned row carries are the
 * same answer, and nothing may seed either (#11667).
 */
export function isLauncherItemOnToolbar(
  id: LauncherItemToolbarButtonId,
  pinnedButtons: ToolbarPinnedState
): boolean {
  return pinnedButtons[id] === true;
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
