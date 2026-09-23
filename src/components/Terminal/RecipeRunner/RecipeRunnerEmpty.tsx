import { Play, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import type { RunCommand } from "@/types";

interface RecipeRunnerEmptyProps {
  onCreate: () => void;
  suggestions: RunCommand[];
  onRunSuggestion: (suggestion: RunCommand) => void;
  disabled?: boolean;
}

export function RecipeRunnerEmpty({
  onCreate,
  suggestions,
  onRunSuggestion,
  disabled,
}: RecipeRunnerEmptyProps) {
  const hasSuggestions = suggestions.length > 0;
  const createButton = (
    <button
      type="button"
      onClick={onCreate}
      className="group flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
    >
      <Plus
        className="h-3.5 w-3.5 text-text-secondary group-hover:text-text-primary transition-colors shrink-0"
        aria-hidden
      />
      <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
        Create your first recipe…
      </span>
    </button>
  );

  return (
    <div
      data-testid="recipe-runner-empty"
      className="flex flex-col items-stretch gap-3 py-2 w-full"
    >
      {hasSuggestions ? (
        <>
          <div className="flex flex-col gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                data-testid="recipe-suggestion-pill"
                onClick={() => onRunSuggestion(suggestion)}
                disabled={disabled}
                className="group w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle hover:bg-overlay-soft hover:border-border-default transition-colors text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-overlay-subtle disabled:hover:border-border-subtle"
              >
                <Play
                  className={cn(
                    "h-3.5 w-3.5 text-status-success transition-colors shrink-0",
                    !disabled && "group-hover:text-status-success"
                  )}
                  aria-hidden
                />
                <span className="flex-1 text-sm font-medium text-text-primary truncate">
                  {suggestion.name}
                </span>
                <span className="text-xs text-text-secondary truncate max-w-[55%]">
                  {suggestion.command}
                </span>
              </button>
            ))}
          </div>
          <div className="flex justify-center">{createButton}</div>
        </>
      ) : (
        // Sidebar scale on purpose: this sits under the canvas identity and
        // the launch anchor, and the canvas scale would outweigh both.
        <EmptyState
          variant="zero-data"
          scale="sidebar"
          title="Launch agents, dev servers, and terminals together with one click"
          action={createButton}
        />
      )}
    </div>
  );
}
