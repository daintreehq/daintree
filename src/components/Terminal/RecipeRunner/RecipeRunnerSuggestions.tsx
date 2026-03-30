import { Plus, Sparkles } from "lucide-react";
import type { RunCommand } from "@/types";

interface RecipeRunnerSuggestionsProps {
  suggestions: RunCommand[];
  onCreateFromTemplate: (runner: RunCommand) => void;
}

export function RecipeRunnerSuggestions({
  suggestions,
  onCreateFromTemplate,
}: RecipeRunnerSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-2 px-1">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-muted uppercase tracking-wide">
        <Sparkles className="h-3 w-3" aria-hidden />
        Suggested
      </div>
      <div className="flex flex-wrap gap-1.5 px-2 py-1">
        {suggestions.slice(0, 4).map((runner) => (
          <button
            key={runner.id}
            type="button"
            onClick={() => onCreateFromTemplate(runner)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-canopy-text/70 bg-overlay-subtle border border-border-subtle rounded-full hover:bg-overlay-soft hover:border-border-default transition-colors opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
          >
            <Plus className="h-3 w-3" aria-hidden />
            {runner.name}
          </button>
        ))}
      </div>
    </div>
  );
}
