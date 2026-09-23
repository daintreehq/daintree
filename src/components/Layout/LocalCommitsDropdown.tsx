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
  ArrowUp,
  GitCommitHorizontal,
  Check,
  ChevronRight,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { KbdChord } from "@/components/ui/Kbd";
import { SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { useDebounce } from "@/hooks/useDebounce";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { formatTimeAgo } from "@/utils/timeAgo";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { classifyGitError, getGitRecoveryHint } from "@shared/utils/gitOperationErrors";
import { logError } from "@/utils/logger";
import type { GitCommit, GitPushCommitPreview } from "@shared/types/git";

// Local-git fallback for the commits pill dropdown (issue #10414). Commit
// history is local git data, not forge data, so the pill can open a list even
// when no forge provider supplies a stats dropdown view. Self-contained: owns
// its fetch, search, pagination, and keyboard navigation; FixedDropdown (via
// ForgeStatPill) owns the portal, positioning, and dismiss behavior.
//
// Chrome follows the forge issue/PR dropdowns: a fixed
// 450×500 panel, the search shell as the region's one accent, a grid popup so
// rows may carry a control, and a neutral cursor ladder with a leading rail.

interface LocalCommitsDropdownProps {
  cwd: string;
  branch?: string;
  open: boolean;
  initialCount?: number | null;
  onClose?: () => void;
}

const PAGE_SIZE = 30;
const COPY_FEEDBACK_MS = 2000;
// The push range read is capped in main; the rows it names are the only ones
// this list marks. A row outside it is never called "pushed".
const PUSH_RANGE_LIMIT = 100;

// Mirrors a rendered commit row (py-2.5 + title + metadata) so skeleton rows
// don't shift the layout when real content lands.
const COMMIT_ROW_HEIGHT_PX = 58;

const LIST_ID = "local-commit-list";
const LOAD_MORE_ID = "local-commit-load-more";
const optionIdFor = (hash: string) => `local-commit-row-${hash}`;

const skeletonRowCount = (initialCount: number | null | undefined) =>
  Math.max(1, Math.min(initialCount ?? 3, 8));

type PushStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; preview: GitPushCommitPreview; hashes: Set<string> }
  | { kind: "no-destination" }
  | { kind: "failed" };

/**
 * What git said, without the transport around it. Electron prefixes every
 * rejected invoke with "Error invoking remote method '<channel>': Error: ",
 * which is plumbing, not information.
 */
