import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  getSpawnablePanelKinds,
  subscribeToPanelKindDefinitions,
  getPanelKindDefinitionsSnapshot,
} from "@/registry";
import {
  panelKindIsDockable,
  panelKindIsProjectScoped,
  getPanelKindConfig,
  getPanelKindOrigin,
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
  type PanelKindOrigin,
} from "@shared/config/panelKindRegistry";
import { useRecipeStore } from "@/store/recipeStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { actionService } from "@/services/ActionService";
import { launchPanelKind } from "@/registry/panelKindLaunch";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { notify } from "@/lib/notify";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { getRecipeScope } from "@/utils/recipeScope";
import { logError } from "@/utils/logger";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { isOwnPluginAction } from "@shared/utils/remotePluginContributions";
import { isBuiltInActionId } from "@shared/utils/builtInActionIds";
import {
  getPluginAgentRegistrySnapshot,
  subscribeToPluginAgentRegistry,
} from "@shared/config/pluginAgentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { evaluateWhenClause } from "@shared/utils/whenClause";
import { useChromeWhenContext } from "@/hooks/useChromeWhenContext";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";
import { isRegisteredAgent } from "@/config/agents";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { TOOLBAR_CUSTOMIZE_LABEL } from "./toolbarMenuStrings";
import type { ActionSource, AgentAvailabilityState, TerminalRecipe } from "@shared/types";
import type { PluginLaunchEntryConfig, PluginLaunchEntryTarget } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import type { RecipeContext } from "@/utils/recipeVariables";

export const AGENT_MRU_PREFIX = "agent.";

/** Cap the recent group at the head of the agents so it stays a quick-reach
 * handful rather than reordering the whole agent list. */
export const RECENCY_BAND_CAP = 3;

/** Terminal opts out of the palette (it has dedicated spawn actions) but is the
 * launcher's most-used entry, so it is added back explicitly here. */
const TERMINAL_KIND_ID = "terminal";

/** Row id of the "Create a recipe" cue — the one browse row with no item. */
export const CREATE_RECIPE_ROW_KEY = "create-recipe";

export type LaunchAgentIcon = React.ComponentType<{
  className?: string;
  style?: React.CSSProperties;
}>;

/** Which provenance group a preset renders under, in this order. */
export type DockLaunchPresetGroup = "default" | "ccr" | "project" | "custom";

/**
 * One selectable preset for an agent. `presetId: null` is the synthetic
 * "Default" choice — the sentinel that clears a saved preset rather than
 * inheriting it, so it is deliberately distinct from `undefined`.
 */
export interface DockLaunchPresetChoice {
  presetId: string | null;
  label: string;
  color?: string;
  group: DockLaunchPresetGroup;
  isSelected: boolean;
}

export interface DockLaunchAgent {
  id: string;
  name: string;
  icon?: LaunchAgentIcon;
  brandColor?: string;
  availability?: AgentAvailabilityState;
  /**
   * Present only when the agent has at least one named preset. Always begins
   * with the synthetic Default choice, so an expanded row can offer the plain
   * launch alongside the named ones.
   */
  presetChoices?: readonly DockLaunchPresetChoice[];
  /** Newly detected on this machine and not yet acted on — drives the "New" cue. */
  isNew?: boolean;
}

/**
 * Why a row cannot be activated right now. An object rather than a boolean plus
 * a separately-optional reason, so a disabled row can never render without one.
 */
export interface DockLaunchDisabledState {
  reason: string;
}

interface DockLaunchItemBase {
  /** Stable key, unique across categories (an agent and a panel can share an id). */
  key: string;
  name: string;
  searchAliases?: string[];
  description?: string;
  /**
   * Set when a precondition for launching is missing. The row stays in the
   * navigation space regardless — its pin affordance is still worth reaching,
   * and pinning a panel you haven't opened a project for yet is reasonable.
   */
  disabled?: DockLaunchDisabledState;
}

/** Which agent band a row belongs to, decided by availability. */
export type DockLaunchAgentBand = "launch" | "needs-setup" | "available";

export interface DockLaunchAgentItem extends DockLaunchItemBase {
  category: "agent";
  agent: DockLaunchAgent;
  agentBand: DockLaunchAgentBand;
}

export interface DockLaunchPanelItem extends DockLaunchItemBase {
  category: "panel";
  kindId: string;
  iconId: string;
  color: string;
  /** Where selecting this item actually lands the panel. Derived from
   * `panelKindIsDockable`, so the label can never contradict `addPanel`. */
  location: "dock" | "grid";
  /** Which tier contributed the kind. Classified once here rather than at each
   * render site so the launcher, its context menu and the palette cannot
   * disagree about the same kind (#12272). */
  origin: PanelKindOrigin;
}

export interface DockLaunchRecipeItem extends DockLaunchItemBase {
  category: "recipe";
  recipe: TerminalRecipe;
  scopeLabel: string;
  isShadowed: boolean;
}

/** The plugin a launcher group belongs to, named as the group's heading. */
export interface DockLaunchPluginGroup {
  pluginId: string;
  pluginName: string;
}

/** Where `panel.openPluginPanel` opens a panel entry's panel. */
export type DockLaunchEntryPresentation = "panel" | "dock" | "dialog";

/** A row a plugin contributed (#13788), rendered by the host from its data. */
export interface DockLaunchPluginEntryItem extends DockLaunchItemBase, DockLaunchPluginGroup {
  category: "plugin-entry";
  /** The runtime entry id `{pluginId}.{entry id}` — what its toolbar pin is keyed by. */
  entryId: string;
  iconId: string;
  target: PluginLaunchEntryTarget;
  /** Where a panel target opens from this surface. Absent for every other target. */
  presentation?: DockLaunchEntryPresentation;
}

export type DockLaunchItem =
  DockLaunchAgentItem | DockLaunchPanelItem | DockLaunchRecipeItem | DockLaunchPluginEntryItem;

/** Heading a launcher row renders under. `results` is the filtered list. */
export type DockLaunchBandId =
  | "recent"
  | "pinned"
  | "other"
  | "agents"
  | "dock-panels"
  | "grid-panels"
  | "plugin-entries"
  | "recipes"
  | "needs-setup"
  | "available-agents"
  | "presets"
  | "actions"
  | "results";

