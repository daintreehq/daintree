import type { TerminalRecipe } from "../types/project.js";
import { isPluginRecipe } from "../types/project.js";
import { pluginManifestIdFromInstanceKey } from "../types/plugin.js";
import { isInRepoRecipeId } from "./recipeFilename.js";

/**
 * How the four recipe tiers become the one list a project shows, shared by a
 * view's recipe store and the host's own `recipe.list` (#14139) so the two
 * can't list different recipes for the same files.
 */

// Recipes read from disk may still contain agentModelId/agentLaunchFlags/location
// if they were written by an older build before those fields were stripped on
// persist. Treat them as session-only state and drop them at load time.
//
// `origin` is dropped for a different reason: this runs over the three
// USER-OWNED tiers, whose files a user can hand-edit and whose schema is
// `.passthrough()`. An `origin` present there is a forgery — only the plugin
// registry stamps real provenance — and honouring it would route that recipe's
// writes into the plugin sidecar and make it undeletable (#11860). The fields
// only a plugin's own recipe carries (#13797) go for the same reason.
export function stripSessionOverridesFromRecipe(recipe: TerminalRecipe): TerminalRecipe {
  let changed = false;
  const terminals = recipe.terminals.map((terminal) => {
    if (
      terminal.agentModelId === undefined &&
      terminal.agentLaunchFlags === undefined &&
      terminal.location === undefined &&
      terminal.systemPrompt === undefined &&
      terminal.panelKindId === undefined &&
      terminal.panelArgs === undefined
    ) {
      return terminal;
    }
    changed = true;
    const {
      agentModelId: _m,
      agentLaunchFlags: _f,
      location: _l,
      systemPrompt: _sp,
      panelKindId: _pk,
      panelArgs: _pa,
      ...rest
    } = terminal;
    return rest;
  });
  if (
    recipe.shadowedBy !== undefined ||
    recipe.origin !== undefined ||
    recipe.pluginVariables !== undefined ||
    recipe.requiresAgentTools !== undefined
  ) {
    const {
      shadowedBy: _s,
      origin: _o,
      pluginVariables: _pv,
      requiresAgentTools: _rt,
      ...rest
    } = recipe;
    return { ...rest, ...(changed ? { terminals } : {}) };
  }
  return changed ? { ...recipe, terminals } : recipe;
}

/**
 * The canonical .daintree/recipes/*.json files intentionally omit machine-local
 * frecency (lastUsedAt/usageHistory) — it lives only in the ProjectFileStore
 * mirror (#11354) — so it is read back from the mirror.
 */
export function hydrateInRepoRecipeUsage(
  inRepoRecipes: TerminalRecipe[],
  projectRecipes: TerminalRecipe[]
): TerminalRecipe[] {
  const inRepoMirrorMeta = new Map(
    projectRecipes.filter((r) => isInRepoRecipeId(r)).map((r) => [r.id, r] as const)
  );
  return inRepoRecipes.map((r) => {
    const mirror = inRepoMirrorMeta.get(r.id);
    if (!mirror) return r;
    return { ...r, lastUsedAt: mirror.lastUsedAt, usageHistory: mirror.usageHistory };
  });
}

/**
 * Flatten the four recipe tiers into the list the UI renders.
 *
 * `pluginRecipes` is REQUIRED and deliberately has no default: a default would
 * let any one of the dozen mutation sites silently drop every plugin recipe
 * from the merged view by forgetting to pass it, whereas an omission is now a
 * compile error (#11860).
 */
export function mergeRecipes(
  globalRecipes: TerminalRecipe[],
  projectRecipes: TerminalRecipe[],
  inRepoRecipes: TerminalRecipe[],
  pluginRecipes: TerminalRecipe[]
): TerminalRecipe[] {
  // Project-local recipes that share a name with an in-repo recipe are kept but
  // marked as shadowed so the UI can surface them dimmed instead of hiding them.
  // ProjectFileStore also carries a reconciled mirror of each in-repo recipe so
  // runtime metadata can survive. Do not render those mirrors as project-local
  // duplicates; use the mirror as the displayed in-repo recipe instead.
  const inRepoIds = new Set(inRepoRecipes.map((r) => r.id));
  const inRepoNames = new Set(inRepoRecipes.map((r) => r.name));
  const inRepoMirrors = new Map(
    projectRecipes
      .filter((r) => inRepoIds.has(r.id) && isInRepoRecipeId(r))
      .map((r) => [r.id, r] as const)
  );
  const projectLocalRecipes = projectRecipes.filter(
    (r) => !(inRepoIds.has(r.id) && isInRepoRecipeId(r))
  );
  const projectWithMarkers = projectLocalRecipes.map((r) =>
    inRepoNames.has(r.name) ? { ...r, shadowedBy: r.name } : r
  );
  const inRepoWithMirrors = inRepoRecipes.map((r) => {
    const mirror = inRepoMirrors.get(r.id);
    if (!mirror) return r;
    const { shadowedBy: _shadowedBy, ...displayRecipe } = mirror;
    return displayRecipe;
  });
  // Plugin recipes sit with the other always-available entries and take no part
  // in name shadowing: their ids are plugin-qualified, so identity is exact and
  // a user recipe that happens to share a display name is a different recipe,
  // not an override of one.
  return [...globalRecipes, ...pluginRecipes, ...projectWithMarkers, ...inRepoWithMirrors];
}

export interface RecipeSummary {
  id: string;
  name: string;
  worktreeId: string | null;
  terminalCount: number;
  showInEmptyState: boolean;
  origin: { kind: "global" | "project" | "team" | "plugin"; pluginId: string | null };
}

/**
 * A recipe's tier for `recipe.list` (#11860). Plugin provenance is checked
 * first because a plugin recipe also carries no `projectId` and would
 * otherwise report as "global" — the same inference bug the persistence
 * routing has to avoid.
 */
export function describeRecipeOrigin(recipe: TerminalRecipe): RecipeSummary["origin"] {
  if (isPluginRecipe(recipe)) {
    // The manifest id, which `plugin.diagnose` takes: a project plugin's
    // instance key carries a machine-local project id (#12211).
    return { kind: "plugin", pluginId: pluginManifestIdFromInstanceKey(recipe.origin.pluginId) };
  }
  if (isInRepoRecipeId(recipe)) return { kind: "team", pluginId: null };
  return { kind: recipe.projectId === undefined ? "global" : "project", pluginId: null };
}

/**
 * The `recipe.list` rows: every recipe, or with a worktree named, its own
 * recipes and the ones not tied to any worktree.
 */
export function summarizeRecipes(
  recipes: readonly TerminalRecipe[],
  worktreeId: string | undefined
): RecipeSummary[] {
  const filtered = worktreeId
    ? recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined)
    : recipes;
  return filtered.map((r) => ({
    id: r.id,
    name: r.name,
    worktreeId: r.worktreeId ?? null,
    terminalCount: r.terminals.length,
    showInEmptyState: r.showInEmptyState ?? false,
    origin: describeRecipeOrigin(r),
  }));
}
