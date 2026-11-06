import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  PROJECT_GROUP_NAME_MAX_LENGTH,
  isProjectListSortMode,
  type Project,
  type ProjectGroup,
  type ProjectListSortMode,
} from "../../shared/types/project.js";
import { getSharedDb } from "./persistence/db.js";
import { projects as projectsTable } from "./persistence/schema.js";
import { projectStore } from "./ProjectStore.js";
import {
  readProjectGroups,
  writeProjectGroups,
  type ProjectGroupsWriter,
} from "./projectGroupsDocument.js";

/**
 * The name a group will be stored under, or an error the user can act on.
 * Unique ignoring case: two groups called "Clients" and "clients" would be two
 * headers nobody can tell apart.
 */
function validateName(name: unknown, groups: ProjectGroup[], excludeId?: string): string {
  if (typeof name !== "string") throw new Error("Group name must be text");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new Error("Give the group a name");
  if (trimmed.length > PROJECT_GROUP_NAME_MAX_LENGTH) {
    throw new Error(`Group names can be up to ${PROJECT_GROUP_NAME_MAX_LENGTH} characters`);
  }
  const lower = trimmed.toLocaleLowerCase();
  if (groups.some((group) => group.id !== excludeId && group.name.toLocaleLowerCase() === lower)) {
    throw new Error(`A group called "${trimmed}" already exists`);
  }
  return trimmed;
}

export class ProjectGroupStore {
  list(): ProjectGroup[] {
    return readProjectGroups();
  }

  /** Writes through `writer` so a caller inside a transaction can pass its own. */
  private save(groups: ProjectGroup[], writer?: ProjectGroupsWriter): ProjectGroup[] {
    return writeProjectGroups(groups, writer);
  }

  private require(groups: ProjectGroup[], groupId: unknown): ProjectGroup {
    const group = typeof groupId === "string" ? groups.find((g) => g.id === groupId) : undefined;
    if (!group) throw new Error("That group no longer exists");
    return group;
  }

  /** Appends a group after every existing one. */
  create(name: unknown): { group: ProjectGroup; groups: ProjectGroup[] } {
    const groups = this.list();
    const group: ProjectGroup = {
      id: randomUUID(),
      name: validateName(name, groups),
      position: groups.length,
      sortMode: "mostUsed",
      createdAt: Date.now(),
    };
    const saved = this.save([...groups, group]);
    return { group: saved.find((g) => g.id === group.id)!, groups: saved };
  }

  rename(groupId: unknown, name: unknown): ProjectGroup[] {
    const groups = this.list();
    const group = this.require(groups, groupId);
    const nextName = validateName(name, groups, group.id);
    return this.save(groups.map((g) => (g.id === group.id ? { ...g, name: nextName } : g)));
  }

  setSortMode(groupId: unknown, sortMode: unknown): ProjectGroup[] {
    if (!isProjectListSortMode(sortMode)) throw new Error("Unknown sort order");
    const groups = this.list();
    const group = this.require(groups, groupId);
    const mode: ProjectListSortMode = sortMode;
    return this.save(groups.map((g) => (g.id === group.id ? { ...g, sortMode: mode } : g)));
  }

  /**
   * Puts the groups in exactly this order. Takes the whole order rather than a
   * delta so two windows reordering at once converge on the last write instead
   * of compounding each other's moves.
   */
  reorder(orderedIds: unknown): ProjectGroup[] {
    const groups = this.list();
    if (
      !Array.isArray(orderedIds) ||
      orderedIds.length !== groups.length ||
      new Set(orderedIds).size !== groups.length ||
      !orderedIds.every((id) => groups.some((g) => g.id === id))
    ) {
      throw new Error("The group list changed — try again");
    }
    const byId = new Map(groups.map((g) => [g.id, g]));
    return this.save(orderedIds.map((id, position) => ({ ...byId.get(id as string)!, position })));
  }

  /**
   * Removes the group and returns its former members to Other projects, in one
   * transaction so no reader can see members pointing at a group that is gone.
   * The projects themselves are untouched.
   */
  delete(groupId: unknown): { groups: ProjectGroup[]; releasedProjects: Project[] } {
    const db = getSharedDb();
    const groups = this.list();
    const group = this.require(groups, groupId);
    const memberIds = db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.groupId, group.id))
      .all()
      .map((row) => row.id);
    let saved: ProjectGroup[] = [];
    db.transaction(
      (tx) => {
        tx.update(projectsTable)
          .set({ groupId: null })
          .where(eq(projectsTable.groupId, group.id))
          .run();
        saved = this.save(
          groups.filter((g) => g.id !== group.id),
          tx
        );
      },
      { behavior: "immediate" }
    );
    const releasedProjects = memberIds
      .map((id) => projectStore.getProjectById(id))
      .filter((project): project is Project => project !== null);
    return { groups: saved, releasedProjects };
  }

  /** Files a project under a group, or back into Other projects with `null`. */
  setMembership(projectId: unknown, groupId: unknown): Project {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new Error("Invalid project ID");
    }
    const nextGroupId = groupId === null ? null : this.require(this.list(), groupId).id;
    return projectStore.updateProject(projectId, { groupId: nextGroupId });
  }

  /**
   * Files a project away, or brings it back. Archiving an already archived
   * project keeps its original time — the date says when it was filed, and a
   * repeated request is not a new filing.
   */
  setArchived(projectId: unknown, archived: unknown): Project {
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new Error("Invalid project ID");
    }
    if (typeof archived !== "boolean") throw new Error("Invalid archive state");
    const current = projectStore.getProjectById(projectId);
    if (!current) throw new Error(`Project not found: ${projectId}`);
    if (archived === (current.archivedAt !== undefined)) return current;
    return projectStore.updateProject(projectId, { archivedAt: archived ? Date.now() : null });
  }
}

export const projectGroupStore = new ProjectGroupStore();
