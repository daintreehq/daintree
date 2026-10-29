import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CircleDot, Link, Link2Off, CircleCheck, RefreshCw } from "lucide-react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Kbd } from "@/components/ui/Kbd";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { useDeferredLoading, useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { forgeClient } from "@/clients";
import type { Issue } from "@shared/types/forge";
import type { WorktreeState } from "@/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { pluralize } from "@/lib/pluralize";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";

interface IssuePickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * What the picker lists issues for and compares the current link against.
   * A worktree card passes its worktree; the New Worktree form, which has no
   * worktree yet, passes the project path and the issue it has picked so far.
   */
  worktree: Pick<WorktreeState, "path" | "issueProviderId" | "issueKey">;
  currentIssueNumber?: number;
  onAttach: (issue: Issue) => void;
  onDetach: () => void;
  /** `"nested"` when opened from inside another dialog, so it layers above it. */
  zIndex?: "modal" | "nested";
  /**
   * Picking for a form that hasn't been submitted yet, so nothing is linked
   * until the form is: the copy talks about a selection, not a link.
   */
  draft?: boolean;
}

type StateFilter = "open" | "closed" | "all";

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const SEARCH_DEBOUNCE_MS = 300;
/** Lets the dialog finish mounting its focus trap before the search takes focus. */
const SEARCH_FOCUS_DELAY_MS = 100;

/** What a result set was fetched for; results only answer the query they were fetched for. */
interface ResultScope {
  query: string;
  state: StateFilter;
}

function scopeNoun(state: StateFilter): string {
  return state === "all" ? "issues" : `${state} issues`;
}

function countLabel(count: number, state: StateFilter): string {
  return pluralize(count, state === "all" ? "issue" : `${state} issue`);
}

/**
 * What the status says about a result set. A page the forge says has more
 * behind it is never announced as the whole set: it names the total when the
 * forge reports one, and says more are available when it doesn't.
 */
function resultsLabel(
  count: number,
  state: StateFilter,
  more: boolean,
  totalCount: number | undefined
): string {
  if (!more) return countLabel(count, state);
  if (totalCount !== undefined && totalCount > count) {
    return `Showing ${count.toLocaleString()} of ${countLabel(totalCount, state)}`;
  }
  return `Showing ${countLabel(count, state)}, more available`;
}

function issueIdentity(issue: Issue): string | number {
  return issue.id ?? issue.key ?? issue.number;
}

