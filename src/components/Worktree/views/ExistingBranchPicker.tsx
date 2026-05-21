import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, ChevronsUpDown, GitBranch, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BranchInfo } from "@/types/electron";

interface ExistingBranchPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedBranch: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  filteredBranches: BranchInfo[];
  onSelect: (branchName: string) => void;
  disabled?: boolean;
}

export function ExistingBranchPicker({
  open,
  onOpenChange,
  selectedBranch,
  query,
  onQueryChange,
  filteredBranches,
  onSelect,
  disabled,
}: ExistingBranchPickerProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-daintree-text">Select Branch</label>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            className="w-full justify-between bg-daintree-bg border-daintree-border text-daintree-text hover:bg-daintree-bg hover:text-daintree-text"
            disabled={disabled}
            data-testid="existing-branch-picker"
          >
            <span className="flex items-center gap-2 truncate">
              <GitBranch className="w-4 h-4 shrink-0 text-daintree-accent" />
              {selectedBranch ? (
                <span className="font-mono text-sm">{selectedBranch}</span>
              ) : (
                <span className="text-daintree-text/60">Select a local branch...</span>
              )}
            </span>
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
              className="flex h-10 w-full rounded-[var(--radius-md)] bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Search local branches..."
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              autoFocus
              aria-label="Search existing branches"
              data-testid="existing-branch-search"
            />
          </div>
          <ScrollShadow role="listbox" className="max-h-[300px]" scrollClassName="p-1">
            {filteredBranches.length === 0 ? (
              query.trim() ? (
                <EmptyState
                  variant="filtered-empty"
                  scale="popover"
                  title={`No matches for "${query.trim()}"`}
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
                <EmptyState
                  variant="zero-data"
                  scale="popover"
                  title="No available local branches"
                />
              )
            ) : (
              filteredBranches.map((branch) => (
                <div
                  key={branch.name}
                  role="option"
                  aria-selected={branch.name === selectedBranch}
                  onClick={() => {
                    onSelect(branch.name);
                    onOpenChange(false);
                    onQueryChange("");
                  }}
                  className={cn(
                    "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border font-mono",
                    branch.name === selectedBranch && "bg-daintree-border"
                  )}
                >
                  <span className="truncate">{branch.name}</span>
                  {branch.name === selectedBranch && (
                    <Check className="h-4 w-4 shrink-0 text-daintree-text" />
                  )}
                </div>
              ))
            )}
          </ScrollShadow>
        </PopoverContent>
      </Popover>
    </div>
  );
}
