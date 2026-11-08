import { useMemo } from "react";
import type { ContextProviderItem } from "@shared/types/pluginContextProvider";
import { formatContextReference } from "@shared/utils/pluginContextReference";
import { pluralize } from "@/lib/pluralize";
import { hasPendingDiffNotes, type PendingDiffNotes } from "@/components/Worktree/diffNotes";
import type { AutocompleteItem } from "../AutocompleteMenu";
import { filterForgeReferences, type ForgeReference } from "../forgeReferences";
import {
  getDaintreeAtClaim,
  formatAtFileToken,
  formatAtNotesToken,
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
  /** Plugin prompt templates matching a `/` query, listed after the agent's commands. */
  templateItems?: AutocompleteItem[];
  contextClaim?: ContextProviderClaim | null;
  contextItems?: ContextProviderItem[];
  isContextLoading?: boolean;
  forgeReferences?: ForgeReference[];
  /** The notes this composer's `@notes` would take; `null` where it can't take any. */
  pendingDiffNotes?: PendingDiffNotes | null;
}

const NO_CONTEXT_ITEMS: ContextProviderItem[] = [];
const NO_FORGE_REFERENCES: ForgeReference[] = [];
const NO_TEMPLATE_ITEMS: AutocompleteItem[] = [];
const FORGE_REFERENCE_LIMIT = 50;

/** What a `#` row says about its item: whether it's an issue or a PR, and its state. */
export function forgeReferenceBadge(ref: Pick<ForgeReference, "kind" | "isDraft">): string {
  if (ref.kind === "issue") return "Open issue";
  return ref.isDraft ? "Draft PR" : "Open PR";
}

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

const NOTES_RESOLVER: AutocompleteItem["insert"] = { insert: "resolve", resolverId: "notes" };

/** What a notes row would send, or that its notes wait on an open editor. */
function noteCountBadge(sendable: number): string {
  return sendable > 0 ? pluralize(sendable, "note") : "Being edited";
}

/**
 * `@notes` and one row per file with notes, narrowed by what is typed after
 * `@notes:`. Empty while nothing is pending, which is what makes the rows a
 * reminder rather than a fixture of the menu.
 */
