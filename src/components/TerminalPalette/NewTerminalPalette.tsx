import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import type { LaunchOption } from "./launchOptions";

interface NewTerminalPaletteProps {
  isOpen: boolean;
  query: string;
  results: LaunchOption[];
  totalResults?: number;
  selectedIndex: number;
  onQueryChange: (q: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (option: LaunchOption) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function NewTerminalPalette({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onConfirm,
  onClose,
}: NewTerminalPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          onConfirm();
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
      }
    },
    [onSelectPrevious, onSelectNext, onConfirm, onClose]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="New terminal palette">
      <AppPaletteDialog.Header label="New Terminal" keyHint="⌘N">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Select terminal type..."
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Select terminal type"
          aria-controls="new-terminal-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `new-terminal-option-${results[selectedIndex]!.id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="new-terminal-list" role="listbox" aria-label="Terminal types">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-daintree-text/50 text-sm">
              No terminal types match "{query}"
            </div>
          ) : (
            results.map((option, index) => (
              <button
                key={option.id}
                id={`new-terminal-option-${option.id}`}
                tabIndex={-1}
                onPointerDown={(e) => e.preventDefault()}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
                  index === selectedIndex
                    ? "bg-overlay-soft border-overlay text-daintree-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
                    : "border-transparent text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
                )}
                onClick={() => onSelect(option)}
              >
                <span className="shrink-0 text-daintree-text/70">{option.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-daintree-text">{option.label}</div>
                  <div className="text-xs text-daintree-text/50 truncate">{option.description}</div>
                </div>
              </button>
            ))
          )}
        </div>
        {totalResults != null && (
          <PaletteOverflowNotice shown={results.length} total={totalResults} />
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: "to launch" }}
          hints={[
            { keys: ["↑", "↓"], label: "to navigate" },
            { keys: ["↵"], label: "to launch" },
            { keys: ["Esc"], label: "to close" },
          ]}
        />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
