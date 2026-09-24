import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { BrowseSlotButton, SlottedInputField } from "@/components/Project/projectDialogFields";

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
 * row read as assembled parts. The shared slotted field hoists the focus ring to
 * the pair and turns it to the error ring when the path is rejected.
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
      <SlottedInputField
        id="worktree-path"
        data-testid="worktree-path-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/worktree"
        className="font-mono text-xs"
        disabled={isPending}
        invalid={hasError}
        aria-describedby={hasError ? "validation-error" : undefined}
        trailing={
          <>
            {showGeneratingSpinner && (
              <Spinner size="sm" className="mr-1.5 shrink-0 text-text-secondary" />
            )}
            <BrowseSlotButton
              onBrowse={onBrowseClick}
              disabled={disabled}
              label="Browse for a worktree directory"
            />
          </>
        }
      />
      {pathWasAutoResolved && (
        <p className="text-xs text-text-secondary" role="status" aria-live="polite">
          Renamed to avoid a conflict with an existing directory
        </p>
      )}
    </div>
  );
}