export const DOCK_LAUNCH_BAND_LABELS: Record<DockLaunchBandId, string> = {
  recent: "Recent",
  pinned: "Pinned",
  other: "Other",
  agents: "Agents",
  "dock-panels": "Open in dock",
  "grid-panels": "Open in grid",
  // Only a fallback: each plugin's group is headed by the plugin's own name
  // (see `dockLaunchBandLabel`).
  "plugin-entries": "Plugins",
  recipes: "Recipes",
  "needs-setup": "Needs setup",
  "available-agents": "Available agents",
  presets: "Presets",
  actions: "More",
  results: "Search results",
};

/**
 * What kind of thing a row is, in one word.
 *
 * Only ever rendered in the flat `results` band. Every browse band is
 * type-homogeneous and its heading already says this, so a row that carries it
 * under a heading is saying the same word twice; a row that carries it in mixed
 * search results is the only thing telling a recipe named Review apart from a
 * panel named Review.
 */
export const DOCK_LAUNCH_CATEGORY_LABELS: Record<DockLaunchItem["category"], string> = {
  agent: "Agent",
  panel: "Panel",
  recipe: "Recipe",
  "plugin-entry": "Plugin",
};

/** A row that runs something other than a launchable item. */
export type DockLaunchCueId =
  "create-recipe" | "setup-agents" | "manage-agents" | "customize-toolbar" | "hide-plugin-group";

/** Heading for each named provenance group, matching the old preset submenu. */
export const DOCK_LAUNCH_PRESET_GROUP_LABELS: Record<DockLaunchPresetGroup, string> = {
  default: "",
  ccr: "CCR routes",
  project: "Project shared",
  custom: "Custom",
};

export const DOCK_LAUNCH_CUE_LABELS: Record<DockLaunchCueId, string> = {
  "create-recipe": "Create a recipe",
  "setup-agents": "Set up agents",
  "manage-agents": "Manage agents",
  // The plugin tray's own entry, word for word: two routes to one settings page
  // that disagreed about its name would read as two destinations (#12218).
  "customize-toolbar": TOOLBAR_CUSTOMIZE_LABEL,
  // It ends its group, under the plugin's own heading, so the plugin's name
  // would only repeat it; the row's accessible name carries it instead.
  "hide-plugin-group": "Hide in this project",
};

interface DockLaunchRowBase {
  /**
   * Unique per rendered row — NOT the item key. The recency band repeats agents
   * that also appear under Pinned/Other, and two rows sharing an id would
   * highlight together and break `aria-activedescendant`.
   */
  rowKey: string;
  band: DockLaunchBandId;
}

/**
 * One rendered row of the `+` launcher palette. The launcher drives arrow-key
 * navigation off a single flat row list for both the browse bands and the
 * filtered results, so every row needs an index in the same space — which is
 * why an expanded agent's presets are sibling rows here rather than a nested
 * menu. A submenu would open a second focus and navigation system that
 * `selectedIndex` and `aria-activedescendant` cannot describe.
 */
export type DockLaunchRow =
  | (DockLaunchRowBase & { kind: "item"; item: DockLaunchItem })
  | (DockLaunchRowBase & {
      kind: "cue";
      cue: DockLaunchCueId;
      /** The group a `hide-plugin-group` cue hides; absent on every other cue. */
      pluginGroup?: DockLaunchPluginGroup;
    })
  | (DockLaunchRowBase & {
      kind: "preset";
      band: "presets";
      item: DockLaunchAgentItem;
      /**
       * The exact parent ROW key, not the item key: an agent listed under both
       * Recently launched and Pinned must expand only the copy that was
       * activated, or both highlight and the ids collide.
       */
      parentRowKey: string;
      preset: DockLaunchPresetChoice;
      /**
       * Provenance heading, stamped on the first row of each named group and
       * only when more than one exists — with a single group the heading would
       * just restate what every row under it already is.
       */
      groupLabel?: string;
    });

/** The plugin group a row belongs to: a plugin entry, or the cue that hides its group. */
export function getDockLaunchRowPluginGroup(row: DockLaunchRow): DockLaunchPluginGroup | undefined {
  if (row.kind === "cue") return row.pluginGroup;
  return row.item.category === "plugin-entry" ? row.item : undefined;
}

/**
 * The heading a row's band shows. Every band names itself except a plugin
 * group, which is headed by the plugin it belongs to — that heading is the
 * attribution, so a row never has to say whose it is.
 */
export function dockLaunchBandLabel(band: DockLaunchBandId, row: DockLaunchRow): string {
  if (band === "plugin-entries") {
    return getDockLaunchRowPluginGroup(row)?.pluginName ?? DOCK_LAUNCH_BAND_LABELS[band];
  }
  return DOCK_LAUNCH_BAND_LABELS[band];
}

/** Narrowing helper — the item rows are the only ones carrying a launchable item. */
export function getDockLaunchRowItem(row: DockLaunchRow): DockLaunchItem | undefined {
  return row.kind === "item" || row.kind === "preset" ? row.item : undefined;
}

/**
 * Split an agent's merged presets into the launcher's fixed provenance order,
 * with the synthetic Default first.
 *
 * Project membership beats the `ccr-` prefix so a project preset with a `ccr-*`
 * id still reads as Project shared; everything neither project nor `ccr-` falls
 * through to Custom, preserving display for presets whose origin can't be told
 * from the id alone.
 */
export function buildPresetChoices(
  presets: ReadonlyArray<{ id: string; name: string; displayTitle?: string; color?: string }>,
  projectPresetIds: ReadonlySet<string>,
  savedPresetId: string | undefined
): DockLaunchPresetChoice[] {
  const groupOf = (id: string): DockLaunchPresetGroup =>
    projectPresetIds.has(id) ? "project" : id.startsWith("ccr-") ? "ccr" : "custom";
  const order: DockLaunchPresetGroup[] = ["ccr", "project", "custom"];

  const named = presets.map((preset) => {
    const group = groupOf(preset.id);
    return {
      presetId: preset.id,
      // CCR names carry a redundant "CCR: " prefix that the group heading
      // already states.
      label:
        preset.displayTitle ??
        (group === "ccr" ? preset.name.replace(/^CCR:\s*/, "") : preset.name),
      color: preset.color,
      group,
      isSelected: savedPresetId === preset.id,
    } satisfies DockLaunchPresetChoice;
  });

  named.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

  return [
    {
      presetId: null,
      label: "Default",
      group: "default",
      // Default is the selection precisely when nothing named is saved.
      isSelected: savedPresetId === undefined,
    },
    ...named,
  ];
}

