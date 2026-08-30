import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { BranchPickerPanel } from "./BranchPickerPanel";
import { FIELD_TRIGGER } from "./WorktreeFormLayout";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

interface BaseBranchComboboxProps {
  baseBranch: string;
  controller: UseBranchPickerResult;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  disabled?: boolean;
}

/** Control only — "Base" and its help text live on the form's label rail. */
export function BaseBranchCombobox({
  baseBranch,
  controller,
  errorField,
  disabled,
}: BaseBranchComboboxProps) {
  const hasError = errorField === "base-branch";
  return (
    <Popover open={controller.open} onOpenChange={controller.setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="base-branch"
          variant="ghost"
          role="combobox"
          aria-expanded={controller.open}
          aria-haspopup="listbox"
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? "validation-error" : undefined}
          className={cn(FIELD_TRIGGER, hasError && "border-status-error")}
          disabled={disabled}
        >
          {/* The trigger keeps the composed "(current)"/"(remote)" label — it has
              one line for the whole answer. Rows draw those as badges instead. */}
          <span className="truncate font-mono text-xs">
            {controller.selectedOption?.labelText || "Select base branch"}
          </span>
          <ChevronsUpDown className="text-text-secondary shrink-0" />
        </Button>
      </PopoverTrigger>
      <BranchPickerPanel
        controller={controller}
        selectedBranch={baseBranch}
        listId="branch-list"
        optionIdPrefix="branch-option-"
        searchPlaceholder="Search branches"
        searchAriaLabel="Search base branches"
        zeroDataTitle="No branches available"
        showCurrentBadge
      />
    </Popover>
  );
}
