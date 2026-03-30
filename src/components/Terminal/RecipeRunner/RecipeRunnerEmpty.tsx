import { BookOpen, Plus } from "lucide-react";
import type { RunCommand } from "@/types";

interface RecipeRunnerEmptyProps {
  suggestions: RunCommand[];
  onCreateFromTemplate: (runner: RunCommand) => void;
  onCreate: () => void;
}

export function RecipeRunnerEmpty({
  suggestions,
  onCreateFromTemplate,
  onCreate,
}: RecipeRunnerEmptyProps) {
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <BookOpen className="h-10 w-10 text-text-muted/50" aria-hidden />
      <div className="text-center">
        <p className="text-sm font-medium text-canopy-text">No recipes yet</p>
        <p className="text-xs text-text-muted mt-1">
          Recipes let you launch multi-terminal workflows with a single click
        </p>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-canopy-accent hover:text-canopy-accent/80 bg-canopy-accent/10 hover:bg-canopy-accent/15 rounded-[var(--radius-md)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Create your first recipe
      </button>
      {suggestions.length > 0 && (
        <div className="flex flex-col items-center gap-2 mt-2">
          <p className="text-xs text-text-muted">Or start from a detected script:</p>
          <div className="flex flex-wrap gap-1.5 justify-center max-w-sm">
            {suggestions.slice(0, 4).map((runner) => (
              <button
                key={runner.id}
                type="button"
                onClick={() => onCreateFromTemplate(runner)}
                className="flex items-center gap-1 px-2.5 py-1 text-xs text-canopy-text/80 bg-overlay-subtle border border-border-subtle rounded-full hover:bg-overlay-soft hover:border-border-default transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
              >
                <Plus className="h-3 w-3" aria-hidden />
                {runner.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
