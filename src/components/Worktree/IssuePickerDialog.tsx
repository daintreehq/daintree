import { useState, useCallback, useEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { CircleDot, Search, Link, Unlink, CircleCheck } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients";
import type { GitHubIssue } from "@shared/types/github";
import type { WorktreeState } from "@/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

interface IssuePickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
  currentIssueNumber?: number;
  onAttach: (issue: GitHubIssue) => void;
  onDetach: () => void;
}

type StateFilter = "open" | "closed" | "all";

interface IssueOptionRowProps {
  issue: GitHubIssue;
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
          isSelected
            ? "bg-daintree-accent/10 border border-daintree-accent/30"
            : "hover:bg-tint/5 border border-transparent",
          isCurrentlyAttached && "ring-1 ring-status-success/30"
        )}
      >
        {issue.state === "OPEN" ? (
          <CircleDot className="w-4 h-4 text-github-open shrink-0 mt-0.5" />
        ) : (
          <CircleCheck className="w-4 h-4 text-github-merged shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span ref={ref} className="text-sm text-daintree-text truncate">
              {issue.title}
            </span>
            {isCurrentlyAttached && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-success/10 text-status-success shrink-0">
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
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchIssues = useCallback(
    async (searchTerm: string, state: StateFilter) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await githubClient.listIssues({
          cwd: worktree.path,
          search: searchTerm || undefined,
          state,
        });
        setIssues(result.items);
        setSelectedIndex(0);
      } catch (e) {
        setError(formatErrorMessage(e, "Failed to load issues"));
        setIssues([]);
      } finally {
        setIsLoading(false);
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
    };
  }, [search, stateFilter, isOpen, fetchIssues]);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setStateFilter("open");
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
    (issue: GitHubIssue) => {
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
      <AppDialog.Header>
        <AppDialog.Title icon={<Link className="w-5 h-5 text-github-open" />}>
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
            className="w-full pl-10 pr-4 py-2 bg-tint/5 border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text placeholder:text-text-muted focus:outline-none focus:border-daintree-accent"
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
                  ? "bg-daintree-accent/20 text-daintree-accent"
                  : "text-daintree-text/50 hover:text-daintree-text/80 hover:bg-tint/5"
              )}
            >
              {state}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
        {isLoading && issues.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-daintree-text/50">
            <Spinner size="lg" className="mr-2" />
            <span className="text-sm">Loading issues...</span>
          </div>
        ) : error ? (
          <div className="text-center py-8 text-sm text-status-error">{error}</div>
        ) : issues.length === 0 ? (
          <div className="text-center py-8 text-sm text-daintree-text/50">
            {search ? "No issues match your search" : "No issues found"}
          </div>
        ) : (
          <div ref={listRef} className="space-y-1" role="listbox">
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
        <AppDialog.Footer>
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
