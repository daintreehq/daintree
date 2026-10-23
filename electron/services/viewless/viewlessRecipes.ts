import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project, RecipeNameCollision, TerminalRecipe } from "../../../shared/types/project.js";
import {
  hydrateInRepoRecipeUsage,
  mergeRecipes,
  stripSessionOverridesFromRecipe,
  summarizeRecipes,
} from "../../../shared/utils/recipeListing.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { RecipeListArgsSchema } from "./viewlessArgsSchemas.js";
import {
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

/**
 * `recipe.list` with no view (#14139): the four tiers a view's recipe store
 * loads, read through the same handlers and merged by the same rules. The
 * project read reconciles on the way, as it does for a view, so a listing here
 * promotes and backfills .daintree/recipes exactly as one there would; the
 * catalog counts it a write for that. A name conflict it finds is a view's to
 * raise, and with none attached it waits for the next one to load.
 *
 * Never fails, as a view's listing never does: a tier that can't be read
 * contributes nothing, and the others still answer.
 */
export async function runRecipeList(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = RecipeListArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const read = <T>(channel: string, args: unknown[], fallback: T) =>
    deps.invoke<T>(project.id, channel, args).catch(() => fallback);

  const [globalRaw, projectResult, inRepoRaw, pluginRecipes] = await Promise.all([
    read<TerminalRecipe[]>(CHANNELS.GLOBAL_GET_RECIPES, [], []),
    read<{ recipes: TerminalRecipe[]; collisions: RecipeNameCollision[] }>(
      CHANNELS.PROJECT_GET_RECIPES,
      [project.id],
      { recipes: [], collisions: [] }
    ),
    read<TerminalRecipe[]>(CHANNELS.PROJECT_GET_INREPO_RECIPES, [project.id], []),
    read<TerminalRecipe[]>(CHANNELS.PLUGIN_RECIPES_GET, [], []),
  ]);
  const projectRecipes = projectResult.recipes.map(stripSessionOverridesFromRecipe);
  const recipes = mergeRecipes(
    globalRaw.map(stripSessionOverridesFromRecipe),
    projectRecipes,
    hydrateInRepoRecipeUsage(inRepoRaw.map(stripSessionOverridesFromRecipe), projectRecipes),
    pluginRecipes
  );
  return success({
    recipes: summarizeRecipes(recipes, parsed.data?.worktreeId),
    isLoading: false,
  });
}
