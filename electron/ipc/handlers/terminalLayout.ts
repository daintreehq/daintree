import { projectStore } from "../../services/ProjectStore.js";
import {
  TerminalSnapshotSchema,
  filterValidTerminalEntries,
  sanitizeTabGroups,
} from "../../schemas/index.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalSnapshot, TabGroup } from "../../types/index.js";
import { defineIpcNamespace, op } from "../define.js";
import {
  mergeIdArray,
  mergeRecord,
  type IdArrayFieldEdit,
} from "../../../shared/utils/layoutMerge.js";
import { TERMINAL_LAYOUT_METHOD_CHANNELS } from "./terminalLayout.preload.js";

/**
 * Coerce an over-the-wire id list into a clean `string[]`, or `undefined` when
 * absent. Absent delta metadata means a legacy full-replace write (see
 * `setTerminals` / `setTabGroups` below); a present-but-malformed value is
 * treated as an empty list rather than throwing.
 */
function sanitizeIdList(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is string => typeof id === "string");
}

/**
 * Validate and filter terminal snapshots using the Zod schema.
 * Invalid entries are silently dropped with a console warning.
 */
export function sanitizeTerminals(terminals: unknown[], context: string): TerminalSnapshot[] {
  return filterValidTerminalEntries(terminals, TerminalSnapshotSchema, context);
}

/**
 * Fields on a terminal snapshot that Main itself can author, so a renderer only
 * moves them when it says it changed them (#11461). Kept to the minimum: just the
 * graceful-shutdown session capture.
 */
export const TERMINAL_FIELD_LEVEL_MERGE = [
  "agentSessionId",
] as const satisfies readonly (keyof TerminalSnapshot)[];

const TERMINAL_TRACKED_FIELD_SET: ReadonlySet<string> = new Set(TERMINAL_FIELD_LEVEL_MERGE);

/**
 * Coerce untrusted `fieldEdits` metadata into the authority claims the merge
 * accepts. Entries without a usable id are dropped and field names outside the
 * allowlist are ignored, so a malformed payload can neither clear nor overwrite
 * anything the renderer isn't entitled to touch. Returns `undefined` when nothing
 * survives so the merge keeps its cheap path.
 */
export function sanitizeFieldEdits(value: unknown): IdArrayFieldEdit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized: IdArrayFieldEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, fields } = entry as { id?: unknown; fields?: unknown };
    if (typeof id !== "string" || !id || !Array.isArray(fields)) continue;
    const allowed = fields.filter(
      (field): field is string => typeof field === "string" && TERMINAL_TRACKED_FIELD_SET.has(field)
    );
    if (allowed.length === 0) continue;
    sanitized.push({ id, fields: allowed });
  }
  return sanitized.length > 0 ? sanitized : undefined;
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

