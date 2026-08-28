import { useState, useCallback, useEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { CircleDot, Search, Link, Unlink, CircleCheck } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";
import { forgeClient } from "@/clients";
import type { Issue } from "@shared/types/forge";
import type { WorktreeState } from "@/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

interface IssuePickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
  currentIssueNumber?: number;
  onAttach: (issue: Issue) => void;
  onDetach: () => void;
}

type StateFilter = "open" | "closed" | "all";

interface IssueOptionRowProps {
  issue: Issue;
  isSelected: boolean;
  isCurrentlyAttached: boolean;
  onClick: () => void;
}

function IssueOptionRow({ issue, isSelected, isCurrentlyAttached, onClick }: IssueOptionRowProps) {
  const { ref, isTruncated } = useTruncationDetection();

  return (
    <TruncatedTooltip content={issue.title} isTruncated={isTruncated}>
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={onClick}
        className={cn(
          "w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] transition-colors flex items-start gap-3",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
          isSelected
            ? "bg-overlay-soft border border-border-strong"
            : isCurrentlyAttached
              ? "hover:bg-tint/5 border border-border-default"
              : "hover:bg-tint/5 border border-transparent"
        )}
      >
        {issue.state === "open" ? (
          <CircleDot className="w-4 h-4 text-pr-open shrink-0 mt-0.5" />
        ) : (
          <CircleCheck className="w-4 h-4 text-pr-merged shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span ref={ref} className="text-sm text-text-primary truncate">
              {issue.title}
            </span>
            {isCurrentlyAttached && (
              <span className="text-3xs px-1.5 py-0.5 rounded border border-border-default bg-overlay-subtle text-text-secondary shrink-0">
                attached
              </span>
            )}
          </div>
          <span className="text-xs text-daintree-text/50 font-mono">#{issue.number}</span>
        </div>
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
  const [fetchedQuery, setFetchedQuery] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchIdRef = useRef(0);

  const fetchIssues = useCallback(
    async (searchTerm: string, state: StateFilter) => {
      const trimmed = searchTerm.trim();
      const id = ++fetchIdRef.current;
      setIsPending(true);
      try {
        const result = await forgeClient.listIssues(worktree.path, {
          search: trimmed || undefined,
          state,
        });
        if (id !== fetchIdRef.current) return;
        setIssues(result.items);
        setFetchedQuery(trimmed);
        setSelectedIndex(0);
        setError(null);
        setIsPending(false);
      } catch (e) {
        if (id !== fetchIdRef.current) return;
        setError(formatErrorMessage(e, "Failed to load issues"));
        setIssues([]);
        setFetchedQuery(trimmed);
        setSelectedIndex(0);
        setIsPending(false);
      }
    },
    [worktree.path]
  );

  useEffect(() => {
    if (!isOpen) return;
    fetchIssues("", stateFilter);
  }, [isOpen, fetchIssues, stateFilter]);

  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchIssues(search, stateFilter);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Invalidate any in-flight fetch the moment the user's input changes,
      // so a slow response from the prior query can't land under the new one.
      fetchIdRef.current++;
    };
  }, [search, stateFilter, isOpen, fetchIssues]);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setStateFilter("open");
      setFetchedQuery("");
      setIssues([]);
      setError(null);
      setIsPending(true);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, issues.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && issues[selectedIndex]) {
        e.preventDefault();
        onAttach(issues[selectedIndex]);
        onClose();
      }
    },
    [issues, selectedIndex, onAttach, onClose]
  );

  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const selected = listEl.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleSelectIssue = useCallback(
    (issue: Issue) => {
      onAttach(issue);
      onClose();
    },
    [onAttach, onClose]
  );

  const handleDetach = useCallback(() => {
    onDetach();
    onClose();
  }, [onDetach, onClose]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" maxHeight="max-h-[70vh]">
      <AppDialog.Header plainBody>
        <AppDialog.Title icon={<Link className="w-5 h-5 text-pr-open" />}>
          Attach Issue
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div className="px-6 pt-4 pb-3 space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-daintree-text/40" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search issues by title or number..."
            className="w-full pl-10 pr-4 py-2 bg-tint/5 border border-border-default rounded-[var(--radius-md)] text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:border-daintree-accent/40"
          />
        </div>

        <div className="flex gap-1">
          {(["open", "closed", "all"] as const).map((state) => (
            <button
              key={state}
              onClick={() => setStateFilter(state)}
              className={cn(
                "px-3 py-1 text-xs rounded-full transition-colors capitalize",
                stateFilter === state
                  ? "bg-filter-selected-bg-strong text-text-primary border border-transparent"
                  : "border border-transparent text-daintree-text/50 hover:text-daintree-text/80 hover:bg-tint/5"
              )}
            >
              {state}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
        {isPending && issues.length === 0 ? (
          <Skeleton label="Loading issues" className="space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="px-3 py-2.5 rounded-[var(--radius-md)] flex items-start gap-3"
              >
                <SkeletonBone className="w-4 h-4 rounded-full shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <SkeletonBone className={cn("h-4", i % 2 === 0 ? "w-3/4" : "w-1/2")} />
                  <SkeletonBone className="h-3 w-12" />
                </div>
              </div>
            ))}
          </Skeleton>
        ) : error ? (
          <div className="text-center py-8 text-sm text-status-error">{error}</div>
        ) : issues.length === 0 ? (
          fetchedQuery ? (
            <EmptyState
              variant="filtered-empty"
              scale="popover"
              title={`No matches for "${fetchedQuery}"`}
              action={
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-text-primary hover:bg-overlay-soft rounded transition-colors"
                >
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState variant="zero-data" scale="popover" title="No issues found" />
          )
        ) : (
          <div
            ref={listRef}
            className={cn("space-y-1", isPending && "surface-stale")}
            role="listbox"
            data-stale={isPending ? "true" : undefined}
            aria-busy={isPending || undefined}
          >
            {issues.map((issue, index) => (
              <IssueOptionRow
                key={issue.number}
                issue={issue}
                isSelected={index === selectedIndex}
                isCurrentlyAttached={issue.number === currentIssueNumber}
                onClick={() => handleSelectIssue(issue)}
              />
            ))}
          </div>
        )}
      </div>

      {currentIssueNumber && (
        <AppDialog.Footer plainBody>
          <Button variant="ghost" onClick={handleDetach} className="text-daintree-text/70 mr-auto">
            <Unlink className="w-4 h-4 mr-2" />
            Detach Issue
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </AppDialog.Footer>
      )}
    </AppDialog>
  );
}
