import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, KeyboardEventHandler } from "react";

/**
 * The keyboard model for a palette whose list has groups.
 *
 * Every selector that needed section headers used to write this itself, and the
 * three that existed disagreed on what selection even is — a DOM id, a row id,
 * an index. The index-keyed one carried the bug the others had worked around:
 * a list that shrinks under an open palette leaves the index addressing a row
 * the user never selected, and Enter commits that one (#11071).
 *
 * The invariant this hook exists to make structural: the rendered rows and the
 * arrow-key domain are one derivation, never two. `renderGroups` and `rows`
 * hold the same row objects, built in a single pass — a caller that renders
 * `renderGroups` cannot show a row the arrows can't reach, or reach one that
 * isn't on screen, so `aria-activedescendant` can only ever name a rendered row.
 *
 * Groups are structure, not state: they organise the rows and nothing more.
 * This hook once carried a disclosure model too, whose horizontal arrows could
 * act on a group the user was nowhere near, and whose only consumer has since
 * dropped collapse entirely (#11669).
 */

/** What every row carries, header or item. */
export interface PaletteTreeRowIdentity {
  /**
   * Stable across re-renders; this is what selection is keyed on.
   *
   * Must be unique across the WHOLE tree, not just within its group: selection
   * and activation resolve it by first match, so a group-local id reused under
   * another group would make the second row act as the first.
   */
  rowId: string;
  /** The element's DOM id, for `aria-activedescendant` and scrolling. */
  domId: string;
  /**
   * Whether the arrow keys stop here.
   *
   * A flag per row rather than one option for the whole palette: a listbox
   * whose headers are labels and a tree whose parents are stops are the same
   * model with different rows, and a group can hold a mix. Making it a row's
   * own property also keeps the skip decision next to the row it describes,
   * so no second, independently filtered array is needed to express it.
   */
  navigable: boolean;
}

export interface PaletteTreeItemInput<TItem> extends PaletteTreeRowIdentity {
  item: TItem;
}

/** One group as the caller has already ordered and filtered it. */
export interface PaletteTreeGroupInput<TGroup, TItem> {
  groupId: string;
  group: TGroup;
  header: PaletteTreeRowIdentity;
  items: readonly PaletteTreeItemInput<TItem>[];
}

export type PaletteTreeRow<TGroup, TItem> =
  | (PaletteTreeRowIdentity & {
      kind: "group";
      groupId: string;
      group: TGroup;
    })
  | (PaletteTreeRowIdentity & {
      kind: "item";
      groupId: string;
      group: TGroup;
      item: TItem;
    });

export type PaletteTreeGroupRow<TGroup, TItem> = Extract<
  PaletteTreeRow<TGroup, TItem>,
  { kind: "group" }
>;

export type PaletteTreeItemRow<TGroup, TItem> = Extract<
  PaletteTreeRow<TGroup, TItem>,
  { kind: "item" }
>;

export type NavigablePaletteTreeRow<TGroup, TItem> = PaletteTreeRow<TGroup, TItem> & {
  navigable: true;
};

/**
 * The render shape: the same row objects `rows` walks, grouped for markup.
 *
 * Returning both from one pass is the whole point — a caller that maps over
 * this is rendering exactly what the arrows address.
 */
export interface PaletteTreeRenderGroup<TGroup, TItem> {
  header: PaletteTreeGroupRow<TGroup, TItem>;
  items: readonly PaletteTreeItemRow<TGroup, TItem>[];
}