/**
 * The sibling rows an expanded agent contributes, keyed to the exact parent row
 * so the same agent listed twice expands independently.
 */
export function buildPresetRows(parentRow: DockLaunchRow): DockLaunchRow[] {
  if (parentRow.kind !== "item") return [];
  const { item } = parentRow;
  if (item.category !== "agent") return [];
  const choices = item.agent.presetChoices;
  if (!choices || choices.length === 0) return [];
  // Headings only earn their space when they tell two groups apart — the old
  // submenu applied exactly this rule.
  const namedGroups = new Set(
    choices.filter((choice) => choice.presetId !== null).map((choice) => choice.group)
  );
  const showGroupLabels = namedGroups.size > 1;
  const labelled = new Set<DockLaunchPresetGroup>();

  return choices.map((preset) => ({
    kind: "preset" as const,
    // The synthetic Default and a real preset live in separate key namespaces:
    // Mistral ships a preset whose id is literally "default", and a shared
    // spelling would collide — two rows with one id highlight together and
    // leave `aria-activedescendant` pointing at whichever rendered last.
    rowKey: `preset:${parentRow.rowKey}:${
      preset.presetId === null ? "sentinel:default" : `id:${preset.presetId}`
    }`,
    band: "presets" as const,
    item,
    parentRowKey: parentRow.rowKey,
    preset,
    groupLabel:
      showGroupLabels && preset.presetId !== null && !labelled.has(preset.group)
        ? (labelled.add(preset.group), DOCK_LAUNCH_PRESET_GROUP_LABELS[preset.group])
        : undefined,
  }));
}

/** Splice an agent's preset rows in immediately after it, leaving order intact. */
export function insertExpandedPresetRows(
  rows: ReadonlyArray<DockLaunchRow>,
  parentRowKey: string | null
): DockLaunchRow[] {
  if (!parentRowKey) return [...rows];
  const index = rows.findIndex((row) => row.rowKey === parentRowKey);
  if (index < 0) return [...rows];
  const presetRows = buildPresetRows(rows[index]!);
  if (presetRows.length === 0) return [...rows];
  return [...rows.slice(0, index + 1), ...presetRows, ...rows.slice(index + 1)];
}

/** True when a row can expand into preset children. */
export function rowHasPresets(row: DockLaunchRow | undefined): boolean {
  if (!row || row.kind !== "item") return false;
  const { item } = row;
  return (
    item.category === "agent" &&
    isAgentLaunchable(item.agent.availability) &&
    (item.agent.presetChoices?.length ?? 0) > 0
  );
}

export interface DockLaunchModel {
  /** Capped frecency band; entries also appear in the agent groups below. */
  recentAgents: DockLaunchAgent[];
  dockPanels: DockLaunchPanelItem[];
  gridPanels: DockLaunchPanelItem[];
  /** One group per plugin with an entry showing, in heading order, each sorted by priority. */
  pluginGroups: Array<DockLaunchPluginGroup & { items: DockLaunchPluginEntryItem[] }>;
  recipes: DockLaunchRecipeItem[];
  /** Flat, de-duplicated set fed to Fuse — the recency band is not repeated. */
  searchItems: DockLaunchItem[];
  /**
   * Every browse row in render order, recency duplicates included. This is the
   * launcher's navigation space when nothing is typed; `searchItems` stays
   * de-duplicated so a recent agent can't rank twice in the results.
   */
  browseRows: DockLaunchRow[];
}

/**
 * Where a launcher surface creates panels by default. The dock `+` button and
 * the dock's right-click menu create in the dock; the grid's right-click menu
 * creates in the grid, so nothing rendered there may claim a dock landing.
 */
export type DockLaunchSurface = "dock" | "grid";

/**
 * Preconditions the launcher gates rows on. Optional throughout: a surface that
 * doesn't know (the dock's right-click menu) gets today's behaviour, where a row
 * with no resolvable target reports after the fact instead of pre-empting.
 */
export interface DockLaunchPreconditions {
  hasWorkspace?: boolean;
  hasProject?: boolean;
}

/**
 * Whether the agent inventory is still being detected, reflects what is actually
 * installed, or is the every-built-in discovery list shown when nothing is.
 */
export type DockLaunchInventoryState = "loading" | "installed" | "fallback";

export interface BuildDockLaunchModelOptions extends DockLaunchPreconditions {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  activeWorktreeId: string | null;
  recipes: ReadonlyArray<TerminalRecipe>;
  mruEntries: ReadonlyArray<{ id: string; lastAccessedAt: number }>;
  surface: DockLaunchSurface;
  agentInventoryState?: DockLaunchInventoryState;
  /** Every launch entry registered for this project, shown or not. */
  launchEntries?: ReadonlyArray<PluginLaunchEntryConfig>;
  /** Plugin ids whose group this project hides. */
  hiddenPluginIds?: ReadonlyArray<string>;
  /** The live chrome context entries' `when` clauses are read against. Absent: every clause holds. */
  whenContext?: WhenClauseContext;
  /** Whether an agent entry's agent is registered. Absent: the live effective registry. */
  isAgentRegistered?: (agentId: string) => boolean;
}

/**
 * Panels whose action resolves nothing without a workspace or project. Gated
 * here rather than at the row so every consumer of the model agrees, and stated
 * as a reason the row can render rather than a bare boolean.
 */
