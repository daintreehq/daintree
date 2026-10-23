import { create } from "zustand";
import type { ProjectApplicationState } from "@shared/types/plugin";
import { persist, type StorageValue } from "zustand/middleware";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getViewWorkspaceId } from "./viewWorkspaceId";

/**
 * Which arrangement a project's main area is in: its plugin's Home alone, the
 * Home beside the grid (`split`, #14107), or the grid alone.
 */
export type ProjectMainAreaRoute = "home" | "split" | "grid";

function isRoute(value: unknown): value is ProjectMainAreaRoute {
  return value === "home" || value === "split" || value === "grid";
}

/**
 * Where this project's main area was left: on its plugin's Home (the
 * `projectHome` surface, §7.8), on Home beside the grid, or on the grid.
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
 * Persisted on this machine only, like the rest of the slot answers. Only a
 * route the user chose is stored, every one of the three, so a project with no
 * entry takes its application's default (see {@link applicationDefaultRoute})
 * and one whose user chose the grid keeps it.
 */
interface ProjectHomeState {
  /** Host-scoped project ids and the route the user chose for each. */
  routeByProject: Record<string, ProjectMainAreaRoute>;
  /**
   * Whether this view's main area is drawing Home in place of the grid right
   * now, after fleet scope and maximize have had their say. Set by the Home
   * body while it fills the area; never persisted. A split leaves it false: the
   * grid, and its focused panel, are on screen beside Home.
   */
  presented: boolean;
  showHome: () => void;
  showSplit: () => void;
  showGrid: () => void;
  setPresented: (presented: boolean) => void;
}

type ProjectHomePersistedState = Pick<ProjectHomeState, "routeByProject">;

function viewKey(): string | null {
  const workspaceId = getViewWorkspaceId();
  return workspaceId ? hostScopedKey(workspaceId) : null;
}

function readRecord(value: unknown, field: string): object {
  if (value === null || typeof value !== "object" || !(field in value)) return {};
  const raw: unknown = Reflect.get(value, field);
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function toPersisted(value: unknown): ProjectHomePersistedState {
  const routeByProject: Record<string, ProjectMainAreaRoute> = {};
  for (const [key, entry] of Object.entries(readRecord(value, "routeByProject"))) {
    if (isRoute(entry)) routeByProject[key] = entry;
  }
  return { routeByProject };
}

/**
 * Version 1 stored Home as `true` and the grid as no entry at all, so only its
 * Home answers carry over: an absent entry never said the user chose the grid.
 */
function migrateProjectHomeState(persisted: unknown, version: number): ProjectHomePersistedState {
  if (version >= 2) return toPersisted(persisted);
  const routeByProject: Record<string, ProjectMainAreaRoute> = {};
  for (const [key, entry] of Object.entries(readRecord(persisted, "homeByProject"))) {
    if (entry === true) routeByProject[key] = "home";
  }
  return { routeByProject };
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
      routeByProject: mergeRecordByWriterDelta(
        toPersisted(baseline?.state).routeByProject,
        toPersisted(incoming.state).routeByProject,
        disk.routeByProject
      ),
    },
  };
}

export const useProjectHomeStore = create<ProjectHomeState>()(
  persist(
    (set, get) => {
      const choose = (route: ProjectMainAreaRoute) => {
        const key = viewKey();
        if (key === null || get().routeByProject[key] === route) return;
        set((state) => ({ routeByProject: { ...state.routeByProject, [key]: route } }));
      };
      return {
        routeByProject: {},
        presented: false,
        showHome: () => choose("home"),
        showSplit: () => choose("split"),
        showGrid: () => choose("grid"),
        setPresented: (presented) => {
          if (get().presented === presented) return;
          set({ presented });
        },
      };
    },
    {
      name: "daintree-project-home",
      version: 2,
      storage: createSafeJSONStorage<ProjectHomePersistedState>({
        mergeOnWrite: mergeProjectHomePersistedWrite,
      }),
      partialize: (state): ProjectHomePersistedState => ({
        routeByProject: state.routeByProject,
      }),
      migrate: migrateProjectHomeState,
      // `migrate` only runs across a version change; a same-version blob is
      // adopted through this, so a hand-edited or corrupt entry is dropped here.
      merge: (persisted, current) => ({
        ...current,
        ...toPersisted(persisted),
      }),
    }
  )
);

/**
 * The route a project application asks to open on when the user has chosen
 * none (#14107): its Home, alone or beside the grid, while it is in force and
 * lands on Home. Anything else, or no application at all, keeps the grid.
 */
export function applicationDefaultRoute(
  application: Pick<ProjectApplicationState, "status" | "application"> | null
): ProjectMainAreaRoute {
  if (application?.status !== "active") return "grid";
  const { destination, arrangement } = application.application;
  if (destination !== "home") return "grid";
  return arrangement === "beside-grid" ? "split" : "home";
}

/**
 * The route this view's project is on: the user's choice, or else `fallback`,
 * the application's default from {@link applicationDefaultRoute}.
 */
export function selectProjectMainAreaRoute(
  state: Pick<ProjectHomeState, "routeByProject">,
  fallback: ProjectMainAreaRoute = "grid"
): ProjectMainAreaRoute {
  const key = viewKey();
  return (key !== null ? state.routeByProject[key] : undefined) ?? fallback;
}

registerPersistedStore({
  storeId: "projectHomeStore",
  store: useProjectHomeStore,
  persistedStateType: "{ routeByProject: Record<string, ProjectMainAreaRoute> }",
});
