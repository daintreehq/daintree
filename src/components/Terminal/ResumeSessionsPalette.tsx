import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { HighlightedText, findMatchIndices } from "@/components/ui/HighlightedText";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useResumeSessionsPalette } from "@/hooks/useResumeSessionsPalette";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import type { ResumeSessionItem } from "@/services/resumeSessionItems";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

interface ResumeSessionRowProps {
  item: ResumeSessionItem;
  isSelected: boolean;
  matches: readonly FuseResultMatch[] | undefined;
  onSelect: (item: ResumeSessionItem) => void;
  itemRef: (el: HTMLElement | null) => void;
}

function ResumeSessionRow({ item, isSelected, matches, onSelect, itemRef }: ResumeSessionRowProps) {
  return (
    <button
      id={`resume-session-option-${item.id}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      role="option"
      aria-selected={isSelected}
      aria-disabled={item.isStale || undefined}
      ref={itemRef}
      className={cn(
        "relative w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
        isSelected
          ? "bg-overlay-raised border-overlay text-daintree-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:bg-daintree-accent before:content-['']"
          : "border-transparent text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text",
        item.isStale && "opacity-50"
      )}
      onClick={() => onSelect(item)}
    >
      <div className="shrink-0 mt-0.5">
        <PanelKindIcon iconId={item.iconId} color={item.color} size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-daintree-text truncate">
          <HighlightedText text={item.name} indices={findMatchIndices(matches, "name")} />
        </div>
        {item.description && (
          <div className="text-xs text-daintree-text/50 truncate">{item.description}</div>
        )}
      </div>
      {item.isStale && (
        <span className="shrink-0 mt-0.5 text-[10px] font-medium text-daintree-text/40">
          Worktree removed
        </span>
      )}
    </button>
  );
}

export function ResumeSessionsPalette() {
  const {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    matchesById,
    setQuery,
    selectPrevious,
    selectNext,
    close,
    isLoading,
  } = useResumeSessionsPalette();

  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());
  const shortcut = useEffectiveCombo("terminal.resumeSessions");
  const resume = useResumeAgentSession();

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedIndex >= 0 && results[selectedIndex]) {
      const node = itemsRef.current.get(results[selectedIndex]!.id);
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results]);

  const launch = useCallback(
    (item: ResumeSessionItem) => {
      // Stale entries (removed worktree) can't be resumed — swallow the click.
      if (item.isStale) return;
      close();
      void resume(item.session);
    },
    [close, resume]
  );

  const handleConfirm = useCallback(() => {
    const selected = selectedIndex >= 0 ? results[selectedIndex] : undefined;
    if (selected) launch(selected);
  }, [results, selectedIndex, launch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          selectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          selectNext();
          break;
        case "Enter":
          e.preventDefault();
          handleConfirm();
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) selectPrevious();
          else selectNext();
          break;
      }
    },
    [selectPrevious, selectNext, handleConfirm, close]
  );

  const setItemRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) itemsRef.current.set(id, el);
      else itemsRef.current.delete(id);
    },
    []
  );

  const isSearching = query.trim().length > 0;

  const renderRow = (item: ResumeSessionItem) => {
    const index = results.indexOf(item);
    return (
      <ResumeSessionRow
        key={item.id}
        item={item}
        isSelected={index === selectedIndex}
        matches={matchesById.get(item.id)}
        onSelect={launch}
        itemRef={setItemRef(item.id)}
      />
    );
  };

  // Grouped by worktree when browsing; flat, relevance-ordered while searching.
  // Items arrive newest-first, so a keyed Map yields correct group order and
  // intra-group recency for free. Sub-headers stay aria-hidden (never
  // role="group", #9006) and are excluded from the selection-driving results.
  const renderGrouped = () => {
    const groups = new Map<string, ResumeSessionItem[]>();
    for (const item of results) {
      const bucket = groups.get(item.groupKey);
      if (bucket) bucket.push(item);
      else groups.set(item.groupKey, [item]);
    }
    const elements: React.ReactNode[] = [];
    for (const [groupKey, groupItems] of groups) {
      const label = groupItems[0]?.groupLabel;
      if (label) {
        elements.push(
          <div
            key={`resume-group-${groupKey}`}
            className="px-3 pt-3 pb-1 text-[10px] font-medium text-daintree-text/40 select-none truncate"
            aria-hidden="true"
          >
            {label}
          </div>
        );
      }
      for (const item of groupItems) elements.push(renderRow(item));
    }
    return elements;
  };

  const selected = selectedIndex >= 0 ? results[selectedIndex] : undefined;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={close} ariaLabel="Resume session">
      <AppPaletteDialog.Header label="Resume session" shortcut={shortcut} isLoading={isLoading}>
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search closed sessions…"
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label="Search closed sessions"
          aria-controls="resume-session-list"
          aria-activedescendant={selected ? `resume-session-option-${selected.id}` : undefined}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        {results.length === 0 ? (
          isLoading ? null : (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No closed sessions yet"
              noMatchMessage={`No sessions match "${query.length > 40 ? query.slice(0, 40) + "…" : query}"`}
            >
              <p className="mt-2 text-xs text-daintree-text/40">
                Sessions you close appear here so you can pick them back up later.
              </p>
            </AppPaletteDialog.Empty>
          )
        ) : (
          <>
            <div id="resume-session-list" role="listbox" aria-label="Closed sessions">
              {isSearching ? results.map(renderRow) : renderGrouped()}
            </div>
            {totalResults != null && (
              <PaletteOverflowNotice shown={results.length} total={totalResults} />
            )}
          </>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <PaletteFooterHints
          primaryHint={{
            keys: ["↵"],
            label: selected ? `to resume ${selected.name.toLowerCase()}` : "to resume",
          }}
          hints={[
            { keys: ["↑", "↓"], label: "navigate" },
            { keys: ["Esc"], label: "close" },
          ]}
        />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
