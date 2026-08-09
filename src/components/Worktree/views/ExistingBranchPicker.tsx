import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { ChevronsUpDown, GitBranch } from "lucide-react";
import { BranchPickerPanel } from "./BranchPickerPanel";
import type { UseBranchPickerResult } from "../hooks/useBranchPicker";

interface ExistingBranchPickerProps {
  selectedBranch: string | null;
  controller: UseBranchPickerResult;
  disabled?: boolean;
}

export function ExistingBranchPicker({
  selectedBranch,
  controller,
  disabled,
}: ExistingBranchPickerProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-daintree-text">Select Branch</label>
      <Popover open={controller.open} onOpenChange={controller.setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={controller.open}
            aria-haspopup="listbox"
            className="w-full justify-between bg-daintree-bg border-daintree-border text-daintree-text hover:bg-daintree-bg hover:text-daintree-text"
            disabled={disabled}
            data-testid="existing-branch-picker"
          >
            <span className="flex items-center gap-2 truncate">
              {/* Muted, not accent: a decorative field glyph is not this region's
                  one load-bearing signal. */}
              <GitBranch className="w-4 h-4 shrink-0 text-text-muted" aria-hidden="true" />
              {selectedBranch ? (
                <span className="font-mono text-sm">{selectedBranch}</span>
              ) : (
                <span className="text-daintree-text/60">Select a local branch...</span>
              )}
            </span>
            <ChevronsUpDown className="text-text-muted shrink-0" />
          </Button>
        </PopoverTrigger>
        <BranchPickerPanel
          controller={controller}
          selectedBranch={selectedBranch}
          listId="existing-branch-list"
          optionIdPrefix="existing-branch-option-"
          searchPlaceholder="Search local branches..."
          searchAriaLabel="Search existing branches"
          zeroDataTitle="No available local branches"
        />
      </Popover>
    </div>
  );
}
