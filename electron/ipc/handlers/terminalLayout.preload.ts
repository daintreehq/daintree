import type { IpcInvokeMap } from "../../types/index.js";
import type { IdArrayFieldClear } from "../../../shared/utils/layoutMerge.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — `terminalLayout`'s renderer
// API uses positional arguments (e.g. `setTerminals(projectId, terminals)`)
// while the IPC channels carry payload objects. The translation lives in the
// invoke wrapper below, so the generator must skip this namespace.
export const RENDERER_API_SKIP = true as const;

export const TERMINAL_LAYOUT_METHOD_CHANNELS = {
  getTerminals: "project:get-terminals",
  setTerminals: "project:set-terminals",
  getTerminalSizes: "project:get-terminal-sizes",
  setTerminalSizes: "project:set-terminal-sizes",
  getTabGroups: "project:get-tab-groups",
  setTabGroups: "project:set-tab-groups",
  getFocusMode: "project:get-focus-mode",
  setFocusMode: "project:set-focus-mode",
  getDraftInputs: "project:get-draft-inputs",
  setDraftInputs: "project:set-draft-inputs",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type TerminalSnapshot = import("../../types/index.js").TerminalSnapshot;
type TabGroup = import("../../types/index.js").TabGroup;
type FocusModeResult = IpcInvokeMap["project:get-focus-mode"]["result"];
type FocusPanelState = NonNullable<FocusModeResult["focusPanelState"]>;

export interface TerminalLayoutPreloadBindings {
  getTerminals(projectId: string): Promise<TerminalSnapshot[]>;
  // `changedIds`/`removedIds` describe what this renderer changed relative to
  // its last-persisted baseline so Main can merge concurrent writes from
  // sibling windows of the same project (#11350). Omit both for a full replace.
  // `clearedFields` tombstones fields Main may author out-of-band (#11461).
  setTerminals(
    projectId: string,
    terminals: TerminalSnapshot[],
    changedIds?: string[],
    removedIds?: string[],
    clearedFields?: IdArrayFieldClear[]
  ): Promise<void>;
  getTerminalSizes(projectId: string): Promise<Record<string, { cols: number; rows: number }>>;
  setTerminalSizes(
    projectId: string,
    terminalSizes: Record<string, { cols: number; rows: number }>
  ): Promise<void>;
  getTabGroups(projectId: string): Promise<TabGroup[]>;
  setTabGroups(
    projectId: string,
    tabGroups: TabGroup[],
    changedIds?: string[],
    removedIds?: string[]
  ): Promise<void>;
  getFocusMode(projectId: string): Promise<FocusModeResult>;
  setFocusMode(
    projectId: string,
    focusMode: boolean,
    focusPanelState?: FocusPanelState
  ): Promise<void>;
  getDraftInputs(projectId: string): Promise<Record<string, string>>;
  // `changedIds`/`removedIds` (terminal ids) describe what this renderer changed
  // relative to its last-persisted baseline so Main can merge concurrent writes
  // from sibling windows of the same project (#11352). Omit both for a full
  // replace.
  setDraftInputs(
    projectId: string,
    draftInputs: Record<string, string>,
    changedIds?: string[],
    removedIds?: string[]
  ): Promise<void>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildTerminalLayoutPreloadBindings(invoke: Invoker): TerminalLayoutPreloadBindings {
  return {
    getTerminals: (projectId) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getTerminals, projectId) as Promise<
        TerminalSnapshot[]
      >,
    setTerminals: (projectId, terminals, changedIds, removedIds, clearedFields) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setTerminals, {
        projectId,
        terminals,
        changedIds,
        removedIds,
        clearedFields,
      }) as Promise<void>,
    getTerminalSizes: (projectId) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getTerminalSizes, projectId) as Promise<
        Record<string, { cols: number; rows: number }>
      >,
    setTerminalSizes: (projectId, terminalSizes) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setTerminalSizes, {
        projectId,
        terminalSizes,
      }) as Promise<void>,
    getTabGroups: (projectId) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getTabGroups, projectId) as Promise<TabGroup[]>,
    setTabGroups: (projectId, tabGroups, changedIds, removedIds) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setTabGroups, {
        projectId,
        tabGroups,
        changedIds,
        removedIds,
      }) as Promise<void>,
    getFocusMode: (projectId) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getFocusMode, projectId) as Promise<FocusModeResult>,
    setFocusMode: (projectId, focusMode, focusPanelState) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setFocusMode, {
        projectId,
        focusMode,
        focusPanelState,
      }) as Promise<void>,
    getDraftInputs: (projectId) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getDraftInputs, projectId) as Promise<
        Record<string, string>
      >,
    setDraftInputs: (projectId, draftInputs, changedIds, removedIds) =>
      invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setDraftInputs, {
        projectId,
        draftInputs,
        changedIds,
        removedIds,
      }) as Promise<void>,
  };
}
