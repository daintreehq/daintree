import { useCallback, useEffect, useRef } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { ChevronRight } from "lucide-react";
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
import { keyBelongsToField } from "@/hooks/useListboxCursor";

interface ResumeSessionRowProps {
  item: ResumeSessionItem;
  isSelected: boolean;
  matches: readonly FuseResultMatch[] | undefined;
  onSelect: (item: ResumeSessionItem) => void;
  onHover: () => void;
  itemRef: (el: HTMLElement | null) => void;
}

function ResumeSessionRow({
  item,
  isSelected,
  matches,
  onSelect,
  onHover,
  itemRef,
}: ResumeSessionRowProps) {
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
        "w-full flex items-start gap-3 px-3 rounded-[var(--radius-md)] text-left",
        meta ? "py-2" : "py-1.5",
        "text-text-secondary",
        // A removed-worktree row is inert: it never takes the cursor, so the
        // pointer lights nothing Enter will not act on, and its title steps down
        // the text hierarchy rather than fading the whole row — the title is
        // still what says which session this was.
        item.isStale && "cursor-default"
      )}
      // The pointer moves the one cursor rather than painting a second row, so
      // the lit row is always the one Enter resumes. `pointermove`, not
      // `pointerenter`: rows scrolling under a resting pointer must not steal it.
      onPointerMove={item.isStale ? undefined : onHover}
      onClick={() => onSelect(item)}
    >
      <div className="shrink-0 mt-0.5">
        <PanelKindIcon iconId={item.iconId} color={item.color} size={16} />
        {/* The glyph is aria-hidden; without this two agents' rows with the
            same title read identically. */}
        <span className="sr-only">{item.agentName} </span>
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
 * searching the rows are always shown and this is just their label. Pointer
 * only (`tabIndex={-1}`), like the project switcher's band folds: the rows
 * under it cannot take the selection anyway (#10851), so there is nothing for
 * the keyboard to reach by opening it, and search shows them regardless.
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
      <div id={id} className={className}>
        Worktree removed
      </div>
    );
  }
  return (
    <div>
      <button
        id={id}
        type="button"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(className, "w-full text-left transition-colors hover:text-text-primary")}
      >
        <ChevronRight
          data-animated-chevron
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
          aria-hidden="true"
        />
        <span>Worktree removed</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{count}</span>
      </button>
    </div>
  );
}

const LIST_ID = "resume-session-list";
const REMOVED_LIST_ID = "resume-session-removed-list";
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
    setSelectedIndex,
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
      // A row under the pointer was just claimed by it; revealing it would
      // scroll a half-visible row out from under the pointer.
      if (isPointerClaimed(node)) return;
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

  // A row can go stale under the selection (its worktree deleted while the
  // palette is open); the shared hook re-validates on the next commit, but
  // nothing here may point at it in the meantime.
  const selected =
    selectedIndex >= 0 && results[selectedIndex] && !results[selectedIndex]!.isStale
      ? results[selectedIndex]
      : undefined;

  const handleConfirm = useCallback(() => {
    if (selected) launch(selected);
  }, [selected, launch]);

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
        // First and last, as in every other palette. Shift+Home selects the
        // query instead, and an empty list leaves the keys to the caret.
        case "Home":
        case "End": {
          if (keyBelongsToField(e)) break;
          // Removed-worktree rows are never selectable; the ends are the live rows.
          const live = results.flatMap((item, index) => (item.isStale ? [] : [index]));
          const target = (e.key === "Home" ? live[0] : live[live.length - 1]) ?? -1;
          if (target < 0) break;
          e.preventDefault();
          setSelectedIndex(target);
          break;
        }
        case "Enter":
          e.preventDefault();
          handleConfirm();
          break;
        case "Escape":
          // An IME spends Escape cancelling its candidate; leave the query alone.
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) break;
          e.preventDefault();
          // A query clears before the palette closes, as in every SearchablePalette.
          // Stopped so the dialog's document-level Escape backstop cannot close it.
          if (query !== "") {
            e.stopPropagation();
            setQuery("");
          } else {
            close();
          }
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) selectPrevious();
          else selectNext();
          break;
      }
    },
    [selectPrevious, selectNext, handleConfirm, close, query, setQuery, results, setSelectedIndex]
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
        onHover={() => {
          if (index !== selectedIndex) setSelectedIndex(index);
        }}
        itemRef={setItemRef(item.id)}
      />
    );
  };

  const activeDescendant = selected ? `resume-session-option-${selected.id}` : undefined;
  // Options live in two listboxes — the resumable rows, and the removed rows
  // under their heading — so the paging and fold controls between them are
  // never children of a listbox. The combobox controls whichever are rendered.
  const showList = visibleResults.length > 0;
  const showRemovedList = removedResults.length > 0 && removedVisible;
  const controlledIds = [showList && LIST_ID, showRemovedList && REMOVED_LIST_ID]
    .filter((id): id is string => !!id)
    .join(" ");
  const hasList = controlledIds.length > 0;

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
          // The listbox only exists once there are rows; an expanded combobox
          // controlling an id that is not in the tree points at nothing.
          aria-expanded={hasList}
          aria-haspopup="listbox"
          aria-label="Search closed sessions"
          aria-controls={hasList ? controlledIds : undefined}
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
            {showList && (
              <div id={LIST_ID} role="listbox" aria-label="Closed sessions">
                {visibleResults.map(renderRow)}
              </div>
            )}
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
            {removedResults.length > 0 && (
              <>
                <RemovedHeading
                  id={REMOVED_HEADING_ID}
                  count={removedResults.length}
                  expanded={removedVisible}
                  // A fold needs something to fold under: with nothing
                  // resumable the history is all there is, so the heading
                  // is a label and the chevron makes no promise.
                  collapsible={!isSearching && showList}
                  onToggle={toggleRemoved}
                />
                {showRemovedList && (
                  // Its own listbox, named by the heading, so a row read out
                  // of it is announced as one whose worktree is gone.
                  <div id={REMOVED_LIST_ID} role="listbox" aria-labelledby={REMOVED_HEADING_ID}>
                    {removedResults.map(renderRow)}
                  </div>
                )}
              </>
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
