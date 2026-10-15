import type { Project, ProjectGroup, ProjectListSortMode } from "../../../shared/types/project.js";
import { projectGroupStore } from "../../services/ProjectGroupStore.js";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { PROJECT_GROUPS_METHOD_CHANNELS } from "./projectGroups.preload.js";

/**
 * Every live view gets the whole list after any change, over the multiplexed
 * events bus — groups are app-wide, so a group made in one window has to show
 * up as a header in every other one without a reload.
 */
function broadcastGroups(groups: ProjectGroup[]): void {
  broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "project-groups:update", payload: groups });
}

/** Membership and archive live on the project row, so they travel as row updates. */
function broadcastProject(project: Project): void {
  broadcastToRenderer(CHANNELS.PROJECT_UPDATED, project);
}

export const projectGroupsNamespace = defineIpcNamespace({
  name: "projectGroups",
  ops: {
    list: op(PROJECT_GROUPS_METHOD_CHANNELS.list, async (): Promise<ProjectGroup[]> =>
      projectGroupStore.list()
    ),
    create: op(
      PROJECT_GROUPS_METHOD_CHANNELS.create,
      async (name: string): Promise<ProjectGroup> => {
        const { group, groups } = projectGroupStore.create(name);
        broadcastGroups(groups);
        return group;
      }
    ),
    rename: op(
      PROJECT_GROUPS_METHOD_CHANNELS.rename,
      async (groupId: string, name: string): Promise<ProjectGroup[]> => {
        const groups = projectGroupStore.rename(groupId, name);
        broadcastGroups(groups);
        return groups;
      }
    ),
    delete: op(
      PROJECT_GROUPS_METHOD_CHANNELS.delete,
      async (groupId: string): Promise<ProjectGroup[]> => {
        const { groups, releasedProjects } = projectGroupStore.delete(groupId);
        // Rows first: a view that applied the shorter group list before its
        // members' cleared ids would briefly resolve them as ungrouped anyway,
        // but the order keeps every intermediate state one a user could see.
        for (const project of releasedProjects) broadcastProject(project);
        broadcastGroups(groups);
        return groups;
      }
    ),
    reorder: op(
      PROJECT_GROUPS_METHOD_CHANNELS.reorder,
      async (orderedIds: string[]): Promise<ProjectGroup[]> => {
        const groups = projectGroupStore.reorder(orderedIds);
        broadcastGroups(groups);
        return groups;
      }
    ),
    setSortMode: op(
      PROJECT_GROUPS_METHOD_CHANNELS.setSortMode,
      async (groupId: string, sortMode: ProjectListSortMode): Promise<ProjectGroup[]> => {
        const groups = projectGroupStore.setSortMode(groupId, sortMode);
        broadcastGroups(groups);
        return groups;
      }
    ),
    setMembership: op(
      PROJECT_GROUPS_METHOD_CHANNELS.setMembership,
      async (projectId: string, groupId: string | null): Promise<Project> => {
        const project = projectGroupStore.setMembership(projectId, groupId);
        broadcastProject(project);
        return project;
      }
    ),
    setArchived: op(
      PROJECT_GROUPS_METHOD_CHANNELS.setArchived,
      async (projectId: string, archived: boolean): Promise<Project> => {
        const project = projectGroupStore.setArchived(projectId, archived);
        broadcastProject(project);
        return project;
      }
    ),
  },
});

export function registerProjectGroupsHandlers(): () => void {
  return projectGroupsNamespace.register();
}
