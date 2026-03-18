import { useState, useCallback, useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { useCommandHistoryStore, type PromptHistoryEntry } from "@/store/commandHistoryStore";
import { useShallow } from "zustand/react/shallow";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useSearchablePalette } from "./useSearchablePalette";

const FUSE_OPTIONS: IFuseOptions<PromptHistoryEntry> = {
  keys: [{ name: "prompt", weight: 1 }],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 50;

export type HistoryScope = "project" | "global";

export interface UsePromptHistoryPaletteOptions {
  terminalId: string;
  projectId: string | undefined;
}

export function usePromptHistoryPalette({ terminalId, projectId }: UsePromptHistoryPaletteOptions) {
  const [scope, setScope] = useState<HistoryScope>("project");

  const history = useCommandHistoryStore(useShallow((s) => s.history));

  const items = useMemo(() => {
    if (scope === "project") {
      return projectId ? (history[projectId] ?? []) : [];
    }
    const all = Object.values(history).flat();
    const seen = new Set<string>();
    const deduped: PromptHistoryEntry[] = [];
    for (const entry of all.sort((a, b) => b.addedAt - a.addedAt)) {
      if (!seen.has(entry.prompt)) {
        seen.add(entry.prompt);
        deduped.push(entry);
      }
    }
    return deduped;
  }, [scope, projectId, history]);

  const palette = useSearchablePalette<PromptHistoryEntry>({
    items,
    fuseOptions: FUSE_OPTIONS,
    maxResults: MAX_RESULTS,
    paletteId: "prompt-history",
  });

  const toggleScope = useCallback(() => {
    setScope((prev) => (prev === "project" ? "global" : "project"));
  }, []);

  const selectEntry = useCallback(
    (entry: PromptHistoryEntry) => {
      const store = useTerminalInputStore.getState();
      store.setDraftInput(terminalId, entry.prompt, projectId);
      store.bumpVoiceDraftRevision();
      palette.close();
    },
    [terminalId, projectId, palette]
  );

  const confirmSelection = useCallback(() => {
    const { results, selectedIndex } = palette;
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectEntry(results[selectedIndex]);
    }
  }, [palette, selectEntry]);

  return {
    ...palette,
    scope,
    toggleScope,
    selectEntry,
    confirmSelection,
  };
}
