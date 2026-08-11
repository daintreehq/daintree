import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useEscapeStack } from "@/hooks";
import type { LaunchOption } from "./launchOptions";

interface NewTerminalPaletteProps {
  isOpen: boolean;
  query: string;
  results: LaunchOption[];
  selectedIndex: number;
  onQueryChange: (q: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (option: LaunchOption) => void;
  onConfirm: () => void;
  onClose: () => void;
  onHoverIndex?: (index: number) => void;
}

export function NewTerminalPalette({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onConfirm,
  onClose,
  onHoverIndex,
}: NewTerminalPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newTerminalShortcut = useEffectiveCombo("terminal.new");

  useEffect(() => {
    if (isOpen) {
      const rafId = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(rafId);
    }
    return undefined;
  }, [isOpen]);

  useEscapeStack(isOpen, () => {
    if (query !== "") {
      onQueryChange("");
    } else {
      onClose();
    }
  });

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          onConfirm();
          break;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
      }
    },
    [onSelectPrevious, onSelectNext, onConfirm]
  );

  const selectedOption =
    selectedIndex >= 0 && selectedIndex < results.length ? results[selectedIndex] : null;
  const activeDescendant = selectedOption ? `new-terminal-option-${selectedOption.id}` : undefined;

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="New terminal palette"
      tier="anchored"
    >
      <AppPaletteDialog.Header label="New terminal" shortcut={newTerminalShortcut}>
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search terminal types"
          role="combobox"
          aria-expanded={isOpen}
          aria-label="Select terminal type"
          aria-controls="new-terminal-list"
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Terminal types"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
      >
        <div role="status" aria-live="polite" className="sr-only">
          {results.length} terminal types
        </div>
        {results.length === 0 ? (
          <AppPaletteDialog.Empty query={query} />
        ) : (
          <div ref={listRef} id="new-terminal-list" role="listbox" aria-label="Terminal types">
            {results.map((option, index) => (
              <button
                key={option.id}
                id={`new-terminal-option-${option.id}`}
                tabIndex={-1}
                onPointerDown={(e) => e.preventDefault()}
                onPointerMove={() => onHoverIndex?.(index)}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  PALETTE_ROW_CLASS,
                  "group w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
                  "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
                )}
                onClick={() => onSelect(option)}
              >
                <span className="shrink-0 text-daintree-text/70">{option.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-daintree-text truncate">
                    {option.label}
                  </div>
                  <div className="text-xs text-daintree-text/50 truncate">{option.description}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <PaletteFooterHints
          primaryHint={{
            keys: ["↵"],
            label: selectedOption ? `to launch ${selectedOption.label.toLowerCase()}` : "to launch",
          }}
        />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