function diffNoteItems(pending: PendingDiffNotes | null, query: string): AutocompleteItem[] {
  if (!pending) return [];
  const sendableByFile = new Map<string, number>();
  for (const { filePath } of pending.editing) sendableByFile.set(filePath, 0);
  for (const { filePath } of pending.sendable) {
    sendableByFile.set(filePath, (sendableByFile.get(filePath) ?? 0) + 1);
  }
  if (sendableByFile.size === 0) return [];

  const narrowing = query.startsWith("notes:");
  const needle = narrowing ? query.slice("notes:".length).replace(/^"/, "").toLowerCase() : "";
  const items: AutocompleteItem[] = narrowing
    ? []
    : [
        {
          key: "notes",
          label: "@notes",
          description: "Every pending note, cleared on send",
          badge: noteCountBadge(pending.sendable.length),
          insertText: formatAtNotesToken(null),
          enterAction: "insert",
          insert: NOTES_RESOLVER,
        },
      ];
  for (const filePath of [...sendableByFile.keys()].sort()) {
    if (!filePath.toLowerCase().includes(needle)) continue;
    const sep = filePath.lastIndexOf("/");
    items.push({
      key: `notes:${filePath}`,
      label: `@notes:${filePath.slice(sep + 1)}`,
      description: sep >= 0 ? filePath.slice(0, sep) : undefined,
      descriptionKind: "path",
      badge: noteCountBadge(sendableByFile.get(filePath) ?? 0),
      insertText: formatAtNotesToken(filePath),
      enterAction: "insert",
      insert: NOTES_RESOLVER,
    });
  }
  return items;
}

/**
 * Merge the active trigger's completion items. `/` and `$` come pre-mapped from
 * discovery, and `/` adds the plugins' prompt templates after them; `#` narrows the project's open issues and pull requests; `@` is
 * served by Daintree's diff/terminal/selection/notes providers (which claim
 * their prefixes ahead of file search) with `@file` fuzzy search as the fallback
 * provider.
 */
export function useAutocompleteItems({
  activeCompletionContext,
  autocompleteFiles,
  isAutocompleteLoading,
  autocompleteCommands,
  isCommandsLoading,
  templateItems = NO_TEMPLATE_ITEMS,
  contextClaim = null,
  contextItems = NO_CONTEXT_ITEMS,
  isContextLoading = false,
  forgeReferences = NO_FORGE_REFERENCES,
  pendingDiffNotes = null,
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
      autocompleteFiles
        // A query ending in a separator has opened that directory to pick
        // inside it: the directory itself, already typed, is not a match.
        .filter((file) => !(/[\\/]$/.test(query) && file === query))
        .map((file) => {
          // A directory (`src/auth/`) is named by its last segment, slash kept,
          // under its parent, the same as a file: split past the trailing slash,
          // or the row repeats its own path as its description.
          const trailing = /[\\/]$/.test(file) ? 1 : 0;
          const body = file.slice(0, file.length - trailing);
          const sep = Math.max(body.lastIndexOf("/"), body.lastIndexOf("\\"));
          const base = sep >= 0 ? file.slice(sep + 1) : file;
          const dir = sep >= 0 ? body.slice(0, sep) : "";
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
    [autocompleteFiles, query]
  );

  const isReferenceQuery = activeCompletionContext?.triggerChar === "#";
  // Narrowed here, as typed, from rows fetched once: a query never reaches the
  // forge. A row inserts its reference and nothing it says.
  const referenceItems = useMemo((): AutocompleteItem[] => {
    if (!isReferenceQuery) return [];
    return filterForgeReferences(forgeReferences, query, FORGE_REFERENCE_LIMIT).map((ref) => ({
      key: `ref:${ref.kind}:${ref.number}`,
      label: ref.reference,
      description: ref.title,
      badge: forgeReferenceBadge(ref),
      insertText: ref.reference,
      enterAction: "insert",
      insert: "literal",
    }));
  }, [isReferenceQuery, forgeReferences, query]);

  const diffItems = useMemo((): AutocompleteItem[] => {
    if (!query) return DIFF_ITEMS;
    return DIFF_ITEMS.filter((item) => item.insertText.slice(1).startsWith(query));
  }, [query]);

  const noteItems = useMemo(
    (): AutocompleteItem[] => diffNoteItems(pendingDiffNotes, query),
    [pendingDiffNotes, query]
  );

  const { autocompleteItems, isLoading } = useMemo((): {
    autocompleteItems: AutocompleteItem[];
    isLoading: boolean;
  } => {
    const ctx = activeCompletionContext;
    if (!ctx) return { autocompleteItems: [], isLoading: false };

    if (ctx.triggerChar === "/" && templateItems.length > 0) {
      return {
        autocompleteItems: [...autocompleteCommands, ...templateItems],
        isLoading: isCommandsLoading,
      };
    }
    if (ctx.triggerChar === "/" || ctx.triggerChar === "$") {
      return { autocompleteItems: autocompleteCommands, isLoading: isCommandsLoading };
    }
    if (ctx.triggerChar === "#") return { autocompleteItems: referenceItems, isLoading: false };

    // ctx.triggerChar === "@": a plugin's `@{prefix}:` and Daintree's own
    // providers claim their prefix; else file.
    if (contextPrefix !== null) {
      return { autocompleteItems: contextRows, isLoading: isContextLoading };
    }
    const claim = getDaintreeAtClaim(ctx.query, hasPendingDiffNotes(pendingDiffNotes));
    if (claim === "terminal") return { autocompleteItems: [TERMINAL_ITEM], isLoading: false };
    if (claim === "selection") return { autocompleteItems: [SELECTION_ITEM], isLoading: false };
    if (claim === "notes") return { autocompleteItems: noteItems, isLoading: false };
    if (claim === "diff") {
      // A bare `@` is where the reminder shows, after the rows it has always
      // led with, so `@` and Enter still picks a diff.
      return {
        autocompleteItems: ctx.query === "" ? [...diffItems, ...noteItems] : diffItems,
        isLoading: false,
      };
    }
    return { autocompleteItems: fileItems, isLoading: isAutocompleteLoading };
  }, [
    activeCompletionContext,
    autocompleteCommands,
    isCommandsLoading,
    templateItems,
    diffItems,
    pendingDiffNotes,
    noteItems,
    fileItems,
    isAutocompleteLoading,
    contextPrefix,
    contextRows,
    isContextLoading,
    referenceItems,
  ]);

  return { autocompleteItems, isLoading };
}