export interface UsePaletteTreeNavigationOptions<TGroup, TItem> {
  groups: readonly PaletteTreeGroupInput<TGroup, TItem>[];
  /** False parks the model: selection resets and the scroll effect stands down. */
  isActive: boolean;
  /**
   * Changing this drops the selection back to the top row.
   *
   * A palette's query re-ranks its list, so holding the old row would leave the
   * highlight somewhere down the new ranking rather than on its best match.
   */
  selectionScopeKey?: string | number | null;
  onActivate: (row: NavigablePaletteTreeRow<TGroup, TItem>) => void;
  /**
   * Whether a caret exists that the structural keys must stand down for.
   *
   * Home/End are this list's structural keys, but they are also the search
   * box's editing keys and the box owns focus by default. Consulted only for
   * those two, and only on the input — the body region has no caret. Defaults
   * to preserving them, because editable text should win unless a caller says
   * otherwise.
   */
  shouldPreserveInputCaretKey?: (event: KeyboardEvent<HTMLInputElement>) => boolean;
}

export interface UsePaletteTreeNavigationResult<TGroup, TItem> {
  renderGroups: readonly PaletteTreeRenderGroup<TGroup, TItem>[];
  rows: readonly PaletteTreeRow<TGroup, TItem>[];
  selectedRowId: string | null;
  /**
   * Position among the NAVIGABLE rows — the sequence the arrows walk, headers
   * excluded — so it lines up with a flat `results`-style array. Not an index
   * into `rows`, which counts headers. -1 when nothing is navigable.
   */
  selectedNavigableIndex: number;
  selectedRow: NavigablePaletteTreeRow<TGroup, TItem> | null;
  /** Undefined unless it names a row that is actually rendered. */
  activeDescendantId: string | undefined;
  selectRow: (rowId: string) => void;
  activateRow: (rowId: string) => void;
  step: (delta: number) => void;
  handleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  handleBodyKeyDown: KeyboardEventHandler<HTMLElement>;
}

/**
 * Keys this list and a text caret both have a claim on.
 *
 * The horizontal arrows were here too while groups could collapse. With no
 * disclosure left they are the caret's alone, so they never reach the switch
 * below and never need arbitrating.
 */
const CARET_KEYS = new Set(["Home", "End"]);

function isNavigable<TGroup, TItem>(
  row: PaletteTreeRow<TGroup, TItem>
): row is NavigablePaletteTreeRow<TGroup, TItem> {
  return row.navigable;
}

