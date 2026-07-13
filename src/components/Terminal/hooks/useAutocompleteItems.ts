import { useMemo } from "react";
import type { AutocompleteItem } from "../AutocompleteMenu";
import {
  getDaintreeAtClaim,
  formatAtFileToken,
  type ActiveCompletionContext,
} from "../hybridInputParsing";

interface UseAutocompleteItemsParams {
  activeCompletionContext: ActiveCompletionContext | null;
  autocompleteFiles: string[];
  isAutocompleteLoading: boolean;
  autocompleteCommands: AutocompleteItem[];
  isCommandsLoading: boolean;
}

const DIFF_ITEMS: AutocompleteItem[] = [
  {
    key: "diff",
    label: "Working tree diff (@diff)",
    insertText: "@diff",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:staged",
    label: "Staged diff (@diff:staged)",
    insertText: "@diff:staged",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:head",
    label: "HEAD diff (@diff:head)",
    insertText: "@diff:head",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
];

const TERMINAL_ITEM: AutocompleteItem = {
  key: "terminal",
  label: "Terminal output (@terminal)",
  insertText: "@terminal",
  enterAction: "insert",
  insert: { insert: "resolve", resolverId: "terminal" },
};

const SELECTION_ITEM: AutocompleteItem = {
  key: "selection",
  label: "Terminal selection (@selection)",
  insertText: "@selection",
  enterAction: "insert",
  insert: { insert: "resolve", resolverId: "selection" },
};

/**
 * Merge the active trigger's completion items. `/` and `$` come pre-mapped from
 * discovery; `@` is served by Daintree's diff/terminal/selection providers
 * (which claim their prefixes ahead of file search) with `@file` fuzzy search
 * as the fallback provider.
 */
export function useAutocompleteItems({
  activeCompletionContext,
  autocompleteFiles,
  isAutocompleteLoading,
  autocompleteCommands,
  isCommandsLoading,
}: UseAutocompleteItemsParams) {
  const query = activeCompletionContext?.query ?? "";

  const fileItems = useMemo(
    (): AutocompleteItem[] =>
      // Basename first, directory as the dimmed description — scannable in a
      // dense list and disambiguates duplicate filenames across directories.
      autocompleteFiles.map((file) => {
        const sep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
        const base = sep >= 0 ? file.slice(sep + 1) : file;
        const dir = sep >= 0 ? file.slice(0, sep) : "";
        return {
          key: file,
          label: base || file,
          insertText: formatAtFileToken(file),
          description: dir || undefined,
          enterAction: "insert",
          insert: "literal",
        };
      }),
    [autocompleteFiles]
  );

  const diffItems = useMemo((): AutocompleteItem[] => {
    if (!query) return DIFF_ITEMS;
    return DIFF_ITEMS.filter((item) => item.insertText.slice(1).startsWith(query));
  }, [query]);

  const { autocompleteItems, isLoading } = useMemo((): {
    autocompleteItems: AutocompleteItem[];
    isLoading: boolean;
  } => {
    const ctx = activeCompletionContext;
    if (!ctx) return { autocompleteItems: [], isLoading: false };

    if (ctx.triggerChar === "/" || ctx.triggerChar === "$") {
      return { autocompleteItems: autocompleteCommands, isLoading: isCommandsLoading };
    }

    // ctx.triggerChar === "@": Daintree providers claim their prefix; else file.
    const claim = getDaintreeAtClaim(ctx.query);
    if (claim === "terminal") return { autocompleteItems: [TERMINAL_ITEM], isLoading: false };
    if (claim === "selection") return { autocompleteItems: [SELECTION_ITEM], isLoading: false };
    if (claim === "diff") return { autocompleteItems: diffItems, isLoading: false };
    return { autocompleteItems: fileItems, isLoading: isAutocompleteLoading };
  }, [
    activeCompletionContext,
    autocompleteCommands,
    isCommandsLoading,
    diffItems,
    fileItems,
    isAutocompleteLoading,
  ]);

  return { autocompleteItems, isLoading };
}
