import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check } from "lucide-react";
import { Sprout } from "@/components/icons";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useIsDockPopoverChild } from "@/components/ui/DockPopoverChildContext";
import { useSidebarWorktreeOrder } from "@/hooks/useSidebarWorktreeOrder";
import { useWorktreeColorMap } from "@/hooks/useWorktreeColorMap";
import { matchesWorktreeQuery, sortWorktreesByRelevance } from "@/lib/worktreeFilters";
import {
  getWorktreeBranchLabel,
  getWorktreeHeadline,
  type WorktreeHeadline,
} from "@/lib/worktreeHeadline";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useWorktreeFilterStore, type OrderBy } from "@/store/worktreeFilterStore";
import type { WorktreeState } from "@/types";

export interface MoveToWorktreePickerProps {
  panelId: string;
  /** The worktree the panel is already in: listed in place, but not a target. */
  currentWorktreeId: string | undefined;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The control the picker hangs off. It is an anchor rather than a trigger —
   * the picker opens from a menu item — so a keyboard dismissal has to be told
   * where to go back to.
   */
  returnFocusRef: React.RefObject<HTMLElement | null>;
}

/**
 * The searchable list behind the panel header's "Move to worktree…" item.
 *
 * Content only: the `AppPalettePopover` root and its anchor belong to the
 * header, which wraps its own button. Rows come in the sidebar's order with the
 * sidebar's titles and filter with the sidebar's search, so a worktree the user
 * can find in one is found the same way in the other.
 */
export function MoveToWorktreePicker({
  panelId,
  currentWorktreeId,
  isOpen,
  onOpenChange,
  returnFocusRef,
}: MoveToWorktreePickerProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressCloseAutoFocusRef = useRef(false);
  const isDockPopoverChild = useIsDockPopoverChild();

  // Each opening starts unfiltered. Reset on the way in rather than the way
  // out: Escape and click-away close through Radix straight to the header, and
  // clearing on close would re-render the full list under the exit animation.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) setQuery("");
  }

  // Disarmed on every opening, not only when spent. Reopening inside the exit
  // animation cancels Radix's unmount, so that close never reaches
  // close-autofocus, and an answer left armed would swallow the focus return
  // owed to the next Escape.
  useEffect(() => {
    if (isOpen) suppressCloseAutoFocusRef.current = false;
  }, [isOpen]);

  const consumeCloseAutoFocusSuppression = useCallback(() => {
    const suppress = suppressCloseAutoFocusRef.current;
    suppressCloseAutoFocusRef.current = false;
    return suppress;
  }, []);

  const clearQuery = useCallback(() => setQuery(""), []);

  const moveTo = useCallback(
    (worktreeId: string) => {
      // Armed before the dispatch: the move takes this panel out of the grid,
      // and the button focus would return to goes with it.
      suppressCloseAutoFocusRef.current = true;
      onOpenChange(false);
      void actionService.dispatch(
        "terminal.moveToWorktree",
        { terminalId: panelId, worktreeId },
        { source: "menu" }
      );
    },
    [onOpenChange, panelId]
  );

  return (
    <AppPalettePopover.Content
      ariaLabel="Move to worktree"
      tier="anchored"
      inputRef={inputRef}
      onClearQuery={clearQuery}
      consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
      returnFocusRef={returnFocusRef}
      side="bottom"
      align="end"
      sideOffset={4}
      // Narrower than the anchored tier: a list of one- and two-line titles,
      // not a launcher with metadata columns.
      className="flex w-80 flex-col p-0 max-h-[var(--radix-popover-content-available-height)]"
      // Portalled out of a docked panel, the picker would otherwise read as a
      // click outside the dock preview and dismiss it.
      data-dock-popover-child={isDockPopoverChild ? "" : undefined}
    >
      <MoveToWorktreePickerBody
        query={query}
        onQueryChange={setQuery}
        inputRef={inputRef}
        currentWorktreeId={currentWorktreeId}
        onMove={moveTo}
      />
    </AppPalettePopover.Content>
  );
}

interface PickerRow {
  worktree: WorktreeState;
  headline: WorktreeHeadline;
  /** The branch, when the headline is a title rather than the branch itself. */
  detail: string | null;
  isCurrent: boolean;
}

interface OrderPrefs {
  orderBy: OrderBy;
  pinnedWorktrees: string[];
  manualOrder: string[];
}

function toRow(worktree: WorktreeState, currentWorktreeId: string | undefined): PickerRow {
  const headline = getWorktreeHeadline(worktree);
  const detail =
    headline.kind === "pr" || headline.kind === "issue"
      ? getWorktreeBranchLabel(worktree)
      : headline.kind === "main"
        ? (worktree.branch ?? null)
        : null;
  return { worktree, headline, detail, isCurrent: worktree.id === currentWorktreeId };
}

