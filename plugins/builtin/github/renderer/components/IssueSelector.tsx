import { useState, useEffect, useRef } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { useListboxCursor } from "@/hooks/useListboxCursor";
import { Check, ChevronsUpDown, CircleDot, RefreshCw, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { forgeClient } from "@/clients/forgeClient";
import type { Issue } from "@shared/types/forge";
import type { ForgeIssueSelectorProps } from "@/types/forgeSlotProps";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIELD_SURFACE } from "@/components/Worktree/views/WorktreeFormLayout";
import { GitHubResourceRowsSkeleton } from "./GitHubDropdownSkeletons";
import { logError } from "@/utils/logger";

/** Conforms to the host's issue-selector slot contract (forge-normalized shapes). */
export type IssueSelectorProps = ForgeIssueSelectorProps;

const LIST_ID = "issue-list";
const OPTION_ID_PREFIX = "issue-option-";

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
  const debouncedQuery = useDebounce(query, 300);
  const requestGenRef = useRef(0);
  const prevProjectPathRef = useRef(projectPath);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (prevProjectPathRef.current !== projectPath) {
      prevProjectPathRef.current = projectPath;
      setIssues([]);
    }
    if (!open) return;

    const abortController = new AbortController();
    const gen = ++requestGenRef.current;
    setLoading(true);
    setLoadFailed(false);
    forgeClient
      .listIssues(projectPath, {
        state: "open",
        search: debouncedQuery || undefined,
      })
      .then((res) => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setIssues(res.items);
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setLoadFailed(true);
          logError("Failed to fetch issues", err);
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted && requestGenRef.current === gen) {
          setLoading(false);
        }
      });

    return () => abortController.abort();
  }, [open, debouncedQuery, projectPath, retryTick]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setIssues([]);
      setLoadFailed(false);
    }
  };

  const handleSelect = (issue: Issue) => {
    onSelect(issue);
    handleOpenChange(false);
  };

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListboxCursor({
    itemCount: issues.length,
    open,
    // The rows are fetched, not filtered locally, so a new query replaces the
    // whole set — the cursor rewinds with it rather than keeping a raw index
    // that would resurface on an unrelated issue once the list widens again.
    resetKey: debouncedQuery,
    onSelect: (index) => {
      const issue = issues[index];
      if (issue) handleSelect(issue);
    },
    onClose: () => handleOpenChange(false),
  });

  // Focus the search field on open. Paired with the panel's `onOpenAutoFocus`:
  // this covers the warm path, that one a cold mount where the lazy Radix chunk
  // lands after this effect has already run. Both are load-bearing.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const trimmedQuery = debouncedQuery.trim();

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
              className={cn(
                "flex h-full min-w-0 flex-1 items-center justify-between gap-2 px-2.5",
                "text-sm text-daintree-text transition-colors duration-150 ease-out",
                "hover:bg-surface-hover",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2",
                "disabled:cursor-not-allowed"
              )}
              disabled={disabled}
            >
              {selectedIssue ? (
                <span className="flex items-center gap-2 truncate">
                  <CircleDot className="w-3 h-3 text-pr-open shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    #{selectedIssue.number} {selectedIssue.title}
                  </span>
                </span>
              ) : (
                <span className="text-text-secondary">Select an issue (optional)</span>
              )}
              <ChevronsUpDown className="h-4 w-4 text-text-secondary shrink-0" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          {selectedIssue && !disabled && (
            <Tooltip>
              <TooltipTrigger asChild>
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
                    "hover:bg-overlay-hover hover:text-daintree-text",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
                  )}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Clear selection</TooltipContent>
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
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
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
          <InlineStatusBanner
            severity="error"
            icon={XCircle}
            title="Couldn't load issues"
            description="The forge didn't answer."
            action={{
              id: "retry-issues",
              label: "Retry",
              icon: RefreshCw,
              onClick: () => setRetryTick((tick) => tick + 1),
            }}
          />
        )}
        <ScrollShadow
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          className="max-h-[300px]"
          scrollClassName={cn("p-1", loading && issues.length > 0 && "palette-results-stale")}
          data-stale={loading && issues.length > 0 ? "true" : undefined}
          aria-busy={loading || undefined}
        >
          {loading && issues.length === 0 ? (
            <GitHubResourceRowsSkeleton count={3} immediate />
          ) : issues.length === 0 ? (
            loadFailed ? null : trimmedQuery ? (
              <EmptyState
                variant="filtered-empty"
                scale="popover"
                title={`No matches for "${trimmedQuery}"`}
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                  >
                    Clear search
                  </button>
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
                className={cn(
                  PALETTE_ROW_CLASS,
                  "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer"
                )}
              >
                <CircleDot className="w-3 h-3 text-pr-open shrink-0" aria-hidden="true" />
                <span className="truncate flex-1 min-w-0">
                  #{issue.number} {issue.title}
                </span>
                {selectedIssue?.number === issue.number && (
                  <>
                    <Check className="h-4 w-4 shrink-0 text-daintree-text" aria-hidden="true" />
                    <span className="sr-only">Currently selected</span>
                  </>
                )}
              </div>
            ))
          )}
        </ScrollShadow>
      </PopoverContent>
    </Popover>
  );
}
