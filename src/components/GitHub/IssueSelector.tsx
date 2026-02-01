import { useState, useEffect } from "react";
import { Check, ChevronsUpDown, Search, CircleDot, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { githubClient } from "@/clients/githubClient";
import type { GitHubIssue } from "@shared/types/github";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar } from "@/components/ui/Avatar";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

interface IssueSelectorProps {
  projectPath: string;
  selectedIssue: GitHubIssue | null;
  onSelect: (issue: GitHubIssue | null) => void;
  disabled?: boolean;
}

export function IssueSelector({
  projectPath,
  selectedIssue,
  onSelect,
  disabled,
}: IssueSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (!open) return;

    const abortController = new AbortController();
    setLoading(true);
    githubClient
      .listIssues({
        cwd: projectPath,
        state: "open",
        search: debouncedQuery || undefined,
      })
      .then((res) => {
        if (!abortController.signal.aborted) {
          setIssues(res.items);
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted) {
          console.error("Failed to fetch issues:", err);
          setIssues([]);
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      });

    return () => abortController.abort();
  }, [open, debouncedQuery, projectPath]);

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          className="w-full justify-between bg-canopy-bg border-canopy-border text-canopy-text hover:bg-canopy-bg hover:text-canopy-text"
          disabled={disabled}
        >
          {selectedIssue ? (
            <span className="flex items-center gap-2 truncate">
              <CircleDot className="w-3 h-3 text-green-400 shrink-0" />
              <span className="truncate">
                #{selectedIssue.number} {selectedIssue.title}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Select an issue (optional)...</span>
          )}
          <div className="flex items-center gap-1 shrink-0">
            {selectedIssue && !disabled && (
              <span
                role="button"
                tabIndex={0}
                onClick={handleClear}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleClear(e as unknown as React.MouseEvent);
                  }
                }}
                className="p-0.5 hover:bg-canopy-border rounded cursor-pointer"
                title="Clear selection"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-canopy-text" />
              </span>
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <div className="flex items-center border-b border-canopy-border px-3">
          <Search className="mr-2 h-4 w-4 opacity-50 shrink-0" />
          <input
            className="flex h-10 w-full rounded-[var(--radius-md)] bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Search issues..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-autocomplete="list"
            aria-controls="issue-list"
            aria-expanded={open}
          />
        </div>
        <div id="issue-list" role="listbox" className="max-h-[300px] overflow-y-auto p-1">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading issues...</div>
          ) : issues.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {debouncedQuery ? "No issues found" : "No open issues"}
            </div>
          ) : (
            issues.map((issue) => (
              <div
                key={issue.number}
                role="option"
                aria-selected={selectedIssue?.number === issue.number}
                onClick={() => {
                  onSelect(issue);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                  selectedIssue?.number === issue.number && "bg-canopy-border"
                )}
              >
                <CircleDot className="w-3 h-3 text-green-400 shrink-0" />
                <span className="truncate flex-1">
                  #{issue.number} {issue.title}
                </span>
                {issue.assignees.length > 0 && (
                  <div className="flex -space-x-1.5 shrink-0">
                    {issue.assignees.slice(0, 3).map((assignee) => (
                      <Avatar
                        key={assignee.login}
                        src={`${assignee.avatarUrl}${assignee.avatarUrl.includes("?") ? "&" : "?"}s=32`}
                        alt={assignee.login}
                        title={assignee.login}
                        className="w-5 h-5 ring-1 ring-canopy-bg"
                      />
                    ))}
                    {issue.assignees.length > 3 && (
                      <div className="w-5 h-5 rounded-full bg-canopy-border ring-1 ring-canopy-bg flex items-center justify-center text-[10px] text-canopy-text/70">
                        +{issue.assignees.length - 3}
                      </div>
                    )}
                  </div>
                )}
                {selectedIssue?.number === issue.number && <Check className="h-4 w-4 shrink-0" />}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
