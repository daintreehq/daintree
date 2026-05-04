import { useEffect, type Dispatch, type SetStateAction } from "react";
import type {
  AtFileContext,
  SlashCommandContext,
  AtDiffContext,
  AtTerminalContext,
  AtSelectionContext,
} from "../hybridInputParsing";

interface UseAutocompleteStateParams {
  isAutocompleteOpen: boolean;
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
  atContext: AtFileContext | null;
  slashContext: SlashCommandContext | null;
  diffContext: AtDiffContext | null;
  terminalContext: AtTerminalContext | null;
  selectionContext: AtSelectionContext | null;
  autocompleteItemsLength: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  lastQueryRef: React.RefObject<string>;
  setAtContext: Dispatch<SetStateAction<AtFileContext | null>>;
  setSlashContext: Dispatch<SetStateAction<SlashCommandContext | null>>;
  setDiffContext: Dispatch<SetStateAction<AtDiffContext | null>>;
  setTerminalContext: Dispatch<SetStateAction<AtTerminalContext | null>>;
  setSelectionContext: Dispatch<SetStateAction<AtSelectionContext | null>>;
}

export function useAutocompleteState({
  isAutocompleteOpen,
  activeMode,
  atContext,
  slashContext,
  diffContext,
  terminalContext,
  selectionContext,
  autocompleteItemsLength,
  rootRef,
  selectedIndex,
  setSelectedIndex,
  lastQueryRef,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
}: UseAutocompleteStateParams) {
  useEffect(() => {
    const activeQuery =
      activeMode === "terminal"
        ? `terminal:${terminalContext?.atStart ?? ""}`
        : activeMode === "selection"
          ? `selection:${selectionContext?.atStart ?? ""}`
          : activeMode === "diff"
            ? `diff:${diffContext?.atStart ?? ""}:${diffContext?.tokenEnd ?? ""}:${diffContext?.diffType ?? ""}`
            : activeMode === "file"
              ? `file:${atContext?.queryForSearch ?? ""}`
              : activeMode === "command"
                ? `command:${slashContext?.query ?? ""}`
                : "";
    if (activeQuery !== lastQueryRef.current) {
      lastQueryRef.current = activeQuery;
      setSelectedIndex(0);
    }
  }, [
    activeMode,
    atContext?.queryForSearch,
    diffContext?.atStart,
    diffContext?.tokenEnd,
    diffContext?.diffType,
    terminalContext?.atStart,
    selectionContext?.atStart,
    slashContext?.query,
  ]);

  useEffect(() => {
    if (!isAutocompleteOpen) return;
    const root = rootRef.current;
    if (!root) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (root.contains(target)) return;
      setAtContext(null);
      setSlashContext(null);
      setDiffContext(null);
      setTerminalContext(null);
      setSelectionContext(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isAutocompleteOpen]);

  useEffect(() => {
    if (!isAutocompleteOpen) return;
    if (autocompleteItemsLength === 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= autocompleteItemsLength) {
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, autocompleteItemsLength - 1)));
    }
  }, [autocompleteItemsLength, isAutocompleteOpen]);
}
