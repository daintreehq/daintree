import type { RecipeContribution } from "../../../shared/types/plugin.js";
import type {
  PluginRecipeMetadata,
  RecipeTerminal,
  TerminalRecipe,
} from "../../../shared/types/project.js";
import { sanitizeRecipeTerminals } from "../../../shared/utils/recipeSanitizer.js";

/**
 * Main-process registry for plugin-contributed recipes (#11860).
 *
 * A recipe is a named multi-terminal launch layout a plugin declares inline in
 * its manifest. Unlike skills — which never leave the main process — recipes
 * have to reach renderer state, so this registry is the source the
 * `plugin:recipes-changed` broadcast and the `plugin.getRecipes` pull both read.
 *
 * Follows `PluginSkillRegistry`'s lifecycle shape: a qualified-id map plus a
 * per-plugin index so `unregisterPluginRecipes` drops exactly one plugin's
 * recipes on unload/disable/reload, and per-contribution resilience — a recipe
 * whose terminals are all rejected is skipped with a warning rather than
 * failing the whole plugin load.
 *
 * The registry holds the plugin's IMMUTABLE half. The user-owned half
 * (frecency, empty-state pin, auto-assign) lives in `PluginRecipeMetadataStore`
 * and is overlaid at read time from a snapshot pushed in by `PluginService`,
 * which keeps this module free of any filesystem dependency.
 */

interface RegisteredPluginRecipe {
  qualifiedId: string;
  pluginId: string;
  contributionId: string;
  name: string;
  terminals: RecipeTerminal[];
  /** Manifest defaults; a user override in the metadata snapshot wins. */
  defaultShowInEmptyState?: boolean;
  defaultAutoAssign?: TerminalRecipe["autoAssign"];
}

const recipesByQualifiedId = new Map<string, RegisteredPluginRecipe>();
const qualifiedIdsByPlugin = new Map<string, Set<string>>();

let metadataSnapshot: Record<string, PluginRecipeMetadata> = {};

/**
 * Mirror the metadata store's current state for the overlay. Pushed in rather
 * than read out so the registry never awaits a filesystem read while building a
 * broadcast payload.
 */
export function setPluginRecipeMetadataSnapshot(
  snapshot: Record<string, PluginRecipeMetadata>
): void {
  metadataSnapshot = snapshot;
}

/**
 * Register a plugin's declared recipes, replacing any it had registered before
 * (idempotent per plugin, so a dev reload can't leave stale entries).
 *
 * Every contributed terminal goes through `sanitizeRecipeTerminals` — the same
 * content trust boundary the import and in-repo tiers use. `TerminalRecipeSchema`
 * validates shape only and is `.passthrough()`, so the manifest parse is not a
 * substitute for it: a contributed `command` is forwarded verbatim to node-pty.
 *
 * `ownedAgentIds` admits agent ids this plugin effectively owns, so a plugin
 * shipping both an agent and a recipe that launches it works. It is computed
 * from the live agent registry (not the manifest) because a cross-plugin agent
 * id collision resolves first-registered-wins — a plugin that lost the
 * collision must not have its recipe launch the winner's agent.
 */
export function registerPluginRecipes(
  pluginId: string,
  contributions: readonly RecipeContribution[],
  ownedAgentIds: ReadonlySet<string>
): void {
  unregisterPluginRecipes(pluginId);
  for (const contribution of contributions) {
    const qualifiedId = `${pluginId}.${contribution.id}`;
    const terminals = sanitizeRecipeTerminals(contribution.terminals, {
      additionalAllowedTypes: ownedAgentIds,
    });
    if (terminals.length === 0) {
      console.warn(
        `[PluginRecipeRegistry] Skipping recipe "${qualifiedId}": no terminal survived content validation.`
      );
      continue;
    }
    const entry: RegisteredPluginRecipe = {
      qualifiedId,
      pluginId,
      contributionId: contribution.id,
      name: contribution.name,
      terminals,
    };
    if (contribution.showInEmptyState !== undefined) {
      entry.defaultShowInEmptyState = contribution.showInEmptyState;
    }
    if (contribution.autoAssign !== undefined) {
      entry.defaultAutoAssign = contribution.autoAssign;
    }
    recipesByQualifiedId.set(qualifiedId, entry);
    let ids = qualifiedIdsByPlugin.get(pluginId);
    if (!ids) {
      ids = new Set<string>();
      qualifiedIdsByPlugin.set(pluginId, ids);
    }
    ids.add(qualifiedId);
  }
}

