import { useMemo } from "react";
import type { ContextProviderItem } from "@shared/types/pluginContextProvider";
import { formatContextReference } from "@shared/utils/pluginContextReference";
import type { AutocompleteItem } from "../AutocompleteMenu";
import {
  getDaintreeAtClaim,
  formatAtFileToken,
  type ActiveCompletionContext,
} from "../hybridInputParsing";

/** The plugin context provider an `@{prefix}:` query names (#13795). */
export interface ContextProviderClaim {
  prefix: string;
  pluginId: string;
  pluginName: string;
  /** What the user typed after the prefix. */
  query: string;
}

interface UseAutocompleteItemsParams {
  activeCompletionContext: ActiveCompletionContext | null;
  autocompleteFiles: string[];
  isAutocompleteLoading: boolean;
  autocompleteCommands: AutocompleteItem[];
  isCommandsLoading: boolean;
  contextClaim?: ContextProviderClaim | null;
  contextItems?: ContextProviderItem[];
  isContextLoading?: boolean;
}

const NO_CONTEXT_ITEMS: ContextProviderItem[] = [];

/** The menu key of a provider's row, unique across providers that reuse an id. */
export function contextItemKey(prefix: string, id: string): string {
  return `context:${prefix}:${id}`;
}

const DIFF_ITEMS: AutocompleteItem[] = [
  {
    key: "diff",
    label: "@diff",
    description: "Working tree diff",
    insertText: "@diff",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:staged",
    label: "@diff:staged",
    description: "Staged diff",
    insertText: "@diff:staged",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
  {
    key: "diff:head",
    label: "@diff:head",
    description: "HEAD diff",
    insertText: "@diff:head",
    enterAction: "insert",
    insert: { insert: "resolve", resolverId: "diff" },
  },
];

const TERMINAL_ITEM: AutocompleteItem = {
  key: "terminal",
  label: "@terminal",
  description: "Terminal output",
  insertText: "@terminal",
  enterAction: "insert",
  insert: { insert: "resolve", resolverId: "terminal" },
};

const SELECTION_ITEM: AutocompleteItem = {
  key: "selection",
  label: "@selection",
  description: "Terminal selection",
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
  contextClaim = null,
  contextItems = NO_CONTEXT_ITEMS,
  isContextLoading = false,
}: UseAutocompleteItemsParams) {
  const query = activeCompletionContext?.query ?? "";
  const contextPrefix = contextClaim?.prefix ?? null;
  const contextPluginName = contextClaim?.pluginName ?? "";

  // The plugin names its rows; the host decides what a row does. Picking one
  // inserts the reference and nothing else — a provider never sends.
  const contextRows = useMemo((): AutocompleteItem[] => {
    if (contextPrefix === null) return [];
    return contextItems.map((item) => ({
      key: contextItemKey(contextPrefix, item.id),
      label: item.label,
      description: item.description,
      badge: contextPluginName,
      insertText: formatContextReference({ prefix: contextPrefix, id: item.id }),
      enterAction: "insert",
      insert: { insert: "resolve", resolverId: "context" },
    }));
  }, [contextItems, contextPrefix, contextPluginName]);

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
          descriptionKind: "path",
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

    // ctx.triggerChar === "@": a plugin's `@{prefix}:` and Daintree's own
    // providers claim their prefix; else file.
    if (contextPrefix !== null) {
      return { autocompleteItems: contextRows, isLoading: isContextLoading };
    }
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
    contextPrefix,
    contextRows,
    isContextLoading,
  ]);

  return { autocompleteItems, isLoading };
}
