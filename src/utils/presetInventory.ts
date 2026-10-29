import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import type { AgentPreset } from "@shared/config/agentRegistry";
import type { PresetInventoryState } from "@shared/utils/agentPresets";

/** How long a launch waits for an unread preset inventory before refusing (#15025). */
export const LAUNCH_PRESET_WAIT_MS = 3_000;

/** The workspace a view is showing, by the ids its own stores hold. */
export interface PresetInventoryScope {
  projectId: string | undefined;
  scratchId: string | undefined;
}

/**
 * Whether this view's preset inventories have loaded. A scratch workspace has
 * no project presets to wait for; a view that has resolved neither a project
 * nor a scratch can't yet say what its project holds.
 */
export function presetInventoryState(
  ccrInitialized: boolean,
  hydratedProjectId: string | null,
  scope: PresetInventoryScope
): PresetInventoryState {
  return {
    ccr: ccrInitialized,
    project:
      scope.projectId !== undefined
        ? hydratedProjectId === scope.projectId
        : scope.scratchId !== undefined,
  };
}

/** One agent's CCR and project presets as this view holds them, with whether each has loaded. */
export function readLaunchPresetSources(
  agentId: string,
  scope: PresetInventoryScope
): {
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
  presetInventory: PresetInventoryState;
} {
  const ccr = useCcrPresetsStore.getState();
  const project = useProjectPresetsStore.getState();
  return {
    ccrPresets: ccr.ccrPresetsByAgent[agentId],
    projectPresets: project.presetsByAgent[agentId],
    presetInventory: presetInventoryState(ccr.isInitialized, project.hydratedProjectId, scope),
  };
}

/**
 * Resolves true once `isSettled` holds, rechecked on every change to the preset
 * inventories or the agent settings (a choice made meanwhile settles it too),
 * or false when `timeoutMs` passes first. A failed CCR read never marks its
 * store loaded, so the deadline is what ends the wait there.
 */
export function waitForLaunchPresets(
  isSettled: () => boolean,
  timeoutMs: number = LAUNCH_PRESET_WAIT_MS
): Promise<boolean> {
  if (isSettled()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const unsubscribes: Array<() => void> = [];
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      resolve(settled);
    };
    const recheck = () => {
      if (isSettled()) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribes.push(
      useCcrPresetsStore.subscribe(recheck),
      useProjectPresetsStore.subscribe(recheck),
      useAgentSettingsStore.subscribe(recheck)
    );
    // A store that changed between the first check and the subscriptions
    // would otherwise go unseen until the deadline.
    recheck();
  });
}
