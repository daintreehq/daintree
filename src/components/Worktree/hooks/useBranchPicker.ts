import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  toBranchOption,
  buildBranchRows,
  type BranchOption,
  type BranchPickerRow,
  type BranchWorktreeRef,
} from "../branchPickerUtils";
import type { BranchInfo } from "@/types/electron";

export type BranchOptionRow = BranchPickerRow & { kind: "option" };

/**
 * Exactly the surface the key handler reads — a structural subset every
 * `React.KeyboardEvent` satisfies. Declaring what it actually needs (rather than
 * the whole synthetic event) keeps the contract honest and lets callers and tests
 * hand over a minimal object without a cast.
 */
export interface BranchPickerKeyEvent {
  key: string;
  /**
   * Read so a modified Enter is left alone. The dialog advertises Cmd/Ctrl+Enter
   * as "submit from anywhere, pickers included"; a search field that swallowed
   * it would break the shortcut printed on the dialog's own button.
   */
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface UseBranchPickerResult {
  open: boolean;
  setOpen: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  /**
   * The one index the cursor highlight, `aria-activedescendant`, the scroll
   * target and Enter all read. Derived at render time, never stored, so a
   * freshly narrowed list can't leave the three disagreeing for a frame.
   */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  rows: BranchPickerRow[];
  selectableRows: BranchOptionRow[];
  selectedOption: BranchOption | undefined;
  /**
   * Candidates that qualified before the display cap — all branches with no
   * query, all matches with one. The footnote compares it to the rows on screen.
   */
  matchedTotal: number;
  handleKeyDown: (e: BranchPickerKeyEvent) => void;
  handleSelect: (option: BranchOption) => void;
}

export interface UseBranchPickerArgs {
  branches: readonly BranchInfo[];
  selectedBranch: string | null;
  recentBranchNames: readonly string[];
  worktreeByBranch: ReadonlyMap<string, BranchWorktreeRef>;
  onSelect: (option: BranchOption) => void;
}

export function useBranchPicker({
  branches,
  selectedBranch,
  recentBranchNames,
  worktreeByBranch,
  onSelect,
}: UseBranchPickerArgs): UseBranchPickerResult {
  const [open, setOpenState] = useState(false);
  const [query, setQueryState] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const branchOptions = useMemo(() => branches.map(toBranchOption), [branches]);

  const { rows, matchedTotal } = useMemo(
    () => buildBranchRows(branchOptions, { query, recentBranchNames, worktreeByBranch }),
    [branchOptions, query, recentBranchNames, worktreeByBranch]
  );

  const selectableRows = useMemo(
    () => rows.filter((r): r is BranchOptionRow => r.kind === "option"),
    [rows]
  );

  const selectedOption = useMemo(
    () => (selectedBranch ? branchOptions.find((b) => b.name === selectedBranch) : undefined),
    [branchOptions, selectedBranch]
  );

  // Clamped here rather than corrected by an effect: an effect runs a render
  // after the rows shrank, so for one frame the highlight, the active descendant
  // and Enter's target could each resolve to a different row.
  const activeIndex =
    cursorIndex >= 0 && cursorIndex < selectableRows.length
      ? cursorIndex
      : selectableRows.length > 0
        ? 0
        : -1;

  // The raw cursor is rewound on every edit, not just clamped at read time.
  // Clamping alone hides an out-of-range index without discarding it, so
  // narrowing to one row (rendered cursor 0) and then clearing the query would
  // resurrect the old index and jump the cursor to an unrelated branch.
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setCursorIndex(0);
  }, []);

  // The session is cleared on every transition, not just close: Radix cancels the
  // 120ms exit animation when the popover reopens inside it, so a reset armed only
  // on the close path would be skipped and fire against the next session instead.
  //
  // This is also the only reset the dialog needs — closing subsumes clearing, so
  // a mode switch or a dialog reopen can't leave a picker mounted expanded.
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    setQueryState("");
    setCursorIndex(0);
  }, []);

  // Focus the search field on open. Paired with the panel's `onOpenAutoFocus`:
  // this covers the warm path, that one covers a cold mount where the lazy Radix
  // chunk lands after this effect has already run. Both are load-bearing.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSelect = useCallback(
    (option: BranchOption) => {
      onSelect(option);
      setOpen(false);
    },
    [onSelect, setOpen]
  );

  const handleKeyDown = useCallback(
    (e: BranchPickerKeyEvent) => {
      // Mid-composition, Arrow and Enter belong to the IME: Enter commits the
      // candidate rather than the branch. Chromium can emit 229 before
      // `isComposing` flips, so both are checked (as in `SearchablePalette`).
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      // The popover portals to document.body, so an unhandled Enter or Escape
      // reaches the dialog that logically contains it. Every key this picker
      // owns stops there.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "Escape") {
        consume();
        setOpen(false);
        return;
      }

      // The list owns the bare navigation keys only. A modified chord belongs to
      // whatever bound it — Cmd+Enter to the dialog's submit.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (selectableRows.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          consume();
          setCursorIndex((activeIndex + 1) % selectableRows.length);
          break;
        case "ArrowUp":
          consume();
          setCursorIndex((activeIndex - 1 + selectableRows.length) % selectableRows.length);
          break;
        case "Home":
          consume();
          setCursorIndex(0);
          break;
        case "End":
          consume();
          setCursorIndex(selectableRows.length - 1);
          break;
        case "Enter": {
          consume();
          const row = selectableRows[activeIndex];
          if (row) handleSelect(row);
          break;
        }
      }
    },
    [activeIndex, handleSelect, selectableRows, setOpen]
  );

  return {
    open,
    setOpen,
    query,
    setQuery,
    activeIndex,
    setActiveIndex: setCursorIndex,
    inputRef,
    listRef,
    rows,
    selectableRows,
    selectedOption,
    matchedTotal,
    handleKeyDown,
    handleSelect,
  };
}
