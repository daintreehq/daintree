import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
  sanitizeTabGroups,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalSnapshot, TabGroup } from "../../types/index.js";
import { typedHandle } from "../utils.js";

/**
 * Validate and filter terminal snapshots using the Zod schema.
 * Invalid entries are silently dropped with a console warning.
 */
export function sanitizeTerminals(terminals: unknown[], context: string): TerminalSnapshot[] {
  return filterValidTerminalEntries(terminals, TerminalSnapshotSchema, context);
}

/**
 * Validate and sanitize terminal size records.
 * Entries with invalid dimensions (non-finite, non-integer, out of 1–500 range) are dropped.
 */
export function sanitizeTerminalSizes(
  sizes: Record<string, unknown>
): Record<string, { cols: number; rows: number }> {
  const sanitized: Record<string, { cols: number; rows: number }> = {};
  for (const [terminalId, size] of Object.entries(sizes)) {
    if (
      size &&
      typeof size === "object" &&
      "cols" in size &&
      "rows" in size &&
      typeof (size as { cols: unknown }).cols === "number" &&
      typeof (size as { rows: unknown }).rows === "number"
    ) {
      const { cols, rows } = size as { cols: number; rows: number };
      if (
        Number.isFinite(cols) &&
        Number.isFinite(rows) &&
        Number.isInteger(cols) &&
        Number.isInteger(rows) &&
        cols > 0 &&
        cols <= 500 &&
        rows > 0 &&
        rows <= 500
      ) {
        sanitized[terminalId] = { cols, rows };
      }
    }
  }
  return sanitized;
}

/**
 * Validate and sanitize draft input records.
 * Entries with non-string values or empty keys/values are dropped.
 */
export function sanitizeDraftInputs(inputs: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [terminalId, value] of Object.entries(inputs)) {
    if (terminalId && typeof value === "string" && value !== "") {
      sanitized[terminalId] = value;
    }
  }
  return sanitized;
}

export function registerTerminalLayoutHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetTerminals = async (projectId: string): Promise<TerminalSnapshot[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.terminals ?? [];
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_TERMINALS, handleProjectGetTerminals));

  const handleProjectSetTerminals = async (payload: {
    projectId: string;
    terminals: TerminalSnapshot[];
  }): Promise<void> => {
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

    const validTerminals = sanitizeTerminals(terminals, `project:set-terminals(${projectId})`);

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
      draftInputs: existingState?.draftInputs,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SET_TERMINALS, handleProjectSetTerminals));

  const handleProjectGetTerminalSizes = async (
    projectId: string
  ): Promise<Record<string, { cols: number; rows: number }>> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.terminalSizes ?? {};
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_TERMINAL_SIZES, handleProjectGetTerminalSizes));

  const handleProjectSetTerminalSizes = async (payload: unknown): Promise<void> => {
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

    const sanitizedSizes = sanitizeTerminalSizes(terminalSizes as Record<string, unknown>);

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
      draftInputs: existingState?.draftInputs,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SET_TERMINAL_SIZES, handleProjectSetTerminalSizes));

  const handleProjectGetTabGroups = async (projectId: string): Promise<TabGroup[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.tabGroups ?? [];
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_TAB_GROUPS, handleProjectGetTabGroups));

  const handleProjectSetTabGroups = async (payload: {
    projectId: string;
    tabGroups: TabGroup[];
  }): Promise<void> => {
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
      draftInputs: existingState?.draftInputs,
    };
    await projectStore.saveProjectState(projectId, newState);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SET_TAB_GROUPS, handleProjectSetTabGroups));

  const handleProjectGetFocusMode = async (
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
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_FOCUS_MODE, handleProjectGetFocusMode));

  const handleProjectSetFocusMode = async (payload: {
    projectId: string;
    focusMode: boolean;
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
  }): Promise<void> => {
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
      draftInputs: existingState?.draftInputs,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SET_FOCUS_MODE, handleProjectSetFocusMode));

  const handleProjectGetDraftInputs = async (
    projectId: string
  ): Promise<Record<string, string>> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const state = await projectStore.getProjectState(projectId);
    return state?.draftInputs ?? {};
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_DRAFT_INPUTS, handleProjectGetDraftInputs));

  const handleProjectSetDraftInputs = async (payload: unknown): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, draftInputs } = payload as {
      projectId: string;
      draftInputs: Record<string, string>;
    };
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (
      !draftInputs ||
      typeof draftInputs !== "object" ||
      Array.isArray(draftInputs) ||
      draftInputs === null
    ) {
      throw new Error("Invalid draft inputs");
    }

    const sanitized = sanitizeDraftInputs(draftInputs as Record<string, unknown>);

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
      terminalSizes: existingState?.terminalSizes,
      draftInputs: sanitized,
    };

    await projectStore.saveProjectState(projectId, newState);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_SET_DRAFT_INPUTS, handleProjectSetDraftInputs));

  return () => handlers.forEach((cleanup) => cleanup());
}
