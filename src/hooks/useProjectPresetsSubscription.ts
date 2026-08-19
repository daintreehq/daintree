import { useCallback, useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { projectClient } from "@/clients";

const POLL_INTERVAL_MS = 30_000;

/**
 * Loads `.daintree/presets/{agentId}/*.json` into the project presets store
 * when the current project changes, and re-polls every 30 seconds so that
 * team-pulled or hand-edited preset files surface without restart. Polling
 * pauses while the window is hidden and refreshes immediately on restore;
 * unchanged poll results are skipped so store subscribers don't re-render.
 */
export function useProjectPresetsSubscription(): void {
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const setPresetsByAgent = useProjectPresetsStore((s) => s.setPresetsByAgent);
  const reset = useProjectPresetsStore((s) => s.reset);
  const activeIdRef = useRef<string | null>(null);
  const lastAppliedRef = useRef<string | null>(null);

  const load = useCallback(
    async (projectId: string) => {
      try {
        const presets = await projectClient.getInRepoPresets(projectId);
        if (activeIdRef.current !== projectId) return;
        const serialized = JSON.stringify(presets);
        if (serialized === lastAppliedRef.current) return;
        lastAppliedRef.current = serialized;
        // Ownership rides with the data: `hydratedProjectId` is what lets a
        // reader tell "this project declares no presets" from "the load has
        // not landed yet", and it must never name a project other than the one
        // this payload came from.
        setPresetsByAgent(projectId, presets);
      } catch (error) {
        console.warn("[useProjectPresetsSubscription] Failed to load project presets:", error);
      }
    },
    [setPresetsByAgent]
  );

  useEffect(() => {
    activeIdRef.current = currentProjectId;
    lastAppliedRef.current = null;

    if (!currentProjectId) {
      reset();
      return;
    }

    // Pre-clear so the previous project's presets don't leak through if the
    // first load for the new project fails. Without this, a failed IPC would
    // leave stale presets in the store until the next 30s poll succeeds.
    reset();

    void load(currentProjectId);
  }, [currentProjectId, load, reset]);

  useVisibilityAwareInterval(
    () => {
      if (activeIdRef.current) void load(activeIdRef.current);
    },
    POLL_INTERVAL_MS,
    currentProjectId !== null
  );
}
