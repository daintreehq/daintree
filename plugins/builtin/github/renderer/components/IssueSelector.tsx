import { useState, useEffect, useRef } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useListboxCursor } from "@/hooks/useListboxCursor";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import {
  Button,
  Callout,
  EmptyState,
  Icon,
  PopoverSearchField,
  ScrollShadow,
  Spinner,
  Tooltip,
} from "@daintreehq/plugin-ui";
import { cn } from "@/lib/utils";
import { forgeClient } from "@/clients/forgeClient";
import type { Issue } from "@shared/types/forge";
import type { ForgeIssueSelectorProps } from "@/types/forgeSlotProps";
// The host popover: the panel anchors to the whole compound field (trigger and
// clear), not the trigger alone, and it owns its open focus and Escape. The kit
// Popover has no anchor and neither handler.
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { FIELD_SURFACE } from "@/components/Worktree/views/WorktreeFormLayout";
import { FORGE_OPTION_ROW, ForgeOptionRowsSkeleton } from "./GitHubDropdownSkeletons";
import { logError } from "@/utils/logger";

/** Conforms to the host's issue-selector slot contract (forge-normalized shapes). */
export type IssueSelectorProps = ForgeIssueSelectorProps;

const LIST_ID = "issue-list";
const OPTION_ID_PREFIX = "issue-option-";

/** A later page can repeat a row when issues move between fetches. */
function appendUnique(existing: Issue[], page: Issue[]): Issue[] {
  const seen = new Set(existing.map((issue) => issue.number));
  const added = page.filter((issue) => {
    if (seen.has(issue.number)) return false;
    seen.add(issue.number);
    return true;
  });
  return added.length > 0 ? [...existing, ...added] : existing;
}

/**
 * The forge's contribution to the create-worktree form's "Issue" row.
 *
 * It sits directly under two branch pickers built on the same model, so it
 * takes the same chrome (`FIELD_SURFACE`), the same search field, the same
 * palette rows and the same keyboard contract. It used to be the odd one out on
 * all four: a differently-styled `outline` button, a panel pinned at 400px next
 * to trigger-width siblings, rows with no cursor, and a search box that was
 * never focused — so opening the list and typing did nothing at all.
 */
