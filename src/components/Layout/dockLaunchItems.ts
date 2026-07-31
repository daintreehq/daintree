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
import { usePanelStore } from "@/store/panelStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { actionService } from "@/services/ActionService";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { getRecipeScope } from "@/utils/recipeScope";
import { logError } from "@/utils/logger";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import type { ActionSource, AgentAvailabilityState, TerminalRecipe } from "@shared/types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { RecipeContext } from "@/utils/recipeVariables";

export const AGENT_MRU_PREFIX = "agent.";

/** Cap the "Recently launched" band so it stays a quick-reach shortcut rather
 * than a second full agent list above the fixed Pinned/Other groups. */
export const RECENCY_BAND_CAP = 3;

/**
 * Panel kinds `agent.launch` understands. `terminal` resolves to the plain
 * shell; `browser` and `dev-preview` return from their own branches in
 * `launchAgent` (seeding the dev-server title, reusing the launch reentrancy
 * guard). Every other kind must be created through `addPanel` directly —
 * `resolveAgentLaunchKind` throws on an id it can't resolve as an agent (#11498).
 */
const AGENT_LAUNCH_PANEL_KINDS: ReadonlySet<string> = new Set([
  "terminal",
  "browser",
  "dev-preview",
]);

/** Terminal opts out of the palette (it has dedicated spawn actions) but is the
 * launcher's most-used entry, so it is added back explicitly here. */
const TERMINAL_KIND_ID = "terminal";

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

  return {
    recentAgents,
    showAgentGroups: pinnedCount !== undefined && pinnedCount > 0 && pinnedCount < agents.length,
    dockPanels,
    gridPanels,
    recipes: recipeItems,
    searchItems: [...agentItems, ...panelItems, ...recipeItems],
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

  return { ...stable, recentAgents: selectRecentAgents(agents, getSortedActionMruList()) };
}

export interface ActivateDockLaunchItemContext {
  cwd: string;
  activeWorktreeId: string | null;
  recipeContext?: RecipeContext;
  onLaunchAgent: (agentId: string) => void;
  settingsSource: ActionSource;
}

/**
 * Run a launcher entry. Agents and the three kinds `launchAgent` special-cases
 * keep routing through `onLaunchAgent`; everything else creates its panel
 * directly at the location its menu heading advertised.
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
        { source: ctx.settingsSource }
      );
      return;
    }
    useActionMruStore.getState().recordActionMru(`${AGENT_MRU_PREFIX}${agent.id}`);
    ctx.onLaunchAgent(agent.id);
    return;
  }

  if (item.category === "panel") {
    if (AGENT_LAUNCH_PANEL_KINDS.has(item.kindId)) {
      ctx.onLaunchAgent(item.kindId);
      return;
    }
    void usePanelStore.getState().addPanel({
      kind: item.kindId,
      cwd: ctx.cwd,
      worktreeId: ctx.activeWorktreeId ?? undefined,
      location: item.location,
      // Folds dock activation into the same set() that commits the panel, so
      // the offscreen-container watchdog can't close it in the render gap (#6590).
      activateDockOnCreate: item.location === "dock",
      // Plugin kinds are deliberately outside the built-in AddPanelOptions
      // union (a `string & {}` member would defeat discriminated narrowing),
      // so widening happens here at the integration boundary.
    } as AddPanelOptions);
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