function panelPrecondition(
  kindId: string,
  { hasWorkspace, hasProject }: DockLaunchPreconditions
): DockLaunchDisabledState | undefined {
  // Undefined means "not supplied", which must not read as false — the dock's
  // context menu doesn't know either answer and must keep offering both rows.
  if (kindId === "file-browser" && hasWorkspace === false) return { reason: "Needs a workspace" };
  if (kindId === "dev-preview" && hasProject === false) return { reason: "Needs a project" };
  return undefined;
}

function toPanelItem(
  config: {
    id: string;
    name: string;
    iconId: string;
    color: string;
    searchAliases?: string[];
    extensionId?: string;
    projectId?: string | null;
  },
  surface: DockLaunchSurface,
  preconditions: DockLaunchPreconditions
): DockLaunchPanelItem {
  // A grid surface lands everything in the grid regardless of dockability — its
  // launch callback dispatches `location: "grid"`, so claiming "dock" there
  // would misstate the destination just as badly as the redirect this replaced.
  // The one exception is a project-scoped plugin kind, which `launchPanelKind`
  // always puts in the dock (#13778).
  const location =
    panelKindIsProjectScoped(config.id) || (surface === "dock" && panelKindIsDockable(config.id))
      ? "dock"
      : "grid";
  return {
    category: "panel",
    key: `panel:${config.id}`,
    kindId: config.id,
    name: config.name,
    iconId: config.iconId,
    color: config.color,
    // "panel" and the destination are searchable so "grid" or "panel" narrows
    // to this group without the registry aliases having to spell it out.
    searchAliases: [...(config.searchAliases ?? []), "panel", location],
    location,
    origin: getPanelKindOrigin(config),
    disabled: panelPrecondition(config.id, preconditions),
  };
}

/**
 * Whether a command entry dispatches its own plugin's action. A built-in is
 * never one, even when its id starts with the plugin's name — a plugin named
 * `env.global` does not own `env.global.set`.
 */
function isOwnLaunchCommand(pluginId: string, actionId: string): boolean {
  return isOwnPluginAction(pluginId, actionId) && !isBuiltInActionId(actionId);
}

/**
 * Where a panel entry opens from `surface`. An explicit placement is the
 * author's, already checked against the panel at the manifest gate; without
 * one it lands where this surface lands a panel row of the same kind.
 */
function entryPresentation(
  target: Extract<PluginLaunchEntryTarget, { type: "panel" }>,
  surface: DockLaunchSurface
): DockLaunchEntryPresentation {
  if (target.placement === "dialog") return "dialog";
  if (target.placement === "dock") return "dock";
  if (target.placement === "grid") return "panel";
  if (panelKindIsProjectScoped(target.panelKindId)) return "dock";
  return surface === "dock" && panelKindIsDockable(target.panelKindId) ? "dock" : "panel";
}

/**
 * The launcher row for one entry, or `null` for an entry that names something
 * outside its own plugin. The manifest gate and main's registration already
 * refuse those; this is the check at the point of use, so a stale or forged
 * snapshot still can't make a row open another plugin's panel.
 */
function toPluginEntryItem(
  entry: PluginLaunchEntryConfig,
  surface: DockLaunchSurface,
  isAgentRegistered: (agentId: string) => boolean
): DockLaunchPluginEntryItem | null {
  const { target } = entry;
  const base = {
    category: "plugin-entry" as const,
    key: `plugin-entry:${entry.id}`,
    entryId: entry.id,
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    name: entry.label,
    description: entry.description,
    iconId: entry.iconId,
    target,
    // The plugin's name is searchable so typing it narrows to its group, as
    // "panel" and "recipe" narrow to theirs.
    searchAliases: [entry.pluginName, "plugin"],
  };
  if (target.type === "command") {
    return isOwnLaunchCommand(entry.pluginId, target.actionId) ? base : null;
  }
  if (target.type === "agent") {
    return isAgentRegistered(target.agentId)
      ? base
      : { ...base, disabled: { reason: "Agent not available" } };
  }
  const config = getPanelKindConfig(target.panelKindId);
  // Not registered yet: the plugin's metadata can land before its kinds do.
  if (!config) return { ...base, disabled: { reason: "Panel not available" } };
  if (config.extensionId !== entry.pluginId) return null;
  return { ...base, presentation: entryPresentation(target, surface) };
}

/**
 * The plugin groups a surface lists: every entry whose group this project
 * hasn't hidden and whose `when` holds, one group per plugin. Groups are in
 * name order, so a plugin can't buy its way up the launcher; within one,
 * priority decides and ties keep manifest order.
 */
export function buildPluginGroups(
  entries: ReadonlyArray<PluginLaunchEntryConfig>,
  {
    surface,
    hiddenPluginIds = [],
    whenContext,
    isAgentRegistered = isRegisteredAgent,
  }: {
    surface: DockLaunchSurface;
    hiddenPluginIds?: ReadonlyArray<string>;
    whenContext?: WhenClauseContext;
    isAgentRegistered?: (agentId: string) => boolean;
  }
): DockLaunchModel["pluginGroups"] {
  const hidden = new Set(hiddenPluginIds);
  const groups = new Map<string, DockLaunchModel["pluginGroups"][number]>();
  const shown = entries
    .filter((entry) => !hidden.has(entry.pluginId))
    .filter((entry) => !whenContext || evaluateWhenClause(entry.when, whenContext))
    .sort((a, b) => a.priority - b.priority);
  for (const entry of shown) {
    const item = toPluginEntryItem(entry, surface, isAgentRegistered);
    if (!item) continue;
    const group = groups.get(entry.pluginId);
    if (group) group.items.push(item);
    else
      groups.set(entry.pluginId, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
        items: [item],
      });
  }
  return [...groups.values()].sort(
    (a, b) => a.pluginName.localeCompare(b.pluginName) || a.pluginId.localeCompare(b.pluginId)
  );
}

/**
 * Capped frecency band, newest-first as the MRU store already sorted it. Drops
 * cold-start seeds (never launched), non-agent keys, and entries whose agent is
 * no longer registered.
 */
