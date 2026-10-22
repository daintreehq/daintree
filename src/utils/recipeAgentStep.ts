import { isPluginRecipe, type RecipeTerminal, type TerminalRecipe } from "@shared/types/project";
import { normalizeSystemPrompt, resolveSystemPromptArgs } from "@shared/utils/agentSystemPrompt";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";

export type ResolvedRecipeAgentStep =
  | {
      ok: true;
      /** The first turn as launch sends it, variables substituted. */
      initialPrompt: string | undefined;
      /** The standing instruction as the agent receives it, for showing. */
      systemPrompt: string | undefined;
      /** Its launch arguments; empty when the step has none. */
      systemPromptArgs: string[];
    }
  | { ok: false; reason: string };

/**
 * The prompts an agent step launches with (#13797). One function for the
 * launch and for the dialog that asks before a plugin's run, so what the user
 * approves is what starts — the gap #12263 closed for recipe approvals.
 *
 * A plugin's recipe is held to the rule a plugin's `agent.launch` is (#13762):
 * most CLIs take the first turn as a positional argument, so one starting
 * with "-" is an option rather than a task, and a plugin variable is a way for
 * one to arrive. A system prompt this agent can't take is refused rather than
 * dropped, since the recipe relies on it.
 */
export function resolveRecipeAgentStep(
  recipe: TerminalRecipe,
  terminal: RecipeTerminal,
  agentId: string,
  context: RecipeContext
): ResolvedRecipeAgentStep {
  const rawPrompt = terminal.initialPrompt?.trim();
  const initialPrompt = rawPrompt ? replaceRecipeVariables(rawPrompt, context) : undefined;
  if (isPluginRecipe(recipe) && initialPrompt?.trimStart().startsWith("-")) {
    return {
      ok: false,
      reason:
        'The prompt starts with "-", which the agent would read as an option rather than a task.',
    };
  }
  const systemPromptText = terminal.systemPrompt
    ? replaceRecipeVariables(terminal.systemPrompt, context)
    : undefined;
  const systemPromptArgs = resolveSystemPromptArgs(agentId, systemPromptText);
  if (!systemPromptArgs.ok) return { ok: false, reason: systemPromptArgs.reason };
  return {
    ok: true,
    initialPrompt,
    systemPrompt: normalizeSystemPrompt(systemPromptText),
    systemPromptArgs: systemPromptArgs.args,
  };
}
