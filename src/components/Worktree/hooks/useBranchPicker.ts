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
  /** Candidates before the empty-query cap — what the truncation footnote counts against. */
  totalCount: number;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleSelect: (option: BranchOption) => void;
  reset: () => void;
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
  const [query, setQuery] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const branchOptions = useMemo(() => branches.map(toBranchOption), [branches]);

  const rows = useMemo(
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

  const reset = useCallback(() => {
    setQuery("");
    setCursorIndex(0);
  }, []);

  // Assigned on every transition, not just close: Radix cancels the 120ms exit
  // animation when the popover reopens inside it, so a reset armed only on the
  // close path would be skipped and fire against the next session instead.
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      reset();
    },
    [reset]
  );

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
    (e: React.KeyboardEvent) => {
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
    totalCount: branchOptions.length,
    handleKeyDown,
    handleSelect,
    reset,
  };
}
