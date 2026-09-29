import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CircleDot, Link, Link2Off, CircleCheck } from "lucide-react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Kbd } from "@/components/ui/Kbd";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { cn } from "@/lib/utils";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { forgeClient } from "@/clients";
import type { Issue } from "@shared/types/forge";
import type { WorktreeState } from "@/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { pluralize } from "@/lib/pluralize";

interface IssuePickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
  currentIssueNumber?: number;
  onAttach: (issue: Issue) => void;
  onDetach: () => void;
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
            #{issue.number}
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
}: IssuePickerDialogProps) {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [resultScope, setResultScope] = useState<ResultScope | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0);
  // The last query a fetch was started for. A filter change or a retry re-runs
  // that query at once; only a changed query waits out the typing debounce.
  const requestedQueryRef = useRef("");
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

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
        setIssues(result.items);
        setError(null);
      } catch (e) {
        if (id !== fetchIdRef.current) return;
        setError(formatErrorMessage(e, "Failed to load issues"));
        setIssues([]);
      }
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
  const activeIssue = resultsAreCurrent ? issues[selectedIndex] : undefined;

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
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(issues.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIssue) {
        attach(activeIssue);
      } else if (!resultsAreCurrent) {
        // Typed faster than the debounce: run the query now instead of acting
        // on the previous query's results.
        requestedQueryRef.current = query;
        setReloadToken((n) => n + 1);
      }
    }
  };

  useEffect(() => {
    const option =
      scrollRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex];
    option?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

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
        : countLabel(issues.length, shownScope.state);

  const isLinked = currentIssueNumber !== undefined && currentIssueNumber > 0;

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
            key={issue.number}
            id={optionId(index)}
            issue={issue}
            isActive={index === selectedIndex}
            isCurrentlyAttached={issue.number === currentIssueNumber}
            onPoint={() => {
              if (index !== selectedIndex) setSelectedIndex(index);
            }}
            onClick={() => attach(issue)}
          />
        ))}
      </div>
    );
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      maxHeight="max-h-[70vh]"
      // A fixed height keeps the search field still while the body swaps
      // between results, loading, empty and error.
      className="h-[min(40rem,70vh)]"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Link className="w-4 h-4 text-text-secondary" />}>
          {isLinked ? "Change linked issue" : "Attach issue"}
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
          aria-activedescendant={hasResults ? optionId(selectedIndex) : undefined}
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
          // Only where Enter can actually link something.
          isLinked || !hasResults ? undefined : (
            <>
              <Kbd>↵</Kbd>
              <span>to link</span>
            </>
          )
        }
      >
        {isLinked && (
          <Button variant="ghost" onClick={handleDetach} className="text-text-secondary mr-auto">
            <Link2Off aria-hidden="true" />
            Unlink issue #{currentIssueNumber}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose} className="text-text-secondary">
          Cancel
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
