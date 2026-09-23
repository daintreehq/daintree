import { useState, useCallback, useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { useCommandHistoryStore, type PromptHistoryEntry } from "@/store/commandHistoryStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { toPromptPreview } from "@/utils/promptHistoryPreview";
import { useSearchablePalette } from "./useSearchablePalette";

/** A history entry plus the one-line preview the row shows and search runs over. */
export interface PromptHistoryItem extends PromptHistoryEntry {
  preview: string;
  lineCount: number;
}

/**
 * Search runs over the preview rather than the raw prompt so the match ranges
 * index the text the row actually shows. `ignoreLocation` because a remembered
 * word can sit anywhere in a multi-paragraph prompt: with Fuse's default
 * location window a word ~60 characters in simply never matched, and the
 * palette answered "no matches" for a prompt the user could see in the list.
 * `ignoreLocation` makes `distance` inert, so it is not set.
 */
const FUSE_OPTIONS: IFuseOptions<PromptHistoryItem> = {
  keys: [{ name: "preview", weight: 1 }],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

const MAX_RESULTS = 50;

export type HistoryScope = "project" | "global";

export interface UsePromptHistoryPaletteOptions {
  terminalId: string;
  projectId: string | undefined;
}

function toItem(entry: PromptHistoryEntry): PromptHistoryItem {
  const { text, lineCount } = toPromptPreview(entry.prompt);
  return { ...entry, preview: text, lineCount };
}

/**
 * One row per distinct prompt, newest first. The store keeps a fleet
 * broadcast's repeats apart when the armed set differed, and the global view
 * merges every project's list — but recall only ever inserts the text, so two
 * rows for one prompt are two identical choices spending the result cap.
 */
function newestPerPrompt(entries: readonly PromptHistoryEntry[]): PromptHistoryEntry[] {
  const seen = new Set<string>();
  const out: PromptHistoryEntry[] = [];
  for (const entry of [...entries].sort((a, b) => b.addedAt - a.addedAt)) {
    if (seen.has(entry.prompt)) continue;
    seen.add(entry.prompt);
    out.push(entry);
  }
  return out;
}

export function usePromptHistoryPalette({ terminalId, projectId }: UsePromptHistoryPaletteOptions) {
  const [scope, setScope] = useState<HistoryScope>("project");

  const history = useCommandHistoryStore((s) => s.history);

  const items = useMemo(() => {
    const entries =
      scope === "project"
        ? projectId
          ? (history[projectId] ?? [])
          : []
        : Object.values(history).flat();
    return newestPerPrompt(entries).map(toItem);
  }, [scope, projectId, history]);

  const palette = useSearchablePalette<PromptHistoryItem>({
    items,
    fuseOptions: FUSE_OPTIONS,
    maxResults: MAX_RESULTS,
    paletteId: "prompt-history",
    includeMatches: true,
  });

  const toggleScope = useCallback(() => {
    setScope((prev) => (prev === "project" ? "global" : "project"));
  }, []);

  const selectEntry = useCallback(
    (entry: PromptHistoryEntry) => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput(terminalId, entry.prompt, projectId);
      store.bumpExternalDraftRevision();
      palette.close();
    },
    [terminalId, projectId, palette]
  );

  const confirmSelection = useCallback(() => {
    const { results, selectedIndex } = palette;
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectEntry(results[selectedIndex]!);
    }
  }, [palette, selectEntry]);

  return {
    ...palette,
    scope,
    setScope,
    toggleScope,
    selectEntry,
    confirmSelection,
  };
}
