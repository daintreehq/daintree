import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Sprout } from "@/components/icons";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { Button } from "@/components/ui/button";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { splitBranchType, type BranchGlyph } from "@/components/Worktree/BranchLabel";
import { useIsDockPopoverChild } from "@/components/ui/DockPopoverChildContext";
import { useSidebarWorktreeOrder } from "@/hooks/useSidebarWorktreeOrder";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
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
import { pluralize } from "@/lib/pluralize";
import { UI_TOOLTIP_DELAY_DURATION } from "@/lib/animationUtils";

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
  /**
   * Which edge of the picker lines up with the anchor. The header's button
   * sits at the end of its bar, so by default the picker hangs back from it.
   */
  align?: "start" | "center" | "end";
}

/**
 * The searchable list behind the panel header's "Move to worktree…" item and
 * the context menu's "More worktrees…".
 *
 * Content only: the `AppPalettePopover` root and its anchor belong to whoever
 * opens it — the header wraps its own button, the context menu anchors on the
 * pane it opened over. Rows come in the sidebar's order with the
 * sidebar's titles and filter with the sidebar's search, so a worktree the user
 * can find in one is found the same way in the other.
 */
export function MoveToWorktreePicker({
  panelId,
  currentWorktreeId,
  isOpen,
  onOpenChange,
  returnFocusRef,
  align = "end",
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
      // Rows stay on screen through the exit animation, and by then the header
      // may already speak for another panel; a closing picker moves nothing.
      if (!isOpen) return;
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
    [isOpen, onOpenChange, panelId]
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
      align={align}
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
  /** The headline is the branch, so it is drawn as one. */
  isBranchTitled: boolean;
  isCurrent: boolean;
}

interface OrderPrefs {
  orderBy: OrderBy;
  pinnedWorktrees: string[];
  manualOrder: string[];
  customTitles: Readonly<Record<string, string>>;
}

function toRow(
  worktree: WorktreeState,
  currentWorktreeId: string | undefined,
  customTitle: string | undefined
): PickerRow {
  const headline = getWorktreeHeadline(worktree, customTitle);
  // A custom title (#13409) is a title like an issue's, whatever it displaced,
  // so the branch goes underneath it.
  const detail =
    headline.customTitle !== undefined
      ? getWorktreeBranchLabel(worktree).trim() || null
      : headline.kind === "pr" || headline.kind === "issue"
        ? getWorktreeBranchLabel(worktree)
        : headline.kind === "main"
          ? (worktree.branch ?? null)
          : null;
  const isBranchTitled =
    headline.customTitle === undefined &&
    headline.kind === "branch" &&
    getWorktreeBranchLabel(worktree).trim() !== "";
  return {
    worktree,
    headline,
    detail,
    isBranchTitled,
    isCurrent: worktree.id === currentWorktreeId,
  };
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
  const matches = ordered.filter((worktree) =>
    matchesWorktreeQuery(worktree, query, prefs.customTitles[worktree.id])
  );
  const main = matches.filter((worktree) => worktree.isMainWorktree);
  const rest = matches.filter((worktree) => !worktree.isMainWorktree);
  return [
    ...main,
    ...sortWorktreesByRelevance(
      rest,
      query,
      prefs.orderBy,
      prefs.pinnedWorktrees,
      prefs.manualOrder,
      prefs.customTitles
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
      customTitles: state.worktreeCustomTitles,
    }))
  );

  // Whitespace alone is no query here. The sidebar's box treats it as one that
  // matches nothing, which is a dead end nobody in a picker means to type.
  const deferredQuery = useDeferredValue(query).trim();

  const rows = useMemo(
    () =>
      orderForQuery(ordered, deferredQuery, prefs).map((worktree) =>
        toRow(worktree, currentWorktreeId, prefs.customTitles[worktree.id])
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

  // The row the arrow keys last landed on shows its full name when it is cut.
  // Under the pointer the tooltip opens on hover as any other does. Scoped to
  // the query like the cursor, so typing takes it down without an effect.
  const [reveal, setReveal] = useState<{ query: string; worktreeId: string } | null>(null);
  const revealedWorktreeId =
    reveal !== null && reveal.query === deferredQuery ? reveal.worktreeId : null;

  // The row Enter takes with no key pressed, the first target on opening and
  // after each query, reveals too once the user pauses on it, for as long as a
  // hover tooltip waits. Otherwise a typed query's first result is taken
  // unread. Once the user has acted under a query (moved the cursor, taken the
  // pointer, pressed Escape) the pause stands down for it: their reveal, or
  // their dismissal, is the one that holds. Until then it follows the first
  // target, which an agent's activity can reorder under a still cursor.
  const [actedQuery, setActedQuery] = useState<string | null>(null);
  const firstTargetId = targets[0]?.worktree.id ?? null;
  useEffect(() => {
    if (firstTargetId === null || actedQuery === deferredQuery) return;
    const timer = setTimeout(
      () => setReveal({ query: deferredQuery, worktreeId: firstTargetId }),
      UI_TOOLTIP_DELAY_DURATION
    );
    return () => clearTimeout(timer);
  }, [actedQuery, deferredQuery, firstTargetId]);

  const moveCursorTo = useCallback(
    (index: number) => {
      const row = targets[index];
      if (!row) return;
      setCursor({ query: deferredQuery, worktreeId: row.worktree.id });
      setReveal({ query: deferredQuery, worktreeId: row.worktree.id });
      setActedQuery(deferredQuery);
    },
    [deferredQuery, targets]
  );

  const handleHover = useCallback(
    (worktreeId: string) => {
      setCursor({ query: deferredQuery, worktreeId });
      setReveal(null);
      setActedQuery(deferredQuery);
    },
    [deferredQuery]
  );

  const handleNavigationKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Mid-composition the keys belong to the IME's candidate window. Chromium
      // can report 229 before `isComposing` flips, so both are checked.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // An open reveal is the topmost layer, so the shell never sees this
      // Escape: it takes the reveal down and leaves the query and the picker.
      // Without a reveal showing, the shell has already cleared or closed.
      if (event.key === "Escape") {
        setReveal(null);
        setActedQuery(deferredQuery);
        return;
      }
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
    [activeIndex, deferredQuery, moveCursorTo, onMove, targets]
  );

  const clearSearch = useCallback(() => {
    onQueryChange("");
    // The button is about to unmount with the empty state; without this the
    // keyboard is left on the document body.
    inputRef.current?.focus();
  }, [inputRef, onQueryChange]);

  const hasResults = rows.length > 0;
  const announcement = deferredQuery && hasResults ? `${pluralize(rows.length, "worktree")}` : "";

  return (
    <>
      <PopoverSearchField
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        // "Clear", not the family default: the no-match state owns "Clear
        // search", and two buttons with one name are indistinguishable.
        clearLabel="Clear"
        onClear={() => onQueryChange("")}
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
                isRevealed={
                  row.worktree.id === activeWorktreeId && row.worktree.id === revealedWorktreeId
                }
                color={colorMap?.[row.worktree.id]}
                onHover={handleHover}
                onMove={onMove}
              />
            ))}
          </div>
        ) : (
          <AppPaletteDialog.Empty
            query={deferredQuery}
            emptyMessage="No worktrees"
            noMatchContent={
              <Button variant="subtle" size="sm" onClick={clearSearch}>
                Clear search
              </Button>
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

/** Shortest end of a branch that is kept whole, and the longest it may grow to reach a word. */
const BRANCH_TAIL_MIN = 12;
const BRANCH_TAIL_MAX = 20;

/**
 * A branch name as the part that may give way and the end that never does.
 *
 * Branches cut from neighbouring issues share everything up to their last
 * words — `…-restart-on-idle-link-release`, `…-restart-on-endpoint-close-revoke`
 * — so an end-cut makes them identical. The kept end starts on a word, and is
 * the longest that fits the budget, so it reads as words rather than letters.
 */
function splitBranchTail(name: string): { head: string; tail: string } {
  const chars = Array.from(name);
  if (chars.length <= BRANCH_TAIL_MAX + 4) return { head: name, tail: "" };
  let keep = BRANCH_TAIL_MIN;
  for (let i = chars.length - BRANCH_TAIL_MAX; i <= chars.length - BRANCH_TAIL_MIN; i++) {
    if (/[-_/.]/.test(chars[i - 1]!) && !/[-_/.]/.test(chars[i]!)) {
      keep = chars.length - i;
      break;
    }
  }
  return {
    head: chars.slice(0, chars.length - keep).join(""),
    tail: chars.slice(chars.length - keep).join(""),
  };
}

let measureContext: CanvasRenderingContext2D | null = null;

function measureText(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * A branch the way the sidebar draws one, its type as a glyph and the rest in
 * mono, with its head fitted to the room its kept end leaves.
 *
 * Fitted in JS rather than left to `text-overflow`: a mono ellipsis lands on a
 * glyph boundary, so the head's box keeps up to a character of slack after it,
 * and `issue-13336-… exchange-history` reads as a branch with a space in it.
 * The fit is also what says whether the row needs its reveal.
 */
function useFittedBranch(branch: string | null) {
  const { Icon, rest } = splitBranchType(branch ?? "");
  const { head, tail } = splitBranchTail(rest);
  const boxRef = useRef<HTMLSpanElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(head);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let live = true;
    const fit = () => {
      if (!live) return;
      const style = getComputedStyle(box);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = box.clientWidth - (tailRef.current?.offsetWidth ?? 0);
      // Unmeasured (hidden, zero-width): the whole head, with CSS as the backstop.
      if (room <= 0 || measureText(head, font) <= room) {
        setShown(head);
        return;
      }
      let lo = 0;
      let hi = head.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureText(`${head.slice(0, mid)}…`, font) <= room) lo = mid;
        else hi = mid - 1;
      }
      setShown(`${head.slice(0, lo)}…`);
    };
    fit();
    // The first pass can measure the fallback face; the mono face is narrower.
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(box);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [head]);

  return { Icon, head: shown, tail, isCut: shown !== head, boxRef, tailRef };
}

