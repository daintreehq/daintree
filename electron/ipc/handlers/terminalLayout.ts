import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
  sanitizeTabGroups,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalSnapshot, TabGroup } from "../../types/index.js";

export function registerTerminalLayoutHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetTerminals = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TerminalSnapshot[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.terminals ?? [];
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_TERMINALS, handleProjectGetTerminals);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_TERMINALS));

  const handleProjectSetTerminals = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; terminals: TerminalSnapshot[] }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, terminals } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!Array.isArray(terminals)) {
      throw new Error("Invalid terminals array");
    }

    const validTerminals = filterValidTerminalEntries(
      terminals,
      TerminalSnapshotSchema,
      `project:set-terminals(${projectId})`
    );

    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: validTerminals,
      tabGroups: existingState?.tabGroups ?? [],
      terminalLayout: existingState?.terminalLayout,
      focusMode: existingState?.focusMode,
      focusPanelState: existingState?.focusPanelState,
      terminalSizes: existingState?.terminalSizes,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_TERMINALS, handleProjectSetTerminals);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_TERMINALS));

  const handleProjectGetTerminalSizes = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<Record<string, { cols: number; rows: number }>> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.terminalSizes ?? {};
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_TERMINAL_SIZES, handleProjectGetTerminalSizes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_TERMINAL_SIZES));

  const handleProjectSetTerminalSizes = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, terminalSizes } = payload as {
      projectId: string;
      terminalSizes: Record<string, { cols: number; rows: number }>;
    };
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (
      !terminalSizes ||
      typeof terminalSizes !== "object" ||
      Array.isArray(terminalSizes) ||
      terminalSizes === null
    ) {
      throw new Error("Invalid terminal sizes");
    }

    const sanitizedSizes: Record<string, { cols: number; rows: number }> = {};
    for (const [terminalId, size] of Object.entries(terminalSizes)) {
      if (
        size &&
        typeof size === "object" &&
        typeof size.cols === "number" &&
        typeof size.rows === "number" &&
        Number.isFinite(size.cols) &&
        Number.isFinite(size.rows) &&
        Number.isInteger(size.cols) &&
        Number.isInteger(size.rows) &&
        size.cols > 0 &&
        size.cols <= 500 &&
        size.rows > 0 &&
        size.rows <= 500
      ) {
        sanitizedSizes[terminalId] = { cols: size.cols, rows: size.rows };
      }
    }

    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: existingState?.terminals ?? [],
      tabGroups: existingState?.tabGroups ?? [],
      terminalLayout: existingState?.terminalLayout,
      focusMode: existingState?.focusMode,
      focusPanelState: existingState?.focusPanelState,
      terminalSizes: sanitizedSizes,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_TERMINAL_SIZES, handleProjectSetTerminalSizes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_TERMINAL_SIZES));

  const handleProjectGetTabGroups = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TabGroup[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.tabGroups ?? [];
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_TAB_GROUPS, handleProjectGetTabGroups);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_TAB_GROUPS));

  const handleProjectSetTabGroups = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; tabGroups: TabGroup[] }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, tabGroups } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!Array.isArray(tabGroups)) {
      throw new Error("Invalid tabGroups array");
    }

    const sanitizedTabGroups = sanitizeTabGroups(tabGroups, projectId) as TabGroup[];

    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: existingState?.terminals ?? [],
      tabGroups: sanitizedTabGroups,
      terminalLayout: existingState?.terminalLayout,
      focusMode: existingState?.focusMode,
      focusPanelState: existingState?.focusPanelState,
      terminalSizes: existingState?.terminalSizes,
    };
    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_TAB_GROUPS, handleProjectSetTabGroups);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_TAB_GROUPS));

  const handleProjectGetFocusMode = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<{
    focusMode: boolean;
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
  }> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return {
      focusMode: state?.focusMode ?? false,
      focusPanelState: state?.focusPanelState,
    };
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_FOCUS_MODE, handleProjectGetFocusMode);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_FOCUS_MODE));

  const handleProjectSetFocusMode = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      projectId: string;
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, focusMode, focusPanelState } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof focusMode !== "boolean") {
      throw new Error("Invalid focusMode value");
    }

    let validFocusPanelState: { sidebarWidth: number; diagnosticsOpen: boolean } | undefined;
    if (focusPanelState !== undefined && focusPanelState !== null) {
      if (
        typeof focusPanelState !== "object" ||
        typeof focusPanelState.sidebarWidth !== "number" ||
        typeof focusPanelState.diagnosticsOpen !== "boolean"
      ) {
        throw new Error("Invalid focusPanelState structure");
      }
      if (
        !Number.isFinite(focusPanelState.sidebarWidth) ||
        focusPanelState.sidebarWidth < 0 ||
        focusPanelState.sidebarWidth > 10000
      ) {
        throw new Error("Invalid sidebarWidth: must be finite and between 0-10000");
      }
      validFocusPanelState = {
        sidebarWidth: focusPanelState.sidebarWidth,
        diagnosticsOpen: focusPanelState.diagnosticsOpen,
      };
    }

    const existingState = await projectStore.getProjectState(projectId);
    const newState = {
      projectId,
      activeWorktreeId: existingState?.activeWorktreeId,
      sidebarWidth: existingState?.sidebarWidth ?? 350,
      terminals: existingState?.terminals ?? [],
      tabGroups: existingState?.tabGroups ?? [],
      terminalLayout: existingState?.terminalLayout,
      focusMode,
      focusPanelState: validFocusPanelState,
      terminalSizes: existingState?.terminalSizes,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  ipcMain.handle(CHANNELS.PROJECT_SET_FOCUS_MODE, handleProjectSetFocusMode);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SET_FOCUS_MODE));

  return () => handlers.forEach((cleanup) => cleanup());
}
