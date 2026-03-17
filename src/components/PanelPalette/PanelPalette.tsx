import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import type { PanelKindOption, PanelPalettePhase } from "@/hooks/usePanelPalette";
import { PanelKindIcon } from "./PanelKindIcon";

interface PanelPaletteProps {
  isOpen: boolean;
  phase: PanelPalettePhase;
  query: string;
  results: PanelKindOption[];
  totalResults?: number;
  selectedIndex: number;
  onQueryChange: (q: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (kind: PanelKindOption) => void;
  onConfirm: () => void;
  onClose: () => void;
  onBack: () => void;
}

const SECTION_LABELS: Record<"agent" | "tool", string> = {
  agent: "AI Agents",
  tool: "Tools",
};

export function PanelPalette({
  isOpen,
  phase,
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
  onBack,
}: PanelPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedIndex >= 0 && results[selectedIndex]) {
      const node = itemsRef.current.get(results[selectedIndex].id);
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results]);

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
          if (phase === "model") {
            onBack();
          } else {
            onClose();
          }
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
    [onSelectPrevious, onSelectNext, onConfirm, onClose, onBack, phase]
  );

  const isSearching = query.trim().length > 0;
  const isModelPhase = phase === "model";

  const headerLabel = isModelPhase ? "Select Model" : "New Panel";
  const placeholder = isModelPhase ? "Select a model..." : "Select a panel type...";
  const emptyMessage = isModelPhase
    ? `No models match "${query}"`
    : `No panel types match "${query}"`;
  const escHint = isModelPhase ? "to go back" : "to close";

  const renderOption = (kind: PanelKindOption, index: number) => (
    <button
      key={kind.id}
      id={`panel-option-${kind.id}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      role="option"
      aria-selected={index === selectedIndex}
      ref={(el) => {
        if (el) itemsRef.current.set(kind.id, el);
        else itemsRef.current.delete(kind.id);
      }}
      className={cn(
        "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
        index === selectedIndex
          ? "bg-overlay-soft border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "border-transparent text-canopy-text/70 hover:bg-overlay-subtle hover:text-canopy-text"
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
  );

  const renderSectionedList = () => {
    const agents = results.filter((r) => r.category === "agent");
    const tools = results.filter((r) => r.category === "tool");
    const elements: React.ReactNode[] = [];

    if (agents.length > 0) {
      elements.push(
        <div
          key="header-agent"
          className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-canopy-text/40 select-none"
          aria-hidden="true"
        >
          {SECTION_LABELS.agent}
        </div>
      );
      agents.forEach((kind) => {
        const index = results.indexOf(kind);
        elements.push(renderOption(kind, index));
      });
    }

    if (tools.length > 0) {
      elements.push(
        <div
          key="header-tool"
          className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-canopy-text/40 select-none"
          aria-hidden="true"
        >
          {SECTION_LABELS.tool}
        </div>
      );
      tools.forEach((kind) => {
        const index = results.indexOf(kind);
        elements.push(renderOption(kind, index));
      });
    }

    return elements;
  };

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Panel palette">
      <AppPaletteDialog.Header label={headerLabel} keyHint="⌘⇧P">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={isModelPhase ? "Select model" : "Select panel type"}
          aria-controls="panel-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `panel-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div id="panel-list" role="listbox" aria-label={isModelPhase ? "Models" : "Panel types"}>
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">{emptyMessage}</div>
          ) : isModelPhase || isSearching ? (
            results.map((kind, index) => renderOption(kind, index))
          ) : (
            renderSectionedList()
          )}
        </div>
        {totalResults != null && (
          <PaletteOverflowNotice shown={results.length} total={totalResults} />
        )}
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
          <span className="ml-1.5">{isModelPhase ? "to select" : "to create"}</span>
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            Esc
          </kbd>
          <span className="ml-1.5">{escHint}</span>
        </span>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
