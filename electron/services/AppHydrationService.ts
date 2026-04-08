import { app } from "electron";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { isWebGLHardwareAccelerated } from "../utils/gpuDetection.js";
import { isGpuDisabledByFlag } from "./GpuCrashMonitorService.js";
import { getCrashLoopGuard } from "./CrashLoopGuardService.js";
import type { HydrateResult } from "../../shared/types/ipc/app.js";
import { inferKind } from "../../shared/utils/inferPanelKind.js";

/**
 * Build a HydrateResult for project switch payloads.
 *
 * This is the read-only, non-destructive counterpart to `handleAppHydrate` in
 * the IPC handler. It assembles the same shape but:
 *   - never calls destructive one-shot consumers (consumePendingSettingsRecovery,
 *     consumePanelFilter) — those are startup-only
 *   - never runs migration writes (saveProjectState) — migration only applies
 *     on first app load, not on project switches
 *   - always returns safeMode: false — safe mode is a startup-only condition
 */
export async function buildSwitchHydrateResult(projectId: string): Promise<HydrateResult> {
  const currentProject = projectStore.getProjectById(projectId);
  const globalAppState = store.get("appState");

  let terminalsToUse: typeof globalAppState.terminals = [];
  let focusModeToUse = globalAppState.focusMode ?? false;
  let focusPanelStateToUse = globalAppState.focusPanelState;
  let activeWorktreeIdToUse = globalAppState.activeWorktreeId;

  const projectState = await projectStore.getProjectState(projectId);

  if (projectState?.terminals !== undefined) {
    const validatedTerminals = filterValidTerminalEntries(
      projectState.terminals,
      TerminalSnapshotSchema,
      `switch-hydrate(project:${projectId})`
    );
    terminalsToUse = validatedTerminals
      .filter((t) => t.location !== "trash")
      .map((t) => ({
        ...t,
        kind: inferKind(t),
        location: t.location as "grid" | "dock",
      }));

    if (projectState.activeWorktreeId !== undefined) {
      activeWorktreeIdToUse = projectState.activeWorktreeId;
    }

    if (projectState.focusMode !== undefined) {
      focusModeToUse = projectState.focusMode;
      focusPanelStateToUse = projectState.focusPanelState;
    }
  }
  // On project switch, if per-project state doesn't have terminals, the
  // existing IPC handler path will handle migration on the initial load.
  // For switch payloads we just return empty terminals — the renderer's
  // hydrateAppState will discover running terminals via getForProject().

  // Respect safe mode during project switch — if the app started in safe mode,
  // terminals should remain suppressed to prevent crash loops.
  const inSafeMode = getCrashLoopGuard().isSafeMode();
  if (inSafeMode) {
    terminalsToUse = [];
  }

  const appState = {
    ...globalAppState,
    terminals: terminalsToUse,
    activeWorktreeId: activeWorktreeIdToUse,
    focusMode: focusModeToUse,
    focusPanelState: focusPanelStateToUse,
  };

  const gpuStatus = app.getGPUFeatureStatus();
  const gpuWebGLHardware = isWebGLHardwareAccelerated(gpuStatus.webgl2);

  return {
    appState,
    terminalConfig: store.get("terminalConfig"),
    project: currentProject ?? null,
    agentSettings: store.get("agentSettings"),
    gpuWebGLHardware,
    gpuHardwareAccelerationDisabled: isGpuDisabledByFlag(app.getPath("userData")),
    safeMode: inSafeMode,
    settingsRecovery: null,
  };
}
