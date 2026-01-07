import { ipcMain, app } from "electron";
import { CHANNELS } from "../../channels.js";
import { store, type StoreSchema } from "../../../store.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { AppStateTerminalEntrySchema, filterValidTerminalEntries } from "../../../schemas/ipc.js";

export function registerAppStateHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleAppHydrate = async () => {
    const currentProject = projectStore.getCurrentProject();
    const globalAppState = store.get("appState");

    // Validate terminals array on hydration to prevent corrupted data from reaching renderer
    const validatedTerminals = filterValidTerminalEntries(
      globalAppState.terminals,
      AppStateTerminalEntrySchema,
      "app:hydrate"
    );

    // Terminal processes are discovered from backend via terminalClient.getForProject(),
    // but we preserve saved terminals array for ordering metadata (IDs and locations).
    // The frontend uses this to restore panel order when reconnecting to running terminals.
    const appState: StoreSchema["appState"] = {
      ...globalAppState,
      terminals: validatedTerminals,
      // Keep terminals for ordering - frontend sorts discovered terminals by this saved order
      activeWorktreeId: undefined,
    };

    console.log(
      `[AppHydrate] Project: ${currentProject?.name ?? "none"} - terminals will be discovered from running processes (${validatedTerminals.length} valid of ${globalAppState.terminals?.length ?? 0} saved for ordering)`
    );

    return {
      appState,
      terminalConfig: store.get("terminalConfig"),
      project: currentProject,
      agentSettings: store.get("agentSettings"),
    };
  };
  ipcMain.handle(CHANNELS.APP_HYDRATE, handleAppHydrate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_HYDRATE));

  const handleAppGetState = async () => {
    return store.get("appState");
  };
  ipcMain.handle(CHANNELS.APP_GET_STATE, handleAppGetState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_GET_STATE));

  const handleAppSetState = async (
    _event: Electron.IpcMainInvokeEvent,
    partialState: Partial<typeof store.store.appState>
  ) => {
    try {
      if (!partialState || typeof partialState !== "object" || Array.isArray(partialState)) {
        console.error("Invalid app state payload:", partialState);
        return;
      }

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

      if ("terminalGridConfig" in partialState) {
        const gridConfig = partialState.terminalGridConfig;
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
            updates.terminalGridConfig = {
              strategy,
              value,
            };
          }
        }
      }

      if ("dockCollapsed" in partialState) {
        if (typeof partialState.dockCollapsed === "boolean") {
          updates.dockCollapsed = partialState.dockCollapsed;
        }
      }

      if ("dockMode" in partialState) {
        const mode = partialState.dockMode;
        if (mode === "expanded" || mode === "hidden" || mode === "slim") {
          // Normalize legacy "slim" to "hidden"
          updates.dockMode = mode === "slim" ? "hidden" : mode;
        }
      }

      if ("dockBehavior" in partialState) {
        const behavior = partialState.dockBehavior;
        if (behavior === "auto" || behavior === "manual") {
          updates.dockBehavior = behavior;
        }
      }

      if ("dockAutoHideWhenEmpty" in partialState) {
        if (typeof partialState.dockAutoHideWhenEmpty === "boolean") {
          updates.dockAutoHideWhenEmpty = partialState.dockAutoHideWhenEmpty;
        }
      }

      store.set("appState", { ...currentState, ...updates });

      // Note: We intentionally do NOT save per-project terminal state.
      // Terminals stay running in the backend and are discovered on hydration.
    } catch (error) {
      console.error("Failed to set app state:", error);
    }
  };
  ipcMain.handle(CHANNELS.APP_SET_STATE, handleAppSetState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_SET_STATE));

  const handleAppGetVersion = async () => {
    return app.getVersion();
  };
  ipcMain.handle(CHANNELS.APP_GET_VERSION, handleAppGetVersion);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_GET_VERSION));

  const handleAppQuit = async () => {
    app.quit();
  };
  ipcMain.handle(CHANNELS.APP_QUIT, handleAppQuit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_QUIT));

  const handleAppForceQuit = async () => {
    app.exit(0);
  };
  ipcMain.handle(CHANNELS.APP_FORCE_QUIT, handleAppForceQuit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_FORCE_QUIT));

  return () => handlers.forEach((cleanup) => cleanup());
}
