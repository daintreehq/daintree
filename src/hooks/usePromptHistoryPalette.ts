import { useState, useCallback, useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { useCommandHistoryStore, type PromptHistoryEntry } from "@/store/commandHistoryStore";
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

  const projectHistory = useCommandHistoryStore((s) => s.getProjectHistory(projectId));
  const globalHistory = useCommandHistoryStore((s) => s.getGlobalHistory());

  const items = useMemo(
    () => (scope === "project" ? projectHistory : globalHistory),
    [scope, projectHistory, globalHistory]
  );

  const palette = useSearchablePalette<PromptHistoryEntry>({
    items,
    fuseOptions: FUSE_OPTIONS,
    maxResults: MAX_RESULTS,
    debounceMs: 150,
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
