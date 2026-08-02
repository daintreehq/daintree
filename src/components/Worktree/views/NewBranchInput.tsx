import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Spinner } from "@/components/ui/Spinner";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import type { PrefixSuggestion } from "../branchPrefixUtils";

interface NewBranchInputProps {
  value: string;
  onChange: (value: string) => void;
  isPending?: boolean;
  isCheckingBranch: boolean;
  errorField?: "base-branch" | "new-branch" | "worktree-path" | null;
  branchWasAutoResolved: boolean;
  parsedBranch: { hasPrefix: boolean; prefix: string; slug: string; fullBranchName: string };
  prefixPickerOpen: boolean;
  onPrefixPickerOpenChange: (open: boolean) => void;
  prefixSuggestions: PrefixSuggestion[];
  prefixSelectedIndex: number;
  onPrefixKeyDown: (e: React.KeyboardEvent) => void;
  onPrefixSelect: (suggestion: PrefixSuggestion) => void;
  prefixListRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function NewBranchInput({
  value,
  onChange,
  isPending,
  isCheckingBranch,
  errorField,
  branchWasAutoResolved,
  parsedBranch,
  prefixPickerOpen,
  onPrefixPickerOpenChange,
  prefixSuggestions,
  prefixSelectedIndex,
  onPrefixKeyDown,
  onPrefixSelect,
  prefixListRef,
  inputRef,
}: NewBranchInputProps) {
  // isCheckingBranch goes true on every keystroke (it also gates submit), but
  // the debounced check usually resolves fast — only show the spinner for
  // genuinely slow validations.
  const showCheckingSpinner = useDohertyGate(isCheckingBranch);
  return (
    <div className="space-y-2">
      <label htmlFor="new-branch" className="block text-sm font-medium text-daintree-text">
        New Branch Name
      </label>
      <Popover open={prefixPickerOpen} onOpenChange={onPrefixPickerOpenChange}>
        <PopoverTrigger asChild>
          <div className="relative">
            <input
              ref={inputRef}
              id="new-branch"
              type="text"
              data-testid="branch-name-input"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onPrefixKeyDown}
              placeholder="feature/add-user-auth"
              className="w-full px-3 pr-10 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30 font-mono text-sm"
              disabled={isPending}
              aria-invalid={errorField === "new-branch" ? true : undefined}
              aria-describedby={
                [
                  errorField === "new-branch" ? "validation-error" : null,
                  branchWasAutoResolved ? "branch-resolved-hint" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              role="combobox"
              aria-autocomplete="list"
              aria-controls="prefix-list"
              aria-expanded={prefixPickerOpen}
            />
            {showCheckingSpinner && (
              <Spinner
                size="md"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-daintree-text/40 pointer-events-none"
              />
            )}
          </div>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <ScrollShadow
            ref={prefixListRef}
            id="prefix-list"
            role="listbox"
            className="max-h-[240px]"
            scrollClassName="p-1"
          >
            {prefixSuggestions.length === 0 ? (
              <div className="py-4 text-center text-sm text-daintree-text/60">
                No matching prefixes
              </div>
            ) : (
              prefixSuggestions.map((suggestion, index) => (
                <div
                  key={suggestion.type.prefix}
                  role="option"
                  aria-selected={index === prefixSelectedIndex}
                  onClick={() => onPrefixSelect(suggestion)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border",
                    index === prefixSelectedIndex && "bg-overlay-selected"
                  )}
                >
                  <span className="font-mono text-daintree-text">{suggestion.type.prefix}/</span>
                  <span className="text-daintree-text/60">{suggestion.type.displayName}</span>
                </div>
              ))
            )}
          </ScrollShadow>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-daintree-text/60 select-text">
        {parsedBranch.hasPrefix ? (
          <>
            <span className="font-mono text-daintree-text">{parsedBranch.prefix}/</span>
            <span className="font-mono">{parsedBranch.slug || "..."}</span>
          </>
        ) : (
          <span className="font-mono">{parsedBranch.fullBranchName || "..."}</span>
        )}
      </p>
      {branchWasAutoResolved && (
        <p
          id="branch-resolved-hint"
          className="text-xs text-status-success flex items-center gap-1.5 mt-1"
          role="status"
          aria-live="polite"
        >
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          Name auto-incremented to avoid conflict with existing branch
        </p>
      )}
    </div>
  );
}