export function selectRecentAgents(
  agents: ReadonlyArray<DockLaunchAgent>,
  mruEntries: ReadonlyArray<{ id: string; lastAccessedAt: number }>
): DockLaunchAgent[] {
  return mruEntries
    .filter((entry) => entry.lastAccessedAt > 0 && entry.id.startsWith(AGENT_MRU_PREFIX))
    .map((entry) => agents.find((a) => a.id === entry.id.slice(AGENT_MRU_PREFIX.length)))
    .filter((agent): agent is DockLaunchAgent => agent !== undefined)
    .slice(0, RECENCY_BAND_CAP);
}

/**
 * The recent rows at the head of {@link DockLaunchModel.browseRows}. Split out
 * because `useDockLaunchModel` derives the band outside its memo (see there) and
 * has to splice it back onto a `browseRows` built without it.
 *
 * These rows lead the agent column and the agent list below skips them, so
 * each agent is listed once. Pinned state is carried by the row's own pin glyph,
 * not by which heading it sits under, so moving a pinned agent up into the
 * recent group states nothing false.
 */
export function buildRecentBrowseRows(
  agentItems: ReadonlyArray<DockLaunchAgentItem>,
  recentAgentIds: ReadonlyArray<string>
): DockLaunchRow[] {
  const byKey = new Map(agentItems.map((item) => [item.key, item]));
  return (
    recentAgentIds
      .map((id) => byKey.get(`agent:${id}`))
      .filter((item): item is DockLaunchAgentItem => item !== undefined)
      // Only agents that can actually be launched: an agent that needs setup has
      // no business in a quick-reach band, and its row belongs under Needs setup.
      .filter((item) => item.agentBand === "launch")
      .map((item) => ({
        kind: "item" as const,
        rowKey: `recent:${item.key}`,
        band: "recent" as const,
        item,
      }))
  );
}

/**
 * Derive every launchable entry for a launcher surface. Panels come from the
 * shared spawnable-kind selector (so the launcher can't drift from ⌘⇧P) plus
 * Terminal, partitioned by where they will actually land rather than filtered
 * by dockability: a non-dockable kind is offered under a heading that says it
 * opens in the grid, instead of being hidden (#11054's fix was to stop lying,
 * not to stop offering).
 */
export function buildDockLaunchModel({
  agents,
  activeWorktreeId,
  recipes,
  mruEntries,
  surface,
  agentInventoryState = "installed",
  hasWorkspace,
  hasProject,
  launchEntries = [],
  hiddenPluginIds,
  whenContext,
  isAgentRegistered,
}: BuildDockLaunchModelOptions): DockLaunchModel {
  const preconditions: DockLaunchPreconditions = { hasWorkspace, hasProject };

  const panelItems: DockLaunchPanelItem[] = [];
  // A kind a plugin's own entry opens is that entry's to offer, so its bare
  // automatic row is left out (#13788). Read from every registered entry, not
  // only the ones showing: hiding the group, or a `when` that doesn't hold,
  // must not bring back the row the plugin chose to replace.
  const seenKinds = new Set<string>(
    launchEntries.flatMap((entry) =>
      entry.target.type === "panel" ? [entry.target.panelKindId] : []
    )
  );
  const terminalConfig = getPanelKindConfig(TERMINAL_KIND_ID);
  if (terminalConfig) {
    panelItems.push(toPanelItem(terminalConfig, surface, preconditions));
    seenKinds.add(TERMINAL_KIND_ID);
  }
  for (const config of getSpawnablePanelKinds()) {
    if (seenKinds.has(config.id)) continue;
    seenKinds.add(config.id);
    panelItems.push(toPanelItem(config, surface, preconditions));
  }

  const dockPanels = panelItems.filter((item) => item.location === "dock");
  const gridPanels = panelItems.filter((item) => item.location === "grid");
  const pluginGroups = buildPluginGroups(launchEntries, {
    surface,
    hiddenPluginIds,
    whenContext,
    isAgentRegistered,
  });

  // Shadowed recipes stay listed (dimmed, marked "Overridden") rather than
  // vanishing — running one resolves to the winner, so hiding it only hides
  // that the collision exists (#11510).
  const recipeItems: DockLaunchRecipeItem[] = recipes
    .filter((r) => r.worktreeId === undefined || r.worktreeId === (activeWorktreeId ?? undefined))
    .map((recipe) => {
      const scopeLabel = getRecipeScope(recipe).label;
      return {
        category: "recipe" as const,
        key: `recipe:${recipe.id}`,
        name: recipe.name,
        recipe,
        scopeLabel,
        isShadowed: Boolean(recipe.shadowedBy),
        searchAliases: ["recipe", scopeLabel],
      };
    });

  // In fallback mode nothing is installed, so every agent offered is a
  // discovery row that routes to setup rather than a launch.
  const bandFor = (agent: DockLaunchAgent): DockLaunchAgentBand =>
    agentInventoryState === "fallback"
      ? "available"
      : isAgentLaunchable(agent.availability)
        ? "launch"
        : "needs-setup";

  const agentItems: DockLaunchAgentItem[] = agents.map((agent) => ({
    category: "agent" as const,
    key: `agent:${agent.id}`,
    name: agent.name,
    agent,
    agentBand: bandFor(agent),
    // Preset names are searchable through the parent, so typing a preset name
    // still surfaces the agent that owns it — the presets themselves are rows,
    // never search items, so they can never rank detached from their agent.
    searchAliases: [
      agent.id,
      "agent",
      ...(agent.presetChoices ?? [])
        .filter((choice) => choice.presetId !== null)
        .map((choice) => choice.label),
    ],
  }));

  const launchAgents = agentItems.filter((item) => item.agentBand === "launch");
  const needsSetupAgents = agentItems.filter((item) => item.agentBand === "needs-setup");
  const availableAgents = agentItems.filter((item) => item.agentBand === "available");

  // Recency is drawn from launchable agents only, and only after the band
  // assignment above, so a recently-launched agent that has since become
  // unavailable drops out rather than offering a launch that redirects.
  const recentAgents = selectRecentAgents(
    launchAgents.map((item) => item.agent),
    mruEntries
  );

  const browseRows: DockLaunchRow[] = [];
  const pushRows = (band: DockLaunchBandId, items: ReadonlyArray<DockLaunchItem>) => {
    for (const item of items) {
      browseRows.push({ kind: "item", rowKey: item.key, band, item });
    }
  };

  const recentRows = buildRecentBrowseRows(
    agentItems,
    recentAgents.map((agent) => agent.id)
  );
  browseRows.push(...recentRows);
  const recentKeys = new Set(recentRows.map((row) => (row.kind === "item" ? row.item.key : "")));

  // One agent list, pinned first (the host already sorted them). Pinning is
  // row state — the pin glyph stays lit on a pinned row — so it no longer buys
  // a heading of its own, and the whole agent inventory reads as one column.
  const listedAgents = launchAgents.filter((item) => !recentKeys.has(item.key));
  if (listedAgents.length > 0) pushRows("agents", listedAgents);

  // Setup and discovery rows follow the launchable agents rather than trailing
  // the recipes: they are agents too, and the launcher lays agents out as one
  // column beside the panels and recipes, so the navigation order has to match.
  if (needsSetupAgents.length > 0) pushRows("needs-setup", needsSetupAgents);

  if (availableAgents.length > 0) {
    pushRows("available-agents", availableAgents);
    // Setup belongs to the empty state, not the footer (#11681): it only helps
    // when nothing is installed, and as a permanent row it competed with
    // Manage agents, which already reaches the same settings.
    browseRows.push({
      kind: "cue",
      rowKey: "setup-agents",
      band: "available-agents",
      cue: "setup-agents",
    });
  }

  // Always banded by destination, even when only one destination is present.
  // The generic "Launch panel" heading used to be the fallback, and it left the
  // row to say where it lands — which in the toolbar meant six consecutive rows
  // ending in the word "Grid", a column with no information in it. A heading
  // that states the destination once says the same thing for free, and lets the
  // row spend that width on its name instead.
  if (dockPanels.length > 0) pushRows("dock-panels", dockPanels);
  if (gridPanels.length > 0) pushRows("grid-panels", gridPanels);

  // Each plugin's group ends with the row that hides it. A row rather than a
  // control on the heading: headings are decorative inside the listbox, so a
  // button there would be out of reach of the keyboard and the screen reader.
  for (const group of pluginGroups) {
    pushRows("plugin-entries", group.items);
    browseRows.push({
      kind: "cue",
      rowKey: `hide-plugin-group:${group.pluginId}`,
      band: "plugin-entries",
      cue: "hide-plugin-group",
      pluginGroup: { pluginId: group.pluginId, pluginName: group.pluginName },
    });
  }

  if (recipeItems.length > 0) {
    pushRows("recipes", recipeItems);
  } else {
    browseRows.push({
      kind: "cue",
      rowKey: CREATE_RECIPE_ROW_KEY,
      band: "recipes",
      cue: "create-recipe",
    });
  }

  browseRows.push({ kind: "cue", rowKey: "manage-agents", band: "actions", cue: "manage-agents" });
  // Second, not first: Manage agents has held this footer alone and the launcher
  // is an agent list before it is anything else. The pair reads outward from
  // what gets launched to where the launchers sit.
  browseRows.push({
    kind: "cue",
    rowKey: "customize-toolbar",
    band: "actions",
    cue: "customize-toolbar",
  });

  return {
    recentAgents,
    dockPanels,
    gridPanels,
    pluginGroups,
    recipes: recipeItems,
    searchItems: [
      ...agentItems,
      ...panelItems,
      ...pluginGroups.flatMap((group) => group.items),
      ...recipeItems,
    ],
    browseRows,
  };
}

