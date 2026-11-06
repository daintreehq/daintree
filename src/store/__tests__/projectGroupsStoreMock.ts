import { vi } from "vitest";
import { create } from "zustand";
import type { ProjectGroup } from "@shared/types/project";

/**
 * A stand-in for `@/store/projectGroupsStore` holding only the live list, for
 * suites that render a project-creation dialog:
 *
 *   vi.mock("@/store/projectGroupsStore", () => import("@/store/__tests__/projectGroupsStoreMock"));
 *
 * The real store's first pull answers `[]` when the suite's `window.electron`
 * has no groups namespace, which would wipe a list a test had just set. Tests
 * set and change the list with `useProjectGroupsStore.setState({ groups })`.
 */
export const useProjectGroupsStore = create<{ groups: ProjectGroup[]; init: () => void }>(() => ({
  groups: [],
  init: vi.fn(),
}));

export function makeProjectGroup(id: string, name: string, position = 0): ProjectGroup {
  return { id, name, position, sortMode: "mostUsed", createdAt: position };
}