/** Drop every recipe registered by `pluginId`. Safe to call for an unknown id. */
export function unregisterPluginRecipes(pluginId: string): void {
  const ids = qualifiedIdsByPlugin.get(pluginId);
  if (!ids) return;
  for (const qualifiedId of ids) {
    recipesByQualifiedId.delete(qualifiedId);
  }
  qualifiedIdsByPlugin.delete(pluginId);
}

/** Reset the whole registry (test isolation / full plugin-system teardown). */
export function clearPluginRecipeRegistry(): void {
  recipesByQualifiedId.clear();
  qualifiedIdsByPlugin.clear();
  metadataSnapshot = {};
}

function toTerminalRecipe(entry: RegisteredPluginRecipe): TerminalRecipe {
  const metadata = metadataSnapshot[entry.qualifiedId];
  const recipe: TerminalRecipe = {
    id: entry.qualifiedId,
    name: entry.name,
    // Fresh copies per read: main's registry objects must not be reachable for
    // mutation through a returned snapshot, and the array crosses IPC anyway.
    terminals: entry.terminals.map((terminal) => ({ ...terminal })),
    // Deterministic rather than install time: a contributed recipe has no
    // meaningful creation moment, and a reload-varying value would churn every
    // broadcast payload for no reader's benefit.
    createdAt: 0,
    origin: { kind: "plugin", pluginId: entry.pluginId, contributionId: entry.contributionId },
  };
  const showInEmptyState = metadata?.showInEmptyState ?? entry.defaultShowInEmptyState;
  if (showInEmptyState !== undefined) recipe.showInEmptyState = showInEmptyState;
  const autoAssign = metadata?.autoAssign ?? entry.defaultAutoAssign;
  if (autoAssign !== undefined) recipe.autoAssign = autoAssign;
  if (metadata?.lastUsedAt !== undefined) recipe.lastUsedAt = metadata.lastUsedAt;
  if (metadata?.usageHistory !== undefined) recipe.usageHistory = [...metadata.usageHistory];
  return recipe;
}

/**
 * The effective plugin recipe list: manifest content with user metadata
 * overlaid. Iteration follows plugin load order then per-plugin contribution
 * order, so the renderer's merged list is stable across reads.
 */
export function getPluginRecipes(): TerminalRecipe[] {
  return [...recipesByQualifiedId.values()].map(toTerminalRecipe);
}

/** One recipe by qualified id, or undefined if no loaded plugin declares it. */
export function getPluginRecipe(qualifiedId: string): TerminalRecipe | undefined {
  const entry = recipesByQualifiedId.get(qualifiedId);
  return entry ? toTerminalRecipe(entry) : undefined;
}

/**
 * The registered provenance for a qualified id. IPC handlers resolve identity
 * through this rather than trusting a renderer-supplied `pluginId`, and rather
 * than splitting the id (a plugin id is itself dotted — #10109).
 */
export function getPluginRecipeOwner(
  qualifiedId: string
): { pluginId: string; contributionId: string } | undefined {
  const entry = recipesByQualifiedId.get(qualifiedId);
  if (!entry) return undefined;
  return { pluginId: entry.pluginId, contributionId: entry.contributionId };
}

/** Per-plugin qualified-id sets, for metadata reconciliation at startup. */
export function getPluginRecipeQualifiedIdsByPlugin(): Map<string, Set<string>> {
  return new Map([...qualifiedIdsByPlugin].map(([id, ids]) => [id, new Set(ids)]));
}
