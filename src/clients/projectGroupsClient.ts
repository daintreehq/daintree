import type { Project, ProjectGroup, ProjectListSortMode } from "@shared/types/project";

/**
 * Thin renderer-side wrapper for `window.electron.projectGroups`.
 *
 * Reads the namespace lazily and degrades when it is absent, for the same
 * reason `scratchClient` does: the switcher loads groups on mount, and the many
 * tests that hand-build a partial `window.electron` predate this namespace.
 */
type ProjectGroupsApi = NonNullable<Window["electron"]["projectGroups"]>;

function api(): ProjectGroupsApi | null {
  if (typeof window === "undefined") return null;
  return window.electron?.projectGroups ?? null;
}

function required(): ProjectGroupsApi {
  const a = api();
  if (!a) throw new Error("project groups IPC unavailable");
  return a;
}

const NOOP_CLEANUP = () => {};

export const projectGroupsClient = {
  list(): Promise<ProjectGroup[]> {
    return api()?.list() ?? Promise.resolve([]);
  },
  async create(name: string): Promise<ProjectGroup> {
    return required().create(name);
  },
  async rename(groupId: string, name: string): Promise<ProjectGroup[]> {
    return required().rename(groupId, name);
  },
  async delete(groupId: string): Promise<ProjectGroup[]> {
    return required().delete(groupId);
  },
  async reorder(orderedIds: string[]): Promise<ProjectGroup[]> {
    return required().reorder(orderedIds);
  },
  async setSortMode(groupId: string, sortMode: ProjectListSortMode): Promise<ProjectGroup[]> {
    return required().setSortMode(groupId, sortMode);
  },
  async setMembership(projectId: string, groupId: string | null): Promise<Project> {
    return required().setMembership(projectId, groupId);
  },
  async setArchived(projectId: string, archived: boolean): Promise<Project> {
    return required().setArchived(projectId, archived);
  },
  /** Live list after any change in any window. */
  onUpdate(callback: (groups: ProjectGroup[]) => void): () => void {
    if (typeof window === "undefined" || !window.electron?.events) return NOOP_CLEANUP;
    return window.electron.events.on("project-groups:update", callback);
  },
};