/** A later page can repeat a row when issues move between fetches. */
function appendUnique(existing: Issue[], page: Issue[]): Issue[] {
  const seen = new Set(existing.map(issueIdentity));
  const added = page.filter((issue) => {
    const identity = issueIdentity(issue);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return added.length > 0 ? [...existing, ...added] : existing;
}

interface IssueOptionRowProps {
  id: string;
  issue: Issue;
  isActive: boolean;
  isCurrentlyAttached: boolean;
  onPoint: () => void;
  onClick: () => void;
}

function IssueOptionRow({
  id,
  issue,
  isActive,
  isCurrentlyAttached,
  onPoint,
  onClick,
}: IssueOptionRowProps) {
  const { ref, isTruncated } = useTruncationDetection();
  const isOpenIssue = issue.state === "open";

  return (
    <TruncatedTooltip content={issue.title} isTruncated={isTruncated}>
      <button
        id={id}
        type="button"
        role="option"
        aria-selected={isActive}
        // Options are reached through the search field's active descendant,
        // never by Tab: Tab goes from the search to the filter to the footer.
        tabIndex={-1}
        onPointerMove={onPoint}
        // Keep DOM focus in the search field so a click that lands and a
        // keypress after it act on the same cursor.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={cn(
          PALETTE_ROW_CLASS,
          "w-full text-left px-3 py-2 rounded-[var(--radius-md)] flex items-start gap-3"
        )}
      >
        {isOpenIssue ? (
          <CircleDot className="w-4 h-4 text-pr-open shrink-0 mt-0.5" aria-hidden="true" />
        ) : (
          <CircleCheck className="w-4 h-4 text-pr-merged shrink-0 mt-0.5" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span ref={ref} className="text-sm text-text-primary truncate">
              {issue.title}
            </span>
            {isCurrentlyAttached && (
              <Badge size="xs" tone="outline">
                Linked
              </Badge>
            )}
          </span>
          <span className="block text-xs text-text-secondary tabular-nums">
            {issue.key ?? `#${issue.number}`}
            <span className="sr-only">{isOpenIssue ? ", open" : ", closed"}</span>
          </span>
        </span>
      </button>
    </TruncatedTooltip>
  );
}

export function IssuePickerDialog({
  isOpen,
  onClose,
  worktree,
  currentIssueNumber,
  onAttach,
  onDetach,
  zIndex,
  draft = false,
}: IssuePickerDialogProps) {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [resultScope, setResultScope] = useState<ResultScope | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  // Where the next page starts, or null once the forge says there is none.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // The result generation a page is in flight for. Read synchronously, so a
  // second Enter before the next render can't start a second request.
  const loadMoreIdRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0);
  // The last query a fetch was started for. A filter change or a retry re-runs
  // that query at once; only a changed query waits out the typing debounce.
  const requestedQueryRef = useRef("");
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const loadMoreId = `${baseId}-load-more`;

  const fetchIssues = useCallback(
    async (query: string, state: StateFilter) => {
      const id = ++fetchIdRef.current;
      setIsPending(true);
      try {
        const result = await forgeClient.listIssues(worktree.path, {
          search: query || undefined,
          state,
        });
        if (id !== fetchIdRef.current) return;
        setIssues(appendUnique([], result.items));
        setNextCursor(result.hasMore ? result.nextCursor : null);
        setTotalCount(result.totalCount);
        setError(null);
      } catch (e) {
        if (id !== fetchIdRef.current) return;
        setError(formatErrorMessage(e, "Failed to load issues"));
        setIssues([]);
        setNextCursor(null);
        setTotalCount(undefined);
      }
      // A page still in flight belongs to the generation this one replaced and
      // will drop itself on landing; the new set starts with nothing loading.
      setIsLoadingMore(false);
      setLoadMoreFailed(false);
      setResultScope({ query, state });
      setSelectedIndex(0);
      setIsPending(false);
    },
    [worktree.path]
  );

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setStateFilter("open");
      setResultScope(null);
      setIssues([]);
      setNextCursor(null);
      setTotalCount(undefined);
      setIsLoadingMore(false);
      setLoadMoreFailed(false);
      setError(null);
      setIsPending(true);
      setSelectedIndex(0);
      requestedQueryRef.current = "";
      setTimeout(() => inputRef.current?.focus(), SEARCH_FOCUS_DELAY_MS);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const query = search.trim();
    const delay = query === requestedQueryRef.current ? 0 : SEARCH_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      requestedQueryRef.current = query;
      void fetchIssues(query, stateFilter);
    }, delay);
    return () => {
      clearTimeout(timer);
      // Invalidate any in-flight fetch the moment the user's input changes,
      // so a slow response from the prior query can't land under the new one.
      fetchIdRef.current++;
    };
  }, [search, stateFilter, isOpen, reloadToken, fetchIssues]);

  const query = search.trim();
  // Results answer the question on screen only once they were fetched for it.
  // Until then they stay visible (dimmed) but Enter will not act on them.
  const resultsAreCurrent =
    !isPending && resultScope?.query === query && resultScope.state === stateFilter;
  const hasMore = nextCursor !== null;
  // Load more is the list's last option, so the cursor reaches it like a row.
  const optionCount = issues.length + (hasMore ? 1 : 0);
  // Clamped at read time: an appended page that brought nothing new can take
  // the Load more row away from under the cursor.
  const cursor = Math.min(selectedIndex, optionCount - 1);
  const activeIssue = resultsAreCurrent ? issues[cursor] : undefined;
  const isLoadMoreActive = hasMore && cursor === issues.length;
  const showLoadingMore = useDeferredLoading(isLoadingMore, UI_DOHERTY_THRESHOLD);
  const isSlowLoadingMore = useDeferredLoading(isLoadingMore, UI_STILL_WORKING_MS);

  const loadMore = async () => {
    if (!resultsAreCurrent || !resultScope || nextCursor === null) return;
    const id = fetchIdRef.current;
    if (loadMoreIdRef.current === id) return;
    loadMoreIdRef.current = id;
    setIsLoadingMore(true);
    setLoadMoreFailed(false);
    let result: Awaited<ReturnType<typeof forgeClient.listIssues>> | null = null;
    try {
      result = await forgeClient.listIssues(worktree.path, {
        search: resultScope.query || undefined,
        state: resultScope.state,
        cursor: nextCursor,
      });
    } catch {
      result = null;
    }
    if (loadMoreIdRef.current === id) loadMoreIdRef.current = null;
    // A new query, filter, retry or session has replaced the set this page
    // continues; splicing it in would mix two result sets.
    if (id !== fetchIdRef.current) return;
    setIsLoadingMore(false);
    if (!result) {
      setLoadMoreFailed(true);
      return;
    }
    const page = result;
    // The result scope is left alone on purpose: changing it rewinds the
    // scroll, and an appended page continues the list rather than replacing it.
    setIssues((prev) => appendUnique(prev, page.items));
    setNextCursor(page.hasMore ? page.nextCursor : null);
    if (page.totalCount !== undefined) setTotalCount(page.totalCount);
  };

  const retry = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const attach = useCallback(
    (issue: Issue) => {
      onAttach(issue);
      onClose();
    },
    [onAttach, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    // Rows held behind the loading skeleton are not a list to step through yet.
    const next =
      keyBelongsToField(e) || !hasResults ? null : stepListboxCursor(e.key, cursor, optionCount);
    if (next !== null) {
      e.preventDefault();
      setSelectedIndex(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIssue) {
        attach(activeIssue);
      } else if (!resultsAreCurrent) {
        // Typed faster than the debounce: run the query now instead of acting
        // on the previous query's results.
        requestedQueryRef.current = query;
        setReloadToken((n) => n + 1);
      } else if (isLoadMoreActive) {
        void loadMore();
      }
    }
  };

  useEffect(() => {
    const option = scrollRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[cursor];
    option?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // A new result set starts at its top: the cursor resets to the first row, so
  // the viewport must too, or Enter acts on a row scrolled out of sight.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resultScope]);

  const handleDetach = useCallback(() => {
    onDetach();
    onClose();
  }, [onDetach, onClose]);

  // Recovery unmounts Retry. If it still held focus then, hand focus back to
  // the search rather than dropping it on the document.
  const retryHasFocusRef = useRef(false);
  useEffect(() => {
    if (error || !retryHasFocusRef.current) return;
    retryHasFocusRef.current = false;
    inputRef.current?.focus();
  }, [error]);

  const clearSearch = () => {
    setSearch("");
    inputRef.current?.focus();
  };

  const showAll = () => {
    setStateFilter("all");
    inputRef.current?.focus();
  };

  const isInitialLoad = isPending && issues.length === 0 && !error;
  const showSkeleton = useSkeletonDisplayFloor(isInitialLoad);
  const hasResults = !showSkeleton && !error && issues.length > 0;

  const shownScope = resultScope ?? { query, state: stateFilter };
  const status = !resultScope
    ? ""
    : error
      ? "Couldn't load issues"
      : issues.length === 0
        ? shownScope.query
          ? `No ${scopeNoun(shownScope.state)} match "${shownScope.query}"`
          : `No ${scopeNoun(shownScope.state)}`
        : loadMoreFailed
          ? "Couldn't load more issues"
          : resultsLabel(issues.length, shownScope.state, hasMore, totalCount);

  const isLinked = currentIssueNumber !== undefined && currentIssueNumber > 0;

  // Only where Enter will do what the hint says: on Load more, a stale list
  // makes Enter re-run the search and a page in flight makes it do nothing.
  const enterHint =
    isLinked || !hasResults
      ? null
      : !isLoadMoreActive
        ? draft
          ? "to select"
          : "to link"
        : !resultsAreCurrent || isLoadingMore
          ? null
          : loadMoreFailed
            ? "to retry"
            : "to load more";

  let body: React.ReactNode;
  if (showSkeleton) {
    body = (
      <>
        <Skeleton label="Loading issues" className="space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="px-3 py-2 flex items-start gap-3">
              <SkeletonBone className="w-4 h-4 rounded-full shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
                <SkeletonBone className={cn("h-4", i % 2 === 0 ? "w-3/4" : "w-1/2")} />
                <SkeletonBone className="h-3 w-12" />
              </div>
            </div>
          ))}
        </Skeleton>
        <SkeletonHint firstThreshold={UI_STILL_WORKING_MS} onRetry={retry} className="px-3" />
      </>
    );
  } else if (error) {
    body = (
      <div
        aria-busy={isPending || undefined}
        className="flex flex-col items-center gap-1 px-6 py-10 text-center"
      >
        <p className="text-sm font-medium text-text-primary">Couldn't load issues</p>
        <p className="text-xs text-text-secondary max-w-sm break-words">{error}</p>
        <Button
          variant="outline"
          size="xs"
          className="mt-3"
          onClick={retry}
          onFocus={() => {
            retryHasFocusRef.current = true;
          }}
          // A blur with somewhere to go is the user moving on; one without is
          // the button being removed, which is the case the handoff exists for.
          onBlur={(event) => {
            if (event.relatedTarget) retryHasFocusRef.current = false;
          }}
        >
          Retry
        </Button>
      </div>
    );
  } else if (issues.length === 0) {
    const scope = shownScope;
    body = scope.query ? (
      <EmptyState
        variant="filtered-empty"
        scale="popover"
        title={`No ${scopeNoun(scope.state)} match "${scope.query}"`}
        action={
          <div className="flex items-center justify-center gap-2">
            {scope.state !== "all" && (
              <Button variant="outline" size="xs" onClick={showAll}>
                Search all issues
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={clearSearch}>
              Clear search
            </Button>
          </div>
        }
      />
    ) : (
      <EmptyState
        variant="zero-data"
        scale="popover"
        title={
          scope.state === "all" ? "This repository has no issues yet" : `No ${scope.state} issues`
        }
        action={
          scope.state !== "all" ? (
            <Button variant="outline" size="xs" onClick={showAll}>
              Show all issues
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div
        id={listboxId}
        className={cn("space-y-0.5", !resultsAreCurrent && "surface-stale")}
        role="listbox"
        aria-label="Issues"
        data-stale={resultsAreCurrent ? undefined : "true"}
        aria-busy={resultsAreCurrent ? undefined : true}
      >
        {issues.map((issue, index) => (
          <IssueOptionRow
            key={issue.id ?? issue.key ?? issue.number}
            id={optionId(index)}
            issue={issue}
            isActive={index === cursor}
            // Same number and same owner (#13744): a tracker's ENG-42 isn't the
            // code forge's #42 the worktree is linked to.
            isCurrentlyAttached={
              issue.number === currentIssueNumber &&
              (issue.providerId ?? undefined) === (worktree.issueProviderId ?? undefined) &&
              (worktree.issueKey === undefined || issue.key === worktree.issueKey)
            }
            onPoint={() => {
              if (index !== cursor) setSelectedIndex(index);
            }}
            onClick={() => attach(issue)}
          />
        ))}
        {hasMore && (
          <button
            id={loadMoreId}
            type="button"
            role="option"
            aria-selected={isLoadMoreActive}
            aria-disabled={isLoadingMore || undefined}
            tabIndex={-1}
            onPointerMove={() => {
              if (!isLoadMoreActive) setSelectedIndex(issues.length);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void loadMore()}
            className={cn(
              PALETTE_ROW_CLASS,
              "w-full px-3 py-1.5 rounded-[var(--radius-md)] flex items-center justify-center gap-2",
              "text-sm text-text-secondary"
            )}
          >
            {loadMoreFailed ? (
              // One way on, not two: the row that failed is the row that retries.
              <>
                <span>Couldn&apos;t load more issues</span>
                <span aria-hidden="true">·</span>
                <span className="flex items-center gap-1.5 text-text-primary">
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  Retry
                </span>
              </>
            ) : showLoadingMore ? (
              <>
                <Spinner size="sm" />
                {isSlowLoadingMore ? "Still working…" : "Loading…"}
              </>
            ) : (
              "Load more"
            )}
          </button>
        )}
      </div>
    );
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      zIndex={zIndex}
      size="md"
      maxHeight="max-h-[70vh]"
      // A fixed height keeps the search field still while the body swaps
      // between results, loading, empty and error.
      className="h-[min(40rem,70vh)]"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Link className="w-4 h-4 text-text-secondary" />}>
          {draft
            ? isLinked
              ? "Change selected issue"
              : "Select issue"
            : isLinked
              ? "Change linked issue"
              : "Attach issue"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div className="px-6 pt-4 pb-3 space-y-3 shrink-0">
        <SearchField
          size="palette"
          inputRef={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch("")}
          // "Clear", not the family default: the no-match state below owns
          // "Clear search", and two buttons with one name are indistinguishable.
          clearLabel="Clear"
          onKeyDown={handleKeyDown}
          placeholder="Search issues by title or number…"
          aria-label="Search issues"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasResults}
          aria-controls={hasResults ? listboxId : undefined}
          aria-activedescendant={
            !hasResults ? undefined : isLoadMoreActive ? loadMoreId : optionId(cursor)
          }
        />

        <SegmentedRadioGroup
          options={STATE_OPTIONS}
          value={stateFilter}
          onChange={setStateFilter}
          aria-label="Issue state"
        />
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto min-h-0 dialog-body-inset pb-4 scroll-py-2"
      >
        {body}
      </div>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {status}
      </div>

      <AppDialog.Footer
        hint={
          enterHint && (
            <>
              <Kbd>↵</Kbd>
              <span>{enterHint}</span>
            </>
          )
        }
      >
        {isLinked && (
          <Button variant="ghost" onClick={handleDetach} className="text-text-secondary mr-auto">
            <Link2Off aria-hidden="true" />
            {draft
              ? "Clear selection"
              : `Unlink issue ${worktree.issueKey ?? `#${currentIssueNumber}`}`}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose} className="text-text-secondary">
          Cancel
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
