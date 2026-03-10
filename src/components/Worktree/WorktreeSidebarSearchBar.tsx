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
    }
    setLocalQuery("");
    setQuery("");
  }, [setQuery]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (localQuery) {
          handleClear();
        } else {
          internalRef.current?.blur();
        }
      }
    },
    [localQuery, handleClear]
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

  return (
    <div className="px-3 py-2 border-b border-divider shrink-0">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-canopy-text/30 pointer-events-none" />
          <input
            ref={setRefs}
            type="text"
            value={localQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search worktrees..."
            aria-label="Search worktrees"
            className={cn(
              "w-full pl-7 pr-7 py-1.5 text-xs rounded",
              "bg-canopy-bg border border-canopy-border",
              "text-canopy-text placeholder-canopy-text/40",
              "focus:outline-none focus:border-canopy-accent/50"
            )}
          />
          {localQuery && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <WorktreeFilterPopover hideSearchInput />
      </div>
    </div>
  );
}
