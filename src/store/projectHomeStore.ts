import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getViewWorkspaceId } from "./viewWorkspaceId";

/** Which of its two places a project's main area is on. */
export type ProjectMainAreaRoute = "home" | "grid";

/**
 * Where this project's main area was left: on its plugin's Home (the
 * `projectHome` surface, §7.8) or on the grid.
 *
 * This is navigation, not the user's answer about the slot. Going back to the
 * grid keeps Home on offer; choosing "No home" in the slot's switch is what
 * takes it away, and that answer lives with the other slot answers in main.
 * The route is only a pointer: it says nothing about whether Home can draw, so
 * every reader intersects it with the live claim, and a route left on Home in a
 * project whose plugin is gone simply draws the grid.
 *
 * One record shared by every project view, keyed by this view's own workspace,
 * because each view has its own V8 context but they share one localStorage.
 * Persisted on this machine only, like the rest of the slot answers. A grid
 * route is stored as the absence of a key, so projects that never had a Home
 * leave nothing behind.
 */
interface ProjectHomeState {
  /** Host-scoped project ids whose main area was left on Home. */
  homeByProject: Record<string, true>;
  /**
   * Whether this view's main area is drawing Home right now, after fleet scope
   * and maximize have had their say. Set by the Home body while it is mounted;
   * never persisted.
   */
  presented: boolean;
  showHome: () => void;
  showGrid: () => void;
  setPresented: (presented: boolean) => void;
}

type ProjectHomePersistedState = Pick<ProjectHomeState, "homeByProject">;

function viewKey(): string | null {
  const workspaceId = getViewWorkspaceId();
  return workspaceId ? hostScopedKey(workspaceId) : null;
}

function toPersisted(value: unknown): ProjectHomePersistedState {
  const raw =
    value !== null && typeof value === "object" && "homeByProject" in value
      ? value.homeByProject
      : undefined;
  const homeByProject: Record<string, true> = {};
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      if (entry === true) homeByProject[key] = true;
    }
  }
  return { homeByProject };
}

/**
 * Per-project three-way merge, so a stale view writing its own project's route
 * never wipes the route another view just wrote for its project (#11351).
 */
function mergeProjectHomePersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<ProjectHomePersistedState>): StorageValue<ProjectHomePersistedState> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toPersisted(onDisk.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  return {
    version: incoming.version,
    state: {
      homeByProject: mergeRecordByWriterDelta(
        toPersisted(baseline?.state).homeByProject,
        toPersisted(incoming.state).homeByProject,
        disk.homeByProject
      ),
    },
  };
}

export const useProjectHomeStore = create<ProjectHomeState>()(
  persist(
    (set, get) => ({
      homeByProject: {},
      presented: false,

      showHome: () => {
        const key = viewKey();
        if (key === null || get().homeByProject[key]) return;
        set((state) => ({ homeByProject: { ...state.homeByProject, [key]: true } }));
      },

      showGrid: () => {
        const key = viewKey();
        if (key === null || !get().homeByProject[key]) return;
        set((state) => {
          const { [key]: _, ...rest } = state.homeByProject;
          return { homeByProject: rest };
        });
      },

      setPresented: (presented) => {
        if (get().presented === presented) return;
        set({ presented });
      },
    }),
    {
      name: "daintree-project-home",
      version: 1,
      storage: createSafeJSONStorage<ProjectHomePersistedState>({
        mergeOnWrite: mergeProjectHomePersistedWrite,
      }),
      partialize: (state): ProjectHomePersistedState => ({
        homeByProject: state.homeByProject,
      }),
      migrate: (persisted: unknown): ProjectHomePersistedState => toPersisted(persisted),
      // `migrate` only runs across a version change; a same-version blob is
      // adopted through this, so a hand-edited or corrupt entry is dropped here.
      merge: (persisted, current) => ({
        ...current,
        ...toPersisted(persisted),
      }),
    }
  )
);

/** The route this view's project was left on. */
export function selectProjectMainAreaRoute(
  state: Pick<ProjectHomeState, "homeByProject">
): ProjectMainAreaRoute {
  const key = viewKey();
  return key !== null && state.homeByProject[key] === true ? "home" : "grid";
}

registerPersistedStore({
  storeId: "projectHomeStore",
  store: useProjectHomeStore,
  persistedStateType: "{ homeByProject: Record<string, true> }",
});
