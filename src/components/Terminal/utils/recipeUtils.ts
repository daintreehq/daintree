import type { RecipeTerminal } from "@/types";

export function getRecipeGridClasses(recipeCount: number): string {
  if (recipeCount === 1) {
    return "grid grid-cols-1 max-w-md mx-auto gap-3";
  }
  if (recipeCount === 2) {
    return "grid grid-cols-1 sm:grid-cols-2 gap-3";
  }
  if (recipeCount === 3) {
    return "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3";
  }
  if (recipeCount === 4) {
    return "grid grid-cols-1 sm:grid-cols-2 gap-3";
  }
  return "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3";
}

export function getRecipeTerminalSummary(terminals: RecipeTerminal[]): string {
  const MAX_DISPLAY = 4;

  const labels = terminals.map((terminal) => {
    if (terminal.type === "dev-preview") {
      return terminal.title || "Dev Server";
    }
    if (terminal.type === "terminal") {
      return terminal.title || "Terminal";
    }
    const agentLabel = terminal.type.charAt(0).toUpperCase() + terminal.type.slice(1);
    return terminal.title || agentLabel;
  });

  if (labels.length <= MAX_DISPLAY) {
    return labels.join(" • ");
  }

  const displayedLabels = labels.slice(0, MAX_DISPLAY);
  const remainingCount = labels.length - MAX_DISPLAY;
  return `${displayedLabels.join(" • ")} +${remainingCount}`;
}
