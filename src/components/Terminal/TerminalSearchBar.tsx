import { useState, useCallback, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { SEARCH_HIGHLIGHT_LIMIT } from "@/services/terminal/TerminalAddonManager";
import { useTerminalSearchHistoryStore } from "@/store/terminalSearchHistoryStore";
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
  const addSearch = useTerminalSearchHistoryStore((s) => s.addSearch);
  const setToggles = useTerminalSearchHistoryStore((s) => s.setToggles);

  const [searchTerm, setSearchTerm] = useState(
    () => useTerminalSearchHistoryStore.getState().searches[0] ?? ""
  );
  const [caseSensitive, setCaseSensitive] = useState(
    () => useTerminalSearchHistoryStore.getState().caseSensitive
  );
  const [regexEnabled, setRegexEnabled] = useState(
    () => useTerminalSearchHistoryStore.getState().regexEnabled
  );
  const [wholeWord, setWholeWord] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [matchResults, setMatchResults] = useState<MatchResults | null>(null);
  const [regexError, setRegexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const historyIndexRef = useRef(-1);
  const draftBeforeHistoryRef = useRef("");
  const initialTermRef = useRef(searchTerm);
  const didInitialSearchRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    let disposed = false;
    let resultSubscription: { dispose: () => void } | null = null;
    void terminalInstanceService
      .ensureSearchAddon(terminalId)
      .then((addon) => {
        if (disposed || !addon?.onDidChangeResults) return;
        resultSubscription = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
          setMatchResults({ resultIndex, resultCount });
        });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      resultSubscription?.dispose();
    };
  }, [terminalId]);

  const performSearch = useCallback(
    (
      term: string,
      direction: "next" | "prev",
      overrides?: { caseSensitive?: boolean; regexEnabled?: boolean; wholeWord?: boolean }
    ) => {
      const effectiveCaseSensitive = overrides?.caseSensitive ?? caseSensitive;
      const effectiveRegexEnabled = overrides?.regexEnabled ?? regexEnabled;
      const effectiveWholeWord = overrides?.wholeWord ?? wholeWord;

      if (!term) {
        setSearchStatus("idle");
        setMatchResults(null);
        setRegexError(null);
        return;
      }

      if (effectiveRegexEnabled) {
        const validation = validateRegexTerm(term, effectiveCaseSensitive);
        if (!validation.isValid) {
          setSearchStatus("invalidRegex");
          setMatchResults(null);
          setRegexError(validation.error ?? "Invalid regex pattern");
          const managed = terminalInstanceService.get(terminalId);
          managed?.searchAddon?.clearDecorations();
          return;
        }
      }

      setRegexError(null);

      const options = buildSearchOptions(
        effectiveCaseSensitive,
        effectiveRegexEnabled,
        effectiveWholeWord
      );

      void terminalInstanceService
        .ensureSearchAddon(terminalId)
        .then((searchAddon) => {
          if (!searchAddon) return;
          const found =
            direction === "next"
              ? searchAddon.findNext(term, options)
              : searchAddon.findPrevious(term, options);

          if (!found) {
            searchAddon.clearDecorations();
            setMatchResults(null);
          }
          setSearchStatus(found ? "found" : "none");
        })
        .catch((error: unknown) => {
          setSearchStatus(effectiveRegexEnabled ? "invalidRegex" : "none");
          setMatchResults(null);
          if (effectiveRegexEnabled && error instanceof Error) {
            setRegexError(error.message);
          }
          terminalInstanceService.get(terminalId)?.searchAddon?.clearDecorations();
        });
    },
    [terminalId, caseSensitive, regexEnabled, wholeWord]
  );

  const cancelPendingSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const clearSearch = useCallback(() => {
    cancelPendingSearch();
    const managed = terminalInstanceService.get(terminalId);
    managed?.searchAddon?.clearDecorations();
    setSearchStatus("idle");
    setMatchResults(null);
    setRegexError(null);
  }, [terminalId, cancelPendingSearch]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const term = e.target.value;
      historyIndexRef.current = -1;
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
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey && !e.ctrlKey) {
        const history = useTerminalSearchHistoryStore.getState().searches;
        if (history.length === 0) return;

        e.preventDefault();
        e.stopPropagation();

        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }

        if (e.key === "ArrowUp") {
          if (historyIndexRef.current < 0) {
            draftBeforeHistoryRef.current = searchTerm;
          }
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++;
            const term = history[historyIndexRef.current]!;
            setSearchTerm(term);
            performSearch(term, "next");
          }
        } else {
          if (historyIndexRef.current < 0) return;
          historyIndexRef.current--;
          if (historyIndexRef.current < 0) {
            const draft = draftBeforeHistoryRef.current;
            setSearchTerm(draft);
            if (draft) {
              performSearch(draft, "next");
            } else {
              clearSearch();
            }
          } else {
            const term = history[historyIndexRef.current]!;
            setSearchTerm(term);
            performSearch(term, "next");
          }
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        performSearch(searchTerm, e.shiftKey ? "prev" : "next");
        addSearch(searchTerm);
        historyIndexRef.current = -1;
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        addSearch(searchTerm);
        clearSearch();
        onClose();
      }
    },
    [searchTerm, performSearch, clearSearch, onClose, addSearch]
  );

  const handleClose = useCallback(() => {
    addSearch(searchTerm);
    clearSearch();
    onClose();
  }, [searchTerm, addSearch, clearSearch, onClose]);

  const handleCaseSensitiveToggle = useCallback(() => {
    setCaseSensitive((prev) => {
      const nextCaseSensitive = !prev;
      setToggles(nextCaseSensitive, regexEnabled);
      if (searchTerm) {
        cancelPendingSearch();
        performSearch(searchTerm, "next", { caseSensitive: nextCaseSensitive });
      }
      return nextCaseSensitive;
    });
  }, [searchTerm, performSearch, cancelPendingSearch, setToggles, regexEnabled]);

  const handleRegexToggle = useCallback(() => {
    setRegexEnabled((prev) => {
      const nextRegexEnabled = !prev;
      if (!nextRegexEnabled) {
        setRegexError(null);
      }
      setToggles(caseSensitive, nextRegexEnabled);
      if (searchTerm) {
        cancelPendingSearch();
        performSearch(searchTerm, "next", { regexEnabled: nextRegexEnabled });
      }
      return nextRegexEnabled;
    });
  }, [searchTerm, performSearch, cancelPendingSearch, setToggles, caseSensitive]);

  const handleWholeWordToggle = useCallback(() => {
    setWholeWord((prev) => {
      const nextWholeWord = !prev;
      if (searchTerm) {
        cancelPendingSearch();
        performSearch(searchTerm, "next", { wholeWord: nextWholeWord });
      }
      return nextWholeWord;
    });
  }, [searchTerm, performSearch, cancelPendingSearch]);

  useEffect(() => {
    // Run once on mount with the pre-populated history term. The ref guard
    // keeps it single-shot while still listing `performSearch` as a dep, so
    // no React rule needs disabling (which would bail the React Compiler).
    if (didInitialSearchRef.current) return;
    didInitialSearchRef.current = true;
    if (initialTermRef.current) {
      performSearch(initialTermRef.current, "next");
    }
  }, [performSearch]);

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

  const atHighlightLimit =
    searchStatus === "found" &&
    matchResults !== null &&
    matchResults.resultCount >= SEARCH_HIGHLIGHT_LIMIT;

  return (
    <div
      className={cn(
        "absolute top-2 right-2 z-20",
        "flex items-center gap-1 px-2 py-1",
        "bg-surface-sidebar border border-border-default rounded-[var(--radius-md)] shadow-[var(--theme-shadow-floating)]",
        className
      )}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <Tooltip open={searchStatus === "invalidRegex" && !!regexError}>
        <TooltipTrigger asChild>
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            aria-invalid={searchStatus === "invalidRegex" || undefined}
            data-terminal-search-input
            className={cn(
              "w-44 px-2 py-1 text-sm rounded transition-colors",
              "bg-surface-canvas border",
              "focus:outline-hidden focus:ring-1",
              "text-text-primary placeholder:text-text-placeholder",
              searchStatus === "invalidRegex"
                ? "border-status-error/50 focus:border-status-error focus:ring-status-error/30"
                : "border-border-default focus:ring-status-info"
            )}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {regexError}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCaseSensitiveToggle}
            className={cn(
              "px-1.5 py-1 text-xs rounded transition-colors",
              caseSensitive
                ? "bg-status-info text-surface-canvas"
                : "text-text-secondary hover:text-text-primary hover:bg-overlay-medium"
            )}
            aria-label="Toggle case sensitivity"
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Case sensitive</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleRegexToggle}
            className={cn(
              "px-1.5 py-1 text-xs font-mono rounded transition-colors",
              regexEnabled
                ? "bg-status-info text-surface-canvas"
                : "text-text-secondary hover:text-text-primary hover:bg-overlay-medium"
            )}
            aria-label="Toggle regex mode"
            aria-pressed={regexEnabled}
          >
            .*
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Regex</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleWholeWordToggle}
            className={cn(
              "px-1.5 py-1 text-xs rounded transition-colors",
              wholeWord
                ? "bg-status-info text-surface-canvas"
                : "text-text-secondary hover:text-text-primary hover:bg-overlay-medium"
            )}
            aria-label="Toggle whole word"
            aria-pressed={wholeWord}
          >
            <span className="underline underline-offset-2 decoration-1">ab</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Whole word</TooltipContent>
      </Tooltip>

      {statusText &&
        (atHighlightLimit ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-terminal-search-status
                className={cn(
                  "text-xs px-1.5 cursor-help underline decoration-dotted underline-offset-2",
                  searchStatus === "found" ? "text-text-secondary" : "text-status-error"
                )}
              >
                {statusText}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Highlighting and navigation limited to first {SEARCH_HIGHLIGHT_LIMIT} matches
            </TooltipContent>
          </Tooltip>
        ) : (
          <span
            data-terminal-search-status
            className={cn(
              "text-xs px-1.5",
              searchStatus === "found" ? "text-text-secondary" : "text-status-error"
            )}
          >
            {statusText}
          </span>
        ))}

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              onClick={() => performSearch(searchTerm, "prev")}
              disabled={!searchTerm}
              className={cn(
                "p-1 rounded transition-colors",
                "text-daintree-text/60 hover:text-text-primary hover:bg-overlay-medium",
                "disabled:opacity-40 disabled:pointer-events-none"
              )}
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
              onClick={() => performSearch(searchTerm, "next")}
              disabled={!searchTerm}
              className={cn(
                "p-1 rounded transition-colors",
                "text-daintree-text/60 hover:text-text-primary hover:bg-overlay-medium",
                "disabled:opacity-40 disabled:pointer-events-none"
              )}
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
            onClick={handleClose}
            className={cn(
              "p-1 rounded transition-colors",
              "text-daintree-text/60 hover:text-text-primary hover:bg-overlay-medium"
            )}
            aria-label="Close search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  );
}
