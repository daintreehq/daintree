import { ChevronUp, ChevronDown, X } from "lucide-react";
import type { FindInPageState } from "@/hooks/useFindInPage";

interface FindBarProps {
  find: FindInPageState;
}

export function FindBar({ find }: FindBarProps) {
  const {
    query,
    activeMatch,
    matchCount,
    inputRef,
    isComposingRef,
    setQuery,
    goNext,
    goPrev,
    close,
  } = find;

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

  return (
    <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md bg-surface-panel-elevated border border-canopy-border shadow-[var(--theme-shadow-floating)] px-2 py-1">
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
        className="w-44 bg-transparent text-xs text-canopy-text placeholder:text-canopy-text/40 outline-none"
        spellCheck={false}
      />
      {query && (
        <span className="text-[10px] text-canopy-text/50 tabular-nums whitespace-nowrap mr-0.5">
          {matchCount > 0 ? `${activeMatch} / ${matchCount}` : "No results"}
        </span>
      )}
      <button
        type="button"
        onClick={goPrev}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-tint/10 disabled:opacity-30 text-canopy-text/70"
        aria-label="Previous match"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={goNext}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-tint/10 disabled:opacity-30 text-canopy-text/70"
        aria-label="Next match"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={close}
        className="p-0.5 rounded hover:bg-tint/10 text-canopy-text/70"
        aria-label="Close find bar"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
