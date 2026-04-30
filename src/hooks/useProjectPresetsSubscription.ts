import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { projectClient } from "@/clients";

const POLL_INTERVAL_MS = 30_000;

/**
 * Loads `.daintree/presets/{agentId}/*.json` into the project presets store
 * when the current project changes, and re-polls every 30 seconds so that
 * team-pulled or hand-edited preset files surface without restart.
 */
export function useProjectPresetsSubscription(): void {
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const setPresetsByAgent = useProjectPresetsStore((s) => s.setPresetsByAgent);
  const reset = useProjectPresetsStore((s) => s.reset);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = currentProjectId;

    if (!currentProjectId) {
      reset();
      return;
    }

    const projectId = currentProjectId;

    // Pre-clear so the previous project's presets don't leak through if the
    // first load for the new project fails. Without this, a failed IPC would
    // leave stale presets in the store until the next 30s poll succeeds.
    reset();

    const load = async () => {
      try {
        const presets = await projectClient.getInRepoPresets(projectId);
        if (activeIdRef.current !== projectId) return;
        setPresetsByAgent(presets);
      } catch (error) {
        console.warn("[useProjectPresetsSubscription] Failed to load project presets:", error);
      }
    };

    void load();
    const interval = setInterval(() => void load(), POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [currentProjectId, setPresetsByAgent, reset]);
}
