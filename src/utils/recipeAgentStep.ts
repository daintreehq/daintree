import {
  isAgentRecipeType,
  isPluginRecipe,
  type RecipeTerminal,
  type TerminalRecipe,
} from "@shared/types/project";
import { normalizeSystemPrompt, resolveSystemPromptArgs } from "@shared/utils/agentSystemPrompt";
import {
  NO_PLUGIN_VARIABLE_VALUES,
  replaceRecipeVariables,
  segmentRecipePrompt,
  type RecipeContext,
} from "@/utils/recipeVariables";

export type ResolvedRecipeAgentStep =
  | {
      ok: true;
      /** The first turn as launch sends it: variables substituted, one trimmed line. */
      initialPrompt: string | undefined;
      /**
       * The same first turn with its line breaks kept, as the recipe wrote it:
       * what the pane records as its first prompt (#14592).
       */
      promptAsWritten: string | undefined;
      /** The standing instruction as the agent receives it, for showing. */
      systemPrompt: string | undefined;
      /** Its launch arguments; empty when the step has none. */
      systemPromptArgs: string[];
    }
  | { ok: false; reason: string };

/**
 * Whether the first word of `rawPrompt` as launch resolves it is all the
 * author's own text. A substituted value anywhere in it (`-{{issue_title}}`)
 * makes it the value's, and a variable that resolves empty adds nothing.
 */
function leadingWordIsAuthored(rawPrompt: string, context: RecipeContext): boolean {
  let started = false;
  for (const segment of segmentRecipePrompt(rawPrompt, context)) {
    if (segment.kind === "missing") continue;
    const text = started ? segment.text : segment.text.trimStart();
    if (text === "") continue;
    if (segment.kind === "value" || segment.kind === "variable") {
      return started && /^\s/.test(text);
    }
    started = true;
    if (/\s/.test(text)) return true;
  }
  return true;
}

// `{{plugin.<name>}}` is a variable only in a plugin's own recipe, where one
// the run gave no value is empty; anywhere else it is text the user typed.
function recipeStepContext(recipe: TerminalRecipe, context: RecipeContext): RecipeContext {
  return {
    ...context,
    pluginVariables: isPluginRecipe(recipe)
      ? (context.pluginVariables ?? NO_PLUGIN_VARIABLE_VALUES)
      : undefined,
  };
}

/**
 * The prompts an agent step launches with (#13797). One function for the
 * launch and for the dialog that asks before a plugin's run, so what the user
 * approves is what starts — the gap #12263 closed for recipe approvals.
 *
 * A plugin's recipe is held to the rule a plugin's `agent.launch` is (#13762):
 * most CLIs take the first turn as a positional argument, so one starting
 * with "-" is an option rather than a task, and a plugin variable is a way for
 * one to arrive. A user's recipe is held to it only where a variable spells
 * part of that option: an issue's title is anyone's to write (#16381). A
 * system prompt this agent can't take is refused rather than dropped, since
 * the recipe relies on it.
 */
export function resolveRecipeAgentStep(
  recipe: TerminalRecipe,
  terminal: RecipeTerminal,
  agentId: string,
  context: RecipeContext
): ResolvedRecipeAgentStep {
  const fromPlugin = isPluginRecipe(recipe);
  const stepContext = recipeStepContext(recipe, context);
  const rawPrompt = terminal.initialPrompt?.trim();
  const promptAsWritten =
    (rawPrompt ? replaceRecipeVariables(rawPrompt, stepContext) : "").trim() || undefined;
  // The command builder sends the first turn as one trimmed line; resolve it
  // to exactly that here, so a dialog showing it shows what launches.
  const initialPrompt =
    promptAsWritten?.replace(/\r\n/g, " ").replace(/\n/g, " ").trim() || undefined;
  // An author's own leading option in a user recipe is theirs to launch; one a
  // substituted value spelled (an issue's title, a plugin's variable) is not.
  if (
    initialPrompt?.startsWith("-") &&
    (fromPlugin || !leadingWordIsAuthored(rawPrompt ?? "", stepContext))
  ) {
    return {
      ok: false,
      reason:
        'The prompt starts with "-", which the agent would read as an option rather than a task.',
    };
  }
  // Only a plugin's own recipe carries a system prompt; one that reached a
  // user-owned recipe some other way is ignored rather than launched.
  const systemPromptText =
    terminal.systemPrompt && fromPlugin
      ? replaceRecipeVariables(terminal.systemPrompt, stepContext)
      : undefined;
  const systemPromptArgs = resolveSystemPromptArgs(agentId, systemPromptText);
  if (!systemPromptArgs.ok) return { ok: false, reason: systemPromptArgs.reason };
  return {
    ok: true,
    initialPrompt,
    promptAsWritten,
    systemPrompt: normalizeSystemPrompt(systemPromptText),
    systemPromptArgs: systemPromptArgs.args,
  };
}

export interface RecipeRunMissingVariables {
  /** Built-in variables (`issue_number`, `branch_name`, …) that would launch empty. */
  builtIn: string[];
  /** A plugin recipe's own `plugin.<name>` variables that would launch empty. */
  plugin: string[];
}

/**
 * The variables a run would send empty (#15022), read from exactly the fields
 * `resolveRecipeAgentStep` substitutes: an agent step's first turn, and its
 * system prompt only in a plugin's own recipe. Commands, dev commands and args
 * go out as typed, so a `{{…}}` in one is never a missing value. `context` is
 * the run's, with `worktreePath` as the launch's own cwd.
 */
export function missingRecipeVariables(
  recipe: TerminalRecipe,
  context: RecipeContext,
  terminalIndices?: readonly number[]
): RecipeRunMissingVariables {
  const fromPlugin = isPluginRecipe(recipe);
  const stepContext = recipeStepContext(recipe, context);
  const builtIn = new Set<string>();
  const plugin = new Set<string>();
  for (const index of terminalIndices ?? recipe.terminals.keys()) {
    const terminal = recipe.terminals[index];
    if (!terminal || !isAgentRecipeType(terminal.type)) continue;
    for (const text of [terminal.initialPrompt, fromPlugin ? terminal.systemPrompt : undefined]) {
      if (!text) continue;
      for (const segment of segmentRecipePrompt(text, stepContext)) {
        if (segment.kind !== "missing") continue;
        (segment.name.startsWith("plugin.") ? plugin : builtIn).add(segment.name);
      }
    }
  }
  return { builtIn: [...builtIn], plugin: [...plugin] };
}
