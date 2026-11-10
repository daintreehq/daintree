import type { RecipeTerminal } from "@/types";
import { getAgentConfig } from "@/config/agents";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";

/** What a `plugin-panel` step opens, by its panel kind's name (#13797). */
export function recipePanelStepName(terminal: RecipeTerminal): string {
  const kind = terminal.panelKindId;
  return (kind !== undefined ? getPanelKindConfig(kind)?.name : undefined) ?? "Plugin panel";
}

/** A terminal's name as the recipe lists it: its title, else what it launches. */
export function recipeTerminalLabel(terminal: RecipeTerminal): string {
  if (terminal.type === "dev-preview") {
    return terminal.title || "Dev server";
  }
  if (terminal.type === "terminal") {
    return terminal.title || "Terminal";
  }
  if (terminal.type === "plugin-panel") {
    return terminal.title || recipePanelStepName(terminal);
  }
  const agentLabel =
    getAgentConfig(terminal.type)?.name ??
    terminal.type.charAt(0).toUpperCase() + terminal.type.slice(1);
  return terminal.title || agentLabel;
}

export function getRecipeTerminalSummary(terminals: RecipeTerminal[]): string {
  const MAX_DISPLAY = 4;

  const labels = terminals.map(recipeTerminalLabel);

  if (labels.length <= MAX_DISPLAY) {
    return labels.join(" • ");
  }

  const displayedLabels = labels.slice(0, MAX_DISPLAY);
  const remainingCount = labels.length - MAX_DISPLAY;
  return `${displayedLabels.join(" • ")} +${remainingCount}`;
}
