import { createRef } from "react";
import type { BranchOptionRow, UseBranchPickerResult } from "../../hooks/useBranchPicker";
import type { BranchPickerRow, BranchWorktreeRef } from "../../branchPickerUtils";

export function optionRow(name: string, overrides: Partial<BranchOptionRow> = {}): BranchOptionRow {
  return {
    kind: "option",
    name,
    isCurrent: false,
    isRemote: false,
    remoteName: null,
    labelText: name,
    searchText: name.toLowerCase(),
    committerDate: null,
    score: 0,
    matchRanges: [],
    isRecent: false,
    recentRank: 0,
    inUseWorktree: null,
    ...overrides,
  };
}

export function inUseRow(name: string, worktree: BranchWorktreeRef): BranchOptionRow {
  return optionRow(name, { inUseWorktree: worktree });
}

/**
 * A hand-built controller so panel and wrapper tests can pin one exact render
 * state without standing up the hook — the hook's own behaviour is covered by
 * `hooks/__tests__/useBranchPicker.test.tsx`.
 *
 * `selectableRows` is always derived from `rows` so the two can't be given
 * contradictory values, which would render a list the cursor can't address.
 */
export function stubController(
  rows: BranchPickerRow[] = [],
  overrides: Partial<Omit<UseBranchPickerResult, "rows" | "selectableRows">> = {}
): UseBranchPickerResult {
  const selectableRows = rows.filter((r): r is BranchOptionRow => r.kind === "option");

  return {
    open: true,
    setOpen: () => {},
    query: "",
    setQuery: () => {},
    activeIndex: selectableRows.length > 0 ? 0 : -1,
    setActiveIndex: () => {},
    inputRef: createRef<HTMLInputElement>(),
    listRef: createRef<HTMLDivElement>(),
    selectedOption: undefined,
    totalCount: selectableRows.length,
    handleKeyDown: () => {},
    handleSelect: () => {},
    reset: () => {},
    ...overrides,
    rows,
    selectableRows,
  };
}
