import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { ChevronsUpDown, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { BranchPickerPanel } from "./BranchPickerPanel";
import { FIELD_TRIGGER } from "./WorktreeFormLayout";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

interface ExistingBranchPickerProps {
  selectedBranch: string | null;
  controller: UseBranchPickerResult;
  disabled?: boolean;
}

/** Control only — "Branch" lives on the form's label rail. */
export function ExistingBranchPicker({
  selectedBranch,
  controller,
  disabled,
}: ExistingBranchPickerProps) {
  return (
    <Popover open={controller.open} onOpenChange={controller.setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="existing-branch"
          variant="ghost"
          role="combobox"
          aria-expanded={controller.open}
          aria-haspopup="listbox"
          className={cn(FIELD_TRIGGER, "gap-2")}
          disabled={disabled}
          data-testid="existing-branch-picker"
        >
          <span className="flex items-center gap-2 truncate">
            {/* Muted, not accent: a decorative field glyph is not this region's
                one load-bearing signal. */}
            <GitBranch className="w-4 h-4 shrink-0 text-text-secondary" aria-hidden="true" />
            {selectedBranch ? (
              <span className="truncate font-mono text-xs">{selectedBranch}</span>
            ) : (
              <span className="text-text-secondary">Select a local branch</span>
            )}
          </span>
          <ChevronsUpDown className="text-text-secondary shrink-0" />
        </Button>
      </PopoverTrigger>
      <BranchPickerPanel
        controller={controller}
        selectedBranch={selectedBranch}
        listId="existing-branch-list"
        optionIdPrefix="existing-branch-option-"
        searchPlaceholder="Search local branches"
        searchAriaLabel="Search existing branches"
        zeroDataTitle="No available local branches"
      />
    </Popover>
  );
}
