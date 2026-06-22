import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  Search,
  RefreshCw,
  AlertCircle,
  GitCommitHorizontal,
  Check,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/useDebounce";
import { formatTimeAgo } from "@/utils/timeAgo";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { GitCommit } from "@shared/types/git";

// Local-git fallback for the commits pill dropdown (issue #10414). Commit
// history is local git data, not forge data, so the pill can open a list even
// when no forge provider supplies a stats dropdown view. Self-contained: owns
// its fetch, search, pagination, and keyboard navigation; FixedDropdown (via
// ForgeStatPill) owns the portal, positioning, and dismiss behavior.

interface LocalCommitsDropdownProps {
  cwd: string;
  branch?: string;
  open: boolean;
  initialCount?: number | null;
  onClose?: () => void;
}

const PAGE_SIZE = 30;
const COPY_FEEDBACK_MS = 2000;

// Mirrors a rendered commit row (py-2.5 + title + metadata) so skeleton rows
// don't shift the layout when real content lands.
const COMMIT_ROW_HEIGHT_PX = 58;

const skeletonRowCount = (initialCount: number | null | undefined) =>
  Math.max(1, Math.min(initialCount ?? 3, 8));

// Commit bodies are conventionally hard-wrapped at ~72 columns. In the narrow
// dropdown panel those hard breaks collide with the panel's own soft wrapping,
// producing ragged double-wrapped text (issue #10718). Reflow continuation
// prose lines back into their paragraph so soft-wrapping is the only break,
// while preserving structure that depends on its own line breaks: blank lines
// (paragraph separators), list items, indented/code lines, and `Key: value`
// trailers (Co-authored-by:, Signed-off-by:, Fixes:, …). The <pre> keeps
// whitespace-pre-wrap + break-words so long unwrapped lines (e.g. pasted URLs)
// still wrap. Pure, non-throwing, and idempotent.
export function reflowCommitBody(body: string): string {
  if (!body) return body;

  const lines = body.replace(/\r\n?/g, "\n").split("\n");

  const isBlank = (line: string) => line.trim() === "";
  // Lines whose own break is meaningful regardless of context.
  const isAlwaysStructural = (line: string) =>
    /^\s/.test(line) || // indented / code / continuation line
    /^\s*[-*+]\s/.test(line) || // bullet list item
    /^\s*\d+[.)]\s/.test(line) || // numbered list item
    line.startsWith("```"); // fenced code delimiter
  // Trailer-shaped line (`Key: value`, incl. `BREAKING CHANGE:`). Only counts
  // as structural inside a trailer block (see below) so a wrapped prose line
  // that merely starts "Word: …" still reflows.
  const isTrailerShaped = (line: string) =>
    /^[A-Za-z][A-Za-z0-9-]*:\s/.test(line) || /^BREAKING CHANGE:\s/.test(line);

  const out: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push(paragraph.join(" "));
      paragraph = [];
    }
  };

  // A trailer block is a run of `Key: value` lines that begins after a blank
  // line (or at the body start) — matching git's own trailer convention. Mid-
  // paragraph lines that happen to look like trailers are treated as prose.
  let prevBlank = true;
  let inTrailerBlock = false;

  for (const line of lines) {
    if (isBlank(line)) {
      flush();
      out.push(line);
      prevBlank = true;
      inTrailerBlock = false;
      continue;
    }

    const isTrailer = isTrailerShaped(line) && (prevBlank || inTrailerBlock);
    if (isAlwaysStructural(line) || isTrailer) {
      flush();
      out.push(line);
      inTrailerBlock = isTrailer;
    } else {
      paragraph.push(line.replace(/\s+$/, ""));
      inTrailerBlock = false;
    }
    prevBlank = false;
  }
  flush();

  return out.join("\n");
}

