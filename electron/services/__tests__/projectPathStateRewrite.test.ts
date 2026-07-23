import { describe, it, expect } from "vitest";
import { rewriteProjectStatePaths } from "../projectPathStateRewrite.js";
import type { ProjectState } from "../../../shared/types/project.js";

const OLD = "/old/project";
const NEW = "/new/renamed";

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "p1",
    sidebarWidth: 240,
    terminals: [],
    ...overrides,
  };
}

describe("rewriteProjectStatePaths", () => {
  it("rebases activeWorktreeId (a worktree id is an absolute path)", () => {
    const state = baseState({ activeWorktreeId: "/old/project" });
    expect(rewriteProjectStatePaths(state, OLD, NEW).activeWorktreeId).toBe("/new/renamed");
  });

  it("rebases panel cwd, worktreeId, filePath and legacy markdownFilePath", () => {
    const state = baseState({
      terminals: [
        {
          id: "t1",
          title: "sh",
          location: "grid",
          cwd: "/old/project/sub",
          worktreeId: "/old/project",
          filePath: "/old/project/README.md",
          markdownFilePath: "/old/project/notes.md",
        },
      ],
    });
    const panel = rewriteProjectStatePaths(state, OLD, NEW).terminals[0];
    expect(panel.cwd).toBe("/new/renamed/sub");
    expect(panel.worktreeId).toBe("/new/renamed");
    expect(panel.filePath).toBe("/new/renamed/README.md");
    expect(panel.markdownFilePath).toBe("/new/renamed/notes.md");
  });

  it("does NOT rewrite worktree-relative browser paths, URLs, or opaque data", () => {
    const state = baseState({
      terminals: [
        {
          id: "t1",
          title: "browser",
          location: "grid",
          browserRootPath: "src",
          browserSelectedPath: "src/index.ts",
          browserExpandedPaths: ["src", "src/lib"],
          browserUrl: "http://localhost:3000/old/project",
          devServerUrl: "http://localhost:5173",
          command: "run /old/project",
          env: { PWD: "/old/project" },
          extensionState: { path: "/old/project" },
        },
      ],
    });
    const out = rewriteProjectStatePaths(state, OLD, NEW);
    // Nothing absolute changed → same object reference preserved.
    expect(out).toBe(state);
    const panel = out.terminals[0];
    expect(panel.browserRootPath).toBe("src");
    expect(panel.browserSelectedPath).toBe("src/index.ts");
    expect(panel.browserUrl).toBe("http://localhost:3000/old/project");
    expect(panel.command).toBe("run /old/project");
    expect(panel.env).toEqual({ PWD: "/old/project" });
    expect(panel.extensionState).toEqual({ path: "/old/project" });
  });

  it("rebases tab-group worktree bindings", () => {
    const state = baseState({
      tabGroups: [
        {
          id: "g1",
          location: "grid",
          worktreeId: "/old/project",
          activeTabId: "t1",
          panelIds: ["t1"],
        },
        {
          id: "g2",
          location: "grid",
          activeTabId: "t2",
          panelIds: ["t2"],
        },
      ],
    });
    const groups = rewriteProjectStatePaths(state, OLD, NEW).tabGroups!;
    expect(groups[0].worktreeId).toBe("/new/renamed");
    expect(groups[1].worktreeId).toBeUndefined();
  });

  it("rebases worktree: MRU entries and leaves terminal: entries alone", () => {
    const state = baseState({ mruList: ["terminal:t-1", "worktree:/old/project"] });
    expect(rewriteProjectStatePaths(state, OLD, NEW).mruList).toEqual([
      "terminal:t-1",
      "worktree:/new/renamed",
    ]);
  });

  it("returns the SAME reference when nothing matches", () => {
    const state = baseState({
      activeWorktreeId: "/somewhere/else",
      terminals: [{ id: "t1", title: "sh", location: "grid", cwd: "/somewhere/else" }],
      mruList: ["terminal:t-1"],
    });
    expect(rewriteProjectStatePaths(state, OLD, NEW)).toBe(state);
  });

  it("does not mutate the input state", () => {
    const state = baseState({ activeWorktreeId: "/old/project" });
    const snapshot = JSON.parse(JSON.stringify(state));
    rewriteProjectStatePaths(state, OLD, NEW);
    expect(state).toEqual(snapshot);
  });
});
