import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
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
 * Classify which of the three recipe scopes a recipe belongs to, using the
 * vocabulary the Settings recipe list established. In-repo is checked before
 * `projectId` because in-repo recipes can also carry a `projectId` once
 * ProjectFileStore mirrors them.
 */
export function getRecipeScope(
  recipe: TerminalRecipe,
  resolveWorktreeName?: WorktreeNameResolver
): RecipeScope {
  if (isInRepoRecipeId(recipe)) return { label: "Team", isGlobal: false };
  if (recipe.projectId === undefined) return { label: "Global", isGlobal: true };
  if (!recipe.worktreeId) return { label: "Project-wide", isGlobal: false };
  const name = resolveWorktreeName?.(recipe.worktreeId);
  return { label: name ? `Worktree: ${name}` : "Worktree", isGlobal: false };
}
