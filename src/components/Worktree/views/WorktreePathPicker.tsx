import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderOpen, Info } from "lucide-react";
import { useDohertyGate } from "@/hooks/useDeferredLoading";

interface WorktreePathPickerProps {
  value: string;
  onChange: (value: string) => void;
  isPending?: boolean;
  isGeneratingPath: boolean;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  pathWasAutoResolved: boolean;
  onBrowseClick: () => void;
  disabled?: boolean;
}

export function WorktreePathPicker({
  value,
  onChange,
  isPending,
  isGeneratingPath,
  errorField,
  pathWasAutoResolved,
  onBrowseClick,
  disabled,
}: WorktreePathPickerProps) {
  // isGeneratingPath goes true on every keystroke (it also gates submit), but
  // the debounced generation usually resolves fast — only show the spinner for
  // genuinely slow lookups.
  const showGeneratingSpinner = useDohertyGate(isGeneratingPath);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor="worktree-path" className="block text-sm font-medium text-daintree-text">
          Worktree Path
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-daintree-text/40 hover:text-daintree-text/60 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent focus-visible:ring-offset-2"
              aria-label="Help for Worktree Path field"
              disabled={disabled}
            >
              <Info className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="sr-only">Help for Worktree Path field</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>Directory where the worktree will be created</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <input
            id="worktree-path"
            data-testid="worktree-path-input"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="/path/to/worktree"
            className="w-full px-3 pr-10 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30"
            disabled={isPending}
            aria-invalid={errorField === "worktree-path" ? true : undefined}
            aria-describedby={errorField === "worktree-path" ? "validation-error" : undefined}
          />
          {showGeneratingSpinner && (
            <Spinner
              size="md"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-daintree-text/40 pointer-events-none"
            />
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onBrowseClick} disabled={disabled}>
          <FolderOpen />
        </Button>
      </div>
      {pathWasAutoResolved && (
        <p
          className="text-xs text-status-success flex items-center gap-1.5 mt-1"
          role="status"
          aria-live="polite"
        >
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          Path auto-incremented to avoid conflict with existing directory
        </p>
      )}
    </div>
  );
}
