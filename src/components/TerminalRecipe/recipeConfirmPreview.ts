import type { RecipeTerminal, TerminalRecipe } from "@shared/types";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";

/**
 * Preview lines for an agent-initiated dispatch that would run a recipe
 * (#11860).
 *
 * A confirmation that names only the action and echoes back a recipe id tells
 * the approver nothing — the whole point of gating recipe execution is that the
 * terminals run arbitrary commands, so the dialog has to show them. Commands go
 * out verbatim; env VALUES never do, because a recipe is a plausible place for
 * a token and a confirmation dialog is not where it should be displayed.
 *
 * Pure formatting over an already-resolved recipe: the caller resolves through
 * `getRecipeById` so what is previewed is the shadow-resolved winner that will
 * actually run, not whatever the requested id names (#8725).
 */

/** Longest single command/prompt fragment shown before it is elided. */
const MAX_FRAGMENT_LENGTH = 160;

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FRAGMENT_LENGTH
    ? `${collapsed.slice(0, MAX_FRAGMENT_LENGTH - 1)}…`
    : collapsed;
}

/** Where the recipe came from, so an approver can tell a plugin's from their own. */
export function recipeOriginLabel(recipe: TerminalRecipe): string {
  if (recipe.origin?.kind === "plugin") return `from the ${recipe.origin.pluginId} plugin`;
  if (isInRepoRecipeId(recipe)) return "shared team recipe";
  return recipe.projectId === undefined ? "global recipe" : "project recipe";
}

function describeTerminal(terminal: RecipeTerminal): string[] {
  const lines: string[] = [];
  if (terminal.type === "terminal") {
    lines.push(terminal.command ? `$ ${truncate(terminal.command)}` : "$ (default shell)");
  } else if (terminal.type === "dev-preview") {
    lines.push(terminal.devCommand ? `$ ${truncate(terminal.devCommand)}` : "$ (no dev command)");
  } else {
    lines.push(terminal.args ? `${terminal.type} ${truncate(terminal.args)}` : terminal.type);
  }
  if (terminal.initialPrompt) {
    lines.push(`prompt: ${truncate(terminal.initialPrompt)}`);
  }
  const envKeys = Object.keys(terminal.env ?? {}).sort();
  if (envKeys.length > 0) {
    lines.push(`env: ${envKeys.join(", ")} (values hidden)`);
  }
  return lines;
}

/**
 * Render the recipe's terminals for a confirmation dialog.
 *
 * `spawns` selects the framing. A dispatch that will actually start the
 * terminals says so and marks the ones the per-run agent cap trims off the tail
 * — an approver told "runs 5 terminals" when only 3 start has been shown
 * something untrue. A dispatch that merely names the recipe (deleting it,
 * copying it, opening its editor) is gated too and shows the same content, but
 * describing it as starting would be equally untrue.
 *
 * `null` means the id resolved to nothing — surfaced explicitly rather than as
 * an empty preview, which would read as "this recipe does nothing".
 */
export function formatRecipePreviewLines(
  recipe: TerminalRecipe | null,
  options: { agentTerminalCap: number; spawns: boolean }
): string[] {
  if (!recipe) {
    return ["Couldn't resolve this recipe — it may have been deleted or its plugin unloaded."];
  }

  const total = recipe.terminals.length;
  const running = options.spawns ? Math.min(total, Math.max(options.agentTerminalCap, 0)) : total;
  const lines = [`${recipe.name} — ${recipeOriginLabel(recipe)}`];
  if (!options.spawns) {
    lines.push(`Defines ${total} terminal${total === 1 ? "" : "s"}:`);
  } else if (running === total) {
    lines.push(`Starts ${total} terminal${total === 1 ? "" : "s"}:`);
  } else {
    lines.push(
      `Starts ${running} of ${total} terminals (an automated caller gets at most ${options.agentTerminalCap}):`
    );
  }

  recipe.terminals.forEach((terminal, index) => {
    const [head, ...rest] = describeTerminal(terminal);
    const skipped = index >= running ? " — not started" : "";
    const title = terminal.title ? `${terminal.title}: ` : "";
    lines.push(`${index + 1}. ${title}${head ?? terminal.type}${skipped}`);
    for (const line of rest) lines.push(`   ${line}`);
  });

  return lines;
}
