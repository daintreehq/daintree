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

export function buildRecipeSections(
  recipes: TerminalRecipe[],
  activeWorktreeId: string | null | undefined
): RecipeSections {
  const visible = recipes.filter(
    (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
  );

  const pinned = visible
    .filter((r) => r.showInEmptyState)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

  const pinnedIds = new Set(pinned.map((r) => r.id));

  const recent = visible
    .filter((r) => !r.showInEmptyState && r.lastUsedAt != null && !pinnedIds.has(r.id))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 5);

  const usedIds = new Set([...pinnedIds, ...recent.map((r) => r.id)]);
  const all = visible
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

const fuseCache = new WeakMap<readonly TerminalRecipe[], Fuse<TerminalRecipe>>();

export function getRecipeFuse(recipes: readonly TerminalRecipe[]): Fuse<TerminalRecipe> {
  let fuse = fuseCache.get(recipes);
  if (!fuse) {
    fuse = new Fuse(recipes as TerminalRecipe[], RECIPE_FUSE_OPTIONS);
    fuseCache.set(recipes, fuse);
  }
  return fuse;
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
  const results = fuse.search(query, { limit: 50 });

  if (results.length === 0) return [];

  const frecencyScores = results.map((r) => computeFrecency(r.item.usageHistory ?? [], now));
  const maxFrecency = Math.max(...frecencyScores, 1);

  return results
    .map((result, i) => {
      const fuseRelevance = 1 - (result.score ?? 0);
      const frecencyNorm = frecencyScores[i] / maxFrecency;
      const combined = 0.7 * fuseRelevance + 0.3 * frecencyNorm;
      return { recipe: result.item, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}
