import { Play, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
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
    <Button variant="ghost" size="sm" onClick={onCreate}>
      <Plus aria-hidden />
      Create your first recipe…
    </Button>
  );

  return (
    <div data-testid="recipe-runner-empty" className="flex flex-col items-stretch gap-3 w-full">
      {hasSuggestions ? (
        <>
          <div className="flex flex-col gap-2">
            {suggestions.map((suggestion) => (
              <ChoiceCard
                key={suggestion.id}
                padding="sm"
                aria-labelledby={`recipe-suggestion-${suggestion.id}-name`}
                aria-describedby={`recipe-suggestion-${suggestion.id}-command`}
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
                <span
                  id={`recipe-suggestion-${suggestion.id}-name`}
                  className="flex-1 text-sm font-medium text-text-primary truncate"
                >
                  {suggestion.name}
                </span>
                <span
                  id={`recipe-suggestion-${suggestion.id}-command`}
                  className="text-xs text-text-secondary truncate max-w-[55%]"
                >
                  {suggestion.command}
                </span>
              </ChoiceCard>
            ))}
          </div>
          <div className="flex justify-center">{createButton}</div>
        </>
      ) : (
        // Two lines, not an `EmptyState`. Even at sidebar scale that shell
        // carries a pane's vertical padding, which opened ~80px voids above and
        // below the invitation, so the band with nothing in it stood taller
        // than three recipe cards and read like a failed render.
        // On the column's left rail like the bands around it; the sentence
        // takes the ghost button's 12px inset so the two lines start together.
        <div className="flex flex-col items-start gap-1">
          {/* `text-xs`, the button's own size: the explanation should not
              out-rank the one control this band exists for. */}
          <p className="px-3 text-xs text-pretty text-text-secondary">
            Launch agents, dev servers, and terminals together with one click
          </p>
          {createButton}
        </div>
      )}
    </div>
  );
}
