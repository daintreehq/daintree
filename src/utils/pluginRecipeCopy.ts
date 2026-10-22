import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { isPluginRecipe, type RecipeTerminal, type TerminalRecipe } from "@shared/types/project";
import { pluginVariableReferences } from "@shared/utils/pluginRecipeVariables";

/**
 * Whether these steps use anything that only works inside a plugin's own
 * recipe (#13797): a panel step, a system prompt, or a `{{plugin.<name>}}`
 * that no user-owned recipe has a value for.
 */
export function recipeTerminalsUsePluginOnlyFeatures(
  terminals: readonly RecipeTerminal[]
): boolean {
  return terminals.some(
    (terminal) =>
      terminal.type === "plugin-panel" ||
      terminal.systemPrompt !== undefined ||
      pluginVariableReferences(terminal.initialPrompt ?? "").length > 0
  );
}

/**
 * Whether a copy of this recipe into a user-owned tier would quietly do less
 * than the original: it uses a plugin-only step or field, or declares that it
 * needs its plugin's agent tools, which a copy would stop checking.
 */
export function recipeUsesPluginOnlyFeatures(recipe: TerminalRecipe): boolean {
  return (
    (recipe.pluginVariables?.length ?? 0) > 0 ||
    recipe.requiresAgentTools === true ||
    recipeTerminalsUsePluginOnlyFeatures(recipe.terminals)
  );
}

/** Why a recipe using plugin-only features can't be copied into the user's own recipes. */
export function pluginOnlyCopyRefusal(recipe: TerminalRecipe): string {
  const owner = isPluginRecipe(recipe)
    ? `the ${pluginManifestIdFromInstanceKey(recipe.origin.pluginId)} plugin`
    : "a plugin";
  return `"${recipe.name}" opens ${owner}'s panels, uses its variables or needs its agent tools, which only work in the plugin's own recipe, so it can't be copied.`;
}