export function usePaletteTreeNavigation<TGroup, TItem>({
  groups,
  isActive,
  selectionScopeKey = null,
  onActivate,
  shouldPreserveInputCaretKey,
}: UsePaletteTreeNavigationOptions<TGroup, TItem>): UsePaletteTreeNavigationResult<TGroup, TItem> {
  /** The render model and the flat nav list, built together from one pass. */
  const renderGroups = useMemo<PaletteTreeRenderGroup<TGroup, TItem>[]>(
    () =>
      groups.map((input) => ({
        header: {
          kind: "group",
          rowId: input.header.rowId,
          domId: input.header.domId,
          navigable: input.header.navigable,
          groupId: input.groupId,
          group: input.group,
        },
        items: input.items.map((item) => ({
          kind: "item" as const,
          rowId: item.rowId,
          domId: item.domId,
          navigable: item.navigable,
          groupId: input.groupId,
          group: input.group,
          item: item.item,
        })),
      })),
    [groups]
  );

  const rows = useMemo<PaletteTreeRow<TGroup, TItem>[]>(
    () => renderGroups.flatMap((group) => [group.header, ...group.items]),
    [renderGroups]
  );

  const navigableRows = useMemo(() => rows.filter(isNavigable), [rows]);

  /**
   * The selected ROW is the state; its index is derived. Tracking an index
   * instead would let it outlive the row it pointed at — the list shrinks under
   * an open palette whenever an entry disappears or a narrowing changes, and
   * the index would then address a different row than the user selected
   * (#11071).
   */
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  /** Unmoved, the highlight sits on the first row the arrows can reach. */
  const selectedNavigableIndex = useMemo(() => {
    if (navigableRows.length === 0) return -1;
    const index = selectedRowId
      ? navigableRows.findIndex((row) => row.rowId === selectedRowId)
      : -1;
    return index >= 0 ? index : 0;
  }, [navigableRows, selectedRowId]);

  const selectedRow =
    selectedNavigableIndex >= 0 ? (navigableRows[selectedNavigableIndex] ?? null) : null;

  useEffect(() => {
    setSelectedRowId(null);
  }, [selectionScopeKey, isActive]);

  // Keyed on the id rather than the row object: rows are rebuilt whenever their
  // content refreshes, and re-running this each tick would fight the user's own
  // scroll.
  const activeDescendantId = selectedRow?.domId;
  useEffect(() => {
    if (!isActive || activeDescendantId === undefined) return;
    document.getElementById(activeDescendantId)?.scrollIntoView({ block: "nearest" });
  }, [isActive, activeDescendantId]);

  const step = useCallback(
    (delta: number) => {
      if (navigableRows.length === 0) return;
      // Resolve the current row from the id inside the updater so two calls
      // batched into one tick compose instead of collapsing into one.
      setSelectedRowId((previousId) => {
        const current = previousId
          ? navigableRows.findIndex((row) => row.rowId === previousId)
          : -1;
        const from = current >= 0 ? current : 0;
        // Normalised both ways: a single `+ length` only rescues a delta of -1,
        // and this is a shared API that may be handed a page-sized jump.
        const size = navigableRows.length;
        const next = (((from + delta) % size) + size) % size;
        return navigableRows[next]!.rowId;
      });
    },
    [navigableRows]
  );

  const selectRow = useCallback((rowId: string) => setSelectedRowId(rowId), []);

  const activateRow = useCallback(
    (rowId: string) => {
      const row = navigableRows.find((candidate) => candidate.rowId === rowId);
      if (!row) return;
      setSelectedRowId(row.rowId);
      onActivate(row);
    },
    [navigableRows, onActivate]
  );

  /** Vertical movement, the two ends, and commit. Groups are structure only. */
  const handleNavigationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, allowCaretKeys: boolean) => {
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // Nothing to navigate means the browser's own behaviour is the only
      // useful one left; swallowing the key would leave the region eating
      // Enter and the arrows through loading and empty states.
      if (navigableRows.length === 0) return;

      switch (event.key) {
        case "ArrowDown":
          consume();
          step(1);
          break;
        case "ArrowUp":
          consume();
          step(-1);
          break;
        case "Home":
          if (allowCaretKeys) break;
          consume();
          setSelectedRowId(navigableRows[0]!.rowId);
          break;
        case "End":
          if (allowCaretKeys) break;
          consume();
          setSelectedRowId(navigableRows[navigableRows.length - 1]!.rowId);
          break;
        case "Enter":
          consume();
          if (selectedRow) {
            // Commit the id, not just the activation. The highlight may be a
            // DERIVED fallback — the stored row disappeared and the first
            // navigable one took over — and activating without storing would
            // leave the next list change move the highlight off the row the
            // user just acted on. Palettes that stay open on a failed
            // activation are where that shows.
            setSelectedRowId(selectedRow.rowId);
            onActivate(selectedRow);
          }
          break;
      }
    },
    [navigableRows, onActivate, selectedRow, step]
  );

  const handleInputKeyDown = useCallback<KeyboardEventHandler<HTMLInputElement>>(
    (event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      const allowCaretKeys =
        CARET_KEYS.has(event.key) &&
        (shouldPreserveInputCaretKey ? shouldPreserveInputCaretKey(event) : true);
      handleNavigationKeyDown(event, allowCaretKeys);
    },
    [handleNavigationKeyDown, shouldPreserveInputCaretKey]
  );

  const handleBodyKeyDown = useCallback<KeyboardEventHandler<HTMLElement>>(
    (event) => handleNavigationKeyDown(event, false),
    [handleNavigationKeyDown]
  );

  return {
    renderGroups,
    rows,
    selectedRowId: selectedRow?.rowId ?? null,
    selectedNavigableIndex,
    selectedRow,
    activeDescendantId,
    selectRow,
    activateRow,
    step,
    handleInputKeyDown,
    handleBodyKeyDown,
  };
}
