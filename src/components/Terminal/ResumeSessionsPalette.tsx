import { useCallback, useEffect, useMemo, useRef } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AppPaletteDialog,
  PaletteFooterHints,
  PaletteNoMatchHint,
  type PaletteCloseReason,
} from "@/components/ui/AppPaletteDialog";
import { Callout } from "@/components/ui/Callout";
import { Button } from "@/components/ui/button";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { HighlightedText, findMatchIndices } from "@/components/ui/HighlightedText";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { CalendarClock } from "@/components/icons";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useResumeSessionsPalette } from "@/hooks/useResumeSessionsPalette";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import type { ResumeSessionItem } from "@/services/resumeSessionItems";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { keyBelongsToField } from "@/hooks/useListboxCursor";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";

let closedAtFormatter: Intl.DateTimeFormat | undefined;
let closedAtSecondsFormatter: Intl.DateTimeFormat | undefined;

/** "Oct 13, 2:14 PM", or "Oct 13, 2:14:05 PM" when the minute is not enough. */
function formatClosedAt(timestamp: number, withSeconds: boolean): string {
  const formatter = withSeconds
    ? (closedAtSecondsFormatter ??= new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }))
    : (closedAtFormatter ??= new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }));
  return formatter.format(new Date(timestamp));
}