/**
 * The drawn pieces are hidden from assistive technology and the whole ref is
 * spoken instead, so the option's name is the branch exactly, however it is
 * cut on screen.
 */
function BranchName({
  branch,
  Icon,
  head,
  tail,
  boxRef,
  tailRef,
  isHeadline,
}: {
  branch: string;
  Icon: BranchGlyph | null;
  head: string;
  tail: string;
  boxRef: React.RefObject<HTMLSpanElement | null>;
  tailRef: React.RefObject<HTMLSpanElement | null>;
  isHeadline: boolean;
}) {
  return (
    <>
      <span className="sr-only">{branch}</span>
      <span
        aria-hidden="true"
        className={cn(
          "flex min-w-0 items-center gap-1 font-mono",
          isHeadline ? "text-xs leading-5" : "text-2xs font-medium text-text-secondary"
        )}
      >
        {/* One box at both sizes, so a branch starts on the same column whether
            it is a row's headline or its detail. */}
        {Icon && (
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <Icon
              className={cn("text-text-secondary", isHeadline ? "size-3.5" : "size-3")}
              strokeWidth={2.5}
            />
          </span>
        )}
        {/* Fills the line, so the room it measures is the line's, not the text's. */}
        <span ref={boxRef} className="flex min-w-0 flex-1 whitespace-pre">
          <span className="min-w-0 truncate">{head}</span>
          {tail && (
            <span ref={tailRef} className="shrink-0">
              {tail}
            </span>
          )}
        </span>
      </span>
    </>
  );
}

