// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Project, Scratch } from "@shared/types";

const getViewWorkspaceId = vi.fn<() => string | null>(() => null);

interface ProjectSliceShape {
  projects: Project[];
  currentProject: Project | null;
}
interface ScratchSliceShape {
  scratches: Scratch[];
  currentScratch: Scratch | null;
}

let projectSlice: ProjectSliceShape = { projects: [], currentProject: null };
let scratchSlice: ScratchSliceShape = { scratches: [], currentScratch: null };

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: ProjectSliceShape) => unknown) => selector(projectSlice),
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (state: ScratchSliceShape) => unknown) => selector(scratchSlice),
}));
vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => getViewWorkspaceId(),
}));

const { useWorkspaceRoot } = await import("../useWorkspaceRoot");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    path: "/repos/daintree",
    name: "Daintree",
    emoji: "🌳",
    lastOpened: 0,
    ...overrides,
  };
}

function makeScratch(overrides: Partial<Scratch> = {}): Scratch {
  return {
    id: "scratch-1",
    path: "/userData/scratches/scratch-1",
    name: "Quick test",
    createdAt: 0,
    lastOpened: 0,
    ...overrides,
  };
}

beforeEach(() => {
  projectSlice = { projects: [], currentProject: null };
  scratchSlice = { scratches: [], currentScratch: null };
  getViewWorkspaceId.mockReturnValue(null);
});

describe("useWorkspaceRoot", () => {
  it("returns null only when the view owns no workspace at all", () => {
    // This is the one case that must still leave the sidebar unmounted (#5023).
    const { result } = renderHook(() => useWorkspaceRoot());
    expect(result.current).toBeNull();
  });

  it("resolves a scratch, which currentProject alone could never see (#11499)", () => {
    const scratch = makeScratch();
    scratchSlice = { scratches: [scratch], currentScratch: scratch };

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current).toEqual({
      kind: "scratch",
      id: "scratch-1",
      path: "/userData/scratches/scratch-1",
      name: "Quick test",
      isGitBacked: false,
    });
  });

  it("never reports a scratch as git-backed", () => {
    // `isGitBackedProject(null)` answers true — absence of the discriminator
    // means "legacy git project". Routing a scratch through it would hand the
    // sidebar the worktree list for a workspace that has no worktrees.
    const scratch = makeScratch();
    scratchSlice = { scratches: [scratch], currentScratch: scratch };

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.isGitBacked).toBe(false);
  });

  it("treats a project with no gitBacked discriminator as git-backed", () => {
    projectSlice = { projects: [], currentProject: makeProject() };

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.kind).toBe("project");
    expect(result.current?.isGitBacked).toBe(true);
  });

  it("reports a folder opened without git as not git-backed (#11405)", () => {
    projectSlice = { projects: [], currentProject: makeProject({ gitBacked: false }) };

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.isGitBacked).toBe(false);
  });

  it("names the view's own workspace, not whichever one was switched to last", () => {
    // currentProject/currentScratch are broadcast to every view, cached ones
    // included, so a second window switching workspaces repoints them here too.
    // The seeded id is what keeps this view pointing at its own folder.
    const own = makeProject({ id: "proj-own", path: "/repos/own", name: "Own" });
    const elsewhere = makeProject({ id: "proj-other", path: "/repos/other", name: "Other" });
    projectSlice = { projects: [own, elsewhere], currentProject: elsewhere };
    getViewWorkspaceId.mockReturnValue("proj-own");

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.id).toBe("proj-own");
    expect(result.current?.path).toBe("/repos/own");
  });

  it("resolves a scratch by seeded id even while a project is globally current", () => {
    const scratch = makeScratch({ id: "scratch-own" });
    projectSlice = { projects: [makeProject()], currentProject: makeProject() };
    scratchSlice = { scratches: [scratch], currentScratch: null };
    getViewWorkspaceId.mockReturnValue("scratch-own");

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.kind).toBe("scratch");
    expect(result.current?.id).toBe("scratch-own");
  });

  it("prefers the project when an id somehow matches both collections", () => {
    // Mirrors resolveViewWorkspace and main's project-before-scratch order, so
    // the two sides can never pick different folders for the same id.
    const shared = makeProject({ id: "dup" });
    projectSlice = { projects: [shared], currentProject: null };
    scratchSlice = { scratches: [makeScratch({ id: "dup" })], currentScratch: null };
    getViewWorkspaceId.mockReturnValue("dup");

    const { result } = renderHook(() => useWorkspaceRoot());

    expect(result.current?.kind).toBe("project");
  });
});
