import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronsUpDown, Info } from "lucide-react";
import { BranchPickerPanel } from "./BranchPickerPanel";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

interface BaseBranchComboboxProps {
  baseBranch: string;
  controller: UseBranchPickerResult;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  disabled?: boolean;
}

export function BaseBranchCombobox({
  baseBranch,
  controller,
  errorField,
  disabled,
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
      <Popover open={controller.open} onOpenChange={controller.setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="base-branch"
            variant="outline"
            role="combobox"
            aria-expanded={controller.open}
            aria-haspopup="listbox"
            aria-invalid={errorField === "base-branch" ? true : undefined}
            aria-describedby={errorField === "base-branch" ? "validation-error" : undefined}
            className="w-full justify-between bg-daintree-bg border-daintree-border text-daintree-text hover:bg-daintree-bg hover:text-daintree-text"
            disabled={disabled}
          >
            {/* The trigger keeps the composed "(current)"/"(remote)" label — it has
                one line for the whole answer. Rows draw those as badges instead. */}
            <span className="truncate">
              {controller.selectedOption?.labelText || "Select base branch..."}
            </span>
            <ChevronsUpDown className="text-text-muted shrink-0" />
          </Button>
        </PopoverTrigger>
        <BranchPickerPanel
          controller={controller}
          selectedBranch={baseBranch}
          listId="branch-list"
          optionIdPrefix="branch-option-"
          searchPlaceholder="Search branches..."
          searchAriaLabel="Search base branches"
          zeroDataTitle="No branches available"
          showCurrentBadge
        />
      </Popover>
    </div>
  );
}