/**
 * The sidebar's query branch, flattened. With no query the list is the
 * sidebar's order untouched. With one, main keeps its place at the top — the
 * sidebar renders it as its own card above the ranked list — and everything
 * else is ranked by relevance with the sidebar's own tiebreakers.
 */
function orderForQuery(
  ordered: readonly WorktreeState[],
  query: string,
  prefs: OrderPrefs
): readonly WorktreeState[] {
  if (!query) return ordered;
  const matches = ordered.filter((worktree) => matchesWorktreeQuery(worktree, query));
  const main = matches.filter((worktree) => worktree.isMainWorktree);
  const rest = matches.filter((worktree) => !worktree.isMainWorktree);
  return [
    ...main,
    ...sortWorktreesByRelevance(
      rest,
      query,
      prefs.orderBy,
      prefs.pinnedWorktrees,
      prefs.manualOrder
    ),
  ];
}

interface MoveToWorktreePickerBodyProps {
  query: string;
  onQueryChange: (query: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  currentWorktreeId: string | undefined;
  onMove: (worktreeId: string) => void;
}

/**
 * Rendered only while the popover content is, so the worktree subscriptions
 * and the cursor exist for the life of one opening and no longer.
 */
function MoveToWorktreePickerBody({
  query,
  onQueryChange,
  inputRef,
  currentWorktreeId,
  onMove,
}: MoveToWorktreePickerBodyProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const ordered = useSidebarWorktreeOrder();
  const colorMap = useWorktreeColorMap();
  const prefs = useWorktreeFilterStore(
    useShallow((state): OrderPrefs => ({
      orderBy: state.orderBy,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
    }))
  );

  // Whitespace alone is no query here. The sidebar's box treats it as one that
  // matches nothing, which is a dead end nobody in a picker means to type.
  const deferredQuery = useDeferredValue(query).trim();

  const rows = useMemo(
    () =>
      orderForQuery(ordered, deferredQuery, prefs).map((worktree) =>
        toRow(worktree, currentWorktreeId)
      ),
    [ordered, deferredQuery, prefs, currentWorktreeId]
  );
  const targets = useMemo(() => rows.filter((row) => !row.isCurrent), [rows]);

  // The cursor names a worktree, not a position: with the default recent sort
  // an agent's activity can reorder the list under a still cursor, and Enter
  // has to take the row the user is looking at. It is scoped to the query it
  // was set under, so a new query rewinds to the first target without an
  // effect — and an effect would leave the highlight, the active descendant and
  // Enter pointing at different rows for a frame.
  const [cursor, setCursor] = useState<{ query: string; worktreeId: string } | null>(null);
  const cursorIndex =
    cursor !== null && cursor.query === deferredQuery
      ? targets.findIndex((row) => row.worktree.id === cursor.worktreeId)
      : -1;
  const activeIndex = targets.length === 0 ? -1 : Math.max(cursorIndex, 0);
  const activeWorktreeId = activeIndex >= 0 ? targets[activeIndex]!.worktree.id : null;

  const getOptionId = (rowIndex: number) => `${baseId}-option-${rowIndex}`;
  const activeRowIndex =
    activeWorktreeId === null ? -1 : rows.findIndex((row) => row.worktree.id === activeWorktreeId);
  const activeDescendant = activeRowIndex >= 0 ? getOptionId(activeRowIndex) : undefined;

  useEffect(() => {
    if (!activeDescendant) return;
    document.getElementById(activeDescendant)?.scrollIntoView({ block: "nearest" });
  }, [activeDescendant]);

  const moveCursorTo = useCallback(
    (index: number) => {
      const row = targets[index];
      if (row) setCursor({ query: deferredQuery, worktreeId: row.worktree.id });
    },
    [deferredQuery, targets]
  );

  const handleNavigationKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Mid-composition the keys belong to the IME's candidate window. Chromium
      // can report 229 before `isComposing` flips, so both are checked.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Escape is the shell's: it clears a query before it closes.
      if (targets.length === 0) return;

      let handled = true;
      switch (event.key) {
        case "ArrowDown":
          moveCursorTo((activeIndex + 1) % targets.length);
          break;
        case "ArrowUp":
          moveCursorTo((activeIndex - 1 + targets.length) % targets.length);
          break;
        case "Home":
          moveCursorTo(0);
          break;
        case "End":
          moveCursorTo(targets.length - 1);
          break;
        case "Enter": {
          const row = targets[activeIndex];
          if (row) onMove(row.worktree.id);
          break;
        }
        default:
          handled = false;
      }
      if (!handled) return;
      // The content is portalled but still a React child of the panel, so an
      // unconsumed key would carry on up into the panel's own handlers.
      event.preventDefault();
      event.stopPropagation();
    },
    [activeIndex, moveCursorTo, onMove, targets]
  );

  const clearSearch = useCallback(() => {
    onQueryChange("");
    // The button is about to unmount with the empty state; without this the
    // keyboard is left on the document body.
    inputRef.current?.focus();
  }, [inputRef, onQueryChange]);

  const hasResults = rows.length > 0;
  const announcement =
    deferredQuery && hasResults ? `${rows.length} worktree${rows.length === 1 ? "" : "s"}` : "";

  return (
    <>
      <PopoverSearchField
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleNavigationKeyDown}
        placeholder="Search worktrees"
        aria-label="Search worktrees"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={hasResults}
        aria-controls={hasResults ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        autoComplete="off"
        spellCheck={false}
      />

      <AppPaletteDialog.Body
        ariaLabel="Worktrees"
        activeDescendant={activeDescendant}
        focusIndicator="active-option"
        onNavigationKeyDown={handleNavigationKeyDown}
        // Roughly eight two-line rows. The content is capped to the height
        // Radix says is available, and this shrinks inside it on a short window.
        maxHeight="max-h-88"
      >
        {hasResults ? (
          <div id={listboxId} role="listbox" aria-label="Worktrees">
            {rows.map((row, rowIndex) => (
              <MoveToWorktreeRow
                key={row.worktree.id}
                row={row}
                optionId={getOptionId(rowIndex)}
                isActive={row.worktree.id === activeWorktreeId}
                color={colorMap?.[row.worktree.id]}
                onHover={(worktreeId) => setCursor({ query: deferredQuery, worktreeId })}
                onMove={onMove}
              />
            ))}
          </div>
        ) : (
          <AppPaletteDialog.Empty
            query={deferredQuery}
            emptyMessage="No worktrees"
            noMatchContent={
              <button
                type="button"
                onClick={clearSearch}
                className={cn(
                  "rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text-secondary transition-colors",
                  "hover:bg-overlay-subtle hover:text-text-primary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
                )}
              >
                Clear search
              </button>
            }
          />
        )}
      </AppPaletteDialog.Body>

      <div role="status" aria-live="polite" className="sr-only" data-testid="move-picker-count">
        {announcement}
      </div>

      <AppPaletteDialog.Footer>
        <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to move" }} />
      </AppPaletteDialog.Footer>
    </>
  );
}