function groupBy(
  items: readonly ResumeSessionItem[],
  key: (item: ResumeSessionItem) => string
): ResumeSessionItem[][] {
  const groups = new Map<string, ResumeSessionItem[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

/**
 * The exact close time for rows that would otherwise read identically — same
 * agent, title, place, model and age, which untitled sessions in one worktree
 * routinely are. Only these carry it, so the line stays short everywhere else,
 * and seconds appear only where two of them closed in the same minute.
 */
function closedAtForCollisions(items: readonly ResumeSessionItem[]): Map<string, string> {
  const closedAt = new Map<string, string>();
  const lookalikes = groupBy(items, (item) =>
    [
      item.session.agentId,
      item.title,
      item.location,
      item.schedule?.label,
      item.modelName,
      item.timeAgo,
    ].join("\u0000")
  ).filter((group) => group.length > 1);
  for (const group of lookalikes) {
    for (const sameMinute of groupBy(group, (item) =>
      formatClosedAt(item.session.savedAt, false)
    )) {
      const withSeconds = sameMinute.length > 1;
      for (const item of sameMinute) {
        closedAt.set(item.id, formatClosedAt(item.session.savedAt, withSeconds));
      }
    }
  }
  return closedAt;
}

interface ResumeSessionRowProps {
  item: ResumeSessionItem;
  /** Set when another visible row reads the same; the meta line adds it. */
  closedAt: string | undefined;
  isSelected: boolean;
  matches: readonly FuseResultMatch[] | undefined;
  onSelect: (item: ResumeSessionItem) => void;
  onHover: () => void;
  itemRef: (el: HTMLElement | null) => void;
}

function ResumeSessionRow({
  item,
  closedAt,
  isSelected,
  matches,
  onSelect,
  onHover,
  itemRef,
}: ResumeSessionRowProps) {
  // Location first: it is the stronger identifier, and the one that must
  // survive when a long branch name pushes the line into its ellipsis. A
  // scheduled run's schedule follows it, behind the schedule mark.
  const scheduleLabel = item.schedule?.label;
  const lead = item.location ?? "";
  const rest = [item.modelName, closedAt].filter(Boolean).join(" · ");
  const meta = [item.location, scheduleLabel, item.modelName, closedAt].filter(Boolean).join(" · ");
  const optionId = `resume-session-option-${item.id}`;
  return (
    <button
      id={optionId}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      role="option"
      aria-selected={isSelected}
      aria-disabled={item.isStale || undefined}
      // Named by title then agent, with where and when as the description, so
      // each arrow press speaks the title first rather than a run-on of every
      // text node in the row.
      aria-labelledby={`${optionId}-title ${optionId}-agent`}
      aria-describedby={meta ? `${optionId}-meta ${optionId}-age` : `${optionId}-age`}
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
        <span id={`${optionId}-agent`} className="sr-only">
          {item.agentName}
        </span>
        {/* The visible age is a bare "5m ago"; spoken after the location it
            needs its verb. The removed listbox's name already says the
            worktree is gone, so the row does not repeat it. */}
        <span id={`${optionId}-age`} className="sr-only">
          closed {item.timeAgo}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          {/* The whole title, one hover away, for the rows the ellipsis cuts.
              Not focusable: the option is the keyboard's target, driven by
              aria-activedescendant, and the footer names the full title. */}
          <TruncatedTooltip content={item.title} focusable={false}>
            <div
              id={`${optionId}-title`}
              className={cn(
                "flex-1 min-w-0 text-sm font-medium truncate",
                item.isStale ? "text-text-secondary" : "text-text-primary"
              )}
            >
              <HighlightedText text={item.title} indices={findMatchIndices(matches, "title")} />
            </div>
          </TruncatedTooltip>
          {/* Recency is the strongest ranking signal a user has, so it gets a
              column of its own instead of the tail of a run of grey text — and
              it can never be the part that truncates. */}
          <TimeAgo
            timestamp={item.session.savedAt}
            className="shrink-0 text-xs text-text-secondary"
          />
        </div>
        {meta && (
          <TruncatedTooltip content={meta} focusable={false}>
            <div id={`${optionId}-meta`} className="text-xs text-text-secondary truncate">
              {scheduleLabel === undefined ? (
                meta
              ) : (
                <>
                  {lead && `${lead} · `}
                  <CalendarClock
                    className="mr-1 inline-block h-3 w-3 align-[-0.125em]"
                    aria-hidden="true"
                  />
                  {item.schedule?.name != null && (
                    <span className="sr-only">Scheduled run of </span>
                  )}
                  {scheduleLabel}
                  {rest && ` · ${rest}`}
                </>
              )}
            </div>
          </TruncatedTooltip>
        )}
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
  headingRef,
  count,
  expanded,
  collapsible,
  onToggle,
}: {
  id: string;
  headingRef: (el: HTMLElement | null) => void;
  count: number;
  expanded: boolean;
  collapsible: boolean;
  onToggle: () => void;
}) {
  const className = cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1 px-3 pt-3 pb-1");
  if (!collapsible) {
    return (
      <div id={id} ref={headingRef} className={className}>
        Worktree removed
      </div>
    );
  }
  return (
    <div>
      <button
        id={id}
        ref={headingRef}
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
    loadFailed,
    reload,
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

  // A failed read has nothing to resume, so Enter takes the one action there is.
  const handleConfirm = useCallback(() => {
    if (selected) launch(selected);
    else if (loadFailed && !isLoading) reload();
  }, [selected, launch, loadFailed, isLoading, reload]);

  // Search results are counted aloud once typing settles, the way every
  // SearchablePalette does it. Zero is left to the Empty state, which owns its
  // own "no match" announcement. The removed share is named after the total
  // because the cursor never lands on those rows — a bare total would promise
  // rows the arrows cannot reach.
  const resumableCount = visibleResults.length;
  const removedCount = removedResults.length;
  useEffect(() => {
    if (!isOpen || !isSearching || isLoading) return undefined;
    if (resumableCount + removedCount === 0) return undefined;
    const timer = window.setTimeout(() => {
      const parts = [pluralize(resumableCount + removedCount, "session")];
      if (removedCount > 0) parts.push(`${removedCount} with worktree removed`);
      useAnnouncerStore.getState().announce(parts.join(", "), "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [isOpen, isSearching, isLoading, query, resumableCount, removedCount]);

  // The header's loading sweep is aria-hidden; a slow read needs words too.
  useEffect(() => {
    if (!isOpen || !isLoading) return undefined;
    const timer = window.setTimeout(() => {
      useAnnouncerStore.getState().announce("Loading closed sessions", "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [isOpen, isLoading]);

  // Opening the fold reveals its rows by scrolling the heading to the top, so
  // the count it promises is on screen rather than one row peeking over the edge.
  const removedHeadingRef = useRef<HTMLElement | null>(null);
  const setRemovedHeading = useCallback((el: HTMLElement | null) => {
    removedHeadingRef.current = el;
  }, []);
  const handleToggleRemoved = useCallback(() => {
    const opening = !removedVisible;
    toggleRemoved();
    if (opening) {
      requestAnimationFrame(() =>
        removedHeadingRef.current?.scrollIntoView({ block: "start", behavior: "instant" })
      );
    }
  }, [removedVisible, toggleRemoved]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // An IME spends these keys on its candidate window; none of them are ours
      // until composition ends.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          selectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
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
          e.stopPropagation();
          setSelectedIndex(target);
          break;
        }
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          handleConfirm();
          break;
        case "Escape":
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
          // Only from the input, and only while a resumable row exists: on the
          // results region, or with nowhere for the cursor to go, Tab keeps its
          // native traversal so Load more and Retry stay reachable.
          if (!(e.target instanceof HTMLInputElement) || !results.some((item) => !item.isStale))
            break;
          e.preventDefault();
          // Stopped so the dialog's focus trap does not also move focus.
          e.stopPropagation();
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

  const collisionTimes = useMemo(
    () => closedAtForCollisions([...visibleResults, ...(removedVisible ? removedResults : [])]),
    [visibleResults, removedResults, removedVisible]
  );

  const renderRow = (item: ResumeSessionItem) => {
    const index = results.indexOf(item);
    return (
      <ResumeSessionRow
        key={item.id}
        item={item}
        closedAt={collisionTimes.get(item.id)}
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

  // Escape from anywhere but the search field (Tab reaches the list region and
  // Retry when nothing is resumable) arrives through the dialog's backstop.
  // It keeps the field's own rule — a query clears first — so the no-match
  // hint's "Press Esc to see all closed sessions" holds wherever focus is.
  const handleDialogClose = useCallback(
    (reason?: PaletteCloseReason) => {
      if (reason === "escape" && query !== "") {
        setQuery("");
        inputRef.current?.focus();
        return;
      }
      close();
    },
    [query, setQuery, close]
  );

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
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={handleDialogClose}
      ariaLabel="Resume session"
      tier="command"
    >
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
          aria-autocomplete="list"
          aria-label="Search closed sessions"
          aria-controls={hasList ? controlledIds : undefined}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Closed sessions"
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleKeyDown}
        // A press on the list's blank space must not take the caret out of
        // the search field.
        keepPointerFocusOnInput
      >
        {results.length === 0 ? (
          isLoading ? null : loadFailed ? (
            <div className="p-3">
              <Callout
                severity="error"
                role="alert"
                title="Couldn't load closed sessions"
                action={
                  <Button type="button" variant="outline" size="sm" onClick={reload}>
                    Retry
                  </Button>
                }
              >
                <p>The session history couldn't be read.</p>
              </Callout>
            </div>
          ) : (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No closed sessions yet"
              noMatchMessage={`No sessions match "${query.length > 40 ? query.slice(0, 40) + "…" : query}"`}
              noMatchContent={<PaletteNoMatchHint what="all closed sessions" />}
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
                  headingRef={setRemovedHeading}
                  count={removedResults.length}
                  expanded={removedVisible}
                  // A fold needs something to fold under: with nothing
                  // resumable the history is all there is, so the heading
                  // is a label and the chevron makes no promise.
                  collapsible={!isSearching && showList}
                  onToggle={handleToggleRemoved}
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
        {!selected && loadFailed && !isLoading && results.length === 0 && (
          <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to retry" }} />
        )}
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
