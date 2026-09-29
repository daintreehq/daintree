import { Play, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
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
    <Button variant="ghost" onClick={onCreate}>
      <Plus aria-hidden />
      Create your first recipe…
    </Button>
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
              <ChoiceCard
                key={suggestion.id}
                padding="sm"
                data-testid="recipe-suggestion-pill"
                onClick={() => onRunSuggestion(suggestion)}
                disabled={disabled}
                className="group w-full items-center gap-2"
              >
                <Play
                  className={cn(
                    "h-3.5 w-3.5 text-text-secondary transition-colors shrink-0",
                    !disabled && "group-hover:text-text-primary"
                  )}
                  aria-hidden
                />
                <span className="flex-1 text-sm font-medium text-text-primary truncate">
                  {suggestion.name}
                </span>
                <span className="text-xs text-text-secondary truncate max-w-[55%]">
                  {suggestion.command}
                </span>
              </ChoiceCard>
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
