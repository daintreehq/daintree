import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, ChevronsUpDown, Info, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { HighlightBranchText } from "./HighlightBranchText";
import type { BranchPickerRow } from "../branchPickerUtils";

interface BaseBranchComboboxProps {
  baseBranch: string;
  branchPickerOpen: boolean;
  onOpenChange: (open: boolean) => void;
  branchQuery: string;
  onQueryChange: (query: string) => void;
  branchRows: BranchPickerRow[];
  selectableRows: (BranchPickerRow & { kind: "option" })[];
  selectedIndex: number;
  selectedBranchLabel: string | undefined;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSelect: (row: BranchPickerRow & { kind: "option" }) => void;
  branchInputRef: React.RefObject<HTMLInputElement | null>;
  branchListRef: React.RefObject<HTMLDivElement | null>;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  branchOptionsLength: number;
  disabled?: boolean;
  onClose: () => void;
}

export function BaseBranchCombobox({
  baseBranch,
  branchPickerOpen,
  onOpenChange,
  branchQuery,
  onQueryChange,
  branchRows,
  selectableRows,
  selectedIndex,
  selectedBranchLabel,
  onKeyDown,
  onSelect,
  branchInputRef,
  branchListRef,
  errorField,
  branchOptionsLength,
  disabled,
  onClose,
}: BaseBranchComboboxProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor="base-branch" className="block text-sm font-medium text-daintree-text">
          Base Branch
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-daintree-text/40 hover:text-daintree-text/60 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent focus-visible:ring-offset-2"
              aria-label="Help for Base Branch field"
              disabled={disabled}
            >
              <Info className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="sr-only">Help for Base Branch field</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>The branch to create the new worktree from</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <Popover open={branchPickerOpen} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id="base-branch"
            variant="outline"
            role="combobox"
            aria-expanded={branchPickerOpen}
            aria-haspopup="listbox"
            aria-invalid={errorField === "base-branch" ? true : undefined}
            aria-describedby={errorField === "base-branch" ? "validation-error" : undefined}
            className="w-full justify-between bg-daintree-bg border-daintree-border text-daintree-text hover:bg-daintree-bg hover:text-daintree-text"
            disabled={disabled}
          >
            <span className="truncate">{selectedBranchLabel || "Select base branch..."}</span>
            <ChevronsUpDown className="opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[400px] p-0"
          align="start"
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center border-b border-daintree-border px-3">
            <Search className="mr-2 h-4 w-4 opacity-50 shrink-0" />
            <input
              ref={branchInputRef}
              className="flex h-10 w-full rounded-[var(--radius-md)] bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Search branches..."
              value={branchQuery}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-label="Search base branches"
              aria-autocomplete="list"
              aria-controls="branch-list"
              aria-expanded={branchPickerOpen}
              aria-activedescendant={
                selectableRows.length > 0 && selectedIndex >= 0
                  ? `branch-option-${selectedIndex}`
                  : undefined
              }
            />
          </div>
          <ScrollShadow
            ref={branchListRef}
            id="branch-list"
            role="listbox"
            className="max-h-[300px]"
            scrollClassName="p-1"
          >
            {selectableRows.length === 0 ? (
              branchQuery.trim() ? (
                <EmptyState
                  variant="filtered-empty"
                  scale="popover"
                  title={`No matches for "${branchQuery.trim()}"`}
                  action={
                    <button
                      type="button"
                      onClick={() => onQueryChange("")}
                      className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                    >
                      Clear search
                    </button>
                  }
                />
              ) : (
                <EmptyState variant="zero-data" scale="popover" title="No branches available" />
              )
            ) : (
              (() => {
                let optionIndex = 0;
                return branchRows.map((row) => {
                  if (row.kind === "section") {
                    return (
                      <div
                        key={`section-${row.label}`}
                        role="presentation"
                        className="px-2 py-1 text-xs font-medium text-daintree-text/50 uppercase tracking-wider"
                      >
                        {row.label}
                      </div>
                    );
                  }
                  const idx = optionIndex++;
                  return (
                    <div
                      key={row.name}
                      id={`branch-option-${idx}`}
                      data-option-index={idx}
                      role="option"
                      aria-selected={row.name === baseBranch}
                      onClick={() => {
                        if (row.inUseWorktree) {
                          actionService.dispatch("worktree.setActive", {
                            worktreeId: row.inUseWorktree.id,
                          });
                          onOpenChange(false);
                          onClose();
                          return;
                        }
                        onSelect(row);
                      }}
                      className={cn(
                        "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border",
                        row.name === baseBranch && "bg-daintree-border",
                        idx === selectedIndex && "bg-overlay-selected"
                      )}
                    >
                      <span className="truncate">
                        <HighlightBranchText
                          text={row.labelText}
                          matchRanges={row.matchRanges}
                          nameLength={row.name.length}
                        />
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {row.inUseWorktree && (
                          <span
                            className="text-xs text-status-warning"
                            title={`In use by worktree: ${row.inUseWorktree.name}`}
                          >
                            in use
                          </span>
                        )}
                        {row.name === baseBranch && (
                          <Check className="h-4 w-4 text-daintree-text" />
                        )}
                      </span>
                    </div>
                  );
                });
              })()
            )}
          </ScrollShadow>
          {!branchQuery && branchOptionsLength > 500 && (
            <div className="border-t border-daintree-border px-3 py-2 text-xs text-daintree-text/60">
              Showing first 500 branches. Type to search.
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
