import type { RecipeTerminal } from "@/types";
import { getAgentConfig } from "@/config/agents";

export function getRecipeTerminalSummary(terminals: RecipeTerminal[]): string {
  const MAX_DISPLAY = 4;

  const labels = terminals.map((terminal) => {
    if (terminal.type === "dev-preview") {
      return terminal.title || "Dev Server";
    }
    if (terminal.type === "terminal") {
      return terminal.title || "Terminal";
    }
    const agentLabel =
      getAgentConfig(terminal.type)?.name ??
      terminal.type.charAt(0).toUpperCase() + terminal.type.slice(1);
    return terminal.title || agentLabel;
  });

  if (labels.length <= MAX_DISPLAY) {
    return labels.join(" • ");
  }

  const displayedLabels = labels.slice(0, MAX_DISPLAY);
  const remainingCount = labels.length - MAX_DISPLAY;
  return `${displayedLabels.join(" • ")} +${remainingCount}`;
}
