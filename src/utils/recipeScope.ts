import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { isPluginRecipe } from "@shared/types/project";
import type { TerminalRecipe } from "@/types";

export interface RecipeScope {
  label: string;
  isGlobal: boolean;
}

/**
 * Resolve a worktree id to a human-readable name. Surfaces that have worktree
 * data on hand pass one; those that don't fall back to the bare `Worktree`
 * label rather than printing a raw id.
 */
export type WorktreeNameResolver = (worktreeId: string) => string | undefined;

/** The label a worktree goes by in recipe scope text. */
export function worktreeDisplayName(
  worktree: { name: string; branch?: string; isMainWorktree?: boolean } | undefined
): string | undefined {
  if (!worktree) return undefined;
  return worktree.isMainWorktree ? worktree.name : worktree.branch || worktree.name;
}

/**
 * Classify which recipe scope a recipe belongs to, using the vocabulary the
 * Settings recipe list established. Plugin provenance is checked first (it is
 * the only scope that is read-only), then in-repo before `projectId` because
 * in-repo recipes can also carry a `projectId` once ProjectFileStore mirrors
 * them.
 */
export function getRecipeScope(
  recipe: TerminalRecipe,
  resolveWorktreeName?: WorktreeNameResolver
): RecipeScope {
  // Provenance first: a plugin recipe also carries no `projectId`, so the
  // global inference below would claim it and label a plugin-owned, read-only
  // recipe as one the user can edit (#11860).
  if (isPluginRecipe(recipe)) return { label: "Plugin", isGlobal: true };
  if (isInRepoRecipeId(recipe)) return { label: "Team", isGlobal: false };
  if (recipe.projectId === undefined) return { label: "Global", isGlobal: true };
  if (!recipe.worktreeId) return { label: "Project-wide", isGlobal: false };
  const name = resolveWorktreeName?.(recipe.worktreeId);
  return { label: name ? `Worktree: ${name}` : "Worktree", isGlobal: false };
}
