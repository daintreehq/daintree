import Fuse, { type IFuseOptions } from "fuse.js";
import type { TerminalRecipe } from "@/types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function computeFrecency(usageHistory: number[], now: number): number {
  let score = 0;
  for (const ts of usageHistory) {
    const elapsed = now - ts;
    score += 100 * Math.pow(0.5, elapsed / SEVEN_DAYS_MS);
  }
  return score;
}

export interface RecipeSections {
  pinned: TerminalRecipe[];
  recent: TerminalRecipe[];
  all: TerminalRecipe[];
}

export function buildRecipeSections(recipes: TerminalRecipe[]): RecipeSections {
  const pinned = recipes
    .filter((r) => r.showInEmptyState)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  const pinnedIds = new Set(pinned.map((r) => r.id));

  const recent = recipes
    .filter((r) => !r.showInEmptyState && r.lastUsedAt != null && !pinnedIds.has(r.id))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 5);

  const usedIds = new Set([...pinnedIds, ...recent.map((r) => r.id)]);
  const all = recipes
    .filter((r) => !usedIds.has(r.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { pinned, recent, all };
}

const RECIPE_FUSE_OPTIONS: IFuseOptions<TerminalRecipe> = {
  keys: [{ name: "name", weight: 1.0 }],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

// Cache keyed on identity+name so metadata-only updates (lastUsedAt, usageHistory)
// don't bust the Fuse index — only structural changes (add/remove/rename) do.
let fuseCache: { key: string; fuse: Fuse<TerminalRecipe> } | null = null;

// Length-prefix every field so a recipe named with the field separator can't
// collide with a different recipe set — JSON would also work but this avoids
// the parse cost.
function recipeFuseKey(recipes: readonly TerminalRecipe[]): string {
  return recipes.map((r) => `${r.id.length}:${r.id}:${r.name.length}:${r.name}`).join(",");
}

export function getRecipeFuse(recipes: readonly TerminalRecipe[]): Fuse<TerminalRecipe> {
  const key = recipeFuseKey(recipes);
  if (fuseCache && fuseCache.key === key) {
    return fuseCache.fuse;
  }
  const fuse = new Fuse(recipes as TerminalRecipe[], RECIPE_FUSE_OPTIONS);
  fuseCache = { key, fuse };
  return fuse;
}

export function _resetRecipeFuseCacheForTests(): void {
  fuseCache = null;
}

export interface RankedRecipe {
  recipe: TerminalRecipe;
  score: number;
}

export function rankSearchResults(
  recipes: readonly TerminalRecipe[],
  query: string,
  now: number
): RankedRecipe[] {
  const fuse = getRecipeFuse(recipes);
  // Uncapped: a limit would hide matches behind a common prefix while the
  // live region reported the capped length as the total.
  const results = fuse.search(query);

  if (results.length === 0) return [];

  // Fuse caches its items at index-build time, so r.item.usageHistory can be
  // stale after a metadata-only update reuses the cached instance. Look the
  // recipe up in the live input to read the freshest frecency input and to
  // surface the up-to-date recipe in results.
  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  const frecencyScores = results.map((r) => {
    const fresh = recipeById.get(r.item.id) ?? r.item;
    return computeFrecency(fresh.usageHistory ?? [], now);
  });
  const maxFrecency = frecencyScores.reduce((m, s) => Math.max(m, s), 1);

  return results
    .map((result, i) => {
      const fuseRelevance = 1 - (result.score ?? 0);
      const frecencyNorm = frecencyScores[i]! / maxFrecency;
      const combined = 0.7 * fuseRelevance + 0.3 * frecencyNorm;
      const fresh = recipeById.get(result.item.id) ?? result.item;
      return { recipe: fresh, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}
