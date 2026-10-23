import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import {
  PLUGIN_APPLICATION_NAVIGATION_LIMITS,
  type PluginNavigationLocation,
  type PluginNavigationParamValue,
} from "@shared/types/plugin";
import type { NavigationHistory } from "@shared/utils/applicationNavigation";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

/**
 * One project's application location and history (#14108), stamped with the
 * application it belongs to. The stamp is what makes the record a pointer and
 * not a promise: a different owner or a raised `navigation.version` reads it as
 * absent, and every entry is re-resolved against the live declaration before a
 * view sees it, so a record left behind by a removed plugin or section simply
 * isn't used.
 */
export interface ApplicationNavigationRecord {
  /** The owner's manifest id, which survives a reload; never its instance key. */
  ownerId: string;
  version: number;
  entries: PluginNavigationLocation[];
  index: number;
}

interface ApplicationNavigationState {
  /**
   * What is written to disk, keyed by host-scoped project id: only the
   * parameters each section marks `persist`.
   */
  byProject: Record<string, ApplicationNavigationRecord>;
  /**
   * The same history with every parameter, for the life of this project's
   * renderer. Never
   * persisted, so a session-only parameter (a search, a transient selection)
   * comes back after a remount but not after an evicted renderer or a restart.
   */
  sessions: Record<string, ApplicationNavigationRecord>;
  commit: (
    key: string,
    stamp: { ownerId: string; version: number },
    session: NavigationHistory,
    persisted: NavigationHistory
  ) => void;
}

type ApplicationNavigationPersistedState = Pick<ApplicationNavigationState, "byProject">;

const MAX_OWNER_ID_LENGTH = 214;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural decoding only: the shape a record must have to be read at all.
 * Whether its sections and parameters still mean anything is answered later,
 * against the live declaration, because the declaration isn't known yet.
 */
function toRecord(value: unknown): ApplicationNavigationRecord | null {
  if (!isPlainObject(value)) return null;
  const { ownerId, version, entries, index } = value;
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > MAX_OWNER_ID_LENGTH)
    return null;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) return null;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (entries.length > PLUGIN_APPLICATION_NAVIGATION_LIMITS.maxHistoryEntries) return null;
  if (typeof index !== "number" || !Number.isSafeInteger(index)) return null;
  if (index < 0 || index >= entries.length) return null;
  const kept: PluginNavigationLocation[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) return null;
    const { sectionId, params } = entry;
    if (typeof sectionId !== "string" || !isPlainObject(params)) return null;
    const values: Record<string, PluginNavigationParamValue> = {};
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return null;
      }
      values[name] = value;
    }
    kept.push({ sectionId, params: values });
  }
  return { ownerId, version, entries: kept, index };
}

function toPersisted(value: unknown): ApplicationNavigationPersistedState {
  const raw = isPlainObject(value) ? value.byProject : undefined;
  const byProject: Record<string, ApplicationNavigationRecord> = {};
  if (isPlainObject(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      const record = toRecord(entry);
      if (record !== null) byProject[key] = record;
    }
  }
  return { byProject };
}

function toStored(
  stamp: { ownerId: string; version: number },
  history: NavigationHistory
): ApplicationNavigationRecord {
  return { ...stamp, entries: [...history.entries], index: history.index };
}

/**
 * Per-project three-way merge, so one project view writing its location never
 * wipes the location another view just wrote for its own project (#11351). A
 * record is merged whole: two writers' histories are never spliced together.
 */
function mergeApplicationNavigationPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<ApplicationNavigationPersistedState>): StorageValue<ApplicationNavigationPersistedState> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toPersisted(onDisk.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  return {
    version: incoming.version,
    state: {
      byProject: mergeRecordByWriterDelta(
        toPersisted(baseline?.state).byProject,
        toPersisted(incoming.state).byProject,
        disk.byProject
      ),
    },
  };
}

export const useApplicationNavigationStore = create<ApplicationNavigationState>()(
  persist(
    (set) => ({
      byProject: {},
      sessions: {},
      commit: (key, stamp, session, persisted) => {
        set((state) => ({
          byProject: { ...state.byProject, [key]: toStored(stamp, persisted) },
          sessions: { ...state.sessions, [key]: toStored(stamp, session) },
        }));
      },
    }),
    {
      name: "daintree-application-navigation",
      version: 1,
      storage: createSafeJSONStorage<ApplicationNavigationPersistedState>({
        mergeOnWrite: mergeApplicationNavigationPersistedWrite,
      }),
      partialize: (state): ApplicationNavigationPersistedState => ({
        byProject: state.byProject,
      }),
      migrate: (persisted: unknown): ApplicationNavigationPersistedState => toPersisted(persisted),
      // `migrate` only runs across a version change; a same-version blob is
      // adopted through this, so a hand-edited or corrupt record is dropped here.
      merge: (persisted, current) => ({
        ...current,
        ...toPersisted(persisted),
      }),
    }
  )
);

/**
 * The record a project's application should start from: this renderer's session
 * when it is the same application at the same version, else what is on disk
 * under the same stamp, else nothing.
 */
export function selectApplicationNavigationRecord(
  state: Pick<ApplicationNavigationState, "byProject" | "sessions">,
  key: string,
  stamp: { ownerId: string; version: number }
): ApplicationNavigationRecord | null {
  for (const record of [state.sessions[key], state.byProject[key]]) {
    if (record && record.ownerId === stamp.ownerId && record.version === stamp.version) {
      return record;
    }
  }
  return null;
}

registerPersistedStore({
  storeId: "applicationNavigationStore",
  store: useApplicationNavigationStore,
  persistedStateType:
    "{ byProject: Record<string, { ownerId: string; version: number; entries: { sectionId: string; params: Record<string, string | number | boolean> }[]; index: number }> }",
});
