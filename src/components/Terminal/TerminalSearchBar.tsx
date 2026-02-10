import { useState, useCallback, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { validateRegexTerm, buildSearchOptions, type SearchStatus } from "./terminalSearchUtils";

interface TerminalSearchBarProps {
  terminalId: string;
  onClose: () => void;
  className?: string;
}

export function TerminalSearchBar({ terminalId, onClose, className }: TerminalSearchBarProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexEnabled, setRegexEnabled] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const performSearch = useCallback(
    (
      term: string,
      direction: "next" | "prev",
      overrides?: { caseSensitive?: boolean; regexEnabled?: boolean }
    ) => {
      const effectiveCaseSensitive = overrides?.caseSensitive ?? caseSensitive;
      const effectiveRegexEnabled = overrides?.regexEnabled ?? regexEnabled;

      if (!term) {
        setSearchStatus("idle");
        return;
      }

      if (effectiveRegexEnabled) {
        const validation = validateRegexTerm(term, effectiveCaseSensitive);
        if (!validation.isValid) {
          setSearchStatus("invalidRegex");
          const managed = terminalInstanceService.get(terminalId);
          managed?.searchAddon.clearDecorations();
          return;
        }
      }

      const managed = terminalInstanceService.get(terminalId);
      if (!managed) return;

      const options = buildSearchOptions(effectiveCaseSensitive, effectiveRegexEnabled);

      try {
        const found =
          direction === "next"
            ? managed.searchAddon.findNext(term, options)
            : managed.searchAddon.findPrevious(term, options);

        if (!found) {
          managed.searchAddon.clearDecorations();
        }
        setSearchStatus(found ? "found" : "none");
      } catch {
        setSearchStatus(effectiveRegexEnabled ? "invalidRegex" : "none");
        managed.searchAddon.clearDecorations();
      }
    },
    [terminalId, caseSensitive, regexEnabled]
  );

  const clearSearch = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    managed?.searchAddon.clearDecorations();
    setSearchStatus("idle");
  }, [terminalId]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const term = e.target.value;
      setSearchTerm(term);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!term) {
        clearSearch();
        return;
      }

      setSearchStatus("idle");
      debounceRef.current = setTimeout(() => {
        performSearch(term, "next");
      }, 150);
    },
    [performSearch, clearSearch]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        performSearch(searchTerm, e.shiftKey ? "prev" : "next");
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
        onClose();
      }
    },
    [searchTerm, performSearch, clearSearch, onClose]
  );

  const handleClose = useCallback(() => {
    clearSearch();
    onClose();
  }, [clearSearch, onClose]);

  const handleCaseSensitiveToggle = useCallback(() => {
    setCaseSensitive((prev) => {
      const nextCaseSensitive = !prev;
      if (searchTerm) {
        performSearch(searchTerm, "next", { caseSensitive: nextCaseSensitive });
      }
      return nextCaseSensitive;
    });
  }, [searchTerm, performSearch]);

  const handleRegexToggle = useCallback(() => {
    setRegexEnabled((prev) => {
      const nextRegexEnabled = !prev;
      if (searchTerm) {
        performSearch(searchTerm, "next", { regexEnabled: nextRegexEnabled });
      }
      return nextRegexEnabled;
    });
  }, [searchTerm, performSearch]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return (
    <div
      className={cn(
        "absolute top-2 right-2 z-20",
        "flex items-center gap-1 px-2 py-1.5",
        "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] shadow-lg",
        className
      )}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={searchTerm}
        onChange={handleInputChange}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        data-terminal-search-input
        className={cn(
          "w-44 px-2 py-1 text-sm",
          "bg-canopy-bg border border-canopy-border rounded",
          "focus:outline-none focus:ring-1 focus:ring-[var(--color-status-info)]",
          "text-canopy-text placeholder:text-canopy-text/40"
        )}
      />

      <button
        onClick={handleCaseSensitiveToggle}
        className={cn(
          "px-1.5 py-1 text-xs rounded transition-colors",
          caseSensitive
            ? "bg-[var(--color-status-info)] text-white"
            : "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-bg"
        )}
        title="Case sensitive"
        aria-label="Toggle case sensitivity"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>

      <button
        onClick={handleRegexToggle}
        className={cn(
          "px-1.5 py-1 text-xs font-mono rounded transition-colors",
          regexEnabled
            ? "bg-[var(--color-status-info)] text-white"
            : "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-bg"
        )}
        title="Regex"
        aria-label="Toggle regex mode"
        aria-pressed={regexEnabled}
      >
        .*
      </button>

      {searchTerm && searchStatus !== "idle" && (
        <span
          className={cn(
            "text-xs px-1.5",
            searchStatus === "found" ? "text-canopy-text/60" : "text-[var(--color-status-error)]"
          )}
        >
          {searchStatus === "found" && "Found"}
          {searchStatus === "none" && "No matches"}
          {searchStatus === "invalidRegex" && "Invalid regex"}
        </span>
      )}

      <button
        onClick={() => performSearch(searchTerm, "prev")}
        disabled={!searchTerm}
        className={cn(
          "p-1 rounded transition-colors",
          "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-bg",
          "disabled:opacity-30 disabled:cursor-not-allowed"
        )}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className="w-4 h-4" />
      </button>

      <button
        onClick={() => performSearch(searchTerm, "next")}
        disabled={!searchTerm}
        className={cn(
          "p-1 rounded transition-colors",
          "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-bg",
          "disabled:opacity-30 disabled:cursor-not-allowed"
        )}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDown className="w-4 h-4" />
      </button>

      <button
        onClick={handleClose}
        className={cn(
          "p-1 rounded transition-colors",
          "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-bg"
        )}
        aria-label="Close search"
        title="Close (Esc)"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export default TerminalSearchBar;
