import { beforeEach, describe, expect, it } from "vitest";
import { useProjectGroupsStore } from "../projectGroupsStore";

describe("projectGroupsStore", () => {
  beforeEach(() => {
    useProjectGroupsStore.setState({ groups: [] });
  });

  describe("createGroup", () => {
    it("creates a group with the given name", () => {
      const id = useProjectGroupsStore.getState().createGroup("Client Work");
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(id);
      expect(groups[0].name).toBe("Client Work");
      expect(groups[0].projectIds).toEqual([]);
      expect(groups[0].order).toBe(0);
    });

    it("assigns sequential order values", () => {
      useProjectGroupsStore.getState().createGroup("Group A");
      useProjectGroupsStore.getState().createGroup("Group B");
      useProjectGroupsStore.getState().createGroup("Group C");
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups.map((g) => g.order)).toEqual([0, 1, 2]);
    });
  });

  describe("renameGroup", () => {
    it("renames an existing group", () => {
      const id = useProjectGroupsStore.getState().createGroup("Old Name");
      useProjectGroupsStore.getState().renameGroup(id, "New Name");
      expect(useProjectGroupsStore.getState().groups[0].name).toBe("New Name");
    });
  });

  describe("deleteGroup", () => {
    it("removes the group and normalizes order", () => {
      useProjectGroupsStore.getState().createGroup("A");
      const idB = useProjectGroupsStore.getState().createGroup("B");
      useProjectGroupsStore.getState().createGroup("C");

      useProjectGroupsStore.getState().deleteGroup(idB);
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.name)).toEqual(["A", "C"]);
      expect(groups.map((g) => g.order)).toEqual([0, 1]);
    });
  });

  describe("addProjectToGroup", () => {
    it("adds a project to the specified group", () => {
      const id = useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      expect(useProjectGroupsStore.getState().groups[0].projectIds).toEqual(["project-1"]);
    });

    it("does not duplicate projectId in the same group", () => {
      const id = useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      expect(useProjectGroupsStore.getState().groups[0].projectIds).toEqual(["project-1"]);
    });

    it("removes project from its previous group when reassigning", () => {
      const idA = useProjectGroupsStore.getState().createGroup("Group A");
      const idB = useProjectGroupsStore.getState().createGroup("Group B");
      useProjectGroupsStore.getState().addProjectToGroup(idA, "project-1");
      useProjectGroupsStore.getState().addProjectToGroup(idB, "project-1");

      const groups = useProjectGroupsStore.getState().groups;
      const groupA = groups.find((g) => g.id === idA);
      const groupB = groups.find((g) => g.id === idB);
      expect(groupA?.projectIds).not.toContain("project-1");
      expect(groupB?.projectIds).toContain("project-1");
    });

    it("auto-deletes empty groups when reassigning a project leaves one empty", () => {
      const idA = useProjectGroupsStore.getState().createGroup("Group A");
      const idB = useProjectGroupsStore.getState().createGroup("Group B");
      useProjectGroupsStore.getState().addProjectToGroup(idA, "project-1");

      // Move the only project from A to B — A should be auto-deleted
      useProjectGroupsStore.getState().addProjectToGroup(idB, "project-1");
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(idB);
    });
  });

  describe("removeProjectFromGroup", () => {
    it("removes a project from the specified group", () => {
      const id = useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-2");
      useProjectGroupsStore.getState().removeProjectFromGroup(id, "project-1");
      expect(useProjectGroupsStore.getState().groups[0].projectIds).toEqual(["project-2"]);
    });

    it("auto-deletes the group when the last project is removed", () => {
      const id = useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      useProjectGroupsStore.getState().removeProjectFromGroup(id, "project-1");
      expect(useProjectGroupsStore.getState().groups).toHaveLength(0);
    });
  });

  describe("removeProjectFromAllGroups", () => {
    it("removes a project from all groups and auto-deletes empty groups", () => {
      const idA = useProjectGroupsStore.getState().createGroup("Group A");
      const idB = useProjectGroupsStore.getState().createGroup("Group B");
      useProjectGroupsStore.getState().addProjectToGroup(idA, "project-1");
      useProjectGroupsStore.getState().addProjectToGroup(idB, "project-1");
      useProjectGroupsStore.getState().addProjectToGroup(idB, "project-2");

      useProjectGroupsStore.getState().removeProjectFromAllGroups("project-1");
      const groups = useProjectGroupsStore.getState().groups;
      // Group A should be deleted (empty), Group B should remain with project-2
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe(idB);
      expect(groups[0].projectIds).toEqual(["project-2"]);
    });

    it("is a no-op if project is not in any group", () => {
      useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().removeProjectFromAllGroups("non-existent");
      expect(useProjectGroupsStore.getState().groups).toHaveLength(1);
    });
  });

  describe("moveGroupUp", () => {
    it("swaps the group with the one above it", () => {
      useProjectGroupsStore.getState().createGroup("A");
      const idB = useProjectGroupsStore.getState().createGroup("B");
      useProjectGroupsStore.getState().createGroup("C");

      useProjectGroupsStore.getState().moveGroupUp(idB);
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups.map((g) => g.name)).toEqual(["B", "A", "C"]);
      expect(groups.map((g) => g.order)).toEqual([0, 1, 2]);
    });

    it("is a no-op for the first group", () => {
      const idA = useProjectGroupsStore.getState().createGroup("A");
      useProjectGroupsStore.getState().createGroup("B");

      useProjectGroupsStore.getState().moveGroupUp(idA);
      expect(useProjectGroupsStore.getState().groups.map((g) => g.name)).toEqual(["A", "B"]);
    });
  });

  describe("moveGroupDown", () => {
    it("swaps the group with the one below it", () => {
      useProjectGroupsStore.getState().createGroup("A");
      const idB = useProjectGroupsStore.getState().createGroup("B");
      useProjectGroupsStore.getState().createGroup("C");

      useProjectGroupsStore.getState().moveGroupDown(idB);
      const groups = useProjectGroupsStore.getState().groups;
      expect(groups.map((g) => g.name)).toEqual(["A", "C", "B"]);
      expect(groups.map((g) => g.order)).toEqual([0, 1, 2]);
    });

    it("is a no-op for the last group", () => {
      useProjectGroupsStore.getState().createGroup("A");
      const idB = useProjectGroupsStore.getState().createGroup("B");

      useProjectGroupsStore.getState().moveGroupDown(idB);
      expect(useProjectGroupsStore.getState().groups.map((g) => g.name)).toEqual(["A", "B"]);
    });
  });

  describe("getGroupForProject", () => {
    it("returns the group containing the project", () => {
      const id = useProjectGroupsStore.getState().createGroup("My Group");
      useProjectGroupsStore.getState().addProjectToGroup(id, "project-1");
      const group = useProjectGroupsStore.getState().getGroupForProject("project-1");
      expect(group?.id).toBe(id);
    });

    it("returns undefined when project is not in any group", () => {
      useProjectGroupsStore.getState().createGroup("My Group");
      const group = useProjectGroupsStore.getState().getGroupForProject("project-1");
      expect(group).toBeUndefined();
    });
  });
});