/**
 * The whole of a clipped row, in the row's own order: its title, then its
 * branch as git spells it — or, where the branch is the title, the branch alone
 * at the title's weight.
 */
function RowRevealContent({
  title,
  displaced,
  branch,
}: {
  title: string | null;
  /** The computed headline a custom title replaced (#13409). */
  displaced?: string;
  branch: string | null;
}) {
  return (
    <span className="flex flex-col gap-0.5 break-words">
      {title && <span>{title}</span>}
      {displaced && displaced !== branch && (
        <span className="text-2xs text-text-secondary">{displaced}</span>
      )}
      {branch && (
        <span className={cn("font-mono", title ? "text-2xs text-text-secondary" : "text-xs")}>
          {branch}
        </span>
      )}
    </span>
  );
}

interface MoveToWorktreeRowProps {
  row: PickerRow;
  optionId: string;
  isActive: boolean;
  /** The cursor's reveal is here (arrow keys, or a pause on the default row): the full name shows if it is cut. */
  isRevealed: boolean;
  color: string | undefined;
  onHover: (worktreeId: string) => void;
  onMove: (worktreeId: string) => void;
}

function MoveToWorktreeRow({
  row,
  optionId,
  isActive,
  isRevealed,
  color,
  onHover,
  onMove,
}: MoveToWorktreeRowProps) {
  const { worktree, headline, detail, isBranchTitled, isCurrent } = row;
  const branch = isBranchTitled ? headline.label : detail;
  const { ref: titleRef, isTruncated: isTitleCut } = useTruncationDetection();
  const {
    Icon: BranchIcon,
    head: branchHead,
    tail: branchTail,
    isCut: isBranchCut,
    boxRef: branchBoxRef,
    tailRef: branchTailRef,
  } = useFittedBranch(branch);

  return (
    <TruncatedTooltip
      content={
        <RowRevealContent
          title={isBranchTitled ? null : headline.label}
          displaced={headline.computedLabel}
          branch={branch}
        />
      }
      isTruncated={isTitleCut || isBranchCut}
      // The row is the option the input's active descendant names; a tab stop
      // on its text would be a second focus target.
      focusable={false}
      // Held open against Radix's own closes: it drops a tooltip whose trigger
      // scrolls, and the list scrolls to every row the arrow keys reach.
      // Escape and the pointer take it down from the picker instead.
      open={isRevealed || undefined}
      // Off the list's side rather than above or below the row, where it would
      // cover the neighbours the row is being told apart from.
      side="left"
      align="start"
    >
      {/* The reveal's trigger. It spans the list's padding so the tooltip's
          standard offset clears the popover's edge instead of overlapping it. */}
      <div className="-mx-2 px-2">
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
          <span
            className={cn(
              "flex min-w-0 flex-1 flex-col",
              isCurrent ? "text-text-secondary" : "text-text-primary"
            )}
          >
            {isBranchTitled ? (
              <BranchName
                branch={headline.label}
                Icon={BranchIcon}
                head={branchHead}
                tail={branchTail}
                boxRef={branchBoxRef}
                tailRef={branchTailRef}
                isHeadline
              />
            ) : (
              <span ref={titleRef} className="truncate text-sm">
                {headline.label}
              </span>
            )}
            {detail && (
              <BranchName
                branch={detail}
                Icon={BranchIcon}
                head={branchHead}
                tail={branchTail}
                boxRef={branchBoxRef}
                tailRef={branchTailRef}
                isHeadline={false}
              />
            )}
          </span>
          {isCurrent && <span className="shrink-0 text-xs text-text-secondary">Current</span>}
        </div>
      </div>
    </TruncatedTooltip>
  );
}
