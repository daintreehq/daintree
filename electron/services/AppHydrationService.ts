// eager-import-allow: reads persisted hydration state via store.get synchronously during startup
import os from "os";
import { app } from "electron";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { getGpuFeatureStatus, isWebGLHardwareAccelerated } from "../utils/gpuDetection.js";
import { isRunningUnderRosetta } from "../utils/rosettaDetection.js";
import { isGpuDisabledByFlag, isGpuAngleFallbackApplied } from "./GpuCrashMonitorService.js";
import { readGpuDisabledFlagData } from "./gpuDisabledFlag.js";
import { getCrashLoopGuard } from "./CrashLoopGuardService.js";
import type { HydrateResult } from "../../shared/types/ipc/app.js";
import { inferKind } from "../../shared/utils/inferPanelKind.js";

/**
 * Build a HydrateResult for project switch payloads.
 *
 * This is the read-only, non-destructive counterpart to `handleAppHydrate` in
 * the IPC handler. It assembles the same shape but:
 *   - never calls destructive one-shot consumers (consumePendingSettingsRecovery,
 *     consumePanelFilter, DatabaseMaintenanceService.consumeRecovery) — those are
 *     startup-only
 *   - never runs migration writes (saveProjectState) — migration only applies
 *     on first app load, not on project switches
 *   - always returns safeMode: false — safe mode is a startup-only condition
 */
export async function buildSwitchHydrateResult(projectId: string): Promise<HydrateResult> {
  const currentProject = projectStore.getProjectById(projectId);
  // In-repo presets ride along in the payload; kicked off first so the disk
  // read overlaps the rest of the hydrate work.
  const projectPresetsPromise = currentProject
    ? projectStore.readInRepoPresets(currentProject.path).catch((error) => {
        console.warn("[SwitchHydrate] Failed to read in-repo presets:", error);
        return {};
      })
    : undefined;
  const globalAppState = store.get("appState");

  // Mirrors `handleAppHydrate`'s ownership gate: the legacy global
  // focus/worktree/MRU fields may only be inherited by a workspace with a real
  // Project row. The three callers (hover prefetch, project switch, cold-start
  // cache prime) normally resolve the id to a row first, but none holds that
  // guarantee across its later awaits, so a row deleted mid-build lands here
  // with no row — this keeps the leak from reappearing in that window (#11497).
  //
  // Having a row is necessary but not sufficient: the record names the one
  // workspace that left it behind, and only that heir may read it (#11651).
  // This path never claims — it performs no writes by design — so a record no
  // hydrate has claimed yet reads as owned by nobody, and this switch serves
  // clean defaults until `handleAppHydrate` settles the ownership.
  const legacyWorkspaceStateOwnerId = store.get("legacyWorkspaceStateOwnerId");
  const canInheritLegacyWorkspaceState =
    currentProject !== null && legacyWorkspaceStateOwnerId === projectId;

  let terminalsToUse: typeof globalAppState.terminals = [];
  let focusModeToUse = canInheritLegacyWorkspaceState ? (globalAppState.focusMode ?? false) : false;
  let focusPanelStateToUse = canInheritLegacyWorkspaceState
    ? globalAppState.focusPanelState
    : undefined;
  let activeWorktreeIdToUse = canInheritLegacyWorkspaceState
    ? globalAppState.activeWorktreeId
    : undefined;
  // Quick-switcher MRU: prefer per-project, fall back to the legacy global list
  // so a switch can't serve the previous project's order (#9922).
  let mruListToUse = canInheritLegacyWorkspaceState ? globalAppState.mruList : undefined;

  const { state: projectState, quarantinedPath: projectStateQuarantinedPath } =
    await projectStore.getProjectStateWithRecovery(projectId);

  // undefined means "not migrated yet" — fall through to the global list.
  if (projectState?.mruList !== undefined) {
    mruListToUse = projectState.mruList;
  }

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
    mruList: mruListToUse,
  };

  const gpuStatus = getGpuFeatureStatus();
  const gpuWebGLHardware = isWebGLHardwareAccelerated(gpuStatus.webgl2);

  return {
    appState: appState as import("../../shared/types/ipc/app.js").AppState,
    terminalConfig: store.get("terminalConfig"),
    project: currentProject ?? null,
    agentSettings: store.get("agentSettings"),
    gpuWebGLHardware,
    gpuHardwareAccelerationDisabled: isGpuDisabledByFlag(app.getPath("userData")),
    gpuDisabledReason: readGpuDisabledFlagData(app.getPath("userData"))?.reason ?? null,
    gpuAngleFallbackActive: isGpuAngleFallbackApplied(app.getPath("userData")),
    safeMode: inSafeMode,
    isWindowsStore: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true,
    runningUnderRosetta: isRunningUnderRosetta(),
    rosettaWarningDismissed: store.get("rosettaWarningDismissed") === true,
    settingsRecovery: null,
    databaseRecovery: null,
    projectStateRecovery: projectStateQuarantinedPath
      ? { quarantinedPath: projectStateQuarantinedPath }
      : null,
    // Folded into the payload so the renderer skips a standalone
    // `system:get-tmp-dir` round-trip on boot (matches `handleSystemGetTmpDir`).
    systemTmpDir: os.tmpdir(),
    // Per-project layout state folded in so the renderer skips the standalone
    // getTabGroups/getTerminalSizes/getDraftInputs round-trips during hydration.
    // Defaults match the standalone handlers' null-state returns.
    tabGroups: projectState?.tabGroups ?? [],
    terminalSizes: projectState?.terminalSizes ?? {},
    draftInputs: projectState?.draftInputs ?? {},
    projectPresets: projectPresetsPromise ? await projectPresetsPromise : undefined,
  };
}
