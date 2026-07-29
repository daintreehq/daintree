// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Project } from "@shared/types";
import type { Scratch } from "@shared/types";

const { projectState, scratchState } = vi.hoisted(() => ({
  projectState: {
    current: { projects: [] as Partial<Project>[], currentProject: null as Partial<Project> | null },
  },
  scratchState: {
    current: { scratches: [] as Partial<Scratch>[], currentScratch: null as Partial<Scratch> | null },
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector(projectState.current),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (state: unknown) => unknown) => selector(scratchState.current),
}));

import { useWorkspaceRootPath } from "../useWorkspaceRootPath";

function seedView(id: string | undefined) {
  if (id === undefined) {
    delete (window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } })
      .__DAINTREE_INITIAL_PROJECT__;
    return;
  }
  (window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } }).__DAINTREE_INITIAL_PROJECT__ = {
    id,
  };
}

const rootPath = () => renderHook(() => useWorkspaceRootPath()).result.current;

beforeEach(() => {
  projectState.current = { projects: [], currentProject: null };
  scratchState.current = { scratches: [], currentScratch: null };
  // jsdom's URL carries no `?projectId=`, so the seeded global is the only
  // identity source here — the same precedence the real fallback uses.
  seedView(undefined);
});

afterEach(() => {
  seedView(undefined);
});

describe("useWorkspaceRootPath", () => {
  it("resolves this view's own scratch by its seeded id", () => {
    seedView("s-1");
    scratchState.current = {
      scratches: [{ id: "s-1", path: "/scratches/one" }],
      currentScratch: { id: "s-1", path: "/scratches/one" },
    };

    expect(rootPath()).toBe("/scratches/one");
  });

  it("keeps resolving when another window switches the global pointer away", () => {
    // The regression this hook exists to prevent: `currentScratch` is broadcast
    // to every view, so a second window moving to s-2 must not blank this one.
    seedView("s-1");
    scratchState.current = {
      scratches: [
        { id: "s-1", path: "/scratches/one" },
        { id: "s-2", path: "/scratches/two" },
      ],
      currentScratch: { id: "s-2", path: "/scratches/two" },
    };

    expect(rootPath()).toBe("/scratches/one");
  });

  it("never reports another workspace's folder as this view's", () => {
    seedView("s-1");
    scratchState.current = {
      scratches: [{ id: "s-2", path: "/scratches/two" }],
      currentScratch: { id: "s-2", path: "/scratches/two" },
    };

    // s-1 isn't in the collection: unresolved beats naming the wrong folder,
    // which copy-path and reveal would then act on.
    expect(rootPath()).toBe("");
  });

  it("resolves a project view by its seeded id", () => {
    seedView("p-1");
    projectState.current = {
      projects: [{ id: "p-1", path: "/folders/notes" }],
      currentProject: { id: "p-1", path: "/folders/notes" },
    };

    expect(rootPath()).toBe("/folders/notes");
  });

  it("prefers the project when a stale scratch shares this view's id", () => {
    seedView("w-1");
    projectState.current = {
      projects: [{ id: "w-1", path: "/folders/notes" }],
      currentProject: null,
    };
    scratchState.current = {
      scratches: [{ id: "w-1", path: "/scratches/one" }],
      currentScratch: null,
    };

    // Project-first, matching `resolveWorkspaceCwd` and main's own
    // project-before-scratch resolution, so both sides pick the same folder.
    expect(rootPath()).toBe("/folders/notes");
  });

  it("falls back to the current pointers only for an unbound view", () => {
    // No seeded id at all — a shell window, where nothing else can answer.
    scratchState.current = {
      scratches: [{ id: "s-9", path: "/scratches/nine" }],
      currentScratch: { id: "s-9", path: "/scratches/nine" },
    };

    expect(rootPath()).toBe("/scratches/nine");
  });

  it("is empty when nothing resolves at all", () => {
    seedView("s-1");
    expect(rootPath()).toBe("");
  });
});
