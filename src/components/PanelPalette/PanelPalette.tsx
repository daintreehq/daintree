import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import type { PanelKindOption } from "@/hooks/usePanelPalette";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { PanelKindIcon } from "./PanelKindIcon";
import { usePanelStore } from "@/store/panelStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";

interface PanelPaletteProps {
  isOpen: boolean;
  query: string;
  results: PanelKindOption[];
  totalResults?: number;
  selectedIndex: number;
  matchesById: Map<string, readonly FuseResultMatch[]>;
  onQueryChange: (q: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (kind: PanelKindOption) => void;
  onConfirm: () => void;
  onClose: () => void;
}

function HighlightText({
  text,
  indices,
}: {
  text: string;
  indices: readonly [number, number][] | undefined;
}) {
  if (!indices?.length) return <>{text}</>;
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  sorted.forEach(([start, end], i) => {
    if (start > lastIndex) parts.push(text.substring(lastIndex, start));
    parts.push(
      <mark key={i} className="bg-daintree-accent/25 text-inherit rounded-sm">
        {text.substring(start, end + 1)}
      </mark>
    );
    lastIndex = end + 1;
  });
  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return <>{parts}</>;
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
  matchesById,
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

  const panelCount = usePanelStore((state) => {
    let count = 0;
    for (const id of state.panelIds) {
      const t = state.panelsById[id];
      if (t && t.location !== "trash") count++;
    }
    return count;
  });
  const hardLimit = usePanelLimitStore((state) => state.hardLimit);
  const keyHint = useKeybindingDisplay("panel.palette");
  const showCounter = hardLimit > 0 && panelCount / hardLimit >= 0.75;

  const isSearching = query.trim().length > 0;

  const renderOption = (kind: PanelKindOption, index: number) => {
    const isUnavailable = kind.installed === false;
    return (
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
            ? "bg-overlay-soft border-overlay text-daintree-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
            : "border-transparent text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text",
          isUnavailable && "opacity-50"
        )}
        onClick={() => onSelect(kind)}
      >
        <div className="shrink-0">
          <PanelKindIcon iconId={kind.iconId} color={kind.color} size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-daintree-text">
            {(() => {
              const kindMatches = matchesById.get(kind.id);
              const nameMatch = kindMatches?.find((m) => m.key === "name");
              return nameMatch ? (
                <HighlightText text={kind.name} indices={nameMatch.indices} />
              ) : (
                kind.name
              );
            })()}
          </div>
          {kind.description && (
            <div className="text-xs text-daintree-text/50 truncate">{kind.description}</div>
          )}
        </div>
        {isUnavailable && (
          <span className="shrink-0 text-[10px] font-medium text-daintree-text/40">
            Not installed
          </span>
        )}
      </button>
    );
  };

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
          className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-daintree-text/40 select-none"
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
    renderSection("tool", tools);
    renderSection("resume", resumeSessions);

    return elements;
  };

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Panel palette">
      <AppPaletteDialog.Header
        label={showCounter ? `New Panel (${panelCount} / ${hardLimit})` : "New Panel"}
        keyHint={keyHint || undefined}
      >
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
            <div className="px-3 py-8 text-center text-daintree-text/50 text-sm">{`No panel types match "${query}"`}</div>
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
