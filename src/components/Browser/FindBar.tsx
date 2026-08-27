import { useId } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FindInPageState } from "@/hooks/useFindInPage";

interface FindBarProps {
  find: FindInPageState;
}

export function FindBar({ find }: FindBarProps) {
  const {
    query,
    activeMatch,
    matchCount,
    matchCase,
    inputRef,
    isComposingRef,
    setQuery,
    goNext,
    goPrev,
    close,
    toggleMatchCase,
  } = find;
  const counterId = useId();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingRef.current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    } else if (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    }
  };

  const hasQuery = query.length > 0;
  const noResults = hasQuery && matchCount === 0;
  const countText = !hasQuery
    ? ""
    : matchCount > 0
      ? `${activeMatch} of ${matchCount}`
      : "No results";

  return (
    <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md bg-surface-panel-elevated border border-daintree-border shadow-[var(--theme-shadow-floating)] px-2 py-1">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          setQuery(e.currentTarget.value);
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        aria-describedby={counterId}
        data-testid="find-bar-input"
        className="w-44 bg-transparent text-xs text-daintree-text placeholder:text-text-placeholder outline-hidden border border-transparent focus:border-border-strong transition-colors"
        spellCheck={false}
      />
      <span
        id={counterId}
        role="status"
        aria-atomic="true"
        className={`text-2xs tabular-nums whitespace-nowrap mr-0.5 ${
          noResults ? "text-status-error" : "text-daintree-text/50"
        }`}
      >
        {countText}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggleMatchCase}
            onMouseDown={(e) => e.preventDefault()}
            className={`px-1 rounded text-xs font-medium transition-colors ${
              matchCase
                ? "text-accent-primary bg-accent-primary/10"
                : "text-daintree-text/50 hover:text-daintree-text/70 hover:bg-overlay-medium"
            }`}
            aria-label="Match case"
            aria-pressed={matchCase}
          >
            Aa
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Match case</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              onClick={goPrev}
              disabled={matchCount === 0}
              className="p-1 rounded hover:bg-overlay-medium disabled:opacity-40 disabled:pointer-events-none transition-colors text-daintree-text/70"
              aria-label="Previous match"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Previous match (Shift+Enter)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              onClick={goNext}
              disabled={matchCount === 0}
              className="p-1 rounded hover:bg-overlay-medium disabled:opacity-40 disabled:pointer-events-none transition-colors text-daintree-text/70"
              aria-label="Next match"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Next match (Enter)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={close}
            className="p-1 rounded hover:bg-overlay-medium transition-colors text-daintree-text/70"
            aria-label="Close find bar"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  );
}