function describeReadError(error: unknown, fallback: string): string {
  const reason = classifyGitError(error);
  if (reason === "not-a-repository") return "This folder isn't a Git repository";
  const hint = reason === "unknown" ? undefined : getGitRecoveryHint(reason);
  if (hint) return hint;
  const cleaned = formatErrorMessage(error, fallback)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^(?:Error: )+/, "")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 140 ? `${cleaned.slice(0, 139)}…` : cleaned;
}

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
  const isFenceDelimiter = (line: string) => line.startsWith("```");
  // Lines whose own break is meaningful regardless of context. (Fence
  // delimiters and fenced content are handled separately via inFence below.)
  const isAlwaysStructural = (line: string) =>
    /^\s/.test(line) || // indented / code / continuation line
    /^\s*[-*+]\s/.test(line) || // bullet list item
    /^\s*\d+[.)]\s/.test(line); // numbered list item
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
  // Track whether we're between fence delimiters. Inside a fence every line is
  // verbatim code — even unindented ones — so it must not join the paragraph
  // buffer the way a wrapped prose line would.
  let inFence = false;

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      flush();
      out.push(line);
      inFence = !inFence;
      prevBlank = false;
      inTrailerBlock = false;
      continue;
    }

    if (inFence) {
      flush();
      out.push(line);
      prevBlank = false;
      inTrailerBlock = false;
      continue;
    }

    if (isBlank(line)) {
      flush();
      out.push(line);
      prevBlank = true;
      inTrailerBlock = false;
      continue;
    }

    const isTrailer: boolean = isTrailerShaped(line) && (prevBlank || inTrailerBlock);
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
    <div aria-hidden="true" className="divide-y divide-[var(--border-divider)]">
      {Array.from({ length: skeletonRowCount(count) }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-3 py-2.5 box-border"
          style={{ height: `${COMMIT_ROW_HEIGHT_PX}px` }}
        >
          <SkeletonBone className="size-4 mt-0.5 shrink-0 rounded-full" />
          <div className="flex-1 min-w-0">
            <SkeletonBone className="h-5 w-3/4 rounded-[var(--radius-sm)]" />
            <div className="mt-0.5 flex items-center gap-1.5">
              <SkeletonBone className="h-4 w-20 rounded-[var(--radius-sm)]" />
              <SkeletonBone className="h-4 w-12 rounded-[var(--radius-sm)]" />
              <SkeletonBone className="ml-auto h-4 w-14 rounded-[var(--radius-sm)]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface LocalCommitRowProps {
  commit: GitCommit;
  rowIndex: number;
  isActive: boolean;
  isExpanded: boolean;
  isUnpushed: boolean;
  isCopied: boolean;
  onToggle: (hash: string) => void;
  onCopy: (commit: GitCommit) => void;
}

function LocalCommitRow({
  commit,
  rowIndex,
  isActive,
  isExpanded,
  isUnpushed,
  isCopied,
  onToggle,
  onCopy,
}: LocalCommitRowProps) {
  const trimmedBody = reflowCommitBody(commit.body?.trim() ?? "");
  const hasBody = trimmedBody.length > 0;

  const handleCopyHash = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onCopy(commit);
  };

  return (
    /* A row, not an option: `option` admits no interactive descendants and the
       hash is a control. The input keeps DOM focus and points
       `aria-activedescendant` here, as in the forge issue/PR grid. */
    <div
      id={optionIdFor(commit.hash)}
      role="row"
      aria-rowindex={rowIndex}
      data-active={isActive ? "true" : undefined}
      {...(hasBody ? { "aria-expanded": isExpanded } : {})}
      // Keeps DOM focus in the search input so the arrow keys still drive the
      // list after a click — except inside the body, where the press starts a
      // text selection.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element) || !e.target.closest("pre")) e.preventDefault();
      }}
      onClick={() => {
        if (hasBody) onToggle(commit.hash);
      }}
      className={cn(
        "forge-row group relative select-none transition-colors duration-150 ease-out",
        // Nearest-scrolling stops clear of the 32px scroll fades, so the row
        // under the cursor is never the one being washed out.
        "scroll-my-8",
        hasBody ? "cursor-pointer" : "cursor-default",
        // The forge rows' neutral ladder: hover is the lightest fill, the
        // keyboard cursor adds a heavier fill plus the leading rail, which is
        // what carries 1.4.11 — the fill alone cannot on these surfaces.
        "hover:bg-overlay-subtle",
        isActive && "bg-overlay-soft hover:bg-overlay-soft",
        "before:absolute before:inset-y-1.5 before:-start-px before:w-[3px] before:rounded-full",
        "before:bg-selection-outline before:opacity-0 before:transition-opacity before:duration-150",
        "before:content-[''] before:pointer-events-none",
        isActive && "before:opacity-100"
      )}
    >
      <div role="gridcell" className="flex items-start gap-2 px-3 py-2.5">
        {hasBody ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "shrink-0 mt-0.5 size-4 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
              isExpanded && "rotate-90"
            )}
          />
        ) : (
          <GitCommitHorizontal
            aria-hidden="true"
            className="shrink-0 mt-0.5 size-4 text-text-secondary"
          />
        )}

        <div className="flex-1 min-w-0">
          {isExpanded || isActive ? (
            // Under the cursor or expanded, the whole subject is on screen:
            // the tooltip is pointer-only, and a bodyless commit has no
            // expansion to read it through.
            <p className="text-sm font-medium text-text-primary break-words">{commit.message}</p>
          ) : (
            <Tooltip autoDismiss={false}>
              <TooltipTrigger asChild>
                <p className="text-sm font-medium text-text-primary truncate">{commit.message}</p>
              </TooltipTrigger>
              <TooltipContent side="bottom">{commit.message}</TooltipContent>
            </Tooltip>
          )}

          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-xs text-text-secondary">
            {isUnpushed && (
              <>
                <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-text-primary">
                  <ArrowUp aria-hidden="true" className="size-3" />
                  Not pushed
                </span>
                <span aria-hidden="true">&middot;</span>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="truncate">{commit.author.name}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{commit.author.email}</TooltipContent>
            </Tooltip>
            <span aria-hidden="true">&middot;</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0">{formatTimeAgo(commit.date)}</span>
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
                  tabIndex={-1}
                  // Chromium focuses a native button on press even at tabIndex
                  // -1, which would pull focus out of the search input and leave
                  // the arrow keys bound to nothing.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleCopyHash}
                  className={cn(
                    "ml-auto shrink-0 flex items-center gap-1 px-1 font-mono text-xs text-text-secondary hover:text-text-primary transition-colors duration-150 ease-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-[var(--radius-sm)]",
                    isCopied && "text-text-primary"
                  )}
                  aria-label={`Copy hash ${commit.shortHash}`}
                >
                  {isCopied ? (
                    <Check aria-hidden="true" className="size-3 text-status-success" />
                  ) : null}
                  <span>{commit.shortHash}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{isCopied ? "Copied" : "Copy hash"}</TooltipContent>
            </Tooltip>
          </div>

          {hasBody && (
            <div
              aria-hidden={!isExpanded}
              className={cn(
                "grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
                isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div className="overflow-hidden">
                <pre className="mt-2 rounded-[var(--radius-sm)] bg-surface-inset px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-text-primary select-text cursor-text">
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

/**
 * The footer's one line about the remote, worded as what git reported. It
 * never says "up to date": a tracking ref is only as fresh as the last fetch.
 */
function PushSummary({ status }: { status: PushStatus }) {
  if (status.kind === "idle" || status.kind === "loading") return null;
  if (status.kind === "no-destination") {
    return <span className="truncate">No push destination for this branch</span>;
  }
  if (status.kind === "failed") {
    return <span className="truncate">Couldn't read push status</span>;
  }
  const { preview } = status;
  const target = `${preview.destination.remote}/${preview.destination.branch}`;
  // Main caps the returned rows; past the cap the rows below go unmarked, and
  // the footer has to say so rather than let the boundary pass for the remote's.
  const capped = preview.total > status.hashes.size && preview.rangeBasis !== "unverified";
  if (preview.rangeBasis === "creates") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        <ArrowUp aria-hidden="true" className="size-3 shrink-0 text-text-primary" />
        <span className="truncate">
          <span className="font-medium text-text-primary">{preview.total} not pushed</span>
          {" · "}
          {target} doesn't exist yet{capped ? ` · newest ${status.hashes.size} marked` : ""}
        </span>
      </span>
    );
  }
  if (preview.rangeBasis === "unverified") {
    return <span className="truncate">Couldn't verify what {target} has</span>;
  }
  if (preview.total === 0) {
    return <span className="truncate">Nothing to push to {target}</span>;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <ArrowUp aria-hidden="true" className="size-3 shrink-0 text-text-primary" />
      <span className="truncate">
        <span className="font-medium text-text-primary">{preview.total} not pushed</span> to{" "}
        {target}
        {capped ? ` · newest ${status.hashes.size} marked` : ""}
      </span>
    </span>
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
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const copyTimeoutRef = useRef<number | undefined>(undefined);
  // Monotonic fetch generation. Every fresh (non-append) fetch and every
  // effect teardown bumps it; in-flight requests — including appends — compare
  // their captured generation before touching state, so a late "Load more"
  // can't splice an old page into a newer search's results.
  const fetchGenRef = useRef(0);
  const pushGenRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const debouncedSearch = useDebounce(searchQuery, 300);
  const showLoadingMore = useDeferredLoading(loadingMore, UI_DOHERTY_THRESHOLD);
  const isSlowLoadingMore = useDeferredLoading(loadingMore, UI_STILL_WORKING_MS);
  const { ref: scrollShadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();

  const maxCursor = data.length - 1 + (hasMore ? 1 : 0);
  const activeCommit = cursorIndex >= 0 && cursorIndex < data.length ? data[cursorIndex] : null;
  const isLoadMoreActive = hasMore && cursorIndex === data.length;
  const activeDescendantId = activeCommit
    ? optionIdFor(activeCommit.hash)
    : isLoadMoreActive
      ? LOAD_MORE_ID
      : undefined;
  const unpushedHashes = pushStatus.kind === "ready" ? pushStatus.hashes : null;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

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

  const copyHash = useCallback((commit: GitCommit) => {
    const settle = (copied: boolean) => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      setCopiedHash(copied ? commit.hash : null);
      setCopyFailed(!copied);
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedHash(null);
        setCopyFailed(false);
      }, COPY_FEEDBACK_MS);
    };
    if (!navigator.clipboard) {
      settle(false);
      return;
    }
    navigator.clipboard.writeText(commit.hash).then(
      () => settle(true),
      (err: unknown) => {
        logError("Failed to copy commit hash", err);
        settle(false);
      }
    );
  }, []);

  useEffect(() => {
    setExpandedHashes(new Set());
  }, [debouncedSearch, cwd, branch]);

  useEffect(() => {
    if (activeDescendantId) {
      document.getElementById(activeDescendantId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeDescendantId]);

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
        const message = describeReadError(err, "Git didn't answer.");
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

  // Push status is read once per open and scope, not per search: it describes
  // the branch, not the query.
  const fetchPushStatus = useCallback(async () => {
    pushGenRef.current += 1;
    const gen = pushGenRef.current;
    if (!cwd || !branch) {
      setPushStatus({ kind: "idle" });
      return;
    }
    setPushStatus({ kind: "loading" });
    try {
      const preview = await window.electron.git.listPushCommits(cwd, branch, PUSH_RANGE_LIMIT);
      if (gen !== pushGenRef.current) return;
      setPushStatus({
        kind: "ready",
        preview,
        // An unverified range is a local approximation that can overstate, so
        // it marks no rows; only the footer says what was and wasn't checked.
        hashes:
          preview.rangeBasis === "unverified"
            ? new Set()
            : new Set(preview.commits.map((c) => c.hash)),
      });
    } catch (err) {
      if (gen !== pushGenRef.current) return;
      setPushStatus(
        classifyGitError(err) === "config-missing" ? { kind: "no-destination" } : { kind: "failed" }
      );
    }
  }, [cwd, branch]);

  // Stale rows from another repo or branch must not linger under the next
  // scope's skeleton or error state. Same-scope search refetches keep the
  // previous results visible while loading instead (matching the provider
  // dropdown's behavior).
  const scopeKey = `${cwd} ${branch ?? ""}`;
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

  useEffect(() => {
    if (!open) return;
    void fetchPushStatus();
    return () => {
      pushGenRef.current += 1;
    };
  }, [open, fetchPushStatus]);

  const handleLoadMore = useCallback(() => {
    if (!loadingMoreRef.current && hasMore) {
      void fetchData(skip, true);
    }
  }, [hasMore, fetchData, skip]);

  const handleRetry = useCallback(() => {
    setSkip(0);
    void fetchData(0, false);
    inputRef.current?.focus();
  }, [fetchData]);

  const handleClearSearch = () => {
    setSearchQuery("");
    inputRef.current?.focus();
  };

  // A failed page replaces Load more with Retry in the same slot; bring it
  // into view so the recovery is where the eye already is.
  useEffect(() => {
    if (loadMoreError) {
      document.getElementById(LOAD_MORE_ID)?.scrollIntoView({ block: "nearest" });
    }
  }, [loadMoreError]);

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
          if (error && !data.length) {
            handleRetry();
          } else if (isLoadMoreActive) {
            handleLoadMore();
          } else if (activeCommit) {
            if (!e.shiftKey && activeCommit.body?.trim()) {
              toggleCommitExpanded(activeCommit.hash);
            } else {
              copyHash(activeCommit);
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
    [
      error,
      data.length,
      handleRetry,
      maxCursor,
      isLoadMoreActive,
      activeCommit,
      handleLoadMore,
      onClose,
      toggleCommitExpanded,
      copyHash,
    ]
  );

  const trimmedSearch = debouncedSearch.trim();
  const showSkeleton = loading && !data.length;
  // The branch-level line waits for the list it describes, and stands down
  // when the history read failed with nothing to show.
  const showPushSummary = !loading && data.length > 0;

  const renderEmpty = () =>
    trimmedSearch ? (
      <EmptyState
        variant="filtered-empty"
        scale="canvas"
        title={`No commits match “${trimmedSearch}”`}
        description="Search matches commit messages and hashes"
        action={
          <Button variant="ghost" size="sm" onClick={handleClearSearch}>
            Clear search
          </Button>
        }
        className="flex-1 justify-center"
      />
    ) : (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<GitCommitHorizontal />}
        title="No commits on this branch yet"
        description="Commit a change and it shows up here"
        className="flex-1 justify-center"
      />
    );

  const loadMoreRowIndex = data.length + 1;

  return (
    <div className="relative w-[450px] flex flex-col h-[500px]">
      <div className="p-3 border-b border-[var(--border-divider)] shrink-0">
        <div
          className={cn(
            "flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--radius-md)]",
            "bg-overlay-soft border border-[var(--border-overlay)]",
            // Full-strength accent, and only here: the search input is this
            // region's single focus anchor.
            "transition-[border-color] duration-150 ease-out",
            "focus-within:border-accent-primary"
          )}
        >
          <Search
            className="w-3.5 h-3.5 shrink-0 text-text-secondary pointer-events-none"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commits…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-haspopup="grid"
            aria-controls={LIST_ID}
            aria-activedescendant={activeDescendantId}
            aria-label="Search commits"
            aria-keyshortcuts="ArrowDown ArrowUp Enter Shift+Enter Escape"
            className="flex-1 min-w-0 text-sm bg-transparent text-text-primary placeholder:text-text-secondary focus:outline-hidden"
          />
          {searchQuery && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClearSearch}
              aria-label="Clear search"
              className="flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] shrink-0 text-text-secondary hover:text-text-primary transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Outside the grid, whose aria-busy would hold the announcement back.
          Errors are alerts of their own, so they stay out of here. */}
      <span role="status" aria-live="polite" className="sr-only">
        {loading
          ? "Loading commits…"
          : copyFailed
            ? "Couldn't copy hash"
            : copiedHash
              ? "Hash copied"
              : !error && data.length === 0
                ? trimmedSearch
                  ? "No matching commits"
                  : "No commits"
                : loadingMore
                  ? "Loading more commits…"
                  : ""}
      </span>

      {/* The combobox points `aria-controls` here, so it exists in every state
          — loading, empty and failed included. */}
      <div
        id={LIST_ID}
        role="grid"
        aria-label="Commits"
        aria-busy={loading || loadingMore}
        aria-rowcount={hasMore ? -1 : data.length}
        className="flex-1 min-h-0 flex flex-col relative"
      >
        {showSkeleton ? (
          <div className="overflow-hidden flex-1 min-h-0 flex flex-col">
            <LocalCommitsSkeleton count={initialCount} />
            <SkeletonHint
              firstThreshold={UI_STILL_WORKING_MS}
              message="Still working…"
              onRetry={handleRetry}
              className="px-3 py-2"
            />
          </div>
        ) : data.length > 0 ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {error && (
              <div
                role="alert"
                className="px-3 py-2 border-b border-[var(--border-divider)] flex items-center gap-2 text-text-secondary bg-overlay-soft shrink-0"
              >
                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="text-xs truncate">
                  Couldn&apos;t refresh commits &middot; {error}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRetry}
                  className="ml-auto h-6 text-xs shrink-0"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry
                </Button>
              </div>
            )}
            <div role="rowgroup" className="relative flex-1 min-h-0">
              {topShadow}
              {bottomShadow}
              <div ref={scrollShadowRef} className="h-full overflow-y-auto overscroll-contain">
                <div>
                  <div className="divide-y divide-[var(--border-divider)]">
                    {data.map((commit, index) => (
                      <LocalCommitRow
                        key={commit.hash}
                        commit={commit}
                        rowIndex={index + 1}
                        isActive={cursorIndex === index}
                        isExpanded={expandedHashes.has(commit.hash)}
                        isUnpushed={unpushedHashes?.has(commit.hash) ?? false}
                        isCopied={copiedHash === commit.hash}
                        onToggle={toggleCommitExpanded}
                        onCopy={copyHash}
                      />
                    ))}
                  </div>

                  {hasMore && (
                    <div
                      id={LOAD_MORE_ID}
                      role="row"
                      aria-rowindex={loadMoreRowIndex}
                      data-active={isLoadMoreActive ? "true" : undefined}
                      className={cn(
                        "forge-row relative scroll-my-8 border-t border-[var(--border-divider)] p-2",
                        // The same rail as a commit row: the fill alone can't
                        // carry 3:1, and this is where the cursor lands last.
                        "before:absolute before:inset-y-1.5 before:-start-px before:w-[3px] before:rounded-full",
                        "before:bg-selection-outline before:opacity-0 before:transition-opacity before:duration-150",
                        "before:content-[''] before:pointer-events-none",
                        isLoadMoreActive && "before:opacity-100"
                      )}
                    >
                      <div role="gridcell">
                        {loadMoreError ? (
                          // One way out, not two: Retry takes Load more's place.
                          <div className="flex items-center gap-2 px-1">
                            <AlertCircle
                              className="h-3.5 w-3.5 shrink-0 text-text-secondary"
                              aria-hidden="true"
                            />
                            <p role="alert" className="flex-1 min-w-0 text-xs text-text-secondary">
                              Couldn&apos;t load more commits &middot; {loadMoreError}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={handleLoadMore}
                              className={cn(
                                "h-6 text-xs shrink-0",
                                isLoadMoreActive && "bg-overlay-soft text-text-primary"
                              )}
                            >
                              <RefreshCw className="h-3 w-3" />
                              Retry
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className={cn(
                              "w-full",
                              // Neutral, like the row cursor — the search field
                              // keeps the region's one accent.
                              isLoadMoreActive && "bg-overlay-soft text-text-primary"
                            )}
                          >
                            {showLoadingMore ? (
                              <>
                                <RefreshCw className="animate-spin" />
                                {isSlowLoadingMore ? "Still working…" : "Loading…"}
                              </>
                            ) : (
                              "Load more"
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!loading && !data.length && error && (
          <div role="alert" className="contents">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<AlertCircle />}
              title="Couldn't load commits"
              description={error}
              action={
                <Button variant="ghost" size="sm" onClick={handleRetry}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              }
              className="flex-1 justify-center"
            />
          </div>
        )}
        {!loading && !error && !data.length && renderEmpty()}
      </div>

      <div className="px-3 h-9 border-t border-[var(--border-divider)] flex items-center gap-3 shrink-0 text-xs text-text-secondary">
        <div className="flex-1 min-w-0 flex items-center">
          {showPushSummary && <PushSummary status={pushStatus} />}
        </div>
        {copyFailed ? (
          <span className="shrink-0 whitespace-nowrap">Couldn&apos;t copy hash</span>
        ) : activeCommit ? (
          <span
            className="shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap"
            aria-hidden="true"
          >
            <KbdChord shortcut="Shift+Enter" />
            Copy hash
          </span>
        ) : null}
      </div>
    </div>
  );
}
