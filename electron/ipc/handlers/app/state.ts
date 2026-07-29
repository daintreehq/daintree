// eager-import-allow: reads persisted app state via store.get synchronously in the IPC handler
import os from "os";
import { app } from "electron";
import { CHANNELS } from "../../channels.js";
import { store, type StoreSchema, consumePendingSettingsRecovery } from "../../../store.js";
import { projectStore } from "../../../services/ProjectStore.js";
import {
  AppStateTerminalEntrySchema,
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
} from "../../../schemas/ipc.js";
import { getCrashRecoveryService } from "../../../services/CrashRecoveryService.js";
import { getDatabaseMaintenanceService } from "../../../services/DatabaseMaintenanceService.js";
import { USAGE_WINDOW_MS, MAX_USES_PER_ENTRY } from "../../../../shared/utils/actionUsage.js";

export const CRASH_CRITICAL_FIELDS = new Set([
  "terminals",
  "panelGridConfig",
  "focusMode",
  "focusPanelState",
  "activeWorktreeId",
  "recipes",
  "mruList",
  "actionMruList",
  "actionPinnedIds",
  "actionHiddenIds",
  "developerMode",
  "fleetScopeMode",
]);

import { getGpuFeatureStatus, isWebGLHardwareAccelerated } from "../../../utils/gpuDetection.js";
import { isRunningUnderRosetta } from "../../../utils/rosettaDetection.js";
import {
  isGpuDisabledByFlag,
  isGpuAngleFallbackApplied,
} from "../../../services/GpuCrashMonitorService.js";
import { readGpuDisabledFlagData } from "../../../services/gpuDisabledFlag.js";
import { getCrashLoopGuard } from "../../../services/CrashLoopGuardService.js";
import { getPanelSuspectLedger } from "../../../services/PanelSuspectLedgerService.js";
import { closeTelemetry } from "../../../services/TelemetryService.js";
import { inferKind } from "../../../../shared/utils/inferPanelKind.js";
import { typedHandle, typedHandleWithContext } from "../../utils.js";
import { signalFirstInteractive } from "../../../window/deferredInitQueue.js";
import { markPerformance } from "../../../utils/performance.js";
import { PERF_MARKS } from "../../../../shared/perf/marks.js";
import { consumePrefetchedHydrateResult } from "../../../services/prefetchHydrateCache.js";
import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { notifyAppViewPainted } from "../../../setup/deepLinkInstall.js";
import { resolveScopedProjectForIpcContext } from "../../projectContext.js";
import { getValidatedOverrides } from "../keybinding.js";
import { loadSanitizedUserAgentRegistry } from "../../../services/UserAgentRegistryService.js";
import type { Project } from "../../../types/index.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";

interface HydrationWorkspace {
  project: Project | null;
  /**
   * Owner of the per-workspace state directory. Equals `project.id` for a real
   * project, and is the scratch's own id in a scratch view, where `project` is
   * null because scratches deliberately have no Project row (#11484).
   */
  workspaceId: string | null;
}

