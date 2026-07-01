import { useEffect, useMemo, useRef, useState } from "react";
import type { IFuseOptions } from "fuse.js";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { buildResumeSessionItems, type ResumeSessionItem } from "@/services/resumeSessionItems";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

const RESUME_FUSE_OPTIONS: IFuseOptions<ResumeSessionItem> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "searchAliases", weight: 1.5 },
    { name: "description", weight: 1 },
    { name: "teaser", weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
};

/**
 * Data + search state for the resume-sessions launcher (`Cmd+K R` / toolbar).
 * Fetches the journal unscoped on open (gated so closing doesn't re-read the
 * whole file), scopes it to the current project across all worktrees, and feeds
 * the rich items through the shared searchable-palette machinery.
 */
export function useResumeSessionsPalette() {
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const worktrees = useWorktreeStore((state) => state.worktrees);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);

  const items = useMemo(
    () => buildResumeSessionItems(sessions, { currentProjectId, worktrees }),
    [sessions, currentProjectId, worktrees]
  );

  // When there are sessions but none carry a captured snapshot, exit-snapshot
  // capture is almost certainly off — surface the enable hint.
  const hasAnySnapshot = useMemo(() => items.some((item) => item.teaser !== null), [items]);

  const palette = useSearchablePalette<ResumeSessionItem>({
    items,
    fuseOptions: RESUME_FUSE_OPTIONS,
    includeMatches: true,
    maxResults: 100,
    canNavigate: (item) => !item.isStale,
    paletteId: "resume-sessions",
    getItemId: (item) => item.id,
  });

  const { isOpen, setQuery } = palette;

  // Fetch on open (gated). The palette is opened via `paletteStore.openPalette`
  // from the action, which bypasses `useSearchablePalette.open()` — so reset the
  // query here too, mirroring ThemePalette.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      setQuery("");
      let cancelled = false;
      setIsLoading(true);
      void (async () => {
        try {
          const list = (await window.electron?.agentSessionHistory?.list()) ?? [];
          if (!cancelled) setSessions(list);
        } catch {
          if (!cancelled) setSessions([]);
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (!isOpen) {
      wasOpenRef.current = false;
    }
    return undefined;
  }, [isOpen, setQuery]);

  return {
    ...palette,
    isLoading,
    hasSessions: items.length > 0,
    hasAnySnapshot,
  };
}
