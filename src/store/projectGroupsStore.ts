import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";

export interface ProjectGroup {
  id: string;
  name: string;
  projectIds: string[];
  order: number;
}

interface ProjectGroupsState {
  groups: ProjectGroup[];

  createGroup: (name: string) => string;
  renameGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  addProjectToGroup: (groupId: string, projectId: string) => void;
  removeProjectFromGroup: (groupId: string, projectId: string) => void;
  removeProjectFromAllGroups: (projectId: string) => void;
  moveGroupUp: (groupId: string) => void;
  moveGroupDown: (groupId: string) => void;
  getGroupForProject: (projectId: string) => ProjectGroup | undefined;
}

function normalizeOrder(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.map((g, i) => (g.order === i ? g : { ...g, order: i }));
}

export const useProjectGroupsStore = create<ProjectGroupsState>()(
  persist(
    (set, get) => ({
      groups: [],

      createGroup: (name: string) => {
        const id = crypto.randomUUID();
        set((state) => ({
          groups: [...state.groups, { id, name, projectIds: [], order: state.groups.length }],
        }));
        return id;
      },

      renameGroup: (groupId, name) => {
        set((state) => ({
          groups: state.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
        }));
      },

      deleteGroup: (groupId) => {
        set((state) => ({
          groups: normalizeOrder(state.groups.filter((g) => g.id !== groupId)),
        }));
      },

      addProjectToGroup: (groupId, projectId) => {
        set((state) => {
          if (!state.groups.some((g) => g.id === groupId)) return state;
          // Track which groups lost the project (for auto-cleanup)
          const previousGroupIds = new Set(
            state.groups
              .filter((g) => g.id !== groupId && g.projectIds.includes(projectId))
              .map((g) => g.id)
          );
          const updated = state.groups.map((g) => {
            if (g.id === groupId) {
              return g.projectIds.includes(projectId)
                ? g
                : { ...g, projectIds: [...g.projectIds, projectId] };
            }
            // Remove from any other group
            return g.projectIds.includes(projectId)
              ? { ...g, projectIds: g.projectIds.filter((id) => id !== projectId) }
              : g;
          });
          // Only auto-delete groups that lost the project and are now empty
          return {
            groups: normalizeOrder(
              updated.filter((g) => !previousGroupIds.has(g.id) || g.projectIds.length > 0)
            ),
          };
        });
      },

      removeProjectFromGroup: (groupId, projectId) => {
        set((state) => {
          const updated = state.groups.map((g) =>
            g.id === groupId
              ? { ...g, projectIds: g.projectIds.filter((id) => id !== projectId) }
              : g
          );
          // Only auto-delete groups that contained the project and are now empty
          return {
            groups: normalizeOrder(
              updated.filter((g) => g.id !== groupId || g.projectIds.length > 0)
            ),
          };
        });
      },

      removeProjectFromAllGroups: (projectId) => {
        set((state) => {
          const affectedGroupIds = new Set(
            state.groups.filter((g) => g.projectIds.includes(projectId)).map((g) => g.id)
          );
          if (affectedGroupIds.size === 0) return state;
          const updated = state.groups.map((g) =>
            affectedGroupIds.has(g.id)
              ? { ...g, projectIds: g.projectIds.filter((id) => id !== projectId) }
              : g
          );
          // Only auto-delete affected groups that are now empty
          return {
            groups: normalizeOrder(
              updated.filter((g) => !affectedGroupIds.has(g.id) || g.projectIds.length > 0)
            ),
          };
        });
      },

      moveGroupUp: (groupId) => {
        set((state) => {
          const sorted = [...state.groups].sort((a, b) => a.order - b.order);
          const idx = sorted.findIndex((g) => g.id === groupId);
          if (idx <= 0) return state;
          const reordered = [...sorted];
          [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
          return { groups: normalizeOrder(reordered) };
        });
      },

      moveGroupDown: (groupId) => {
        set((state) => {
          const sorted = [...state.groups].sort((a, b) => a.order - b.order);
          const idx = sorted.findIndex((g) => g.id === groupId);
          if (idx < 0 || idx >= sorted.length - 1) return state;
          const reordered = [...sorted];
          [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
          return { groups: normalizeOrder(reordered) };
        });
      },

      getGroupForProject: (projectId) => {
        return get().groups.find((g) => g.projectIds.includes(projectId));
      },
    }),
    {
      name: "project-groups-storage",
      storage: createSafeJSONStorage(),
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0 || version === undefined) {
          return { groups: [], ...(persisted as Record<string, unknown>) };
        }
        return persisted as ProjectGroupsState;
      },
      partialize: (state) => ({
        groups: state.groups,
      }),
    }
  )
);
