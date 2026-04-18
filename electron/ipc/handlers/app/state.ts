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

import { isWebGLHardwareAccelerated } from "../../../utils/gpuDetection.js";
import { isGpuDisabledByFlag } from "../../../services/GpuCrashMonitorService.js";
import { getCrashLoopGuard } from "../../../services/CrashLoopGuardService.js";
import { inferKind } from "../../../../shared/utils/inferPanelKind.js";
import { typedHandle } from "../../utils.js";

export function registerAppStateHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleAppHydrate = async () => {
    const currentProject = projectStore.getCurrentProject();
    const globalAppState = store.get("appState");
    const projectId = currentProject?.id;

    // First, try to get terminals from per-project state (new model)
    // Fall back to global appState.terminals for migration
    let terminalsToUse: StoreSchema["appState"]["terminals"] = [];
    let terminalsSource = "none";

    // Focus mode state to include in response
    let focusModeToUse = globalAppState.focusMode ?? false;
    let focusPanelStateToUse = globalAppState.focusPanelState;
    // Active worktree state to include in response
    let activeWorktreeIdToUse = globalAppState.activeWorktreeId;
    let projectStateQuarantinedPath: string | undefined;

    if (projectId) {
      const { state: projectState, quarantinedPath } =
        await projectStore.getProjectStateWithRecovery(projectId);
      projectStateQuarantinedPath = quarantinedPath;
      // Per-project state exists (even if empty) - use it as authoritative
      if (projectState?.terminals !== undefined) {
        // Use per-project terminals, excluding trashed and normalizing location
        const validatedTerminals = filterValidTerminalEntries(
          projectState.terminals,
          TerminalSnapshotSchema,
          `app:hydrate(project:${projectId})`
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
          await projectStore.saveProjectState(projectId, {
            ...projectState,
            focusMode: focusModeToUse,
            focusPanelState: focusPanelStateToUse,
          });

          console.log(
            `[AppHydrate] Migrated focusMode (${focusModeToUse}) to per-project state for ${currentProject?.name}`
          );
        }
      } else if (globalAppState.terminals && globalAppState.terminals.length > 0) {
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
          await projectStore.saveProjectState(projectId, {
            projectId,
            activeWorktreeId: globalAppState.activeWorktreeId,
            sidebarWidth: globalAppState.sidebarWidth ?? 350,
            terminals: migratedTerminals,
            focusMode: globalAppState.focusMode,
            focusPanelState: normalizedFocusPanelState,
          });

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
          await projectStore.saveProjectState(projectId, {
            projectId,
            activeWorktreeId: globalAppState.activeWorktreeId,
            sidebarWidth: globalAppState.sidebarWidth ?? 350,
            terminals: [],
            focusMode: globalAppState.focusMode,
            focusPanelState: normalizedFocusPanelState,
          });
        }
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

        // No per-project state and no global terminals - create fresh state with focus mode migration
        await projectStore.saveProjectState(projectId, {
          projectId,
          activeWorktreeId: globalAppState.activeWorktreeId,
          sidebarWidth: globalAppState.sidebarWidth ?? 350,
          terminals: [],
          focusMode: globalAppState.focusMode,
          focusPanelState: normalizedFocusPanelState,
        });
      }
    } else {
      // No project - use global terminals (legacy/fallback)
      terminalsToUse = filterValidTerminalEntries(
        globalAppState.terminals,
        AppStateTerminalEntrySchema,
        "app:hydrate(no-project)"
      );
      terminalsSource = "global-fallback";
    }

    // In safe mode, skip terminal restoration to break crash loops
    const inSafeMode = getCrashLoopGuard().isSafeMode();
    if (inSafeMode) {
      terminalsToUse = [];
      terminalsSource = "safe-mode";
      console.log("[AppHydrate] Safe mode active — skipping terminal restoration");
    }

    // Apply one-shot crash recovery panel filter if set
    // Empty array means "no specific selection" (legacy/no-panels case) — skip filtering
    const panelFilter = getCrashRecoveryService().consumePanelFilter();
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
    };

    console.log(
      `[AppHydrate] Project: ${currentProject?.name ?? "none"} - terminals from ${terminalsSource} (${terminalsToUse.length} valid), focusMode: ${focusModeToUse}`
    );

    const gpuStatus = app.getGPUFeatureStatus();
    const gpuWebGLHardware = isWebGLHardwareAccelerated(gpuStatus.webgl2);
    if (!gpuWebGLHardware) {
      console.warn(
        `[AppHydrate] Software-only WebGL2 detected (status: ${gpuStatus.webgl2}). WebGL terminal renderer will be disabled.`
      );
    }

    return {
      appState,
      terminalConfig: store.get("terminalConfig"),
      project: currentProject,
      agentSettings: store.get("agentSettings"),
      gpuWebGLHardware,
      gpuHardwareAccelerationDisabled: isGpuDisabledByFlag(app.getPath("userData")),
      safeMode: inSafeMode,
      settingsRecovery: consumePendingSettingsRecovery(),
      projectStateRecovery: projectStateQuarantinedPath
        ? { quarantinedPath: projectStateQuarantinedPath }
        : null,
    };
  };
  handlers.push(typedHandle(CHANNELS.APP_HYDRATE, handleAppHydrate));

  const handleAppGetState = async () => {
    return store.get("appState");
  };
  handlers.push(typedHandle(CHANNELS.APP_GET_STATE, handleAppGetState));

  const handleAppSetState = async (
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

      const currentState = store.get("appState");

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
        if (
          panelState &&
          typeof panelState === "object" &&
          typeof panelState.sidebarWidth === "number"
        ) {
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
        updates.mruList = sanitized;
      }

      if ("actionMruList" in partialState && Array.isArray(partialState.actionMruList)) {
        const ACTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
        const MAX_ENTRIES = 20;
        const MAX_SCORE = 100;
        const now = Date.now();

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
          const sanitized: Array<{ id: string; score: number; lastAccessedAt: number }> = [];
          for (const entry of partialState.actionMruList as Array<{
            id?: unknown;
            score?: unknown;
            lastAccessedAt?: unknown;
          }>) {
            if (entry == null) continue;
            const id = entry.id;
            const score = typeof entry.score === "number" ? entry.score : 0;
            const lastAccessedAt =
              typeof entry.lastAccessedAt === "number" ? entry.lastAccessedAt : 0;

            if (
              typeof id === "string" &&
              ACTION_ID_PATTERN.test(id) &&
              !seen.has(id) &&
              sanitized.length < MAX_ENTRIES
            ) {
              seen.add(id);
              sanitized.push({
                id,
                score: Math.max(0, Math.min(MAX_SCORE, score)),
                lastAccessedAt: Math.max(0, Math.min(now, lastAccessedAt)),
              });
            }
          }
          updates.actionMruList = sanitized;
        }
      }

      store.set("appState", { ...currentState, ...updates });

      // Note: We intentionally do NOT save per-project terminal state.
      // Terminals stay running in the backend and are discovered on hydration.
    } catch (error) {
      console.error("Failed to set app state:", error);
    }
  };
  handlers.push(typedHandle(CHANNELS.APP_SET_STATE, handleAppSetState));

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

  return () => handlers.forEach((cleanup) => cleanup());
}
