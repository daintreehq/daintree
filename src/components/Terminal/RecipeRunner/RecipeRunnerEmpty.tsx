import { Play, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
import type { RunCommand } from "@/types";

interface RecipeRunnerEmptyProps {
  onCreate: () => void;
  createButtonRef?: React.Ref<HTMLButtonElement>;
  suggestions: RunCommand[];
  onRunSuggestion: (suggestion: RunCommand) => void;
  disabled?: boolean;
}

export function RecipeRunnerEmpty({
  onCreate,
  createButtonRef,
  suggestions,
  onRunSuggestion,
  disabled,
}: RecipeRunnerEmptyProps) {
  const hasSuggestions = suggestions.length > 0;
  const createButton = (
    <Button
      ref={createButtonRef}
      variant="ghost"
      size="sm"
      onClick={onCreate}
      className="gap-2 border border-transparent contrast-more:border-text-secondary"
    >
      <span className="flex w-4 shrink-0 justify-center">
        <Plus aria-hidden />
      </span>
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
                className="group w-full items-center gap-2 contrast-more:border-text-secondary"
              >
                <span className="flex w-4 shrink-0 justify-center">
                  <Play
                    className={cn(
                      "h-3.5 w-3.5 text-text-secondary transition-colors",
                      !disabled && "group-hover:text-text-primary"
                    )}
                    aria-hidden
                  />
                </span>
                <span
                  id={`recipe-suggestion-${suggestion.id}-name`}
                  className="flex-1 text-sm text-text-primary truncate"
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
          <div className="flex justify-start">{createButton}</div>
        </>
      ) : (
        // Two lines, not an `EmptyState`. Even at sidebar scale that shell
        // carries a pane's vertical padding, which opened ~80px voids above and
        // below the invitation, so the band with nothing in it stood taller
        // than three recipe cards and read like a failed render.
        // On the column's left rail like the bands around it; the sentence
        // takes the button's 1px edge (as a margin: a transparent border is
        // drawn under forced colours) and 12px inset, so it starts on the
        // glyph line every band shares.
        <div className="flex flex-col items-start gap-1">
          {/* `text-xs`, the button's own size: the explanation should not
              out-rank the one control this band exists for. */}
          <p className="ml-px px-3 text-xs text-balance text-text-secondary">
            Launch agents, dev servers, and terminals together with one click
          </p>
          {createButton}
        </div>
      )}
    </div>
  );
}
