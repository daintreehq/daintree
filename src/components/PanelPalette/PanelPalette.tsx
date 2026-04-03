import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import type { PanelKindOption } from "@/hooks/usePanelPalette";
import { PanelKindIcon } from "./PanelKindIcon";
import { useTerminalStore } from "@/store/terminalStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";

interface PanelPaletteProps {
  isOpen: boolean;
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
}

const SECTION_LABELS: Record<"agent" | "tool" | "resume", string> = {
  agent: "AI Agents",
  resume: "Resume Sessions",
  tool: "Tools",
};

export function PanelPalette({
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

  const panelCount = useTerminalStore((state) => {
    let count = 0;
    for (const id of state.terminalIds) {
      const t = state.terminalsById[id];
      if (t && t.location !== "trash") count++;
    }
    return count;
  });
  const hardLimit = usePanelLimitStore((state) => state.hardLimit);

  const isSearching = query.trim().length > 0;

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
    const resumeSessions = results.filter((r) => r.category === "resume");
    const tools = results.filter((r) => r.category === "tool");
    const elements: React.ReactNode[] = [];

    const renderSection = (key: "agent" | "resume" | "tool", items: typeof results) => {
      if (items.length === 0) return;
      elements.push(
        <div
          key={`header-${key}`}
          className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-canopy-text/40 select-none"
          aria-hidden="true"
        >
          {SECTION_LABELS[key]}
        </div>
      );
      items.forEach((kind) => {
        const index = results.indexOf(kind);
        elements.push(renderOption(kind, index));
      });
    };

    renderSection("agent", agents);
    renderSection("resume", resumeSessions);
    renderSection("tool", tools);

    return elements;
  };

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Panel palette">
      <AppPaletteDialog.Header label={`New Panel (${panelCount} / ${hardLimit})`} keyHint="⌘⇧P">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Select a panel type..."
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Select panel type"
          aria-controls="panel-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `panel-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div id="panel-list" role="listbox" aria-label="Panel types">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">{`No panel types match "${query}"`}</div>
          ) : isSearching ? (
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
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: "to create" }}
          hints={[
            { keys: ["↑", "↓"], label: "to navigate" },
            { keys: ["↵"], label: "to create" },
            { keys: ["Esc"], label: "to close" },
          ]}
        />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
