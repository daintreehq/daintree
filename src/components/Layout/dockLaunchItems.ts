import { useMemo, useSyncExternalStore } from "react";
import {
  getSpawnablePanelKinds,
  subscribeToPanelKindDefinitions,
  getPanelKindDefinitionsSnapshot,
} from "@/registry";
import {
  panelKindIsDockable,
  getPanelKindConfig,
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
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
import type { ActionSource, AgentAvailabilityState, TerminalRecipe } from "@shared/types";
import type { RecipeContext } from "@/utils/recipeVariables";

export const AGENT_MRU_PREFIX = "agent.";

/** Cap the "Recently launched" band so it stays a quick-reach shortcut rather
 * than a second full agent list above the fixed Pinned/Other groups. */
export const RECENCY_BAND_CAP = 3;

/** Terminal opts out of the palette (it has dedicated spawn actions) but is the
 * launcher's most-used entry, so it is added back explicitly here. */
const TERMINAL_KIND_ID = "terminal";

/** Row id of the "Create a recipe" cue — the one browse row with no item. */
export const CREATE_RECIPE_ROW_KEY = "create-recipe";

export type LaunchAgentIcon = React.ComponentType<{ className?: string; brandColor?: string }>;

export interface DockLaunchAgent {
  id: string;
  name: string;
  icon?: LaunchAgentIcon;
  brandColor?: string;
  availability?: AgentAvailabilityState;
}

interface DockLaunchItemBase {
  /** Stable key, unique across categories (an agent and a panel can share an id). */
  key: string;
  name: string;
  searchAliases?: string[];
  description?: string;
}

export interface DockLaunchAgentItem extends DockLaunchItemBase {
  category: "agent";
  agent: DockLaunchAgent;
}

export interface DockLaunchPanelItem extends DockLaunchItemBase {
  category: "panel";
  kindId: string;
  iconId: string;
  color: string;
  /** Where selecting this item actually lands the panel. Derived from
   * `panelKindIsDockable`, so the label can never contradict `addPanel`. */
  location: "dock" | "grid";
}

export interface DockLaunchRecipeItem extends DockLaunchItemBase {
  category: "recipe";
  recipe: TerminalRecipe;
  scopeLabel: string;
  isShadowed: boolean;
}

export type DockLaunchItem = DockLaunchAgentItem | DockLaunchPanelItem | DockLaunchRecipeItem;

/** Heading a launcher row renders under. `results` is the filtered list. */
export type DockLaunchBandId =
  | "recent"
  | "pinned"
  | "other"
  | "agents"
  | "dock-panels"
  | "grid-panels"
  | "panels"
  | "recipes"
  | "results";

export const DOCK_LAUNCH_BAND_LABELS: Record<DockLaunchBandId, string> = {
  recent: "Recently launched",
  pinned: "Pinned",
  other: "Other",
  agents: "Launch agent",
  "dock-panels": "Open in dock",
  "grid-panels": "Open in grid",
  panels: "Launch panel",
  recipes: "Launch recipe",
  results: "Search results",
};

/**
 * One rendered row of the `+` launcher palette. The launcher drives arrow-key
 * navigation off a single flat row list for both the browse bands and the
 * filtered results, so every row needs an index in the same space.
 */
export interface DockLaunchRow {
  /**
   * Unique per rendered row — NOT the item key. The recency band repeats agents
   * that also appear under Pinned/Other, and two rows sharing an id would
   * highlight together and break `aria-activedescendant`.
   */
  rowKey: string;
  band: DockLaunchBandId;
  /** Absent for the "Create a recipe" discovery cue, which opens the editor. */
  item?: DockLaunchItem;
}

export interface DockLaunchModel {
  /** Capped frecency band; entries also appear in the agent groups below. */
  recentAgents: DockLaunchAgent[];
  /** True when `pinnedCount` splits the agents into a strict Pinned/Other subset. */
  showAgentGroups: boolean;
  dockPanels: DockLaunchPanelItem[];
  gridPanels: DockLaunchPanelItem[];
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

export interface BuildDockLaunchModelOptions {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  activeWorktreeId: string | null;
  recipes: ReadonlyArray<TerminalRecipe>;
  mruEntries: ReadonlyArray<{ id: string; lastAccessedAt: number }>;
  surface: DockLaunchSurface;
}

function toPanelItem(
  config: {
    id: string;
    name: string;
    iconId: string;
    color: string;
    searchAliases?: string[];
  },
  surface: DockLaunchSurface
): DockLaunchPanelItem {
  // A grid surface lands everything in the grid regardless of dockability — its
  // launch callback dispatches `location: "grid"`, so claiming "dock" there
  // would misstate the destination just as badly as the redirect this replaced.
  const location = surface === "dock" && panelKindIsDockable(config.id) ? "dock" : "grid";
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
  };
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
 * The "Recently launched" rows of {@link DockLaunchModel.browseRows}. Split out
 * because `useDockLaunchModel` derives the band outside its memo (see there) and
 * has to splice it back onto a `browseRows` built without it.
 *
 * The band repeats agents that are listed again under Pinned/Other. That
 * duplication is deliberate — a quick-reach shortcut — so the rows are keyed
 * apart rather than de-duplicated: dropping an agent from Pinned because it was
 * recently launched would make that heading lie.
 */
export function buildRecentBrowseRows(
  agentItems: ReadonlyArray<DockLaunchAgentItem>,
  recentAgentIds: ReadonlyArray<string>
): DockLaunchRow[] {
  const byKey = new Map(agentItems.map((item) => [item.key, item]));
  return recentAgentIds
    .map((id) => byKey.get(`agent:${id}`))
    .filter((item): item is DockLaunchAgentItem => item !== undefined)
    .map((item) => ({ rowKey: `recent:${item.key}`, band: "recent" as const, item }));
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
  pinnedCount,
  activeWorktreeId,
  recipes,
  mruEntries,
  surface,
}: BuildDockLaunchModelOptions): DockLaunchModel {
  const recentAgents = selectRecentAgents(agents, mruEntries);

  const panelItems: DockLaunchPanelItem[] = [];
  const seenKinds = new Set<string>();
  const terminalConfig = getPanelKindConfig(TERMINAL_KIND_ID);
  if (terminalConfig) {
    panelItems.push(toPanelItem(terminalConfig, surface));
    seenKinds.add(TERMINAL_KIND_ID);
  }
  for (const config of getSpawnablePanelKinds()) {
    if (seenKinds.has(config.id)) continue;
    seenKinds.add(config.id);
    panelItems.push(toPanelItem(config, surface));
  }

  const dockPanels = panelItems.filter((item) => item.location === "dock");
  const gridPanels = panelItems.filter((item) => item.location === "grid");

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

  const agentItems: DockLaunchAgentItem[] = agents.map((agent) => ({
    category: "agent" as const,
    key: `agent:${agent.id}`,
    name: agent.name,
    agent,
    searchAliases: [agent.id, "agent"],
  }));

  const showAgentGroups =
    pinnedCount !== undefined && pinnedCount > 0 && pinnedCount < agents.length;
  const isSplitByDestination = dockPanels.length > 0 && gridPanels.length > 0;

  const browseRows: DockLaunchRow[] = [];
  const pushRows = (band: DockLaunchBandId, items: ReadonlyArray<DockLaunchItem>) => {
    for (const item of items) {
      browseRows.push({ rowKey: item.key, band, item });
    }
  };

  browseRows.push(
    ...buildRecentBrowseRows(
      agentItems,
      recentAgents.map((agent) => agent.id)
    )
  );

  if (agentItems.length > 0) {
    if (showAgentGroups) {
      pushRows("pinned", agentItems.slice(0, pinnedCount));
      pushRows("other", agentItems.slice(pinnedCount));
    } else {
      pushRows("agents", agentItems);
    }
  }

  if (isSplitByDestination) {
    pushRows("dock-panels", dockPanels);
    pushRows("grid-panels", gridPanels);
  } else {
    pushRows("panels", [...dockPanels, ...gridPanels]);
  }

  if (recipeItems.length > 0) {
    pushRows("recipes", recipeItems);
  } else {
    browseRows.push({ rowKey: CREATE_RECIPE_ROW_KEY, band: "recipes" });
  }

  return {
    recentAgents,
    showAgentGroups,
    dockPanels,
    gridPanels,
    recipes: recipeItems,
    searchItems: [...agentItems, ...panelItems, ...recipeItems],
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
 * is a stable function reference that reads store state at call time, so
 * subscribing to it never re-renders and a memo keyed on it would never observe
 * a launch recorded between two opens — the band would show pre-launch order
 * forever. Reading it per render is safe: the MRU only changes on launch, which
 * closes the menu, so it cannot reshuffle under the user mid-search.
 */
export function useDockLaunchModel(options: {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  activeWorktreeId: string | null;
  surface: DockLaunchSurface;
}): DockLaunchModel {
  const { agents, pinnedCount, activeWorktreeId, surface } = options;
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
  // guard. Mirrors AgentTrayButton's pattern.
  const getSortedActionMruList = useActionMruStore((s) => s.getSortedActionMruList);

  const stable = useMemo(
    () =>
      buildDockLaunchModel({
        agents,
        pinnedCount,
        activeWorktreeId,
        recipes,
        surface,
        mruEntries: [],
      }),
    // The two registry snapshots are read for invalidation only — the builder
    // pulls the live registries itself.
    [agents, pinnedCount, activeWorktreeId, recipes, surface, kindRegistry, definitionRegistry]
  );

  const recentAgents = selectRecentAgents(agents, getSortedActionMruList());
  // `stable` was built with an empty MRU, so its `browseRows` carry no recency
  // band — splice it back on here. Keyed on the id signature rather than the
  // array, which `selectRecentAgents` mints fresh on every render.
  const recentSignature = recentAgents.map((agent) => agent.id).join(",");
  const browseRows = useMemo(() => {
    const agentItems = stable.searchItems.filter(
      (item): item is DockLaunchAgentItem => item.category === "agent"
    );
    const recentIds = recentSignature ? recentSignature.split(",") : [];
    return [...buildRecentBrowseRows(agentItems, recentIds), ...stable.browseRows];
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

export interface ActivateDockLaunchItemContext {
  cwd: string;
  activeWorktreeId: string | null;
  recipeContext?: RecipeContext;
  onLaunchAgent: (agentId: string) => void;
  /** Dispatch source for everything this activation dispatches. Must stay a
   * foreground source, or panel actions silently skip their focus handling. */
  source: ActionSource;
}

/**
 * Run a launcher entry. Agents keep routing through `onLaunchAgent`; panels go
 * through the shared launch seam, so a kind activates here exactly as it does
 * from the palette or the toolbar (#11668).
 */
export function activateDockLaunchItem(
  item: DockLaunchItem,
  ctx: ActivateDockLaunchItemContext
): void {
  if (item.category === "agent") {
    const { agent } = item;
    if (!isAgentLaunchable(agent.availability)) {
      // Mirrors AgentButton.tsx: a non-launchable agent routes to its settings
      // subtab so the user can resolve the precondition instead of bouncing off
      // a disabled row. Not a launch, so it must not pollute the MRU band.
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "agents", subtab: agent.id },
        { source: ctx.source }
      );
      return;
    }
    useActionMruStore.getState().recordActionMru(`${AGENT_MRU_PREFIX}${agent.id}`);
    ctx.onLaunchAgent(agent.id);
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
        notify({
          type: "error",
          title: `Couldn't open ${item.name}`,
          message: outcome.result.error.message,
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
  void useRecipeStore
    .getState()
    .runRecipeWithResults(
      item.recipe.id,
      ctx.cwd,
      ctx.activeWorktreeId ?? undefined,
      ctx.recipeContext
    )
    .then((results) => notifyRecipeSpawnFailures(results, { recipeName: item.recipe.name }))
    .catch((error) => logError("Recipe launch from dock failed", error));
}
