import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
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
        PALETTE_ROW_CLASS,
        "w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "text-text-secondary",
        "hover:bg-overlay-subtle hover:text-text-primary",
        item.isStale && "opacity-50"
      )}
      onClick={() => onSelect(item)}
    >
      <div className="shrink-0 mt-0.5">
        <PanelKindIcon iconId={item.iconId} color={item.color} size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          <HighlightedText text={item.name} indices={findMatchIndices(matches, "name")} />
        </div>
        {item.description && (
          <div className="text-xs text-text-secondary truncate">{item.description}</div>
        )}
      </div>
      {item.isStale && (
        <span className="shrink-0 mt-0.5 text-3xs font-medium text-text-secondary">
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
    isSearching,
    visibleResults,
    hiddenCount,
    showMore,
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

  // Depends on visibleResults (not results) so arrowing past the visible end —
  // which lazily reveals the next page — re-runs once the row actually exists.
  useEffect(() => {
    if (selectedIndex >= 0 && results[selectedIndex]) {
      const node = itemsRef.current.get(results[selectedIndex]!.id);
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results, visibleResults]);

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

  const selected = selectedIndex >= 0 ? results[selectedIndex] : undefined;
  const activeDescendant = selected ? `resume-session-option-${selected.id}` : undefined;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={close} ariaLabel="Resume session" tier="command">
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
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Closed sessions"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
      >
        {results.length === 0 ? (
          isLoading ? null : (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No closed sessions yet"
              noMatchMessage={`No sessions match "${query.length > 40 ? query.slice(0, 40) + "…" : query}"`}
            >
              <p className="mt-2 text-xs text-text-secondary">
                Sessions you close appear here so you can pick them back up later.
              </p>
            </AppPaletteDialog.Empty>
          )
        ) : (
          <>
            <div id="resume-session-list" role="listbox" aria-label="Closed sessions">
              {visibleResults.map(renderRow)}
            </div>
            {!isSearching && hiddenCount > 0 && (
              <button
                type="button"
                tabIndex={-1}
                onPointerDown={(e) => e.preventDefault()}
                onClick={showMore}
                className="w-full px-3 py-2 rounded-[var(--radius-md)] text-xs text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary"
              >
                Load more ({hiddenCount})
              </button>
            )}
            {/* Fully-paged browse and search both surface records beyond the
                result cap — search is the only way to reach them. The notice
                self-hides when nothing overflows. */}
            {hiddenCount === 0 && totalResults != null && (
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
        />
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