export function IssueSelector({
  projectPath,
  selectedIssue,
  onSelect,
  disabled,
}: IssueSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  // A failed load is its own state, not an empty one. Without it, a rejected
  // request rendered "No open issues" — a claim about the repo this component
  // has no grounds to make — and a failed refetch left the previous rows
  // looking current.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  // Where the next page starts, or null once the forge says there is none. The
  // provider hands back one page at a time, so without this a long backlog
  // read as if its first page were all of it (#15014).
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // The fetch run that produced the rows on screen. A close, a new query, a
  // new project or a retry aborts it, and with it any page continuing its set.
  const runRef = useRef<AbortController | null>(null);
  // The run a page is in flight for, read synchronously so a second Enter
  // before the next render can't start a second request.
  const loadMoreRunRef = useRef<AbortController | null>(null);
  const debouncedQuery = useDebounce(query, 300);
  // The query the fetch runs for. It follows the debounce once that settles on
  // what is typed, and an early Enter sets it at once. It never steps back to
  // an older debounced value, so a flushed "ab" stays put while "abc" is typed.
  const [requestedQuery, setRequestedQuery] = useState("");
  // The query and project the rows on screen were fetched for, set only when a
  // first page lands. Enter acts on the rows only while this matches what is
  // typed: until then they answer an earlier search.
  const [resultScope, setResultScope] = useState<{ query: string; projectPath: string } | null>(
    null
  );
  const requestGenRef = useRef(0);
  const prevProjectPathRef = useRef(projectPath);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && debouncedQuery === query) setRequestedQuery(query);
  }, [open, query, debouncedQuery]);

  useEffect(() => {
    if (prevProjectPathRef.current !== projectPath) {
      prevProjectPathRef.current = projectPath;
      setIssues([]);
      setNextCursor(null);
      setResultScope(null);
    }
    if (!open) return;

    const abortController = new AbortController();
    runRef.current = abortController;
    const gen = ++requestGenRef.current;
    setLoading(true);
    setLoadFailed(false);
    setLoadingMore(false);
    setLoadMoreFailed(false);
    forgeClient
      .listIssues(projectPath, {
        state: "open",
        search: requestedQuery || undefined,
      })
      .then((res) => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setIssues(appendUnique([], res.items));
          setNextCursor(res.hasMore ? res.nextCursor : null);
          setResultScope({ query: requestedQuery, projectPath });
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setLoadFailed(true);
          // The rows left on screen answer an earlier query; their next page
          // would continue a set this request was meant to replace.
          setNextCursor(null);
          logError("Failed to fetch issues", err);
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setLoading(false);
        }
      });

    return () => abortController.abort();
  }, [open, requestedQuery, projectPath, retryTick]);

  const resultsAreCurrent =
    !loading &&
    !loadFailed &&
    resultScope?.query === query &&
    resultScope.projectPath === projectPath;

  // Enter typed faster than the search: run the query on screen now, or let the
  // request already running for it land, rather than act on older rows.
  const runTypedQuery = () => {
    if (requestedQuery !== query) setRequestedQuery(query);
    else if (!loading) setRetryTick((tick) => tick + 1);
  };

  const loadMore = () => {
    const run = runRef.current;
    if (loading || nextCursor === null || !resultScope || !run || run.signal.aborted) return;
    if (loadMoreRunRef.current === run) return;
    loadMoreRunRef.current = run;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    forgeClient
      .listIssues(projectPath, {
        state: "open",
        search: resultScope.query || undefined,
        cursor: nextCursor,
      })
      .then((res) => {
        if (run.signal.aborted) return;
        setIssues((prev) => appendUnique(prev, res.items));
        setNextCursor(res.hasMore ? res.nextCursor : null);
      })
      .catch((err) => {
        if (run.signal.aborted) return;
        setLoadMoreFailed(true);
        logError("Failed to fetch more issues", err);
      })
      .finally(() => {
        if (loadMoreRunRef.current === run) loadMoreRunRef.current = null;
        if (!run.signal.aborted) setLoadingMore(false);
      });
  };

  const showLoadingMore = useDeferredLoading(loadingMore, UI_DOHERTY_THRESHOLD);
  const isSlowLoadingMore = useDeferredLoading(loadingMore, UI_STILL_WORKING_MS);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setRequestedQuery("");
      setResultScope(null);
      setIssues([]);
      setLoadFailed(false);
      setNextCursor(null);
      setLoadingMore(false);
      setLoadMoreFailed(false);
    }
  };

  const handleSelect = (issue: Issue) => {
    onSelect(issue);
    handleOpenChange(false);
  };

  const hasMore = nextCursor !== null && issues.length > 0;
  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListboxCursor({
    // Load more is the list's last option, so the cursor reaches it like a row.
    itemCount: issues.length + (hasMore ? 1 : 0),
    open,
    // The rows are fetched, not filtered locally, so a new set replaces the
    // whole list — the cursor rewinds when it lands rather than keeping a raw
    // index that would resurface on an unrelated issue once the list widens.
    resetKey: resultScope,
    onSelect: (index) => {
      const issue = issues[index];
      if (issue) handleSelect(issue);
      else if (hasMore && index === issues.length) loadMore();
    },
    onClose: () => handleOpenChange(false),
  });

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    // Consumed with no rows too: the popover portals out of the dialog, and an
    // early Enter must not submit it before the search has answered.
    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !resultsAreCurrent
    ) {
      event.preventDefault();
      event.stopPropagation();
      runTypedQuery();
      return;
    }
    handleKeyDown(event);
  };

  // Focus the search field on open. Paired with the panel's `onOpenAutoFocus`:
  // this covers the warm path, that one a cold mount where the lazy Radix chunk
  // lands after this effect has already run. Both are load-bearing.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const trimmedQuery = (resultScope?.query ?? "").trim();
  const showStale = issues.length > 0 && !resultsAreCurrent;

  return (
    // Trigger and clear are siblings in one compound control, the same shape
    // `WorktreePathPicker` uses two rows up in this form. The clear used to be a
    // `role="button"` span nested INSIDE the trigger button — invalid, and it
    // only worked because it swallowed the click that would have opened the
    // list. Laying it over the trigger instead would collide with the chevron.
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            FIELD_SURFACE,
            "flex h-8 items-center overflow-hidden",
            "hover:border-border-default",
            disabled && "opacity-50"
          )}
        >
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-controls={LIST_ID}
              // Once an issue is picked the visible text is just the issue, so
              // the field's own name rides in front of it; empty, the visible
              // prompt already says what the field is.
              aria-label={
                selectedIssue ? `Issue #${selectedIssue.number} ${selectedIssue.title}` : undefined
              }
              onKeyDown={(event) => {
                if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  handleOpenChange(true);
                }
              }}
              className={cn(
                "flex h-full min-w-0 flex-1 items-center justify-between gap-2 px-2.5",
                "text-sm text-text-primary transition-colors duration-150 ease-out",
                "hover:bg-surface-hover",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
                "disabled:cursor-not-allowed"
              )}
              disabled={disabled}
            >
              {selectedIssue ? (
                <span className="flex items-center gap-2 truncate">
                  <Icon name="circle-dot" className="w-3 h-3 text-pr-open shrink-0" />
                  <span className="truncate">
                    #{selectedIssue.number} {selectedIssue.title}
                  </span>
                </span>
              ) : (
                <span className="text-text-secondary">Select an issue (optional)</span>
              )}
              <Icon name="chevrons-up-down" className="h-4 w-4 text-text-secondary shrink-0" />
            </button>
          </PopoverTrigger>
          {selectedIssue && !disabled && (
            <Tooltip content="Clear selection" side="left">
              <button
                type="button"
                aria-label="Clear the linked issue"
                onClick={() => {
                  onSelect(null);
                  // This button unmounts with the selection it clears, so hand
                  // focus to the control that survives rather than dropping it
                  // on <body>.
                  triggerRef.current?.focus();
                }}
                className={cn(
                  "flex h-full w-8 shrink-0 items-center justify-center border-l border-border-subtle",
                  "text-text-secondary transition-colors duration-150 ease-out",
                  "hover:bg-overlay-hover hover:text-text-primary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
                )}
              >
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        // The popover portals out of the dialog's subtree; without this its
        // own Escape would also dismiss the dialog behind it.
        onEscapeKeyDown={(e) => e.stopPropagation()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <PopoverSearchField
          ref={inputRef}
          placeholder="Search issues"
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleSearchKeyDown}
          role="combobox"
          aria-label="Search issues"
          aria-autocomplete="list"
          aria-controls={LIST_ID}
          aria-expanded
          aria-activedescendant={activeIndex >= 0 ? `${OPTION_ID_PREFIX}${activeIndex}` : undefined}
        />
        {loadFailed && (
          // Component-owned: the signal and its recovery both live here, so this
          // is a banner rather than a toast. It sits above the rows so a failed
          // refetch cannot leave the previous list reading as current.
          // A strip across the popover, even when the popover opens from a
          // dialog body: the kit's strip never takes the dialog's inset box.
          <Callout
            variant="strip"
            severity="error"
            title="Couldn't load issues"
            actionPlacement="below"
            action={
              <Button
                variant="outline"
                size="sm"
                icon="refresh"
                // The banner's own mark for its recommended action, which the
                // forced-colours rules draw with the heavier border.
                data-notification-action="primary"
                onClick={() => setRetryTick((tick) => tick + 1)}
              >
                Retry
              </Button>
            }
          >
            {"The forge didn't answer."}
          </Callout>
        )}
        <ScrollShadow
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          className="max-h-[300px]"
          scrollClassName={cn("p-1", showStale && "palette-results-stale")}
          data-stale={showStale ? "true" : undefined}
          aria-busy={loading || undefined}
        >
          {loading && issues.length === 0 ? (
            <ForgeOptionRowsSkeleton count={3} />
          ) : issues.length === 0 ? (
            loadFailed ? null : trimmedQuery ? (
              <EmptyState
                variant="filtered-empty"
                scale="popover"
                title={`No matches for "${trimmedQuery}"`}
                action={
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                }
              />
            ) : (
              <EmptyState variant="zero-data" scale="popover" title="No open issues" />
            )
          ) : (
            issues.map((issue, index) => (
              <div
                key={issue.number}
                id={`${OPTION_ID_PREFIX}${index}`}
                data-option-index={index}
                role="option"
                // The cursor, and only the cursor — the committed issue gets a
                // check rather than a second competing background.
                aria-selected={index === activeIndex}
                aria-current={selectedIssue?.number === issue.number ? "true" : undefined}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => handleSelect(issue)}
                className={cn(PALETTE_ROW_CLASS, FORGE_OPTION_ROW, "cursor-pointer")}
              >
                <Icon name="circle-dot" className="w-3 h-3 text-pr-open shrink-0" />
                <span className="truncate flex-1 min-w-0">
                  #{issue.number} {issue.title}
                </span>
                {selectedIssue?.number === issue.number && (
                  <>
                    <Icon name="check" className="h-4 w-4 shrink-0 text-text-primary" />
                    <span className="sr-only">Currently selected</span>
                  </>
                )}
              </div>
            ))
          )}
          {hasMore && (
            <div
              id={`${OPTION_ID_PREFIX}${issues.length}`}
              data-option-index={issues.length}
              role="option"
              aria-selected={activeIndex === issues.length}
              aria-disabled={loadingMore || undefined}
              onPointerMove={() => setActiveIndex(issues.length)}
              // The popover stays open, so the search keeps focus and the
              // arrow keys keep working after a click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={loadMore}
              className={cn(
                PALETTE_ROW_CLASS,
                FORGE_OPTION_ROW,
                "cursor-pointer justify-center text-text-secondary"
              )}
            >
              {loadMoreFailed ? (
                // One way on, not two: the row that failed is the row that retries.
                <>
                  <span>Couldn&apos;t load more issues</span>
                  <span aria-hidden="true">·</span>
                  <span className="flex items-center gap-1.5 text-text-primary">
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    Retry
                  </span>
                </>
              ) : showLoadingMore ? (
                <>
                  <Spinner />
                  {isSlowLoadingMore ? "Still working…" : "Loading…"}
                </>
              ) : (
                "Load more"
              )}
            </div>
          )}
        </ScrollShadow>
      </PopoverContent>
    </Popover>
  );
}