/**
 * Store-connected wrapper around {@link buildDockLaunchModel}. Both launcher
 * surfaces call it; the menu is only mounted while open, so `getSpawnablePanelKinds`
 * is re-read per open and picks up plugin kinds registered mid-session without a
 * registry subscription.
 *
 * The panel/recipe/search derivation is memoized because `searchItems` keys the
 * consumer's Fuse index — rebuilding it on every keystroke would be wasteful.
 * The recency band deliberately sits OUTSIDE that memo: `getSortedActionMruList`
 * prunes by wall-clock and reads store state at call time, so a memo keyed on it
 * would never observe a launch recorded since — the band would show pre-launch
 * order forever.
 *
 * The usage map itself IS subscribed, which the single-surface version could do
 * without: two launchers are mounted at once now, so a launch recorded from one
 * has to re-render the other, and nothing else was going to. It is referenced
 * rather than merely listed as a dependency — a value the callback body never
 * mentions is one the React compiler is free to drop.
 */
export function useDockLaunchModel(options: {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  activeWorktreeId: string | null;
  surface: DockLaunchSurface;
  agentInventoryState?: DockLaunchInventoryState;
  hasWorkspace?: boolean;
  hasProject?: boolean;
}): DockLaunchModel {
  const {
    agents,
    pinnedCount,
    activeWorktreeId,
    surface,
    agentInventoryState,
    hasWorkspace,
    hasProject,
  } = options;
  // Both registries, because a plugin's metadata lands before its renderer
  // definition and `getSpawnablePanelKinds` requires both. Without these the
  // long-lived `+` button would keep a model memoized from before the plugin
  // pull resolved — and it passes that model down, so the freshly-mounted
  // menu's own derivation can't rescue it.
  const kindRegistry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const definitionRegistry = useSyncExternalStore(
    subscribeToPanelKindDefinitions,
    getPanelKindDefinitionsSnapshot,
    getPanelKindDefinitionsSnapshot
  );
  // Subscribe inside the menu so the listener only runs while open.
  const recipes = useRecipeStore((s) => s.recipes);
  // Subscribe to the stable getter (not its result) so the selector returns a
  // constant reference — calling getSortedActionMruList() inside the selector
  // would mint a new array every render and trip Zustand 5's infinite-loop
  // guard.
  const getSortedActionMruList = useActionMruStore((s) => s.getSortedActionMruList);
  // The map is a stable reference that changes identity on every recorded use,
  // which is exactly the invalidation signal the getter cannot provide.
  const actionUsageEntries = useActionMruStore((s) => s.actionUsageEntries);
  // An agent entry is disabled while its agent isn't registered, and the
  // agent can arrive later from another plugin or the user's own agents.
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot,
    getPluginAgentRegistrySnapshot
  );
  const userAgentRegistry = useUserAgentRegistryStore((s) => s.registry);
  const launchEntries = usePluginLaunchEntriesStore((s) => s.entries);
  const hiddenPluginIds = usePluginLaunchEntriesStore((s) => s.hiddenPluginIds);
  const initLaunchEntries = usePluginLaunchEntriesStore((s) => s.init);
  const whenContext = useChromeWhenContext();
  useEffect(() => {
    initLaunchEntries();
  }, [initLaunchEntries]);

  // Read from the two snapshots themselves, the same tiers the effective
  // registry merges, so the memo below sees them as inputs: an indirection
  // through the global registry would be invisible to the React Compiler.
  const isAgentRegistered = useCallback(
    (agentId: string) =>
      isBuiltInAgentId(agentId) ||
      Object.hasOwn(pluginAgentRegistry, agentId) ||
      (userAgentRegistry !== null && Object.hasOwn(userAgentRegistry, agentId)),
    [pluginAgentRegistry, userAgentRegistry]
  );

  const stable = useMemo(
    () =>
      buildDockLaunchModel({
        agents,
        pinnedCount,
        activeWorktreeId,
        recipes,
        surface,
        agentInventoryState,
        hasWorkspace,
        hasProject,
        launchEntries,
        hiddenPluginIds,
        whenContext,
        isAgentRegistered,
        mruEntries: [],
      }),
    // The two registry snapshots are read for invalidation only — the builder
    // pulls the live registries itself.
    [
      agents,
      pinnedCount,
      activeWorktreeId,
      recipes,
      surface,
      agentInventoryState,
      hasWorkspace,
      hasProject,
      launchEntries,
      hiddenPluginIds,
      whenContext,
      isAgentRegistered,
      kindRegistry,
      definitionRegistry,
    ]
  );

  // An empty map can only produce an empty list, so short-circuiting on it is
  // exact rather than defensive — and it makes the subscription above load-
  // bearing in the expression itself, not just in a dependency list.
  const mruEntries = actionUsageEntries.size > 0 ? getSortedActionMruList() : [];
  const launchableAgents = stable.searchItems.filter(
    (item): item is DockLaunchAgentItem => item.category === "agent" && item.agentBand === "launch"
  );
  const recentAgents = selectRecentAgents(
    launchableAgents.map((item) => item.agent),
    mruEntries
  );
  // `stable` was built with an empty MRU, so its `browseRows` carry no recency
  // band — splice it back on here. Keyed on the id signature rather than the
  // array, which `selectRecentAgents` mints fresh on every render.
  const recentSignature = recentAgents.map((agent) => agent.id).join(",");
  const browseRows = useMemo(() => {
    const agentItems = stable.searchItems.filter(
      (item): item is DockLaunchAgentItem => item.category === "agent"
    );
    const recentIds = recentSignature ? recentSignature.split(",") : [];
    const recentRows = buildRecentBrowseRows(agentItems, recentIds);
    // Each agent is listed once. A recently launched agent moves to the top of
    // the agent column and wears "Recent", rather than appearing twice.
    const recentKeys = new Set(recentRows.map((row) => (row.kind === "item" ? row.item.key : "")));
    const rest = stable.browseRows.filter(
      (row) => !(row.kind === "item" && row.band === "agents" && recentKeys.has(row.item.key))
    );
    return [...recentRows, ...rest];
  }, [stable, recentSignature]);

  return { ...stable, recentAgents, browseRows };
}

