import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Spinner } from "@/components/ui/Spinner";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { cn } from "@/lib/utils";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { FIELD_INPUT } from "./WorktreeFormLayout";
import type { PrefixSuggestion } from "../branchPrefixUtils";

interface NewBranchInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: React.FocusEventHandler<HTMLInputElement>;
  isPending?: boolean;
  isCheckingBranch: boolean;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  branchWasAutoResolved: boolean;
  prefixPickerOpen: boolean;
  onPrefixPickerOpenChange: (open: boolean) => void;
  prefixSuggestions: PrefixSuggestion[];
  prefixSelectedIndex: number;
  onPrefixKeyDown: (e: React.KeyboardEvent) => void;
  onPrefixSelect: (suggestion: PrefixSuggestion) => void;
  onPrefixCursorChange: (index: number) => void;
  onPrefixInputFocus: () => void;
  prefixListRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * Control only — "Name" lives on the form's label rail.
 *
 * The old mono echo line under this input is gone: it restated the input's own
 * value, and rendered a bare "..." before anything was typed, which read as a
 * broken field. The base → branch preview in the dialog footer does that job
 * once, for the whole form.
 */
export function NewBranchInput({
  value,
  onChange,
  onBlur,
  isPending,
  isCheckingBranch,
  errorField,
  branchWasAutoResolved,
  prefixPickerOpen,
  onPrefixPickerOpenChange,
  prefixSuggestions,
  prefixSelectedIndex,
  onPrefixKeyDown,
  onPrefixSelect,
  onPrefixCursorChange,
  onPrefixInputFocus,
  prefixListRef,
  inputRef,
}: NewBranchInputProps) {
  // isCheckingBranch goes true on every keystroke (it also gates submit), but
  // the debounced check usually resolves fast — only show the spinner for
  // genuinely slow validations.
  const showCheckingSpinner = useDohertyGate(isCheckingBranch);
  const hasError = errorField === "new-branch";

  return (
    <div className="space-y-1.5">
      {/* Anchor, not trigger: this list is opened by typing, never by clicking.
          As a trigger, Radix bound a toggle to the field itself, so clicking
          into your own text to fix a typo dismissed the suggestions. An anchor
          alone is not enough — with no trigger registered, Radix reads a click
          in the input as an interaction OUTSIDE the list — so the content below
          also vetoes dismissal for targets inside the field. */}
      <Popover open={prefixPickerOpen} onOpenChange={onPrefixPickerOpenChange}>
        <PopoverAnchor asChild>
          <div className="relative">
            <input
              ref={inputRef}
              id="new-branch"
              type="text"
              data-testid="branch-name-input"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              onFocus={onPrefixInputFocus}
              onKeyDown={onPrefixKeyDown}
              placeholder="feature/add-user-auth"
              className={cn(
                FIELD_INPUT,
                "pr-9 font-mono text-xs",
                hasError && "border-status-error"
              )}
              disabled={isPending}
              aria-invalid={hasError ? true : undefined}
              aria-describedby={
                [
                  hasError ? "validation-error" : null,
                  branchWasAutoResolved ? "branch-resolved-hint" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              role="combobox"
              aria-autocomplete="list"
              aria-controls="prefix-list"
              aria-expanded={prefixPickerOpen}
              aria-activedescendant={
                prefixPickerOpen && prefixSuggestions.length > 0
                  ? `prefix-option-${prefixSelectedIndex}`
                  : undefined
              }
            />
            {showCheckingSpinner && (
              <Spinner
                size="sm"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
              />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onInteractOutside={(event) => {
            const target = event.detail.originalEvent.target;
            if (target instanceof Node && inputRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
        >
          <ScrollShadow
            ref={prefixListRef}
            id="prefix-list"
            role="listbox"
            className="max-h-[240px]"
            scrollClassName="p-1"
          >
            {prefixSuggestions.length === 0 ? (
              <div className="py-4 text-center text-sm text-text-secondary">
                No matching prefixes
              </div>
            ) : (
              prefixSuggestions.map((suggestion, index) => (
                <div
                  key={suggestion.type.prefix}
                  id={`prefix-option-${index}`}
                  role="option"
                  aria-selected={index === prefixSelectedIndex}
                  // Pointer-move rather than hover styling, so the pointer and
                  // the arrow keys drive one cursor — the same model the branch
                  // picker uses two rows up in this form.
                  onPointerMove={() => onPrefixCursorChange(index)}
                  onClick={() => onPrefixSelect(suggestion)}
                  className={cn(
                    PALETTE_ROW_CLASS,
                    "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer"
                  )}
                >
                  <span className="font-mono text-xs text-daintree-text">
                    {suggestion.type.prefix}/
                  </span>
                  <span className="text-text-secondary">{suggestion.type.displayName}</span>
                </div>
              ))
            )}
          </ScrollShadow>
        </PopoverContent>
      </Popover>
      {branchWasAutoResolved && (
        <p
          id="branch-resolved-hint"
          className="text-xs text-text-secondary"
          role="status"
          aria-live="polite"
        >
          Renamed to avoid a conflict with an existing branch
        </p>
      )}
    </div>
  );
}
