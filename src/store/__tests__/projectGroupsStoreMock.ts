import { vi } from "vitest";
import { create } from "zustand";
import type { ProjectGroup } from "@shared/types/project";

interface ProjectGroupsMockState {
  groups: ProjectGroup[];
  init: () => void;
  createGroup: (name: string) => Promise<ProjectGroup>;
}

/**
 * A stand-in for `@/store/projectGroupsStore` holding only the live list, for
 * suites that render a project-creation dialog:
 *
 *   vi.mock("@/store/projectGroupsStore", () => import("@/store/__tests__/projectGroupsStoreMock"));
 *
 * The real store's first pull answers `[]` when the suite's `window.electron`
 * has no groups namespace, which would wipe a list a test had just set. Tests
 * set and change the list with `useProjectGroupsStore.setState({ groups })`.
 *
 * `createGroup` behaves like the real one: the new group is in the list by the
 * time it resolves, with an id made from its name (`new-<name>`). A test that
 * needs a refusal or a held answer swaps it with `setState({ createGroup })`
 * and puts {@link createGroupLikeHost} back afterwards.
 */
export const createGroupLikeHost = async (name: string): Promise<ProjectGroup> => {
  const { groups } = useProjectGroupsStore.getState();
  const group = makeProjectGroup(`new-${name}`, name, groups.length);
  useProjectGroupsStore.setState({ groups: [...groups, group] });
  return group;
};

export const useProjectGroupsStore = create<ProjectGroupsMockState>(() => ({
  groups: [],
  init: vi.fn(),
  createGroup: createGroupLikeHost,
}));

export function makeProjectGroup(id: string, name: string, position = 0): ProjectGroup {
  return { id, name, position, sortMode: "mostUsed", createdAt: position };
}