/**
 * First-run discovery cue: route into recipes instead of hiding the section, so
 * users who have never made one can find their way in. With an active worktree,
 * open the editor scoped to it; without one (the common first-run case), fall
 * back to the manager — the editor's event handler hard-requires a string
 * worktreeId and silently no-ops on undefined, so dispatching the editor here
 * would do nothing. Both actions are danger:"safe" and MRU-eligible.
 */
export function activateCreateRecipeCue(
  activeWorktreeId: string | null,
  source: ActionSource
): void {
  if (activeWorktreeId) {
    void actionService.dispatch("recipe.editor.open", { worktreeId: activeWorktreeId }, { source });
  } else {
    void actionService.dispatch("recipe.manager.open", {}, { source });
  }
}

/**
 * What a launcher row may add to an agent launch beyond the agent and preset.
 * Only a plugin's agent entry passes one, and only its first turn — never a
 * flag, an env var or a preset of the plugin's choosing (#13788).
 */
export interface DockLaunchAgentOptions {
  prompt?: string;
}

export interface ActivateDockLaunchItemContext {
  cwd: string;
  activeWorktreeId: string | null;
  recipeContext?: RecipeContext;
  /**
   * `presetId` carries a three-way distinction the launcher depends on:
   * `undefined` launches whatever preset is saved, `null` is the explicit
   * Default that clears it, and a string selects one. Collapsing null into
   * undefined silently relaunches the saved preset when the user asked for
   * plain.
   */
  onLaunchAgent: (
    agentId: string,
    presetId?: string | null,
    options?: DockLaunchAgentOptions
  ) => void;
  /** Dispatch source for everything this activation dispatches. Must stay a
   * foreground source, or panel actions silently skip their focus handling. */
  source: ActionSource;
}

/** Route a cue row — the launcher entries that navigate rather than launch. */
export function activateDockLaunchCue(
  cue: DockLaunchCueId,
  activeWorktreeId: string | null,
  source: ActionSource,
  pluginGroup?: DockLaunchPluginGroup
): void {
  switch (cue) {
    case "hide-plugin-group":
      // Remembered per project in Daintree's settings, with the way back in
      // Project settings → Plugins.
      if (pluginGroup) hidePluginGroup(pluginGroup);
      return;
    case "create-recipe":
      activateCreateRecipeCue(activeWorktreeId, source);
      return;
    case "setup-agents":
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
      return;
    case "manage-agents":
      void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source });
      return;
    case "customize-toolbar":
      void actionService.dispatch("app.settings.openTab", { tab: "toolbar" }, { source });
      return;
  }
  // Every cue names its own destination. This routed on two `if`s and then fell
  // through to the agents tab, so a cue added without a branch opened the wrong
  // settings page and nothing — not a type error, not a test — said so.
  const _exhaustive: never = cue;
  return _exhaustive;
}

