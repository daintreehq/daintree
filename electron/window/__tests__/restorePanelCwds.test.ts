import { describe, it, expect } from "vitest";
import { extractRestorePanelCwds } from "../restorePanelCwds.js";
import type { ProjectState, PanelSnapshot } from "../../../shared/types/project.js";

function panel(overrides: Partial<PanelSnapshot>): PanelSnapshot {
  return {
    id: overrides.id ?? "p",
    title: overrides.title ?? "Terminal",
    location: overrides.location ?? "grid",
    kind: "terminal",
    ...overrides,
  } as PanelSnapshot;
}

function state(terminals: PanelSnapshot[], overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "proj",
    sidebarWidth: 350,
    terminals,
    ...overrides,
  };
}

describe("extractRestorePanelCwds", () => {
  it("returns an empty array for null state or empty terminals", () => {
    expect(extractRestorePanelCwds(null)).toEqual([]);
    expect(extractRestorePanelCwds(state([]))).toEqual([]);
  });

  it("includes plain PTY panels and excludes agent/command panels (#7961)", () => {
    const result = extractRestorePanelCwds(
      state([
        panel({ id: "a", cwd: "/repo/plain" }),
        panel({ id: "b", cwd: "/repo/agent", launchAgentId: "claude" }),
        panel({ id: "c", cwd: "/repo/cmd", command: "npm run dev" }),
      ])
    );
    expect(result).toEqual(["/repo/plain"]);
  });

  it("excludes non-PTY panel kinds and blank/missing cwds", () => {
    const result = extractRestorePanelCwds(
      state([
        panel({ id: "a", cwd: "/repo/term" }),
        panel({ id: "b", cwd: "/repo/browser", kind: "browser" }),
        panel({ id: "c", cwd: "   " }),
        panel({ id: "d" }),
      ])
    );
    expect(result).toEqual(["/repo/term"]);
  });

  it("orders active-worktree panels first, then by lastActiveAt descending", () => {
    const result = extractRestorePanelCwds(
      state(
        [
          panel({ id: "old-other", cwd: "/wt/other-old", worktreeId: "wt-2", lastActiveAt: 10 }),
          panel({ id: "new-other", cwd: "/wt/other-new", worktreeId: "wt-2", lastActiveAt: 30 }),
          panel({ id: "active-old", cwd: "/wt/active-old", worktreeId: "wt-1", lastActiveAt: 5 }),
          panel({ id: "active-new", cwd: "/wt/active-new", worktreeId: "wt-1", lastActiveAt: 20 }),
        ],
        { activeWorktreeId: "wt-1" }
      )
    );
    // Active worktree (wt-1) first, newest-active first within each group.
    expect(result).toEqual(["/wt/active-new", "/wt/active-old", "/wt/other-new", "/wt/other-old"]);
  });

  it("dedupes repeated cwds while preserving priority order", () => {
    const result = extractRestorePanelCwds(
      state(
        [
          panel({ id: "a", cwd: "/wt/shared", worktreeId: "wt-1", lastActiveAt: 5 }),
          panel({ id: "b", cwd: "/wt/shared", worktreeId: "wt-1", lastActiveAt: 50 }),
          panel({ id: "c", cwd: "/wt/other", worktreeId: "wt-2", lastActiveAt: 99 }),
        ],
        { activeWorktreeId: "wt-1" }
      )
    );
    expect(result).toEqual(["/wt/shared", "/wt/other"]);
  });
});