interface MoveToWorktreeRowProps {
  row: PickerRow;
  optionId: string;
  isActive: boolean;
  color: string | undefined;
  onHover: (worktreeId: string) => void;
  onMove: (worktreeId: string) => void;
}

function MoveToWorktreeRow({
  row,
  optionId,
  isActive,
  color,
  onHover,
  onMove,
}: MoveToWorktreeRowProps) {
  const { worktree, headline, detail, isCurrent } = row;

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={isActive}
      // Kept in its place rather than hidden, so every other row still sits
      // where it does in the sidebar.
      aria-disabled={isCurrent || undefined}
      aria-current={isCurrent ? "true" : undefined}
      // Pointer-move rather than mouse-enter, so the cursor follows the pointer
      // within a row too, and keyboard and pointer can never light two rows.
      onPointerMove={isCurrent ? undefined : () => onHover(worktree.id)}
      onClick={
        isCurrent
          ? undefined
          : (event) => {
              // Stopped here, not merely prevented: the pane under the picker
              // focuses itself on any click it sees, whatever the default
              // state, and focusing the pane that just left would pull the
              // view over to the worktree it moved to.
              event.stopPropagation();
              onMove(worktree.id);
            }
      }
      className={cn(
        PALETTE_ROW_CLASS,
        "flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5",
        isCurrent ? "cursor-default" : "cursor-pointer"
      )}
    >
      {/* Reserved whether or not there is a glyph, so the titles hold one column. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {worktree.isMainWorktree ? (
          <Sprout className="size-3.5 text-text-secondary" />
        ) : color ? (
          <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-sm",
            isCurrent ? "text-text-secondary" : "text-text-primary"
          )}
        >
          {headline.label}
        </span>
        {detail && <span className="truncate font-mono text-xs text-text-secondary">{detail}</span>}
      </span>
      {isCurrent && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
          <Check className="size-3.5" aria-hidden="true" />
          Current
        </span>
      )}
    </div>
  );
}
