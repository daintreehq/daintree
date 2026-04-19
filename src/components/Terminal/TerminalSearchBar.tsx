import { useState, useCallback, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { SEARCH_HIGHLIGHT_LIMIT } from "@/services/terminal/TerminalAddonManager";
import { validateRegexTerm, buildSearchOptions, type SearchStatus } from "./terminalSearchUtils";

interface MatchResults {
  resultIndex: number;
  resultCount: number;
}

function formatCount(count: number): string {
  return count >= SEARCH_HIGHLIGHT_LIMIT ? `${SEARCH_HIGHLIGHT_LIMIT}+` : String(count);
}

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
  const [matchResults, setMatchResults] = useState<MatchResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const managed = terminalInstanceService.get(terminalId);
    const addon = managed?.searchAddon;
    if (!addon?.onDidChangeResults) return;
    const disposable = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setMatchResults({ resultIndex, resultCount });
    });
    return () => {
      disposable.dispose();
    };
  }, [terminalId]);

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
        setMatchResults(null);
        return;
      }

      if (effectiveRegexEnabled) {
        const validation = validateRegexTerm(term, effectiveCaseSensitive);
        if (!validation.isValid) {
          setSearchStatus("invalidRegex");
          setMatchResults(null);
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
          setMatchResults(null);
        }
        setSearchStatus(found ? "found" : "none");
      } catch {
        setSearchStatus(effectiveRegexEnabled ? "invalidRegex" : "none");
        setMatchResults(null);
        managed.searchAddon.clearDecorations();
      }
    },
    [terminalId, caseSensitive, regexEnabled]
  );

  const clearSearch = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    managed?.searchAddon.clearDecorations();
    setSearchStatus("idle");
    setMatchResults(null);
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

  const statusText = (() => {
    if (!searchTerm || searchStatus === "idle") return "";
    if (searchStatus === "invalidRegex") return "Invalid regex";
    if (searchStatus === "none") return "No matches";
    if (matchResults && matchResults.resultCount > 0) {
      const countLabel = formatCount(matchResults.resultCount);
      return matchResults.resultIndex >= 0
        ? `${matchResults.resultIndex + 1} of ${countLabel}`
        : `${countLabel} matches`;
    }
    return "Found";
  })();

  return (
    <div
      className={cn(
        "absolute top-2 right-2 z-20",
        "flex items-center gap-1 px-2 py-1.5",
        "bg-daintree-sidebar border border-daintree-border rounded-[var(--radius-md)] shadow-[var(--theme-shadow-floating)]",
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
          "bg-daintree-bg border border-daintree-border rounded",
          "focus:outline-none focus:ring-1 focus:ring-status-info",
          "text-daintree-text placeholder:text-text-muted"
        )}
      />

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCaseSensitiveToggle}
              className={cn(
                "px-1.5 py-1 text-xs rounded transition-colors",
                caseSensitive
                  ? "bg-status-info text-daintree-bg"
                  : "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-bg"
              )}
              aria-label="Toggle case sensitivity"
              aria-pressed={caseSensitive}
            >
              Aa
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Case sensitive</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleRegexToggle}
              className={cn(
                "px-1.5 py-1 text-xs font-mono rounded transition-colors",
                regexEnabled
                  ? "bg-status-info text-daintree-bg"
                  : "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-bg"
              )}
              aria-label="Toggle regex mode"
              aria-pressed={regexEnabled}
            >
              .*
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Regex</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {statusText && (
        <span
          data-terminal-search-status
          className={cn(
            "text-xs px-1.5",
            searchStatus === "found" ? "text-daintree-text/60" : "text-status-error"
          )}
        >
          {statusText}
        </span>
      )}

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                onClick={() => performSearch(searchTerm, "prev")}
                disabled={!searchTerm}
                className={cn(
                  "p-1 rounded transition-colors",
                  "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-bg",
                  "disabled:opacity-30 disabled:cursor-not-allowed"
                )}
                aria-label="Previous match"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Previous match (Shift+Enter)</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                onClick={() => performSearch(searchTerm, "next")}
                disabled={!searchTerm}
                className={cn(
                  "p-1 rounded transition-colors",
                  "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-bg",
                  "disabled:opacity-30 disabled:cursor-not-allowed"
                )}
                aria-label="Next match"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Next match (Enter)</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleClose}
              className={cn(
                "p-1 rounded transition-colors",
                "text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-bg"
              )}
              aria-label="Close search"
            >
              <X className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close (Esc)</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export default TerminalSearchBar;