/**
 * Run a launcher entry. Agents keep routing through `onLaunchAgent`; panels go
 * through the shared launch seam, so a kind activates here exactly as it does
 * from the palette or the toolbar (#11668).
 */
export function activateDockLaunchItem(
  item: DockLaunchItem,
  ctx: ActivateDockLaunchItemContext,
  presetId?: string | null
): void {
  if (item.category === "agent") {
    const { agent } = item;
    // Mirrors AgentButton.tsx: every agent row launches, whatever the last
    // probe reported. `useAgentLauncher` re-probes and decides between a PTY
    // and a missing-CLI recovery panel, so redirecting to settings here would
    // act on a stale reading and skip the gate entirely (#11760).
    //
    // Recorded in the MRU because it is a launch attempt like any other. An
    // unavailable agent still stays out of the visible recency band, which
    // filters to `agentBand === "launch"` — it becomes eligible only once the
    // agent actually resolves.
    useActionMruStore.getState().recordActionMru(`${AGENT_MRU_PREFIX}${agent.id}`);
    ctx.onLaunchAgent(agent.id, presetId);
    return;
  }

  // A row whose precondition is unmet opens nothing. Guarded here as well as at
  // the caller so no surface can activate it by a path that skipped the check —
  // the row stays navigable precisely because it is inert rather than absent.
  if (item.disabled) return;

  if (item.category === "plugin-entry") {
    activatePluginLaunchEntry(item, ctx);
    return;
  }

  if (item.category === "panel") {
    // The menu closes on select, so an action that refuses leaves no trace
    // otherwise — the same reason LauncherQuickActions reports its refusals.
    void launchPanelKind({
      kindId: item.kindId,
      location: item.location,
      cwd: ctx.cwd,
      worktreeId: ctx.activeWorktreeId,
      source: ctx.source,
    })
      .then((outcome) => {
        if (outcome.route !== "action" || outcome.result.ok) return;
        // A full grid is already reported by `addPanel`, with an accurate
        // message and the actual recovery (#11666).
        if (isPanelLimitError(outcome.result.error.message)) return;
        logError("Panel launch from dock refused", outcome.result.error);
        notify({
          type: "error",
          title: `Couldn't open ${item.name}`,
          // Purpose-written rather than the action's own message: those name
          // internal ids ("Worktree not found: wt-3f2") and state a cause
          // without a fix. Covers every kind this launcher offers, so it stays
          // true for a dev preview with no project open as well as a browser
          // with no folder — unlike the file-browser-only surfaces.
          message:
            "No project folder or worktree resolved for this launch. Open a project or select a worktree, then try again.",
          // `uiFeedback` is a passive kind, so without this the toast the
          // closed menu depends on would be an inbox row nobody sees.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: () => activateDockLaunchItem(item, ctx) },
        });
      })
      .catch((error) => logError("Panel launch from dock failed", error));
    return;
  }

  // Fire-and-forget, but surface spawn failures — the menu closes on select, so
  // a toast/inbox entry is the only signal the user gets when terminals are
  // dropped (e.g. panel limit).
  const worktreeId = ctx.activeWorktreeId ?? undefined;
  void useRecipeStore
    .getState()
    .runRecipeWithResults(item.recipe.id, ctx.cwd, worktreeId, ctx.recipeContext)
    .then((results) =>
      notifyRecipeSpawnFailures(results, { recipeName: item.recipe.name, worktreeId })
    )
    .catch((error) => logError("Recipe launch from dock failed", error));
}

/**
 * Run a plugin's launch entry. Each target goes through the path its own kind
 * of row already uses, so an entry can do nothing a user couldn't do from that
 * row: a panel through `panel.openPluginPanel`, a command through its own
 * action, an agent through the surface's own agent launch with the entry's
 * prompt and nothing else. Ownership is checked again here, at the point of
 * dispatch, so no snapshot can turn a row into a side door.
 */
function activatePluginLaunchEntry(
  item: DockLaunchPluginEntryItem,
  ctx: ActivateDockLaunchItemContext
): void {
  const { target } = item;
  if (target.type === "agent") {
    ctx.onLaunchAgent(target.agentId, undefined, { prompt: target.prompt });
    return;
  }

  let dispatched: ReturnType<typeof actionService.dispatch>;
  if (target.type === "panel") {
    if (getPanelKindConfig(target.panelKindId)?.extensionId !== item.pluginId) return;
    dispatched = actionService.dispatch(
      "panel.openPluginPanel",
      {
        kind: target.panelKindId,
        presentation: item.presentation,
        ...(target.args !== undefined ? { initialArgs: target.args } : {}),
      },
      { source: ctx.source }
    );
  } else {
    if (!isOwnLaunchCommand(item.pluginId, target.actionId)) return;
    dispatched = actionService.dispatch(target.actionId, target.args, { source: ctx.source });
  }

  void dispatched
    .then((result) => {
      if (result.ok) return;
      if (target.type === "panel" && isPanelLimitError(result.error.message)) return;
      logError("Plugin launch entry refused", result.error);
      notify({
        type: "error",
        title: `Couldn't launch ${item.name.replace(/…$/, "")}`,
        // The plugin's own wording can name internal ids, and a refusal from
        // the host names a kind id, so the toast says where to look instead.
        message: `${item.pluginName} didn't complete it. Check the plugin in Settings → Plugins, then try again.`,
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: () => activatePluginLaunchEntry(item, ctx) },
      });
    })
    .catch((error) => logError("Plugin launch entry failed", error));
}

/**
 * Hide a plugin's group in this project. The launcher closes on select, so a
 * write main refused would otherwise look like the click did nothing.
 */
function hidePluginGroup(group: DockLaunchPluginGroup): void {
  void usePluginLaunchEntriesStore
    .getState()
    .setGroupHidden(group.pluginId, true)
    .then((saved) => {
      if (saved) return;
      notify({
        type: "error",
        title: `Couldn't hide ${group.pluginName}`,
        message: "The change wasn't saved to this project's settings, so its entries still show.",
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: () => hidePluginGroup(group) },
      });
    });
}
