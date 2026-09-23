import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import {
  AppPaletteDialog,
  PaletteFooterHints,
  PaletteNoMatchHint,
} from "@/components/ui/AppPaletteDialog";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useEscapeStack } from "@/hooks";
import { MORE_AGENTS_OPTION_ID, type LaunchOption } from "./launchOptions";

/**
 * The filter is a plain substring test on label and description
 * (`filterLaunchOptions`), so the substring is exactly the evidence.
 */
function substringRange(text: string, query: string): [number, number][] | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const at = text.toLowerCase().indexOf(q);
  return at < 0 ? undefined : [[at, at + q.length - 1]];
}

function footerLabel(option: LaunchOption): string {
  // The option's name stays as it is written: these are product names, and a
  // lowercased "claude" or "opencode" read as a typo.
  return option.id === MORE_AGENTS_OPTION_ID ? "to configure agents" : `to launch ${option.label}`;
}

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
        // Clear before close, claimed at the input because the dialog's
        // document-level backstop would otherwise close outright (see
        // SearchablePalette).
        case "Escape":
          if (query === "") break;
          e.preventDefault();
          e.stopPropagation();
          onQueryChange("");
          break;
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
        // First and last, as in every other palette (`SearchablePalette`). No-op
        // on an empty list so typing there isn't intercepted.
        case "Home":
          if (results.length === 0 || !onHoverIndex) break;
          e.preventDefault();
          e.stopPropagation();
          onHoverIndex(0);
          break;
        case "End":
          if (results.length === 0 || !onHoverIndex) break;
          e.preventDefault();
          e.stopPropagation();
          onHoverIndex(results.length - 1);
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
        case "Escape":
          // The escape-stack entry above never sees a press while the palette
          // is open — the dialog's document-level backstop closes it first — so
          // the field clears its own query. An empty field lets Escape close.
          if (query !== "") {
            e.preventDefault();
            e.stopPropagation();
            onQueryChange("");
          }
          break;
      }
    },
    [onSelectPrevious, onSelectNext, onConfirm, onHoverIndex, results.length, query, onQueryChange]
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
          // The listbox only exists while there are rows to put in it.
          aria-expanded={isOpen && results.length > 0}
          aria-label="Select terminal type"
          aria-controls={results.length > 0 ? "new-terminal-list" : undefined}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Terminal types"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
        keepPointerFocusOnInput
      >
        <div role="status" aria-live="polite" className="sr-only">
          {results.length} terminal types
        </div>
        {results.length === 0 ? (
          <AppPaletteDialog.Empty
            query={query}
            noMatchContent={<PaletteNoMatchHint what="all terminal types" />}
          />
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
                  "group w-full flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-md)] text-left",
                  "text-text-secondary hover:bg-overlay-subtle"
                )}
                onClick={() => onSelect(option)}
              >
                <span className="shrink-0 text-text-secondary">{option.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">
                    <HighlightedText
                      text={option.label}
                      indices={substringRange(option.label, query)}
                    />
                  </div>
                  <div className="text-xs text-text-secondary truncate">
                    <HighlightedText
                      text={option.description}
                      indices={
                        substringRange(option.label, query)
                          ? undefined
                          : substringRange(option.description, query)
                      }
                    />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </AppPaletteDialog.Body>

      {/* No selection, no band: "↵ to launch" over an empty list promised an
          Enter that does nothing. */}
      <AppPaletteDialog.Footer>
        {selectedOption && (
          <PaletteFooterHints primaryHint={{ keys: ["↵"], label: footerLabel(selectedOption) }} />
        )}
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
