import { ipcMain, app } from "electron";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import { projectStore } from "../../../services/ProjectStore.js";

export function registerAppStateHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleAppHydrate = async () => {
    return {
      appState: store.get("appState"),
      terminalConfig: store.get("terminalConfig"),
      project: projectStore.getCurrentProject(),
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

      if ("terminals" in partialState && Array.isArray(partialState.terminals)) {
        updates.terminals = partialState.terminals;
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
        updates.dockCollapsed = Boolean(partialState.dockCollapsed);
      }

      store.set("appState", { ...currentState, ...updates });
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
