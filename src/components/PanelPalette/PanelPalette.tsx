import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import type { PanelKindOption } from "@/hooks/usePanelPalette";
import { PanelKindIcon } from "./PanelKindIcon";

interface PanelPaletteProps {
  isOpen: boolean;
  kinds: PanelKindOption[];
  selectedIndex: number;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (kind: PanelKindOption) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function PanelPalette({
  isOpen,
  kinds,
  selectedIndex,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onConfirm,
  onClose,
}: PanelPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => comboboxRef.current?.focus());
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
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Panel palette">
      <AppPaletteDialog.Header label="New Panel" keyHint="⌘⇧P">
        <div
          ref={comboboxRef}
          role="combobox"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="px-3 py-2 text-sm text-canopy-text/70"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Select panel type"
          aria-controls="panel-list"
          aria-activedescendant={
            kinds.length > 0 && selectedIndex >= 0 && selectedIndex < kinds.length
              ? `panel-option-${kinds[selectedIndex].id}`
              : undefined
          }
        >
          Select a panel type to create
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="panel-list" role="listbox" aria-label="Panel types">
          {kinds.length === 0 ? (
            <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
              No panel types available
            </div>
          ) : (
            kinds.map((kind, index) => (
              <button
                key={kind.id}
                id={`panel-option-${kind.id}`}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
                  index === selectedIndex
                    ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                    : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
                )}
                onClick={() => onSelect(kind)}
              >
                <div className="shrink-0">
                  <PanelKindIcon iconId={kind.iconId} color={kind.color} size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-canopy-text">{kind.name}</div>
                  {kind.description && (
                    <div className="text-xs text-canopy-text/50 truncate">{kind.description}</div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            ↑
          </kbd>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60 ml-1">
            ↓
          </kbd>
          <span className="ml-1.5">to navigate</span>
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            Enter
          </kbd>
          <span className="ml-1.5">to create</span>
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            Esc
          </kbd>
          <span className="ml-1.5">to close</span>
        </span>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
