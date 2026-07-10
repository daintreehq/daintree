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
      { key: "diff", label: "Working tree diff (@diff)", insertText: "@diff" },
      { key: "diff:staged", label: "Staged diff (@diff:staged)", insertText: "@diff:staged" },
      { key: "diff:head", label: "HEAD diff (@diff:head)", insertText: "@diff:head" },
    ];
    const partial =
      diffContext.tokenEnd > diffContext.atStart + 1
        ? value.slice(diffContext.atStart + 1, diffContext.tokenEnd)
        : "";
    if (!partial) return items;
    return items.filter((item) => item.insertText.slice(1).startsWith(partial));
  }, [diffContext, value]);

  const autocompleteTerminalItems = useMemo((): AutocompleteItem[] => {
    if (!terminalContext) return [];
    return [{ key: "terminal", label: "Terminal output (@terminal)", insertText: "@terminal" }];
  }, [terminalContext]);

  const autocompleteSelectionItems = useMemo((): AutocompleteItem[] => {
    if (!selectionContext) return [];
    return [
      { key: "selection", label: "Terminal selection (@selection)", insertText: "@selection" },
    ];
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
      // Basename first, directory as the dimmed description — scannable in a
      // dense list and disambiguates duplicate filenames across directories.
      return autocompleteFiles.map((file) => {
        const sep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
        const base = sep >= 0 ? file.slice(sep + 1) : file;
        const dir = sep >= 0 ? file.slice(0, sep) : "";
        return {
          key: file,
          label: base || file,
          insertText: file,
          description: dir || undefined,
        };
      });
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
