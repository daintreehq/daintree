import { useLayoutEffect, useRef } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { BrowseSlotButton, SlottedInputField } from "@/components/Project/projectDialogFields";
import { useHostPlatform } from "@/hooks/useHostPlatform";
import type { ErrorField } from "../hooks/useWorktreeFormErrors";

interface WorktreePathPickerProps {
  value: string;
  onChange: (value: string) => void;
  isPending?: boolean;
  isGeneratingPath: boolean;
  errorField?: ErrorField | null;
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
  onBrowseClick,
  disabled,
}: WorktreePathPickerProps) {
  const { platform } = useHostPlatform();
  // isGeneratingPath goes true on every keystroke (it also gates submit), but
  // the debounced generation usually resolves fast — only show the spinner for
  // genuinely slow lookups.
  const showGeneratingSpinner = useDohertyGate(isGeneratingPath);
  const hasError = errorField === "worktree-path";

  // A generated path differs from its siblings only in the last segment, which
  // is exactly what a left-anchored input clips. While the field isn't being
  // edited, show the tail; the user's own caret wins once they're in it.
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input) return;
    input.scrollLeft = input.scrollWidth;
  }, [value]);

  return (
    <SlottedInputField
      ref={inputRef}
      id="worktree-path"
      data-testid="worktree-path-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        e.currentTarget.scrollLeft = e.currentTarget.scrollWidth;
      }}
      placeholder={platform === "win32" ? "C:\\path\\to\\worktree" : "/path/to/worktree"}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
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
  );
}

/** Rides the row's hint rail — see `BranchResolvedHint`. */
export function PathResolvedHint() {
  return (
    <p className="text-xs text-text-secondary" role="status" aria-live="polite">
      Renamed to avoid a conflict with an existing directory
    </p>
  );
}
