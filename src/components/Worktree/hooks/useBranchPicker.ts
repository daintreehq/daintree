import { useState, useEffect, useRef, useMemo } from "react";
import {
  toBranchOption,
  buildBranchRows,
  type BranchOption,
  type BranchPickerRow,
} from "../branchPickerUtils";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { BranchInfo } from "@/types/electron";
import type { WorktreeSnapshot } from "@shared/types";

export interface UseBranchPickerResult {
  branchPickerOpen: boolean;
  setBranchPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  branchQuery: string;
  setBranchQuery: React.Dispatch<React.SetStateAction<string>>;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  recentBranchNames: string[];
  setRecentBranchNames: React.Dispatch<React.SetStateAction<string[]>>;
  branchInputRef: React.RefObject<HTMLInputElement | null>;
  branchListRef: React.RefObject<HTMLDivElement | null>;
  branchOptions: BranchOption[];
  branchRows: BranchPickerRow[];
  selectableRows: (BranchPickerRow & { kind: "option" })[];
  selectedBranchOption: BranchOption | undefined;
  handleBranchKeyDown: (e: React.KeyboardEvent) => void;
  handleBranchSelect: (option: BranchOption) => void;
}

export function useBranchPicker({
  branches,
  baseBranch,
  onSelectBranch,
}: {
  branches: BranchInfo[];
  baseBranch: string;
  onSelectBranch: (name: string, isRemote: boolean) => void;
}): UseBranchPickerResult {
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentBranchNames, setRecentBranchNames] = useState<string[]>([]);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);

  const branchOptions = useMemo(() => branches.map(toBranchOption), [branches]);

  const worktreeMap = useWorktreeStore((s) => s.worktrees);

  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, WorktreeSnapshot>();
    for (const wt of worktreeMap.values()) {
      if (wt.branch) map.set(wt.branch, wt);
    }
    return map;
  }, [worktreeMap]);

  const branchRows = useMemo(
    () =>
      buildBranchRows(branchOptions, {
        query: branchQuery,
        recentBranchNames,
        worktreeByBranch,
      }),
    [branchOptions, branchQuery, recentBranchNames, worktreeByBranch]
  );

  const selectableRows = useMemo(
    () => branchRows.filter((r): r is BranchPickerRow & { kind: "option" } => r.kind === "option"),
    [branchRows]
  );

  const selectedBranchOption = useMemo(
    () => branchOptions.find((b) => b.name === baseBranch),
    [branchOptions, baseBranch]
  );

  // Focus search input on open
  useEffect(() => {
    if (branchPickerOpen && branchInputRef.current) {
      requestAnimationFrame(() => {
        branchInputRef.current?.focus();
      });
    }
  }, [branchPickerOpen]);

  // Reset query and index on open/close
  useEffect(() => {
    setBranchQuery("");
    setSelectedIndex(0);
  }, [branchPickerOpen]);

  // Reset index on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [branchQuery]);

  // Scroll selected row into view
  useEffect(() => {
    if (branchListRef.current && selectedIndex >= 0 && selectableRows.length > 0) {
      const el = branchListRef.current.querySelector(
        `[data-option-index="${selectedIndex}"]`
      ) as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, selectableRows.length]);

  const handleBranchSelect = (option: BranchOption) => {
    onSelectBranch(option.name, option.isRemote);
    setBranchPickerOpen(false);
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent) => {
    if (selectableRows.length === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setBranchPickerOpen(false);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % selectableRows.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + selectableRows.length) % selectableRows.length);
        break;
      case "Enter":
        e.preventDefault();
        if (selectableRows[selectedIndex]) {
          handleBranchSelect(selectableRows[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setBranchPickerOpen(false);
        break;
    }
  };

  return {
    branchPickerOpen,
    setBranchPickerOpen,
    branchQuery,
    setBranchQuery,
    selectedIndex,
    setSelectedIndex,
    recentBranchNames,
    setRecentBranchNames,
    branchInputRef,
    branchListRef,
    branchOptions,
    branchRows,
    selectableRows,
    selectedBranchOption,
    handleBranchKeyDown,
    handleBranchSelect,
  };
}