function LocalCommitsSkeleton({ count }: { count: number | null | undefined }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="Loading commits">
      <span className="sr-only">Loading commits</span>
      <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
        {Array.from({ length: skeletonRowCount(count) }).map((_, i) => (
          <div
            key={i}
            className="px-3 py-2.5 animate-pulse-delayed box-border"
            style={{ height: `${COMMIT_ROW_HEIGHT_PX}px` }}
          >
            <div className="flex items-start gap-2 h-full">
              <div className="w-4 h-4 rounded-full bg-muted mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="h-5 bg-muted rounded w-3/4" />
                <div className="mt-0.5 flex items-center gap-1.5">
                  <div className="h-4 bg-muted rounded w-16" />
                  <div className="h-4 bg-muted rounded w-20" />
                  <div className="h-4 bg-muted rounded w-12" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface LocalCommitRowProps {
  commit: GitCommit;
  optionId: string;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: (hash: string) => void;
}

function LocalCommitRow({ commit, optionId, isActive, isExpanded, onToggle }: LocalCommitRowProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const trimmedBody = reflowCommitBody(commit.body?.trim() ?? "");
  const hasBody = trimmedBody.length > 0;

  const handleCopyHash = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(commit.hash);
      setCopied(true);
      timeoutRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch (error) {
      logError("Failed to copy commit hash", error);
    }
  };

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={isActive}
      {...(hasBody ? { "aria-expanded": isExpanded } : {})}
      onClick={() => {
        if (hasBody) onToggle(commit.hash);
      }}
      className={cn(
        "hover:bg-muted/50 transition-colors group",
        hasBody ? "cursor-pointer" : "cursor-default",
        isActive && "bg-muted/50"
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        {hasBody ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "shrink-0 mt-0.5 size-4 text-muted-foreground transition-transform duration-150 ease-[var(--ease-out-expo)] motion-reduce:transition-none",
              isExpanded && "rotate-90"
            )}
          />
        ) : (
          <span className="shrink-0 mt-0.5 text-muted-foreground">
            <GitCommitHorizontal className="size-4" />
          </span>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Tooltip autoDismiss={false}>
              <TooltipTrigger asChild>
                <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                  {commit.message}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{commit.message}</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{commit.author.name}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{commit.author.email}</TooltipContent>
            </Tooltip>
            <span>&middot;</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{formatTimeAgo(commit.date)}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {(() => {
                  const d = new Date(commit.date);
                  return isNaN(d.getTime()) ? "Unknown" : d.toLocaleString();
                })()}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyHash}
                  className={cn(
                    "ml-auto shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5 font-mono focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded px-1",
                    copied && "text-status-success"
                  )}
                  aria-label={`Copy hash ${commit.shortHash}`}
                >
                  {copied ? <Check className="w-3 h-3 text-status-success" /> : <span>#</span>}
                  <span>{commit.shortHash}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {copied ? "Copied!" : "Click to copy hash"}
              </TooltipContent>
            </Tooltip>
          </div>

          {hasBody && (
            <div
              aria-hidden={!isExpanded}
              className={cn(
                "grid transition-[grid-template-rows] duration-150 ease-out",
                isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div className="overflow-hidden">
                <pre className="mt-2 rounded-[var(--radius-sm)] bg-surface-inset px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-daintree-text">
                  {trimmedBody}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LocalCommitsDropdown({
  cwd,
  branch,
  open,
  initialCount,
  onClose,
}: LocalCommitsDropdownProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [data, setData] = useState<GitCommit[]>([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(-1);
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic fetch generation. Every fresh (non-append) fetch and every
  // effect teardown bumps it; in-flight requests — including appends — compare
  // their captured generation before touching state, so a late "Load more"
  // can't splice an old page into a newer search's results.
  const fetchGenRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const maxCursor = data.length - 1 + (hasMore ? 1 : 0);
  const activeCommit = cursorIndex >= 0 && cursorIndex < data.length ? data[cursorIndex] : null;
  const activeCommitId = activeCommit ? `local-commit-option-${activeCommit.hash}` : undefined;
  const isLoadMoreActive = hasMore && cursorIndex === data.length;
  const listId = "local-commit-list";

  const toggleCommitExpanded = useCallback((hash: string) => {
    setExpandedHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setExpandedHashes(new Set());
  }, [debouncedSearch, cwd, branch]);

  useEffect(() => {
    if (cursorIndex >= 0) {
      const activeEl = activeCommitId
        ? document.getElementById(activeCommitId)
        : isLoadMoreActive
          ? document.getElementById("local-commit-load-more")
          : null;
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [cursorIndex, activeCommitId, isLoadMoreActive]);

  const fetchData = useCallback(
    async (currentSkip: number, append: boolean) => {
      if (!cwd) return;

      if (append) {
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        fetchGenRef.current += 1;
        loadingMoreRef.current = false;
        setCursorIndex(-1);
        setLoading(true);
        setError(null);
        setLoadMoreError(null);
      }
      const gen = fetchGenRef.current;

      try {
        const result = await window.electron.git.listCommits({
          cwd,
          branch,
          search: debouncedSearch || undefined,
          skip: currentSkip,
          limit: PAGE_SIZE,
        });

        if (gen !== fetchGenRef.current) return;

        if (append) {
          setData((prev) => [...prev, ...result.items]);
        } else {
          setData(result.items);
        }
        setSkip(currentSkip + result.items.length);
        setHasMore(result.hasMore);
      } catch (err) {
        if (gen !== fetchGenRef.current) return;
        const message = formatErrorMessage(err, "Failed to fetch commits");
        if (append) {
          setLoadMoreError(message);
        } else {
          setError(message);
        }
      } finally {
        if (gen === fetchGenRef.current) {
          if (append) loadingMoreRef.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cwd, branch, debouncedSearch]
  );

  // Stale rows from another repo or branch must not linger under the next
  // scope's skeleton or error state. Same-scope search refetches keep the
  // previous results visible while loading instead (matching the provider
  // dropdown's behavior).
  const scopeKey = `${cwd} ${branch ?? ""}`;
  const lastScopeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;

    if (lastScopeRef.current !== null && lastScopeRef.current !== scopeKey) {
      setData([]);
    }
    lastScopeRef.current = scopeKey;

    setSkip(0);
    setHasMore(false);
    void fetchData(0, false);

    return () => {
      fetchGenRef.current += 1;
    };
  }, [open, scopeKey, fetchData]);

  const handleLoadMore = useCallback(() => {
    if (!loadingMoreRef.current && hasMore) {
      void fetchData(skip, true);
    }
  }, [hasMore, fetchData, skip]);

  const handleRetry = () => {
    setSkip(0);
    void fetchData(0, false);
  };

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setCursorIndex((prev) => Math.min(prev + 1, maxCursor));
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setCursorIndex((prev) => Math.max(prev - 1, -1));
          break;
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          if (isLoadMoreActive) {
            handleLoadMore();
          } else if (activeCommit) {
            if (activeCommit.body?.trim()) {
              toggleCommitExpanded(activeCommit.hash);
            } else if (navigator.clipboard) {
              navigator.clipboard.writeText(activeCommit.hash).catch((error: unknown) => {
                logError("Failed to copy commit hash", error);
              });
            }
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
          break;
      }
    },
    [maxCursor, isLoadMoreActive, activeCommit, handleLoadMore, onClose, toggleCommitExpanded]
  );

  const renderError = () => (
    <div className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-muted-foreground bg-overlay-soft">
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-error" />
      <span className="text-xs truncate">{error}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRetry}
        className="ml-auto h-6 text-xs text-muted-foreground hover:text-daintree-text shrink-0"
      >
        <RefreshCw className="h-3 w-3" />
        Retry
      </Button>
    </div>
  );

  const renderEmpty = () => (
    <div className="p-8 text-center text-muted-foreground">
      <p className="text-sm">
        {debouncedSearch ? `No matching commits for "${debouncedSearch}"` : "No commits yet"}
      </p>
    </div>
  );

  return (
    <div className="w-[450px] flex flex-col max-h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] shrink-0">
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-md)]",
            "bg-overlay-soft border border-[var(--border-overlay)]",
            "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
          )}
        >
          <Search
            className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commits..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-activedescendant={activeCommitId}
            aria-label="Search commits"
            className="flex-1 min-w-0 text-sm bg-transparent text-daintree-text placeholder:text-muted-foreground focus:outline-hidden"
          />
        </div>
      </div>

      <div className="overflow-y-auto overscroll-contain flex-1 min-h-0 relative">
        {loading && !data.length && initialCount === 0 && renderEmpty()}
        {/* No skeleton/content crossfade here: that would need framer-motion,
            which is a restricted (eagerly-bundled) import in this statically
            loaded toolbar path. The fixed-height skeleton rows keep the swap
            layout-stable, and FixedDropdown supplies the popover motion. */}
        {loading && !data.length && initialCount !== 0 ? (
          <LocalCommitsSkeleton count={initialCount} />
        ) : data.length > 0 ? (
          <div>
            {error && renderError()}
            <div id={listId} role="listbox" className="divide-y divide-[var(--border-divider)]">
              {data.map((commit, index) => (
                <LocalCommitRow
                  key={commit.hash}
                  commit={commit}
                  optionId={`local-commit-option-${commit.hash}`}
                  isActive={cursorIndex === index}
                  isExpanded={expandedHashes.has(commit.hash)}
                  onToggle={toggleCommitExpanded}
                />
              ))}
            </div>

            {hasMore && (
              <div className="p-3 space-y-2">
                {loadMoreError && (
                  <div className="p-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                    <p className="text-xs text-status-error">{loadMoreError}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadMore}
                      className="mt-1 text-status-error hover:text-status-error/70 h-6 text-xs"
                    >
                      Retry
                    </Button>
                  </div>
                )}
                <Button
                  id="local-commit-load-more"
                  variant="ghost"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className={cn(
                    "w-full text-muted-foreground hover:text-daintree-text",
                    // Neutral cursor highlight, matching the row active state —
                    // the search input's focus-within ring is this popover's one
                    // accent signal (accent-restraint policy).
                    isLoadMoreActive && "bg-muted/50 text-daintree-text"
                  )}
                >
                  {loadingMore ? (
                    <>
                      <RefreshCw className="animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load more"
                  )}
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {!loading && !data.length && error && (
          <div className="p-8 text-center text-muted-foreground">
            <AlertCircle className="h-5 w-5 mx-auto mb-2 text-text-muted" />
            <p className="text-sm">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className="mt-2 text-muted-foreground hover:text-daintree-text"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        {!loading && !error && !data.length && renderEmpty()}
      </div>

      <div className="p-3 border-t border-[var(--border-divider)] flex items-center justify-end shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-muted-foreground hover:text-daintree-text"
        >
          Close
        </Button>
      </div>
    </div>
  );
}