export function registerAppStateHandlers(deps?: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const resolveWorkspaceForHydration = (ctx?: IpcContext): HydrationWorkspace => {
    if (ctx) {
      const scoped = resolveScopedProjectForIpcContext(ctx, deps);
      if (scoped) return { project: scoped.project, workspaceId: scoped.workspaceId };
    }

    const project = projectStore.getCurrentProject();
    return { project, workspaceId: project?.id ?? null };
  };

  const handleAppHydrate = async (ctx?: IpcContext) => {
    const { project: currentProject, workspaceId } = resolveWorkspaceForHydration(ctx);
    const panelFilter = getCrashRecoveryService().consumePanelFilter();

    // Hover-prefetch fast path: when a project switcher hover (or any other
    // pre-populated path) has primed the cache for this project, short-circuit
    // the disk read. Only safe when there's no in-flight crash recovery filter
    // and we aren't booting in safe mode — those scenarios layer constraints
    // (`panelFilter`, dropped terminals) that the prefetch built without.
    // consumePrefetchedHydrateResult is destructive (return-and-delete), so the
    // cache is only probed when the result is actually usable.
    const cacheGuard = getCrashLoopGuard();
    const cacheInSafeMode = cacheGuard.isSafeMode();
    const cacheEligible = Boolean(workspaceId) && panelFilter === null && !cacheInSafeMode;
    const cached = cacheEligible ? consumePrefetchedHydrateResult(workspaceId!) : undefined;
    markPerformance(PERF_MARKS.APP_HYDRATE_PREFETCH, {
      hit: Boolean(cached),
      projectId: workspaceId ?? null,
      reason: cached
        ? "hit"
        : !workspaceId
          ? "no-project"
          : cacheInSafeMode
            ? "safe-mode"
            : panelFilter !== null
              ? "panel-filter"
              : "miss",
    });
    if (cached) {
      return {
        ...cached,
        // The live sender's identity always wins over whatever the prefetch
        // stamped — only ever a project today, but never assume that.
        workspaceId,
        skippedPanelCount: 0,
        crashCount: cacheGuard.getCrashCount(),
        lastCrashAt: cacheGuard.getLastCrashTimestamp(),
        settingsRecovery: consumePendingSettingsRecovery(),
        // Boot-time DB recovery is one-shot and predates the prefetch, so it is
        // consumed live here — the cached payload always carries a null for it.
        databaseRecovery: getDatabaseMaintenanceService().consumeRecovery(),
        // Crash-loop quarantine notifications are gated on safe mode; the
        // fast path runs only when safe mode is inactive, so clear the field.
        crashLoopStateRecovery: null,
        // Ride-along synchronous reads not covered by the prefetch cache —
        // always read fresh so the toolbar/bootstrap dedup never sees a stale
        // snapshot from the hover-prefetch window.
        projects: projectStore.getAllProjects(),
        keybindingOverrides: getValidatedOverrides(),
        userAgentRegistry: loadSanitizedUserAgentRegistry(),
      };
    }

    // In-repo presets ride along in the payload; kicked off after the fast
    // path (the cached result already carries them) so the disk read overlaps
    // the rest of the hydrate work.
    const projectPresetsPromise = currentProject
      ? projectStore.readInRepoPresets(currentProject.path).catch((error) => {
          console.warn("[AppHydrate] Failed to read in-repo presets:", error);
          return {};
        })
      : undefined;

    // Read the global app state only after the fast path — the cached
    // HydrateResult already carries appState, so reading it earlier would pay
    // a redundant full config.json parse on every cache hit.
    const globalAppState = store.get("appState");
    const hasCrashRestoreTerminals =
      panelFilter !== null &&
      Array.isArray(globalAppState.terminals) &&
      globalAppState.terminals.length > 0;

    // First, try to get terminals from per-project state (new model)
    // Fall back to global appState.terminals for migration
    let terminalsToUse: StoreSchema["appState"]["terminals"] = [];
    let terminalsSource = "none";

    // Focus mode state to include in response
    let focusModeToUse = globalAppState.focusMode ?? false;
    let focusPanelStateToUse = globalAppState.focusPanelState;
    // Active worktree state to include in response
    let activeWorktreeIdToUse = globalAppState.activeWorktreeId;
    // Quick-switcher MRU: prefer per-project, fall back to the legacy global
    // list so existing users keep their MRU on first open after upgrade.
    let mruListToUse = globalAppState.mruList;
    let projectStateQuarantinedPath: string | undefined;
    // Per-project layout state folded into the payload so the renderer skips
    // the standalone getTabGroups/getTerminalSizes/getDraftInputs round-trips
    // during hydration. Left undefined on the no-project fallback branch so
    // the renderer falls back to the standalone IPC calls.
    let tabGroupsToUse: import("../../../../shared/types/panel.js").TabGroup[] | undefined;
    let terminalSizesToUse: Record<string, { cols: number; rows: number }> | undefined;
    let draftInputsToUse: Record<string, string> | undefined;

    if (workspaceId) {
      const { state: projectState, quarantinedPath } =
        await projectStore.getProjectStateWithRecovery(workspaceId);
      projectStateQuarantinedPath = quarantinedPath;
      // Defaults match the standalone handlers' null-state returns.
      tabGroupsToUse = projectState?.tabGroups ?? [];
      terminalSizesToUse = projectState?.terminalSizes ?? {};
      draftInputsToUse = projectState?.draftInputs ?? {};
      // undefined means "not migrated yet" — fall through to the global list.
      if (projectState?.mruList !== undefined) {
        mruListToUse = projectState.mruList;
      }
      // Per-project state exists (even if empty) - use it as authoritative
      if (!hasCrashRestoreTerminals && projectState?.terminals !== undefined) {
        // Use per-project terminals, excluding trashed and normalizing location
        const validatedTerminals = filterValidTerminalEntries(
          projectState.terminals,
          TerminalSnapshotSchema,
          `app:hydrate(project:${workspaceId})`
        );
        // Filter out trashed terminals, infer missing kind, and normalize location
        terminalsToUse = validatedTerminals
          .filter((t) => t.location !== "trash")
          .map((t) => ({
            ...t,
            kind: inferKind(t),
            location: t.location as "grid" | "dock",
          }));
        terminalsSource = "per-project";

        // Use per-project active worktree if it has been set
        if (projectState.activeWorktreeId !== undefined) {
          activeWorktreeIdToUse = projectState.activeWorktreeId;
        }

        // Use per-project focus mode if it has been set (undefined means not migrated yet)
        if (projectState.focusMode !== undefined) {
          focusModeToUse = projectState.focusMode;
          focusPanelStateToUse = projectState.focusPanelState;
        } else if (globalAppState.focusMode !== undefined) {
          // Migration: per-project state exists but no focusMode - migrate from global
          focusModeToUse = globalAppState.focusMode;
          focusPanelStateToUse = globalAppState.focusPanelState;

          // Save the migrated focus mode to per-project state
          await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => ({
            ...(existing ?? projectState),
            focusMode: focusModeToUse,
            focusPanelState: focusPanelStateToUse,
          }));

          console.log(
            `[AppHydrate] Migrated focusMode (${focusModeToUse}) to per-project state for ${currentProject?.name}`
          );
        }
      } else if (
        currentProject &&
        globalAppState.terminals &&
        globalAppState.terminals.length > 0
      ) {
        // Migration: use global terminals and migrate them to per-project
        terminalsToUse = filterValidTerminalEntries(
          globalAppState.terminals,
          AppStateTerminalEntrySchema,
          "app:hydrate(migration)"
        );
        terminalsSource = "migration";

        // Migrate terminals to per-project state with kind inference
        if (terminalsToUse.length > 0) {
          const migratedTerminals = terminalsToUse.map(
            (t) =>
              ({
                ...t,
                kind: inferKind(t),
                cwd: t.cwd || currentProject?.path || "",
              }) as import("../../../../shared/types/project.js").TerminalSnapshot
          );

          // Normalize legacy focusPanelState (may have logsOpen/eventInspectorOpen instead of diagnosticsOpen)
          const normalizedFocusPanelState = globalAppState.focusPanelState
            ? {
                sidebarWidth: globalAppState.focusPanelState.sidebarWidth,
                diagnosticsOpen:
                  "diagnosticsOpen" in globalAppState.focusPanelState
                    ? globalAppState.focusPanelState.diagnosticsOpen
                    : Boolean(
                        (globalAppState.focusPanelState as any).logsOpen ||
                        (globalAppState.focusPanelState as any).eventInspectorOpen
                      ),
              }
            : undefined;

          // Include focus mode in migration
          await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => ({
            ...(existing ?? {}),
            projectId: workspaceId,
            activeWorktreeId: globalAppState.activeWorktreeId,
            sidebarWidth: globalAppState.sidebarWidth ?? 350,
            terminals: migratedTerminals,
            focusMode: globalAppState.focusMode,
            focusPanelState: normalizedFocusPanelState,
          }));

          console.log(
            `[AppHydrate] Migrated ${migratedTerminals.length} terminals and focusMode to per-project state`
          );
        } else {
          // Normalize legacy focusPanelState
          const normalizedFocusPanelState = globalAppState.focusPanelState
            ? {
                sidebarWidth: globalAppState.focusPanelState.sidebarWidth,
                diagnosticsOpen:
                  "diagnosticsOpen" in globalAppState.focusPanelState
                    ? globalAppState.focusPanelState.diagnosticsOpen
                    : Boolean(
                        (globalAppState.focusPanelState as any).logsOpen ||
                        (globalAppState.focusPanelState as any).eventInspectorOpen
                      ),
              }
            : undefined;

          // No terminals to migrate but still save empty state to mark migration complete
          await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => ({
            ...(existing ?? {}),
            projectId: workspaceId,
            activeWorktreeId: globalAppState.activeWorktreeId,
            sidebarWidth: globalAppState.sidebarWidth ?? 350,
            terminals: existing?.terminals ?? [],
            focusMode: globalAppState.focusMode,
            focusPanelState: normalizedFocusPanelState,
          }));
        }
      } else if (currentProject) {
        // Normalize legacy focusPanelState
        const normalizedFocusPanelState = globalAppState.focusPanelState
          ? {
              sidebarWidth: globalAppState.focusPanelState.sidebarWidth,
              diagnosticsOpen:
                "diagnosticsOpen" in globalAppState.focusPanelState
                  ? globalAppState.focusPanelState.diagnosticsOpen
                  : Boolean(
                      (globalAppState.focusPanelState as any).logsOpen ||
                      (globalAppState.focusPanelState as any).eventInspectorOpen
                    ),
            }
          : undefined;

        // No per-project state and no global terminals - create fresh state with focus mode migration
        await projectStore.enqueueProjectStateUpdate(
          workspaceId,
          (existing) =>
            existing ?? {
              projectId: workspaceId,
              activeWorktreeId: globalAppState.activeWorktreeId,
              sidebarWidth: globalAppState.sidebarWidth ?? 350,
              terminals: [],
              focusMode: globalAppState.focusMode,
              focusPanelState: normalizedFocusPanelState,
            }
        );
      }
      // A scratch with no state yet falls through deliberately: the legacy
      // global terminals and focus mode predate per-workspace state and belong
      // to whichever project was open then, never to this scratch. Its first
      // panel save creates the file, so there is nothing to seed here.
    } else {
      // No project - use global terminals (legacy/fallback)
      terminalsToUse = filterValidTerminalEntries(
        globalAppState.terminals,
        AppStateTerminalEntrySchema,
        "app:hydrate(no-project)"
      );
      terminalsSource = "global-fallback";
    }

    // In safe mode, filter out panels the suspect ledger has quarantined
    // (panels flagged `isSuspect` on enough consecutive crashed boots to
    // cross the threshold) — stable panels survive the safe-mode boot. If
    // every saved panel is quarantined we fall back to the original
    // all-or-nothing wipe so a chronic crash loop where everything is suspect
    // still surfaces an empty workspace rather than restoring suspects in a
    // partial way. `quarantinedPanels` is surfaced to the renderer so
    // `SafeModeBanner` can list them with a "Restore panel" affordance.
    const guard = getCrashLoopGuard();
    const ledger = getPanelSuspectLedger();
    const inSafeMode = guard.isSafeMode();
    let skippedPanelCount = 0;
    let quarantinedPanels: import("../../../../shared/types/ipc/crashRecovery.js").QuarantinedPanelSummary[] =
      [];
    if (inSafeMode) {
      const quarantinedIds = ledger.getQuarantinedPanelIds();
      const ledgerEmpty = quarantinedIds.size === 0;
      const original = terminalsToUse;
      const survivors = original.filter((t) => !quarantinedIds.has(t.id));
      const skippedToQuarantine = original.length - survivors.length;
      if (ledgerEmpty) {
        // Legacy fallback: the ledger has no per-panel quarantine data for
        // this crash-loop run, so the system can't isolate which panel(s)
        // caused it. Fall back to the original all-or-nothing wipe so safe
        // mode still breaks the loop. Hits on first crash loop after upgrade
        // (or after the ledger was cleared by user action).
        skippedPanelCount = original.length;
        terminalsToUse = [];
        terminalsSource = "safe-mode";
        console.log(
          `[AppHydrate] Safe mode active — skipping ${skippedPanelCount} terminal(s) restoration (ledger empty)`
        );
      } else if (original.length > 0 && survivors.length === 0) {
        // Every saved panel for the current project is in the quarantine set
        // — whole-session safe mode escalation. This is the per-project
        // analogue of the legacy wipe.
        skippedPanelCount = original.length;
        terminalsToUse = [];
        terminalsSource = "safe-mode";
        console.log(
          `[AppHydrate] Safe mode active — skipping ${skippedPanelCount} terminal(s) restoration (all quarantined)`
        );
      } else if (skippedToQuarantine > 0) {
        // Partial quarantine — restore the stable panels, drop the suspects.
        terminalsToUse = survivors;
        skippedPanelCount = skippedToQuarantine;
        terminalsSource = "safe-mode-quarantine";
        console.log(
          `[AppHydrate] Safe mode active — quarantining ${skippedToQuarantine} suspect panel(s), restoring ${survivors.length} stable panel(s)`
        );
      } else {
        // Safe mode is active but none of THIS project's saved panels appear
        // in the quarantine set (e.g., the user crashed on a different
        // project and switched here). Restore normally — the per-panel
        // ledger isolates the failure to its real cause. Quarantined panels
        // from other projects are still surfaced via `quarantinedPanels` so
        // the banner popover can list them.
        skippedPanelCount = 0;
        console.log(
          `[AppHydrate] Safe mode active — no panels quarantined for this project, restoring ${original.length} panel(s)`
        );
      }
      quarantinedPanels = ledger.getQuarantinedPanels();
    }

    // Apply one-shot crash recovery panel filter if set
    // Empty array means "no specific selection" (legacy/no-panels case) — skip filtering
    if (panelFilter !== null && panelFilter.length > 0) {
      const filterSet = new Set(panelFilter);
      terminalsToUse = terminalsToUse.filter((t) => filterSet.has(t.id));
      console.log(
        `[AppHydrate] Applied crash recovery panel filter: ${terminalsToUse.length} of ${panelFilter.length} requested panels found`
      );
    }

    // Terminal processes are discovered from backend via terminalClient.getForProject(),
    // but we preserve saved terminals array for ordering metadata (IDs and locations).
    // The frontend uses this to restore panel order when reconnecting to running terminals.
    // activeWorktreeId is preserved so the frontend can validate it exists after worktrees load.
    const appState: StoreSchema["appState"] = {
      ...globalAppState,
      terminals: terminalsToUse,
      // Include per-project state in the response (frontend uses this for hydration)
      activeWorktreeId: activeWorktreeIdToUse,
      focusMode: focusModeToUse,
      focusPanelState: focusPanelStateToUse,
      mruList: mruListToUse,
    };

    console.log(
      `[AppHydrate] Project: ${currentProject?.name ?? (workspaceId ? "scratch" : "none")} - terminals from ${terminalsSource} (${terminalsToUse.length} valid), focusMode: ${focusModeToUse}`
    );

    const gpuStatus = getGpuFeatureStatus();
    const gpuWebGLHardware = isWebGLHardwareAccelerated(gpuStatus.webgl2);
    if (!gpuWebGLHardware) {
      console.warn(
        `[AppHydrate] Software-only WebGL2 detected (status: ${gpuStatus.webgl2}). WebGL terminal renderer will be disabled.`
      );
    }

    return {
      appState: appState as import("../../../../shared/types/ipc/app.js").AppState,
      terminalConfig: store.get("terminalConfig"),
      project: currentProject,
      workspaceId,
      agentSettings: store.get("agentSettings"),
      gpuWebGLHardware,
      gpuHardwareAccelerationDisabled: isGpuDisabledByFlag(app.getPath("userData")),
      gpuDisabledReason: readGpuDisabledFlagData(app.getPath("userData"))?.reason ?? null,
      gpuAngleFallbackActive: isGpuAngleFallbackApplied(app.getPath("userData")),
      safeMode: inSafeMode,
      isWindowsStore:
        (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true,
      runningUnderRosetta: isRunningUnderRosetta(),
      rosettaWarningDismissed: store.get("rosettaWarningDismissed") === true,
      skippedPanelCount,
      quarantinedPanels,
      crashCount: guard.getCrashCount(),
      lastCrashAt: guard.getLastCrashTimestamp(),
      settingsRecovery: consumePendingSettingsRecovery(),
      databaseRecovery: getDatabaseMaintenanceService().consumeRecovery(),
      projectStateRecovery: projectStateQuarantinedPath
        ? { quarantinedPath: projectStateQuarantinedPath }
        : null,
      // Surface the crash-loop quarantine only when safe mode is also active —
      // a silent reset on the happy path would be more noise than signal.
      crashLoopStateRecovery:
        inSafeMode && guard.getQuarantinedStatePath()
          ? { quarantinedPath: guard.getQuarantinedStatePath()! }
          : null,
      // Folded into the payload so the renderer skips a standalone
      // `system:get-tmp-dir` round-trip on boot (matches `handleSystemGetTmpDir`).
      systemTmpDir: os.tmpdir(),
      tabGroups: tabGroupsToUse,
      terminalSizes: terminalSizesToUse,
      draftInputs: draftInputsToUse,
      projectPresets: projectPresetsPromise ? await projectPresetsPromise : undefined,
      // Folded into the payload so the Toolbar mount and the hydration
      // bootstrap skip their standalone round-trips during the boot window
      // (project:get-all / project:get-current, keybinding:get-overrides,
      // user-agent-registry:get). All three are synchronous reads.
      projects: projectStore.getAllProjects(),
      keybindingOverrides: getValidatedOverrides(),
      userAgentRegistry: loadSanitizedUserAgentRegistry(),
    };
  };
  handlers.push(typedHandleWithContext(CHANNELS.APP_HYDRATE, handleAppHydrate));

  // Batched cold-start boot payload. Collapses what was three separate renderer
  // round-trips (`crash-recovery:get-pending`, `crash-recovery:get-config`,
  // `app:hydrate`) into one. The destructive one-shot consumers
  // (`consumePanelFilter`, `consumePendingSettingsRecovery`, `consumeRecovery`) and the prefetch
  // fast path remain inside `handleAppHydrate` — boot just appends the crash
  // gate fields onto the same result.
  const handleAppBoot = async (ctx: IpcContext) => {
    const hydrate = await handleAppHydrate(ctx);
    const crashService = getCrashRecoveryService();
    const guard = getCrashLoopGuard();
    // Mirror crash-recovery:get-pending: suppress in safe mode and inject the
    // live crash count so the renderer's auto-restore heuristic matches the
    // standalone path.
    let crashPending: import("../../../../shared/types/ipc/crashRecovery.js").PendingCrash | null;
    if (guard.isSafeMode()) {
      crashPending = null;
    } else {
      const pending = crashService.getPendingCrash();
      crashPending = pending ? { ...pending, crashCount: guard.getCrashCount() } : null;
    }
    // Ride-along app theme: only when the stored config is already in its
    // fully-migrated shape. First-run defaulting and legacy customSchemes
    // migration stay in the `app-theme:get` handler, which the renderer falls
    // back to whenever this field is undefined.
    const rawAppTheme = store.get("appTheme");
    const appTheme =
      rawAppTheme &&
      typeof rawAppTheme === "object" &&
      !Array.isArray(rawAppTheme) &&
      typeof rawAppTheme.colorSchemeId === "string" &&
      rawAppTheme.colorSchemeId &&
      typeof (rawAppTheme.customSchemes as unknown) !== "string"
        ? (rawAppTheme as import("../../../../shared/types/appTheme.js").AppThemeConfig)
        : undefined;
    // `useAppBootstrap` throws this whole payload away and re-runs `app:hydrate`
    // once the crash gate resolves (`hadPendingCrash ? null : bootResult`), so a
    // destructive one-shot consumed above would never reach the user. An unclean
    // exit is also exactly how the database gets corrupted — hand the recovery
    // back so the live hydrate that follows delivers it.
    const droppedRecovery = crashPending !== null ? hydrate.databaseRecovery : null;
    if (droppedRecovery) {
      getDatabaseMaintenanceService().restoreRecovery(droppedRecovery);
    }

    return {
      ...hydrate,
      databaseRecovery: droppedRecovery ? null : hydrate.databaseRecovery,
      crashPending,
      crashConfig: crashService.getConfig(),
      appTheme,
    };
  };
  handlers.push(typedHandleWithContext(CHANNELS.APP_BOOT, handleAppBoot));

  const handleAppGetState = async () => {
    return store.get("appState") as import("../../../../shared/types/ipc/app.js").AppState;
  };
  handlers.push(typedHandle(CHANNELS.APP_GET_STATE, handleAppGetState));

  const handleAppSetState = async (
    ctx: IpcContext,
    incoming: Partial<import("../../../../shared/types/ipc/app.js").AppState>
  ) => {
    try {
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        console.error("Invalid app state payload:", incoming);
        return;
      }

      // Handler performs its own structural validation before writing; cast to the
      // store schema to keep the `updates` object compatible with persistence types.
      const partialState = incoming as Partial<typeof store.store.appState>;

      const updates: Partial<typeof store.store.appState> = {};

      if ("sidebarWidth" in partialState) {
        const width = Number(partialState.sidebarWidth);
        if (!isNaN(width) && width >= 200 && width <= 600) {
          updates.sidebarWidth = width;
        }
      }

      if ("activeWorktreeId" in partialState) {
        updates.activeWorktreeId = partialState.activeWorktreeId;
      }

      // Note: terminals are NOT persisted - they stay running in the backend
      // and are discovered via terminalClient.getForProject() on hydration
      if ("terminals" in partialState && Array.isArray(partialState.terminals)) {
        // Validate and filter terminal entries before persisting
        const validTerminals = filterValidTerminalEntries(
          partialState.terminals,
          AppStateTerminalEntrySchema,
          "app:set-state"
        );
        updates.terminals = validTerminals;
      }

      if ("recipes" in partialState && Array.isArray(partialState.recipes)) {
        const validRecipes = partialState.recipes.filter((recipe: any) => {
          return (
            recipe &&
            typeof recipe === "object" &&
            typeof recipe.id === "string" &&
            typeof recipe.name === "string" &&
            Array.isArray(recipe.terminals) &&
            recipe.terminals.length > 0 &&
            recipe.terminals.length <= 10 &&
            typeof recipe.createdAt === "number"
          );
        });
        updates.recipes = validRecipes;
      }

      if ("focusMode" in partialState) {
        updates.focusMode = Boolean(partialState.focusMode);
      }

      if ("focusPanelState" in partialState) {
        const panelState = partialState.focusPanelState;
        if (panelState === undefined || panelState === null) {
          updates.focusPanelState = undefined;
        } else if (typeof panelState === "object" && typeof panelState.sidebarWidth === "number") {
          if ("diagnosticsOpen" in panelState && typeof panelState.diagnosticsOpen === "boolean") {
            updates.focusPanelState = {
              sidebarWidth: panelState.sidebarWidth,
              diagnosticsOpen: panelState.diagnosticsOpen,
            };
          } else if (
            "logsOpen" in panelState &&
            typeof panelState.logsOpen === "boolean" &&
            "eventInspectorOpen" in panelState &&
            typeof panelState.eventInspectorOpen === "boolean"
          ) {
            updates.focusPanelState = {
              sidebarWidth: panelState.sidebarWidth,
              diagnosticsOpen: panelState.logsOpen || panelState.eventInspectorOpen,
            };
          }
        }
      }

      if ("diagnosticsHeight" in partialState) {
        const height = Number(partialState.diagnosticsHeight);
        if (!isNaN(height) && height >= 128 && height <= 1000) {
          updates.diagnosticsHeight = height;
        }
      }

      if ("dockedPopoverHeight" in partialState) {
        // Mirrors dockStore's clamp (min 300, up to 80% of a large viewport).
        const height = Number(partialState.dockedPopoverHeight);
        if (!isNaN(height) && height >= 300 && height <= 2000) {
          updates.dockedPopoverHeight = height;
        }
      }

      if ("hasSeenWelcome" in partialState) {
        updates.hasSeenWelcome = Boolean(partialState.hasSeenWelcome);
      }

      if ("developerMode" in partialState) {
        const devMode = partialState.developerMode;
        if (devMode && typeof devMode === "object") {
          updates.developerMode = {
            enabled: Boolean(devMode.enabled),
            showStateDebug: Boolean(devMode.showStateDebug),
            autoOpenDiagnostics: Boolean(devMode.autoOpenDiagnostics),
            focusEventsTab: Boolean(devMode.focusEventsTab),
            ...(typeof devMode.pluginAuditPlaintext === "boolean"
              ? { pluginAuditPlaintext: devMode.pluginAuditPlaintext }
              : {}),
          };
        }
      }

      if ("panelGridConfig" in partialState) {
        const gridConfig = partialState.panelGridConfig;
        if (gridConfig && typeof gridConfig === "object") {
          const strategy = gridConfig.strategy;
          const value = Number(gridConfig.value);
          if (
            (strategy === "automatic" ||
              strategy === "fixed-columns" ||
              strategy === "fixed-rows") &&
            !isNaN(value) &&
            value >= 1 &&
            value <= 10
          ) {
            updates.panelGridConfig = {
              strategy,
              value,
            };
          }
        }
      }

      if ("mruList" in partialState && Array.isArray(partialState.mruList)) {
        // Sanitize: dense array, string items with valid prefix, per-item length cap, dedupe
        const MRU_ID_PATTERN = /^(terminal|worktree):[a-zA-Z0-9_-]{1,128}$/;
        const seen = new Set<string>();
        const sanitized: string[] = [];
        for (const id of partialState.mruList) {
          if (
            typeof id === "string" &&
            MRU_ID_PATTERN.test(id) &&
            !seen.has(id) &&
            sanitized.length < 50
          ) {
            seen.add(id);
            sanitized.push(id);
          }
        }
        // Persist per-workspace so opening another view can't gut this list via
        // the quick-switcher prune pass (#9922). Fall back to the legacy global
        // write only when there's no resolvable workspace.
        const { workspaceId: mruWorkspaceId } = resolveWorkspaceForHydration(ctx);
        if (mruWorkspaceId) {
          await projectStore.enqueueProjectStateUpdate(mruWorkspaceId, (existing) =>
            existing ? { ...existing, mruList: sanitized } : null
          );
        } else {
          updates.mruList = sanitized;
        }
      }

      if ("actionMruList" in partialState && Array.isArray(partialState.actionMruList)) {
        const ACTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
        const MAX_ENTRIES = 20;
        const now = Date.now();
        const cutoff = now - USAGE_WINDOW_MS;

        const isLegacy =
          partialState.actionMruList.length > 0 &&
          typeof partialState.actionMruList[0] === "string";

        if (isLegacy) {
          const seen = new Set<string>();
          const sanitized: string[] = [];
          for (const id of partialState.actionMruList as string[]) {
            if (
              typeof id === "string" &&
              ACTION_ID_PATTERN.test(id) &&
              !seen.has(id) &&
              sanitized.length < MAX_ENTRIES
            ) {
              seen.add(id);
              sanitized.push(id);
            }
          }
          updates.actionMruList = sanitized;
        } else {
          const seen = new Set<string>();
          const sanitized: Array<{ id: string; uses: number[] }> = [];
          for (const entry of partialState.actionMruList as Array<{
            id?: unknown;
            uses?: unknown;
            score?: unknown;
            lastAccessedAt?: unknown;
          }>) {
            if (entry == null) continue;
            const id = entry.id;
            if (
              typeof id !== "string" ||
              !ACTION_ID_PATTERN.test(id) ||
              seen.has(id) ||
              sanitized.length >= MAX_ENTRIES
            ) {
              continue;
            }

            let uses: number[];
            if (Array.isArray(entry.uses)) {
              uses = entry.uses
                .filter(
                  (t): t is number =>
                    typeof t === "number" && Number.isFinite(t) && t > cutoff && t <= now
                )
                .sort((a: number, b: number) => a - b);
              if (uses.length > MAX_USES_PER_ENTRY) {
                uses = uses.slice(uses.length - MAX_USES_PER_ENTRY);
              }
            } else {
              // Migrate a legacy frecency entry ({ score, lastAccessedAt }) by
              // replaying round(score) uses at its last-access time; it drops out
              // entirely if that timestamp predates the rolling window.
              const rawScore = typeof entry.score === "number" ? entry.score : 0;
              const score = Number.isFinite(rawScore) ? rawScore : 0;
              const rawLast = typeof entry.lastAccessedAt === "number" ? entry.lastAccessedAt : 0;
              const lastAccessedAt = Number.isFinite(rawLast) ? Math.min(now, rawLast) : 0;
              if (lastAccessedAt > cutoff) {
                const count = Math.max(1, Math.min(MAX_USES_PER_ENTRY, Math.round(score)));
                uses = new Array(count).fill(lastAccessedAt);
              } else {
                uses = [];
              }
            }

            if (uses.length === 0) continue;
            seen.add(id);
            sanitized.push({ id, uses });
          }
          updates.actionMruList = sanitized;
        }
      }

      if ("actionPinnedIds" in partialState && Array.isArray(partialState.actionPinnedIds)) {
        const ACTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
        const MAX_PINNED = 100;
        const seen = new Set<string>();
        const sanitized: string[] = [];
        for (const id of partialState.actionPinnedIds) {
          if (
            typeof id === "string" &&
            ACTION_ID_PATTERN.test(id) &&
            !seen.has(id) &&
            sanitized.length < MAX_PINNED
          ) {
            seen.add(id);
            sanitized.push(id);
          }
        }
        updates.actionPinnedIds = sanitized;
      }

      if ("actionHiddenIds" in partialState && Array.isArray(partialState.actionHiddenIds)) {
        const ACTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
        const MAX_HIDDEN = 200;
        const seen = new Set<string>();
        const sanitized: string[] = [];
        for (const id of partialState.actionHiddenIds) {
          if (
            typeof id === "string" &&
            ACTION_ID_PATTERN.test(id) &&
            !seen.has(id) &&
            sanitized.length < MAX_HIDDEN
          ) {
            seen.add(id);
            sanitized.push(id);
          }
        }
        updates.actionHiddenIds = sanitized;
      }

      if ("fleetScopeMode" in partialState) {
        const mode = partialState.fleetScopeMode;
        if (mode === "legacy" || mode === "scoped") {
          updates.fleetScopeMode = mode;
        }
      }

      const hasCriticalField = Object.keys(updates).some((k) => CRASH_CRITICAL_FIELDS.has(k));

      try {
        // Batch all fields into one write: every store.set() re-reads and
        // re-serializes the whole config.json, so a per-field loop costs N×
        // the file IO of a single merged set.
        if (Object.keys(updates).length > 0) {
          const current = (store.get("appState") ?? {}) as Record<string, unknown>;
          const merged: Record<string, unknown> = { ...current };
          for (const [field, value] of Object.entries(updates)) {
            if (value === undefined) {
              // electron-store v11 throws on `undefined` values — drop the
              // key from the merged object instead (was store.delete before).
              delete merged[field];
            } else {
              merged[field] = value;
            }
          }
          store.set("appState", merged as StoreSchema["appState"]);
        }
      } finally {
        if (hasCriticalField) {
          getCrashRecoveryService().scheduleBackup();
        }
      }

      // Note: We intentionally do NOT save per-project terminal state.
      // Terminals stay running in the backend and are discovered on hydration.
    } catch (error) {
      console.error("Failed to set app state:", error);
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.APP_SET_STATE, handleAppSetState));

  const handleAppGetVersion = async () => {
    return app.getVersion();
  };
  handlers.push(typedHandle(CHANNELS.APP_GET_VERSION, handleAppGetVersion));

  const handleAppQuit = async () => {
    app.quit();
  };
  handlers.push(typedHandle(CHANNELS.APP_QUIT, handleAppQuit));

  const handleAppForceQuit = async () => {
    app.exit(0);
  };
  handlers.push(typedHandle(CHANNELS.APP_FORCE_QUIT, handleAppForceQuit));

  const handleAppResetAndRelaunch = async () => {
    // Clear the crash-loop sentinel before relaunch so the next boot starts
    // fresh. Mirrors the gpu.ts pattern: prepare state -> relaunch -> close
    // telemetry -> exit. Use app.exit (not app.quit) so beforeunload listeners
    // can't veto the restart.
    getCrashLoopGuard().resetForNormalBoot();
    app.relaunch();
    await closeTelemetry();
    app.exit(0);
  };
  handlers.push(typedHandle(CHANNELS.APP_RESET_AND_RELAUNCH, handleAppResetAndRelaunch));

  handlers.push(
    typedHandleWithContext(CHANNELS.APP_FIRST_INTERACTIVE, async (ctx) => {
      markPerformance(PERF_MARKS.RENDERER_FIRST_INTERACTIVE, {
        webContentsId: ctx.webContentsId,
      });
      signalFirstInteractive(ctx.webContentsId);
    })
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.APP_VIEW_PAINTED, async (ctx) => {
      // Route to the ProjectViewManager that owns the sending view so its
      // pending paint gate can release. Mirrors the multi-window resolution
      // pattern used by `project:switch`: prefer the per-window registry
      // entry, fall back to the global PVM ref for single-window setups.
      const senderWindow = getWindowForWebContents(ctx.event.sender);
      const pvm =
        (senderWindow &&
          deps?.windowRegistry?.getByWindowId(senderWindow.id)?.services?.projectViewManager) ??
        deps?.projectViewManager;
      pvm?.signalViewPainted(ctx.webContentsId);
      // Flush any pending `daintree://` deep link now the view has painted — its
      // renderer-side listener is guaranteed mounted at this point (#9559).
      notifyAppViewPainted(ctx.event.sender);
    })
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.APP_VIEW_WARM_PAINTED, async (ctx) => {
      // Warm reactivation paint signal: the renderer fired this after its wake
      // fan-out completed and a clean post-atlas-repair frame painted. Release
      // the warm paint gate that is holding the reactivated view's opaque
      // background-color cover (#9679). Same per-window resolution as
      // APP_VIEW_PAINTED, but re-fireable across reactivations (unlike the
      // one-shot APP_VIEW_PAINTED).
      const senderWindow = getWindowForWebContents(ctx.event.sender);
      const pvm =
        (senderWindow &&
          deps?.windowRegistry?.getByWindowId(senderWindow.id)?.services?.projectViewManager) ??
        deps?.projectViewManager;
      pvm?.signalWarmViewPainted(ctx.webContentsId);
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
