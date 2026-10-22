import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { isPluginRecipe, type RecipeTerminal, type TerminalRecipe } from "@shared/types/project";

/**
 * Whether these steps use a step or field that only works inside a plugin's
 * own recipe (#13797): a panel step, or a system prompt.
 */
export function recipeTerminalsUsePluginOnlyFeatures(
  terminals: readonly RecipeTerminal[]
): boolean {
  return terminals.some(
    (terminal) => terminal.type === "plugin-panel" || terminal.systemPrompt !== undefined
  );
}

/**
 * Whether a copy of this recipe into a user-owned tier would quietly do less
 * than the original: it uses a plugin-only step or field, declares variables
 * (which a copy has no way to fill, so its prompts would carry the tokens as
 * text), or needs its plugin's agent tools, which a copy would stop checking.
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

/**
 * The same question for a recipe file about to be imported, read loosely: an
 * exported plugin recipe still carries its plugin-only content, and importing
 * it would make the reduced copy that Duplicate and Save to repo refuse.
 */
export function importedRecipeUsesPluginOnlyFeatures(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const recipe = raw as Record<string, unknown>;
  if (recipe.pluginVariables !== undefined || recipe.requiresAgentTools !== undefined) return true;
  const terminals = Array.isArray(recipe.terminals) ? (recipe.terminals as unknown[]) : [];
  return terminals.some(
    (terminal) =>
      terminal !== null &&
      typeof terminal === "object" &&
      ((terminal as Record<string, unknown>).type === "plugin-panel" ||
        (terminal as Record<string, unknown>).systemPrompt !== undefined)
  );
}
