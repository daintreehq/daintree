import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { FIELD_SURFACE } from "./WorktreeFormLayout";

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

/**
 * Control only — "Path" lives on the form's label rail.
 *
 * Input and browse action are one compound control rather than a field with a
 * detached button beside it: they are a single decision, and the seam made the
 * row read as assembled parts. The focus ring is hoisted to the wrapper, scoped
 * to the input, so the whole control lights up as one object.
 */
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
  const hasError = errorField === "worktree-path";

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          FIELD_SURFACE,
          "flex h-8 items-center overflow-hidden",
          // Scoped to the input rather than focus-within: the browse button paints
          // its own ring, and focus-within would stack a second one around the pair.
          "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent-primary has-[input:focus-visible]:outline-offset-2",
          hasError && "border-status-error"
        )}
      >
        <input
          id="worktree-path"
          data-testid="worktree-path-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/path/to/worktree"
          className="min-w-0 flex-1 bg-transparent px-2.5 font-mono text-xs text-text-primary placeholder:text-text-placeholder focus:outline-hidden disabled:opacity-50"
          disabled={isPending}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? "validation-error" : undefined}
        />
        {showGeneratingSpinner && (
          <Spinner size="sm" className="mr-1.5 shrink-0 text-text-secondary" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBrowseClick}
              disabled={disabled}
              aria-label="Browse for a worktree directory"
              className={cn(
                "flex h-full w-8 shrink-0 items-center justify-center border-l border-border-subtle",
                "text-text-secondary transition-colors duration-150 ease-out",
                "hover:bg-overlay-hover hover:text-text-primary",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>Browse for a directory</p>
          </TooltipContent>
        </Tooltip>
      </div>
      {pathWasAutoResolved && (
        <p className="text-xs text-text-secondary" role="status" aria-live="polite">
          Renamed to avoid a conflict with an existing directory
        </p>
      )}
    </div>
  );
}
