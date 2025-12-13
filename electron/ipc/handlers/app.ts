import { ipcMain, app, shell } from "electron";
import { join } from "path";
import { homedir } from "os";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import { logBuffer } from "../../services/LogBuffer.js";
import { setVerboseLogging, isVerboseLogging, logInfo } from "../../utils/logger.js";
import type { HandlerDependencies } from "../types.js";
import type { FilterOptions as LogFilterOptions } from "../../services/LogBuffer.js";
import type { FilterOptions as EventFilterOptions } from "../../services/EventBuffer.js";

export function registerAppHandlers(deps: HandlerDependencies): () => void {
  const { eventBuffer } = deps;
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

  const handleLogsGetAll = async (
    _event: Electron.IpcMainInvokeEvent,
    filters?: LogFilterOptions
  ) => {
    if (filters) {
      return logBuffer.getFiltered(filters);
    }
    return logBuffer.getAll();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_ALL, handleLogsGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_ALL));

  const handleLogsGetSources = async () => {
    return logBuffer.getSources();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_SOURCES, handleLogsGetSources);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_SOURCES));

  const handleLogsClear = async () => {
    logBuffer.clear();
  };
  ipcMain.handle(CHANNELS.LOGS_CLEAR, handleLogsClear);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_CLEAR));

  const handleLogsOpenFile = async () => {
    const logFilePath = join(homedir(), ".config", "canopy", "worktree-debug.log");
    try {
      const fs = await import("fs");
      await fs.promises.access(logFilePath);
      await shell.openPath(logFilePath);
    } catch (_error) {
      const fs = await import("fs");
      const dir = join(homedir(), ".config", "canopy");
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(logFilePath, "# Canopy Debug Log\n", "utf8");
      await shell.openPath(logFilePath);
    }
  };
  ipcMain.handle(CHANNELS.LOGS_OPEN_FILE, handleLogsOpenFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_OPEN_FILE));

  const handleLogsSetVerbose = async (_event: Electron.IpcMainInvokeEvent, enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      console.error("Invalid verbose logging payload:", enabled);
      return { success: false };
    }
    setVerboseLogging(enabled);
    logInfo(`Verbose logging ${enabled ? "enabled" : "disabled"} by user`);
    return { success: true };
  };
  ipcMain.handle(CHANNELS.LOGS_SET_VERBOSE, handleLogsSetVerbose);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_SET_VERBOSE));

  const handleLogsGetVerbose = async () => {
    return isVerboseLogging();
  };
  ipcMain.handle(CHANNELS.LOGS_GET_VERBOSE, handleLogsGetVerbose);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.LOGS_GET_VERBOSE));

  const handleEventInspectorGetEvents = async () => {
    if (!eventBuffer) {
      return [];
    }
    return eventBuffer.getAll();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_EVENTS, handleEventInspectorGetEvents);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_EVENTS));

  const handleEventInspectorGetFiltered = async (
    _event: Electron.IpcMainInvokeEvent,
    filters: EventFilterOptions
  ) => {
    if (!eventBuffer) {
      return [];
    }
    return eventBuffer.getFiltered(filters);
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_FILTERED, handleEventInspectorGetFiltered);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_FILTERED));

  const handleEventInspectorClear = async () => {
    if (!eventBuffer) {
      return;
    }
    eventBuffer.clear();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_CLEAR, handleEventInspectorClear);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_CLEAR));

  const handleTerminalConfigGet = async () => {
    return store.get("terminalConfig");
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_GET, handleTerminalConfigGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_GET));

  const handleTerminalConfigSetScrollback = async (
    _event: Electron.IpcMainInvokeEvent,
    scrollbackLines: number
  ) => {
    if (!Number.isFinite(scrollbackLines) || !Number.isInteger(scrollbackLines)) {
      const error = `Invalid scrollback value (not a finite integer): ${scrollbackLines}`;
      console.warn(error);
      throw new Error(error);
    }
    if (scrollbackLines < 100 || scrollbackLines > 10000) {
      const error = `Invalid scrollback value (out of range 100-10000): ${scrollbackLines}`;
      console.warn(error);
      throw new Error(error);
    }
    const currentConfig = store.get("terminalConfig");
    store.set("terminalConfig", { ...currentConfig, scrollbackLines });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, handleTerminalConfigSetScrollback);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK));

  const handleTerminalConfigSetPerformanceMode = async (
    _event: Electron.IpcMainInvokeEvent,
    performanceMode: boolean
  ) => {
    const currentConfig = store.get("terminalConfig");
    store.set("terminalConfig", { ...currentConfig, performanceMode: Boolean(performanceMode) });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE,
    handleTerminalConfigSetPerformanceMode
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE));

  const handleTerminalConfigSetFontSize = async (
    _event: Electron.IpcMainInvokeEvent,
    fontSize: number
  ) => {
    if (!Number.isFinite(fontSize) || !Number.isInteger(fontSize)) {
      console.warn("Invalid terminal fontSize (not a finite integer):", fontSize);
      return;
    }
    if (fontSize < 8 || fontSize > 24) {
      console.warn("Invalid terminal fontSize (out of range 8-24):", fontSize);
      return;
    }
    const currentConfig = store.get("terminalConfig");
    store.set("terminalConfig", { ...currentConfig, fontSize });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, handleTerminalConfigSetFontSize);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE));

  const handleTerminalConfigSetFontFamily = async (
    _event: Electron.IpcMainInvokeEvent,
    fontFamily: string
  ) => {
    if (typeof fontFamily !== "string" || !fontFamily.trim()) {
      console.warn("Invalid terminal fontFamily:", fontFamily);
      return;
    }
    const currentConfig = store.get("terminalConfig");
    store.set("terminalConfig", { ...currentConfig, fontFamily });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, handleTerminalConfigSetFontFamily);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY));

  return () => handlers.forEach((cleanup) => cleanup());
}