export const terminalLayoutNamespace = defineIpcNamespace({
  name: "terminalLayout",
  ops: {
    getTerminals: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.getTerminals,
      async (projectId: string): Promise<TerminalSnapshot[]> => {
        if (typeof projectId !== "string" || !projectId) {
          throw new Error("Invalid project ID");
        }
        const state = await projectStore.getProjectState(projectId);
        return state?.terminals ?? [];
      }
    ),
    setTerminals: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.setTerminals,
      async (payload: {
        projectId: string;
        terminals: TerminalSnapshot[];
        changedIds?: string[];
        removedIds?: string[];
        fieldEdits?: IdArrayFieldEdit[];
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
        // Delta metadata lets Main merge concurrent writes from sibling windows
        // of the same project instead of blindly replacing the array (#11350).
        // Absent metadata = legacy full-replace write.
        const changedIds = sanitizeIdList(payload.changedIds);
        const removedIds = sanitizeIdList(payload.removedIds);
        const fieldEdits = sanitizeFieldEdits(payload.fieldEdits);

        await projectStore.enqueueProjectStateUpdate(projectId, (existingState) => ({
          projectId,
          activeWorktreeId: existingState?.activeWorktreeId,
          sidebarWidth: existingState?.sidebarWidth ?? 350,
          terminals:
            changedIds === undefined
              ? validTerminals
              : mergeIdArray(
                  existingState?.terminals ?? [],
                  validTerminals,
                  changedIds,
                  removedIds ?? [],
                  {
                    fieldLevelMerge: TERMINAL_FIELD_LEVEL_MERGE,
                    fieldEdits,
                  }
                ),
          tabGroups: existingState?.tabGroups ?? [],
          terminalLayout: existingState?.terminalLayout,
          focusMode: existingState?.focusMode,
          focusPanelState: existingState?.focusPanelState,
          terminalSizes: existingState?.terminalSizes,
          draftInputs: existingState?.draftInputs,
          // This updater rebuilds the whole record, so every field it does not
          // carry forward is deleted — the quick switcher's MRU included
          // (#11497).
          mruList: existingState?.mruList,
        }));
      }
    ),
    getTerminalSizes: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.getTerminalSizes,
      async (projectId: string): Promise<Record<string, { cols: number; rows: number }>> => {
        if (typeof projectId !== "string" || !projectId) {
          throw new Error("Invalid project ID");
        }
        const state = await projectStore.getProjectState(projectId);
        return state?.terminalSizes ?? {};
      }
    ),
    setTerminalSizes: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.setTerminalSizes,
      async (payload: {
        projectId: string;
        terminalSizes: Record<string, { cols: number; rows: number }>;
      }): Promise<void> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { projectId, terminalSizes } = payload;
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

        await projectStore.enqueueProjectStateUpdate(projectId, (existingState) => ({
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
          // See setTerminals: this rebuild deletes any field it omits (#11497).
          mruList: existingState?.mruList,
        }));
      }
    ),
    getTabGroups: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.getTabGroups,
      async (projectId: string): Promise<TabGroup[]> => {
        if (typeof projectId !== "string" || !projectId) {
          throw new Error("Invalid project ID");
        }
        const state = await projectStore.getProjectState(projectId);
        return state?.tabGroups ?? [];
      }
    ),
    setTabGroups: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.setTabGroups,
      async (payload: {
        projectId: string;
        tabGroups: TabGroup[];
        changedIds?: string[];
        removedIds?: string[];
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
        // See setTerminals: merge sibling-window writes by tab-group id (#11350).
        const changedIds = sanitizeIdList(payload.changedIds);
        const removedIds = sanitizeIdList(payload.removedIds);

        await projectStore.enqueueProjectStateUpdate(projectId, (existingState) => ({
          projectId,
          activeWorktreeId: existingState?.activeWorktreeId,
          sidebarWidth: existingState?.sidebarWidth ?? 350,
          terminals: existingState?.terminals ?? [],
          tabGroups:
            changedIds === undefined
              ? sanitizedTabGroups
              : mergeIdArray(
                  existingState?.tabGroups ?? [],
                  sanitizedTabGroups,
                  changedIds,
                  removedIds ?? []
                ),
          terminalLayout: existingState?.terminalLayout,
          focusMode: existingState?.focusMode,
          focusPanelState: existingState?.focusPanelState,
          terminalSizes: existingState?.terminalSizes,
          draftInputs: existingState?.draftInputs,
          // See setTerminals: this rebuild deletes any field it omits (#11497).
          mruList: existingState?.mruList,
        }));
      }
    ),
    getFocusMode: op(TERMINAL_LAYOUT_METHOD_CHANNELS.getFocusMode, async (projectId: string) => {
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project ID");
      }
      const state = await projectStore.getProjectState(projectId);
      return {
        focusMode: state?.focusMode ?? false,
        focusPanelState: state?.focusPanelState,
      };
    }),
    setFocusMode: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.setFocusMode,
      async (payload: {
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

        await projectStore.enqueueProjectStateUpdate(projectId, (existingState) => ({
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
          // This updater rebuilds the whole record, so every field it does not
          // carry forward is deleted. Dropping the MRU here wiped the quick
          // switcher's order on any focus-mode toggle (#11497).
          mruList: existingState?.mruList,
        }));
      }
    ),
    getDraftInputs: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.getDraftInputs,
      async (projectId: string): Promise<Record<string, string>> => {
        if (typeof projectId !== "string" || !projectId) {
          throw new Error("Invalid project ID");
        }
        const state = await projectStore.getProjectState(projectId);
        return state?.draftInputs ?? {};
      }
    ),
    setDraftInputs: op(
      TERMINAL_LAYOUT_METHOD_CHANNELS.setDraftInputs,
      async (payload: {
        projectId: string;
        draftInputs: Record<string, string>;
        changedIds?: string[];
        removedIds?: string[];
      }): Promise<void> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { projectId, draftInputs } = payload;
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
        // Delta metadata lets Main merge concurrent draft writes from sibling
        // windows of the same project instead of blindly replacing the record
        // (#11352). Absent metadata = legacy full-replace write.
        const changedIds = sanitizeIdList(payload.changedIds);
        const removedIds = sanitizeIdList(payload.removedIds);

        await projectStore.enqueueProjectStateUpdate(projectId, (existingState) => {
          const mergedDrafts =
            changedIds === undefined
              ? sanitized
              : mergeRecord(
                  sanitizeDraftInputs(
                    (existingState?.draftInputs ?? {}) as Record<string, unknown>
                  ),
                  sanitized,
                  changedIds,
                  removedIds ?? []
                );
          // Don't recreate a project's deleted state file just to record draft
          // removals. A teardown flush can fire after the project was closed
          // (killTerminals) or removed — its persisted state gone — and emit a
          // pure-removal tombstone. With no existing state and nothing left to
          // persist, skip the write so a deleted state file stays deleted
          // (#11352). A genuine first draft on a new project still persists,
          // because mergedDrafts is non-empty there.
          if (!existingState && Object.keys(mergedDrafts).length === 0) {
            return null;
          }
          return {
            projectId,
            activeWorktreeId: existingState?.activeWorktreeId,
            sidebarWidth: existingState?.sidebarWidth ?? 350,
            terminals: existingState?.terminals ?? [],
            tabGroups: existingState?.tabGroups ?? [],
            terminalLayout: existingState?.terminalLayout,
            focusMode: existingState?.focusMode,
            focusPanelState: existingState?.focusPanelState,
            terminalSizes: existingState?.terminalSizes,
            draftInputs: mergedDrafts,
            // See setTerminals: this rebuild deletes any field it omits (#11497).
            mruList: existingState?.mruList,
          };
        });
      }
    ),
  },
});

export function registerTerminalLayoutHandlers(_deps: HandlerDependencies): () => void {
  return terminalLayoutNamespace.register();
}
