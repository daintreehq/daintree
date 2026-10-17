import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { BranchPickerPanel } from "./BranchPickerPanel";
import { FIELD_TRIGGER } from "./WorktreeFormLayout";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";
import type { ErrorField } from "../hooks/useWorktreeFormErrors";

interface BaseBranchComboboxProps {
  baseBranch: string;
  controller: UseBranchPickerResult;
  errorField?: ErrorField | null;
  disabled?: boolean;
  /** Shown in place of the branch when there is no honest one to show. */
  unavailableLabel?: string;
}

/** Control only — "Base" and its help text live on the form's label rail. */
export function BaseBranchCombobox({
  baseBranch,
  controller,
  errorField,
  disabled,
  unavailableLabel,
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
          aria-controls={controller.open ? "branch-list" : undefined}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? "validation-error" : undefined}
          className={cn(
            FIELD_TRIGGER,
            hasError && "border-status-error focus-visible:outline-status-error"
          )}
          disabled={disabled}
          // Down/Up open the list, as on every other combobox in the form; the
          // search field inside then takes focus and the arrow keys.
          onKeyDown={(event) => {
            if (!controller.open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              controller.setOpen(true);
            }
          }}
        >
          {/* The trigger keeps the composed "(current)"/"(remote)" label — it has
              one line for the whole answer. Rows draw those as badges instead. */}
          {unavailableLabel ? (
            <span className="truncate text-text-secondary">{unavailableLabel}</span>
          ) : controller.selectedOption ? (
            <span className="truncate font-mono text-xs">
              {controller.selectedOption.labelText}
            </span>
          ) : (
            // A prompt, not a value: sans and secondary like every other empty
            // trigger in the form, so it can't be read as a branch called that.
            <span className="truncate text-text-secondary">Select a base branch</span>
          )}
          {/* A pinned field offers nothing to open. */}
          {!disabled && <ChevronsUpDown className="text-text-secondary shrink-0" />}
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
