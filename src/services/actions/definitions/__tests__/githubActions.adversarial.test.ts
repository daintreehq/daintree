import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const githubClientMock = vi.hoisted(() => ({
  openIssues: vi.fn(),
  openPRs: vi.fn(),
  openCommits: vi.fn(),
  openIssue: vi.fn(),
  openPR: vi.fn(),
  getRepoStats: vi.fn(),
  listIssues: vi.fn(),
  listPullRequests: vi.fn(),
  checkCli: vi.fn(),
  getConfig: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  validateToken: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/clients", () => ({ githubClient: githubClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));

import { registerGithubActions } from "../githubActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerGithubActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
}

function setCurrentProject(project: { path?: string } | null) {
  projectStoreMock.getState.mockReturnValue({ currentProject: project });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(githubClientMock)) fn.mockResolvedValue(undefined);
});

describe("githubActions adversarial", () => {
  it("openIssues falls back to current project path when no arg is given", async () => {
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("github.openIssues");
    await def.run({}, {} as never);
    expect(githubClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, undefined);
  });

  it("openIssues throws loudly when neither arg nor current project has a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("github.openIssues");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
    expect(githubClientMock.openIssues).not.toHaveBeenCalled();
  });

  it("openPRs also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("github.openPRs");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openCommits also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("github.openCommits");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openIssues: explicit projectPath takes precedence over current project", async () => {
    setCurrentProject({ path: "/stale" });
    const def = setupActions()("github.openIssues");
    await def.run({ projectPath: "/explicit", query: "bug", state: "open" }, {} as never);
    expect(githubClientMock.openIssues).toHaveBeenCalledWith("/explicit", "bug", "open");
  });

  it("openIssues schema accepts arbitrary state strings (runtime gap vs list schema)", async () => {
    // GitHubListOptionsSchema restricts state to an enum, but openIssues uses
    // z.string().optional() — mismatch. Documenting the gap.
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("github.openIssues");
    await def.run({ state: "wat" }, {} as never);
    expect(githubClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, "wat");
  });

  it("listIssues forwards the whole options object unchanged", async () => {
    githubClientMock.listIssues.mockResolvedValue({ issues: [], nextCursor: "c2" });
    const def = setupActions()("github.listIssues");
    await def.run({ cwd: "/repo", search: "q", state: "open", cursor: "c1" }, {} as never);
    expect(githubClientMock.listIssues).toHaveBeenCalledWith({
      cwd: "/repo",
      search: "q",
      state: "open",
      cursor: "c1",
    });
  });

  it("openIssue forwards cwd + issueNumber positionally", async () => {
    const def = setupActions()("github.openIssue");
    await def.run({ cwd: "/repo", issueNumber: 42 }, {} as never);
    expect(githubClientMock.openIssue).toHaveBeenCalledWith("/repo", 42);
  });

  it("openPR forwards prUrl", async () => {
    const def = setupActions()("github.openPR");
    await def.run({ prUrl: "https://github.com/x/y/pull/1" }, {} as never);
    expect(githubClientMock.openPR).toHaveBeenCalledWith("https://github.com/x/y/pull/1");
  });

  it("getRepoStats forwards cwd + bypassCache", async () => {
    const def = setupActions()("github.getRepoStats");
    await def.run({ cwd: "/repo", bypassCache: true }, {} as never);
    expect(githubClientMock.getRepoStats).toHaveBeenCalledWith("/repo", true);
  });

  it("setToken and clearToken are marked danger:confirm so ActionService blocks agent sources", () => {
    const setDef = setupActions()("github.setToken");
    const clearDef = setupActions()("github.clearToken");
    expect(setDef.danger).toBe("confirm");
    expect(clearDef.danger).toBe("confirm");
  });

  it("validateToken forwards the token unchanged (including whitespace)", async () => {
    const def = setupActions()("github.validateToken");
    await def.run({ token: "  ghp_123  " }, {} as never);
    expect(githubClientMock.validateToken).toHaveBeenCalledWith("  ghp_123  ");
  });

  it("checkCli has no schema and calls client directly", async () => {
    githubClientMock.checkCli.mockResolvedValue({ available: true });
    const def = setupActions()("github.checkCli");
    const result = await def.run(undefined, {} as never);
    expect(result).toEqual({ available: true });
  });
});
