import { useCallback, useEffect, useState, useRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";

interface WorktreeSidebarSearchBarProps {
  inputRef?: React.Ref<HTMLInputElement>;
}

export function WorktreeSidebarSearchBar({ inputRef }: WorktreeSidebarSearchBarProps) {
  const query = useWorktreeFilterStore((state) => state.query);
  const setQuery = useWorktreeFilterStore((state) => state.setQuery);
  const clearAll = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);

  const [localQuery, setLocalQuery] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const internalRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLocalQuery(query);
  }, [query]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setLocalQuery(value);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        setQuery(value);
      }, 200);
    },
    [setQuery]
  );

  const handleClear = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLocalQuery("");
    clearAll();
  }, [clearAll]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (localQuery || hasActiveFilters()) {
          handleClear();
        } else {
          internalRef.current?.blur();
        }
      }
    },
    [localQuery, hasActiveFilters, handleClear]
  );

  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      internalRef.current = el;
      if (typeof inputRef === "function") {
        inputRef(el);
      } else if (inputRef && typeof inputRef === "object") {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }
    },
    [inputRef]
  );

  const showClear = localQuery || hasActiveFilters();

  return (
    <div className="px-3 py-2 border-b border-divider shrink-0">
      <div
        role="search"
        className={cn(
          "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)]",
          "bg-daintree-bg border border-daintree-border",
          "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
        )}
      >
        <Search
          className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={setRefs}
          type="text"
          value={localQuery}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search worktrees..."
          aria-label="Search worktrees"
          className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder-daintree-text/40 focus:outline-none"
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {showClear && (
            <button
              type="button"
              onClick={handleClear}
              className="flex items-center justify-center w-5 h-5 rounded text-daintree-text/40 hover:text-daintree-text"
              aria-label="Clear search and filters"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <WorktreeFilterPopover hideSearchInput />
        </div>
      </div>
    </div>
  );
}
