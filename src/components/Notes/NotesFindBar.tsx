import { useRef } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FindInNoteState } from "@/hooks/useFindInNote";

interface NotesFindBarProps {
  find: FindInNoteState;
}

export function NotesFindBar({ find }: NotesFindBarProps) {
  const {
    query,
    activeMatch,
    matchCount,
    caseSensitive,
    regexp,
    inputRef,
    setQuery,
    toggleCase,
    toggleRegexp,
    goNext,
    goPrev,
    close,
    onCompositionStart,
    onCompositionEnd,
  } = find;

  const localComposingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (localComposingRef.current) return;
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
    <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md bg-surface-panel-elevated border border-daintree-border shadow-[var(--theme-shadow-floating)] px-2 py-1">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          localComposingRef.current = true;
          onCompositionStart();
        }}
        onCompositionEnd={(e) => {
          localComposingRef.current = false;
          onCompositionEnd(e.currentTarget.value);
        }}
        placeholder="Find in note"
        className="w-44 bg-transparent text-xs text-daintree-text placeholder:text-daintree-text/40 outline-none"
        spellCheck={false}
      />
      {query && (
        <span className="text-[10px] text-daintree-text/50 tabular-nums whitespace-nowrap mr-0.5">
          {matchCount > 0 ? `${activeMatch || 1} / ${matchCount}` : "No results"}
        </span>
      )}
      <button
        type="button"
        onClick={toggleCase}
        aria-pressed={caseSensitive}
        aria-label="Match case"
        title="Match case"
        className={cn(
          "px-1 py-0.5 rounded text-[10px] font-semibold",
          caseSensitive
            ? "bg-daintree-accent/20 text-daintree-accent"
            : "hover:bg-tint/10 text-daintree-text/70"
        )}
      >
        Aa
      </button>
      <button
        type="button"
        onClick={toggleRegexp}
        aria-pressed={regexp}
        aria-label="Use regular expression"
        title="Use regular expression"
        className={cn(
          "px-1 py-0.5 rounded text-[10px] font-mono",
          regexp
            ? "bg-daintree-accent/20 text-daintree-accent"
            : "hover:bg-tint/10 text-daintree-text/70"
        )}
      >
        .*
      </button>
      <button
        type="button"
        onClick={goPrev}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-tint/10 disabled:opacity-30 text-daintree-text/70"
        aria-label="Previous match"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={goNext}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-tint/10 disabled:opacity-30 text-daintree-text/70"
        aria-label="Next match"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={close}
        className="p-0.5 rounded hover:bg-tint/10 text-daintree-text/70"
        aria-label="Close find bar"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
