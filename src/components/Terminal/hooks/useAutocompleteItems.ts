import { useMemo } from "react";
import type { AutocompleteItem } from "../AutocompleteMenu";
import type { AtDiffContext, AtTerminalContext, AtSelectionContext } from "../hybridInputParsing";

interface UseAutocompleteItemsParams {
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
  diffContext: AtDiffContext | null;
  terminalContext: AtTerminalContext | null;
  selectionContext: AtSelectionContext | null;
  value: string;
  autocompleteFiles: string[];
  isAutocompleteLoading: boolean;
  autocompleteCommands: AutocompleteItem[];
  isCommandsLoading: boolean;
}

export function useAutocompleteItems({
  activeMode,
  diffContext,
  terminalContext,
  selectionContext,
  value,
  autocompleteFiles,
  isAutocompleteLoading,
  autocompleteCommands,
  isCommandsLoading,
}: UseAutocompleteItemsParams) {
  const autocompleteDiffItems = useMemo((): AutocompleteItem[] => {
    if (!diffContext) return [];
    const items: AutocompleteItem[] = [
      { key: "diff", label: "Working tree diff (@diff)", value: "@diff" },
      { key: "diff:staged", label: "Staged diff (@diff:staged)", value: "@diff:staged" },
      { key: "diff:head", label: "HEAD diff (@diff:head)", value: "@diff:head" },
    ];
    const partial =
      diffContext.tokenEnd > diffContext.atStart + 1
        ? value.slice(diffContext.atStart + 1, diffContext.tokenEnd)
        : "";
    if (!partial) return items;
    return items.filter((item) => item.value.slice(1).startsWith(partial));
  }, [diffContext, value]);

  const autocompleteTerminalItems = useMemo((): AutocompleteItem[] => {
    if (!terminalContext) return [];
    return [{ key: "terminal", label: "Terminal output (@terminal)", value: "@terminal" }];
  }, [terminalContext]);

  const autocompleteSelectionItems = useMemo((): AutocompleteItem[] => {
    if (!selectionContext) return [];
    return [{ key: "selection", label: "Terminal selection (@selection)", value: "@selection" }];
  }, [selectionContext]);

  const autocompleteItems = useMemo((): AutocompleteItem[] => {
    if (activeMode === "terminal") {
      return autocompleteTerminalItems;
    }
    if (activeMode === "selection") {
      return autocompleteSelectionItems;
    }
    if (activeMode === "diff") {
      return autocompleteDiffItems;
    }
    if (activeMode === "file") {
      return autocompleteFiles.map((file) => ({ key: file, label: file, value: file }));
    }
    if (activeMode === "command") {
      return autocompleteCommands;
    }
    return [];
  }, [
    activeMode,
    autocompleteTerminalItems,
    autocompleteSelectionItems,
    autocompleteDiffItems,
    autocompleteCommands,
    autocompleteFiles,
  ]);

  const isLoading =
    activeMode === "file"
      ? isAutocompleteLoading
      : activeMode === "command"
        ? isCommandsLoading
        : false;

  return { autocompleteItems, isLoading };
}
