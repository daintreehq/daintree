import { useCallback, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
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
  // Location first: it is the stronger identifier, and the one that must
  // survive when a long branch name pushes the line into its ellipsis.
  const meta = [item.location, item.modelName].filter(Boolean).join(" · ");
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
        // A removed-worktree row is inert: no hover lift promising an action
        // Enter will not take, and its title steps down the text hierarchy
        // rather than fading the whole row — the title is still what says
        // which session this was.
        item.isStale ? "cursor-default" : "hover:bg-overlay-subtle hover:text-text-primary"
      )}
      onClick={() => onSelect(item)}
    >
      <div className="shrink-0 mt-0.5">
        <PanelKindIcon iconId={item.iconId} color={item.color} size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <div
            className={cn(
              "flex-1 min-w-0 text-sm font-medium truncate",
              item.isStale ? "text-text-secondary" : "text-text-primary"
            )}
          >
            <HighlightedText text={item.title} indices={findMatchIndices(matches, "title")} />
          </div>
          {/* Recency is the strongest ranking signal a user has, so it gets a
              column of its own instead of the tail of a run of grey text — and
              it can never be the part that truncates. */}
          <span className="shrink-0 text-xs text-text-secondary tabular-nums">{item.timeAgo}</span>
        </div>
        {meta && <div className="text-xs text-text-secondary truncate">{meta}</div>}
      </div>
    </button>
  );
}

/**
 * The heading over the removed-worktree rows. While browsing it is a fold, so
 * the dead history is one line rather than the bulk of the list; while
 * searching the rows are always shown and this is just their label. Inside
 * the listbox, so `tabIndex={-1}` and pointer-only: the rows under it cannot
 * take the selection anyway (#10851), so there is nothing for the keyboard
 * to reach by opening it.
 */
function RemovedHeading({
  id,
  count,
  expanded,
  collapsible,
  onToggle,
}: {
  id: string;
  count: number;
  expanded: boolean;
  collapsible: boolean;
  onToggle: () => void;
}) {
  const className = cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1 px-3 pt-3 pb-1");
  if (!collapsible) {
    return (
      <div id={id} role="presentation" className={className}>
        Worktree removed
      </div>
    );
  }
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div role="presentation">
      <button
        id={id}
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(className, "w-full text-left transition-colors hover:text-text-primary")}
      >
        <Chevron className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>Worktree removed</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{count}</span>
      </button>
    </div>
  );
}

const REMOVED_HEADING_ID = "resume-session-removed-heading";

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
    removedResults,
    removedVisible,
    toggleRemoved,
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
              {!isSearching && hiddenCount > 0 && (
                <div role="presentation">
                  <button
                    type="button"
                    tabIndex={-1}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={showMore}
                    className="w-full px-3 py-2 rounded-[var(--radius-md)] text-xs text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary"
                  >
                    Load more ({hiddenCount})
                  </button>
                </div>
              )}
              {removedResults.length > 0 && (
                <>
                  <RemovedHeading
                    id={REMOVED_HEADING_ID}
                    count={removedResults.length}
                    expanded={removedVisible}
                    collapsible={!isSearching}
                    onToggle={toggleRemoved}
                  />
                  {removedVisible && (
                    // The heading names the group for assistive tech too, so a
                    // row read out of it is announced as one whose worktree is gone.
                    <div role="group" aria-labelledby={REMOVED_HEADING_ID}>
                      {removedResults.map(renderRow)}
                    </div>
                  )}
                </>
              )}
            </div>
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
        {/* Only while Enter would do something. With nothing resumable on
            screen — empty, no match, every worktree gone — the band would be
            promising an action, and the footer primitive drops itself. */}
        {selected && (
          <PaletteFooterHints
            primaryHint={{
              keys: ["↵"],
              // The title keeps its own case: these are sentences with names in
              // them, not the noun a sibling palette lowercases.
              label: `to resume ${selected.title}`,
            }}
          />
        )}
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
