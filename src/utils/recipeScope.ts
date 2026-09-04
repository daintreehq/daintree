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

/**
 * The identity a recipe is persisted under when it is pinned to the toolbar
 * (#12217).
 *
 * `recipe.id` alone is not it, because it is not globally unique. A legacy
 * in-repo recipe carries no `id` in its file, so `ProjectIdentityFiles` derives
 * `inrepo-<filename>` deterministically on every read — and `.daintree/recipes/`
 * is tracked in git, so two unrelated projects that each hold a `dev.json` both
 * produce `inrepo-dev`. Keying a pin on that alone makes pinning one project's
 * recipe silently show, and launch, the other project's.
 *
 * So a project-scoped recipe is qualified by the project it belongs to, and a
 * genuinely global one (a user's global recipe, or a plugin contribution whose
 * id is already the globally-unique `publisher.name`) is not — qualifying those
 * would strand the pin the moment the user switched projects.
 *
 * `getRecipeScope` already draws exactly that line, so this reads it rather than
 * re-deriving the classification and risking the two disagreeing.
 */
export function recipeToolbarSourceId(
  recipe: TerminalRecipe,
  currentProjectId: string | null | undefined
): string {
  if (getRecipeScope(recipe).isGlobal) return recipe.id;
  // `recipe.projectId` first: an in-repo recipe only gains one once
  // ProjectFileStore mirrors it, and the ambient current project is the right
  // answer until it does. The literal is a stable stand-in rather than a
  // fallback that silently merges every project's recipes — a launcher with no
  // project open has no recipes to pin in the first place.
  const projectId = recipe.projectId ?? currentProjectId ?? "no-project";
  return `${projectId}:${recipe.id}`;
}
