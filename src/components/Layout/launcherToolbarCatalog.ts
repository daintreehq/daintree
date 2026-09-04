import { useMemo } from "react";
import { SquareTerminal } from "lucide-react";
import {
  decodeLauncherItemToolbarButtonId,
  getLauncherPanelButtonIdForKind,
  isLauncherItemToolbarButtonId,
  launcherItemToolbarButtonId,
  type AnyToolbarButtonId,
  type LauncherItemToolbarButtonId,
} from "@shared/types/toolbar";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { getAgentConfig } from "@/config/agents";
import { getRecipeScope, recipeToolbarSourceId } from "@/utils/recipeScope";
import type { TerminalRecipe } from "@shared/types";
import { DEFAULT_PANEL_ICON, resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { Workflow } from "@/components/icons";
import type { ToolbarButtonMetadata } from "./toolbarButtonMetadata";
import type { DockLaunchItem } from "./dockLaunchItems";

/**
 * The toolbar button id a launcher row pins to, or `null` for a row that pins
 * nothing at all.
 *
 * Three answers, in the order they have to be asked. A built-in agent keeps its
 * bare agent id — its pin lives in `agentSettingsStore`, not `pinnedButtons`,
 * and minting a synthetic id for it would split one button across two stores.
 * One of the four fixed panel kinds keeps its own button id for the same
 * reason: existing profiles carry it, and `isPanelButtonOnToolbar`'s array
 * fall-through is what keeps `terminal`/`file-browser` reading as on out of the
 * box. Everything else — plugin and user-defined agents, every other panel
 * kind, every recipe — gets the launcher-item id (#12217).
 *
 * `null` is now only ever the answer for a row that isn't a launchable item at
 * all, which this function never sees: cues and preset children are `DockLaunchRow`s
 * without an `item`. It is kept as a return value so a future category added to
 * `DockLaunchItem` fails closed rather than minting an id nothing renders.
 */
export function resolveLauncherToolbarButtonId(
  item: DockLaunchItem,
  currentProjectId: string | null | undefined
): AnyToolbarButtonId | null {
  if (item.category === "agent") {
    if (isBuiltInAgentId(item.agent.id)) return item.agent.id;
    if (item.agent.id.length === 0) return null;
    return launcherItemToolbarButtonId("agent", item.agent.id);
  }
  if (item.category === "panel") {
    // Through the kind→button map, never `isLauncherPanelButtonId(kindId)`: the
    // dev preview kind is `dev-preview` and its button is `dev-server`, so the
    // direct test would hand that row a synthetic id alongside the fixed one it
    // already has, and two ids for one button disagree about its state.
    const fixed = getLauncherPanelButtonIdForKind(item.kindId);
    if (fixed) return fixed;
    if (item.kindId.length === 0) return null;
    return launcherItemToolbarButtonId("panel", item.kindId);
  }
  if (item.category === "recipe") {
    // The scoped identity, never the bare `recipe.id` — see
    // `recipeToolbarSourceId` on why a legacy in-repo id aliases across
    // projects.
    return launcherItemToolbarButtonId(
      "recipe",
      recipeToolbarSourceId(item.recipe, currentProjectId)
    );
  }
  return null;
}

/**
 * A launcher item that currently has a toolbar button id of the launcher-item
 * kind, paired with the row it launches.
 *
 * The item is carried whole rather than reduced to a label and an icon because
 * the button activates through `activateDockLaunchItem`, which needs it — one
 * launch seam for the launcher row and its toolbar button, so the two can't
 * drift the way the four fixed panel buttons and the launcher's Panels section
 * once did (#11668).
 */
export interface LauncherToolbarEntry {
  buttonId: LauncherItemToolbarButtonId;
  item: DockLaunchItem;
}

export type LauncherToolbarCatalog = ReadonlyMap<LauncherItemToolbarButtonId, LauncherToolbarEntry>;

const EMPTY_CATALOG: LauncherToolbarCatalog = new Map();

/**
 * Every launcher row that pins to a launcher-item id, keyed by that id.
 *
 * A `Map` rather than a plain object because the keys are built from arbitrary
 * agent ids, panel kind ids and recipe ids — bracket-indexing a plain object
 * with one would inherit `Object.prototype` members, which is the bug
 * `getLauncherPanelButtonIdForKind` already guards against with an own-property
 * check and has a regression test for.
 *
 * This is the render gate. `Toolbar` builds its `buttonRegistry` entries from
 * this map, and `availableLeftIds`/`availableRightIds` drop any id with no
 * registry entry — so a pin left behind by a deleted recipe, an uninstalled
 * plugin, or a project the user has switched away from renders nothing and can
 * launch nothing, without anything having to sweep the persisted map. The
 * catalog is project- and worktree-scoped, which is exactly why a sweep would be
 * wrong: "not live right now" and "gone for good" are not the same fact.
 */
export function buildLauncherToolbarCatalog(
  items: readonly DockLaunchItem[],
  currentProjectId: string | null | undefined
): LauncherToolbarCatalog {
  const catalog = new Map<LauncherItemToolbarButtonId, LauncherToolbarEntry>();
  for (const item of items) {
    const buttonId = resolveLauncherToolbarButtonId(item, currentProjectId);
    if (buttonId === null) continue;
    // Built-in agents and the four fixed panels resolve to ids this catalog
    // does not own — they already have renderers and settings rows.
    if (!isLauncherItemToolbarButtonId(buttonId)) continue;
    // First wins, so a duplicated input can't replace an entry with itself and
    // churn the memo's identity.
    if (catalog.has(buttonId)) continue;
    catalog.set(buttonId, { buttonId, item });
  }
  return catalog.size === 0 ? EMPTY_CATALOG : catalog;
}

/** Memoized {@link buildLauncherToolbarCatalog} over a launcher model's items. */
export function useLauncherToolbarCatalog(
  items: readonly DockLaunchItem[],
  currentProjectId: string | null | undefined
): LauncherToolbarCatalog {
  return useMemo(
    () => buildLauncherToolbarCatalog(items, currentProjectId),
    [items, currentProjectId]
  );
}

/**
 * The verb a launcher item's toolbar button leads with. The toolbar shows a
 * glyph and nothing else, so this is the tooltip and the accessible name — and
 * it has to say what pressing it does, because a recipe named "Review" and a
 * panel named "Review" are otherwise the same button.
 */
const LAUNCHER_ITEM_ACTION_LABEL = {
  agent: "Start",
  panel: "Open",
  recipe: "Run",
} as const;

/**
 * What pressing the button does, plus whatever it takes to tell two rows apart.
 *
 * Two recipes can share a name across scopes — a Project "Deploy" and a Team
 * "Deploy" are different recipes and both are pinnable — and the toolbar shows
 * only a glyph, so without the scope the two buttons, their tooltips and their
 * Settings switches would all read identically (#12217).
 */
function launcherItemDescription(item: DockLaunchItem): string {
  const verb = LAUNCHER_ITEM_ACTION_LABEL[item.category];
  if (item.category === "recipe") return `${verb} ${item.name} (${item.scopeLabel})`;
  return `${verb} ${item.name}`;
}

/** The glyph a catalog entry renders, resolved from whatever its category carries. */
function launcherItemIcon(item: DockLaunchItem): ToolbarButtonMetadata["icon"] {
  if (item.category === "agent") return item.agent.icon ?? DEFAULT_PANEL_ICON;
  if (item.category === "panel") return resolvePluginIcon(item.iconId, DEFAULT_PANEL_ICON);
  return Workflow;
}

/**
 * Display metadata for the launcher items currently on the toolbar, derived
 * from the live launcher row rather than a table.
 *
 * Same shape and the same reason as `buildPluginToolbarMeta`: the toolbar's
 * overflow menu and Settings → Toolbar both read it, so a button reads the same
 * everywhere it appears. Keyed by the launcher-item id and merged over
 * `TOOLBAR_BUTTON_METADATA` by each consumer.
 */
export function buildLauncherToolbarMeta(
  catalog: LauncherToolbarCatalog
): Record<string, ToolbarButtonMetadata> {
  const meta: Record<string, ToolbarButtonMetadata> = {};
  for (const entry of catalog.values()) {
    const { item } = entry;
    meta[entry.buttonId] = {
      label: item.name,
      icon: launcherItemIcon(item),
      description: launcherItemDescription(item),
    };
  }
  return meta;
}

/**
 * Metadata for a launcher item the user has already pinned, resolved from the
 * registries directly rather than from a launcher model.
 *
 * Settings → Toolbar lists what the user pinned so they can find it and unpin
 * it; the launcher stays the one place anything gets pinned. That is a narrower
 * question than the toolbar's — "what is this pinned id called", not "what can
 * be pinned" — and answering it from the registries keeps a settings tab out of
 * the launcher's whole dependency graph (`useDockLaunchModel` reaches the panel
 * definition registry, the action service and the panel store).
 *
 * `undefined` when the source is not currently here — an uninstalled plugin, a
 * deleted recipe, another project's recipe. Callers render nothing for it,
 * which is the same answer the toolbar's registry gate gives.
 */
export function resolveLauncherItemMetadata(
  buttonId: string,
  recipes: ReadonlyArray<TerminalRecipe>,
  currentProjectId: string | null | undefined
): ToolbarButtonMetadata | undefined {
  const decoded = decodeLauncherItemToolbarButtonId(buttonId);
  if (!decoded) return undefined;
  const { category, sourceId } = decoded;

  if (category === "agent") {
    const config = getAgentConfig(sourceId);
    if (!config) return undefined;
    return {
      label: config.name,
      icon: config.icon ?? SquareTerminal,
      description: `${LAUNCHER_ITEM_ACTION_LABEL.agent} ${config.name}`,
    };
  }

  if (category === "panel") {
    const config = getPanelKindConfig(sourceId);
    if (!config) return undefined;
    return {
      label: config.name,
      icon: resolvePluginIcon(config.iconId, DEFAULT_PANEL_ICON),
      description: `${LAUNCHER_ITEM_ACTION_LABEL.panel} ${config.name}`,
    };
  }

  // Compared through `recipeToolbarSourceId`, the same function that minted the
  // id — matching on `candidate.id` would reintroduce the legacy-in-repo
  // aliasing the scoping exists to close, and would also never match a scoped
  // id at all. Linear rather than a keyed lookup because a plain-object index
  // keyed by recipe id would inherit `Object.prototype`, and the list is the
  // handful a project holds.
  const recipe = recipes.find(
    (candidate) => recipeToolbarSourceId(candidate, currentProjectId) === sourceId
  );
  if (!recipe) return undefined;
  return {
    label: recipe.name,
    icon: Workflow,
    // Same scope suffix the catalog builds, through the same classifier, so the
    // two surfaces name a recipe identically.
    description: `${LAUNCHER_ITEM_ACTION_LABEL.recipe} ${recipe.name} (${getRecipeScope(recipe).label})`,
  };
}
