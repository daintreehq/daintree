import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const worktreeClientMock = vi.hoisted(() => ({
  getAvailableBranch: vi.fn(),
  getDefaultPath: vi.fn(),
  create: vi.fn(),
}));

const githubClientMock = vi.hoisted(() => ({
  getIssueByNumber: vi.fn(),
  assignIssue: vi.fn(),
}));

const projectClientMock = vi.hoisted(() => ({
  detectRunners: vi.fn(),
}));

const copyTreeClientMock = vi.hoisted(() => ({
  injectToTerminal: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const recipeStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const githubConfigStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const currentViewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const selectorMock = vi.hoisted(() => ({ selectOrderedTerminals: vi.fn(() => []) }));

const gitGetStagingStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  worktreeClient: worktreeClientMock,
  githubClient: githubClientMock,
  projectClient: projectClientMock,
  copyTreeClient: copyTreeClientMock,
}));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/recipeStore", () => ({ useRecipeStore: recipeStoreMock }));
vi.mock("@/store/githubConfigStore", () => ({ useGitHubConfigStore: githubConfigStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/slices/panelRegistry", () => selectorMock);

(globalThis as unknown as { window: { electron: { git: { getStagingStatus: unknown } } } }).window =
  { electron: { git: { getStagingStatus: gitGetStagingStatusMock } } };

import { registerWorkflowActions } from "../workflowActions";

interface MockCallbacks {
  onLaunchAgent: ReturnType<typeof vi.fn>;
}

function makeCallbacks(): MockCallbacks & Pick<ActionCallbacks, "onLaunchAgent"> {
  return {
    onLaunchAgent: vi.fn().mockResolvedValue("term-1"),
  };
}

function setupActions(callbacks: MockCallbacks) {
  const actions: ActionRegistry = new Map();
  registerWorkflowActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
}

function setProject(project: { id?: string; path?: string } | null) {
  projectStoreMock.getState.mockReturnValue({ currentProject: project });
}

function setMainWorktree(branch: string | null) {
  if (branch === null) {
    currentViewStoreMock.getCurrentViewStore.mockReturnValue({
      getState: () => ({ worktrees: new Map() }),
    });
    return;
  }
  currentViewStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({
      worktrees: new Map([["wt-main", { isMainWorktree: true, branch, worktreeId: "wt-main" }]]),
    }),
  });
}

function setGithubUser(username: string | null) {
  githubConfigStoreMock.getState.mockReturnValue({ config: username ? { username } : null });
}

function setRecipe(recipeId: string | null, runImpl?: () => Promise<void>) {
  recipeStoreMock.getState.mockReturnValue({
    getRecipeById: vi.fn().mockReturnValue(recipeId ? { id: recipeId } : null),
    runRecipe: vi.fn().mockImplementation(runImpl ?? (async () => {})),
  });
}

function setPanelTerminals(
  terminals: Array<{ id: string; agentState?: string; worktreeId?: string; location?: string }>,
  worktrees?: Map<string, { worktreeId?: string; isMainWorktree?: boolean; branch?: string }>
) {
  selectorMock.selectOrderedTerminals.mockReturnValue(terminals);
  panelStoreMock.getState.mockReturnValue({
    panelsById: {},
    panelIds: [],
    isInTrash: vi.fn().mockReturnValue(false),
    focusNextWaiting: vi.fn(),
    focusNextWorking: vi.fn(),
  });
  if (worktrees) {
    currentViewStoreMock.getCurrentViewStore.mockReturnValue({
      getState: () => ({ worktrees }),
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreeClientMock.getAvailableBranch.mockResolvedValue("feature/issue-6609-add-tools");
  worktreeClientMock.getDefaultPath.mockResolvedValue("/repo/feature/issue-6609-add-tools");
  worktreeClientMock.create.mockResolvedValue("wt-new");
  githubClientMock.assignIssue.mockResolvedValue(undefined);
  copyTreeClientMock.injectToTerminal.mockResolvedValue(undefined);
  setProject({ id: "p1", path: "/repo" });
  setMainWorktree("main");
  setGithubUser(null);
  setRecipe(null);
  setPanelTerminals([]);
  // re-arm the panel store after panel reset so focus tests get an empty terminal list by default
  panelStoreMock.getState.mockReturnValue({
    panelsById: {},
    panelIds: [],
    isInTrash: vi.fn().mockReturnValue(false),
    focusNextWaiting: vi.fn(),
    focusNextWorking: vi.fn(),
  });
});

describe("workflow.startWorkOnIssue", () => {
  it("happy path: fetches issue, creates worktree, launches agent, injects context", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({
      number: 6609,
      title: "Add workflow macro tools",
      url: "https://github.com/x/y/issues/6609",
    });
    const callbacks = makeCallbacks();
    const get = setupActions(callbacks);
    const def = get("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude" },
      {} as never
    )) as Record<string, unknown>;

    expect(githubClientMock.getIssueByNumber).toHaveBeenCalledWith("/repo", 6609);
    expect(worktreeClientMock.getAvailableBranch).toHaveBeenCalled();
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ worktreeId: "wt-new", cwd: "/repo/feature/issue-6609-add-tools" })
    );
    expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith("term-1", "wt-new");
    expect(result.terminalId).toBe("term-1");
    expect(result.contextInjected).toBe(true);
    expect(result.recipeLaunched).toBe(false);
    expect(result.assignedToSelf).toBe(false);
    expect(result.issueTitle).toBe("Add workflow macro tools");
  });

  it("throws when project is missing", async () => {
    setProject(null);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await expect(
      def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)
    ).rejects.toThrow(/No active project/);
  });

  it("throws when issue is not found", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue(null);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await expect(
      def.run({ issueNumber: 999, agentId: "claude" }, {} as never)
    ).rejects.toThrow(/issue #999 not found/);
  });

  it("throws PARTIAL_SUCCESS when agent.launch returns null after worktree creation", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({
      number: 1,
      title: "x",
      url: "u",
    });
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValue(null);
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    await expect(
      def.run({ issueNumber: 1, agentId: "claude" }, {} as never)
    ).rejects.toThrow(/PARTIAL_SUCCESS:/);
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
  });

  it("partial-success error embeds the partial result JSON for the caller", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({ number: 7, title: "t", url: "u" });
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValue(null);
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    try {
      await def.run({ issueNumber: 7, agentId: "claude" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("PARTIAL_SUCCESS:");
      const jsonStart = message.indexOf("{");
      const payload = JSON.parse(message.slice(jsonStart));
      expect(payload.partialResult.worktreeId).toBe("wt-new");
      expect(payload.partialResult.terminalId).toBeNull();
      expect(payload.partialResult.contextInjected).toBe(false);
    }
  });

  it("context injection failure is best-effort — agent stays launched, contextInjected: false", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({ number: 1, title: "t", url: "u" });
    copyTreeClientMock.injectToTerminal.mockRejectedValue(new Error("nope"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 1, agentId: "claude" },
      {} as never
    )) as Record<string, unknown>;
    expect(result.terminalId).toBe("term-1");
    expect(result.contextInjected).toBe(false);
  });

  it("injectContext: false skips injection entirely", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({ number: 1, title: "t", url: "u" });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 1, agentId: "claude", injectContext: false },
      {} as never
    )) as Record<string, unknown>;
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
    expect(result.contextInjected).toBe(false);
  });

  it("assignToSelf assigns the issue to the configured user", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(githubClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6609, "ada");
    expect(result.assignedToSelf).toBe(true);
  });

  it("assignToSelf is best-effort — silent failure does not abort the macro", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    githubClientMock.assignIssue.mockRejectedValue(new Error("403"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(result.assignedToSelf).toBe(false);
    expect(result.terminalId).toBe("term-1");
  });

  it("derives a sane branch name from the issue title when none is provided", async () => {
    githubClientMock.getIssueByNumber.mockResolvedValue({
      number: 42,
      title: "Fix: weird $$$ characters & SPACES",
      url: "u",
    });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await def.run({ issueNumber: 42, agentId: "claude" }, {} as never);
    const [, branch] = worktreeClientMock.getAvailableBranch.mock.calls[0];
    expect(branch).toMatch(/^feature\/issue-42-/);
    expect(branch).not.toMatch(/[^a-z0-9/-]/);
  });
});

describe("workflow.prepBranchForReview", () => {
  it("ready when status is clean and runners exist", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "CLEAN",
    });
    projectClientMock.detectRunners.mockResolvedValue([
      { id: "test", name: "Test", command: "npm test" },
    ]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(result.verdict).toBe("ready");
    expect(result.detectedRunners).toEqual([
      { id: "test", name: "Test", command: "npm test" },
    ]);
    expect(result.hasUncommittedChanges).toBe(false);
  });

  it("blocks on uncommitted changes", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [{ path: "a.ts" }],
      unstaged: [{ path: "b.ts" }],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "DIRTY",
    });
    projectClientMock.detectRunners.mockResolvedValue([]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(result.verdict).toBe("blocked_uncommitted_changes");
    expect(result.stagedCount).toBe(1);
    expect(result.unstagedCount).toBe(1);
  });

  it("blocks on merge conflicts (overrides uncommitted-changes verdict)", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [{ path: "a.ts" }],
      unstaged: [],
      conflictedFiles: [{ path: "c.ts", xy: "UU", label: "both modified" }],
      currentBranch: "feature/x",
      repoState: "MERGING",
    });
    projectClientMock.detectRunners.mockResolvedValue([]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(result.verdict).toBe("blocked_merge_conflicts");
  });

  it("flags blocked_repo_busy for in-progress operations like REBASING", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "REBASING",
    });
    projectClientMock.detectRunners.mockResolvedValue([
      { id: "x", name: "x", command: "x" },
    ]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(result.verdict).toBe("blocked_repo_busy");
  });

  it("returns no_runners_detected when clean but no runners are configured", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "CLEAN",
    });
    projectClientMock.detectRunners.mockResolvedValue([]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(result.verdict).toBe("no_runners_detected");
  });

  it("falls back to currentProject id when projectId is not given", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "CLEAN",
    });
    projectClientMock.detectRunners.mockResolvedValue([]);
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    await def.run({ cwd: "/repo/wt" }, {} as never);
    expect(projectClientMock.detectRunners).toHaveBeenCalledWith("p1");
  });

  it("skips runner detection entirely when neither projectId nor currentProject is available", async () => {
    setProject(null);
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "CLEAN",
    });
    const def = setupActions(makeCallbacks())("workflow.prepBranchForReview");
    const result = (await def.run({ cwd: "/repo/wt" }, {} as never)) as Record<string, unknown>;
    expect(projectClientMock.detectRunners).not.toHaveBeenCalled();
    expect(result.detectedRunners).toEqual([]);
    expect(result.verdict).toBe("no_runners_detected");
  });
});

describe("workflow.focusNextAttention", () => {
  it("prefers waiting agents over working ones", async () => {
    setPanelTerminals(
      [
        { id: "t1", agentState: "working", worktreeId: "wt-1", location: "grid" },
        { id: "t2", agentState: "waiting", worktreeId: "wt-1", location: "grid" },
      ],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.focused).toBe(true);
    expect(result.state).toBe("waiting");
    expect(result.waitingCount).toBe(1);
    expect(result.workingCount).toBe(1);
    expect(panelStoreMock.getState().focusNextWaiting).toHaveBeenCalled();
  });

  it("falls back to working agents when nothing is waiting", async () => {
    setPanelTerminals(
      [{ id: "t1", agentState: "working", worktreeId: "wt-1", location: "grid" }],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.focused).toBe(true);
    expect(result.state).toBe("working");
  });

  it("returns focused: false / state: 'none' when no agents need attention", async () => {
    setPanelTerminals(
      [{ id: "t1", agentState: "idle", worktreeId: "wt-1", location: "grid" }],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.focused).toBe(false);
    expect(result.state).toBe("none");
  });

  it("ignores trashed terminals when counting candidates", async () => {
    setPanelTerminals(
      [
        { id: "t1", agentState: "waiting", worktreeId: "wt-1", location: "trash" },
        { id: "t2", agentState: "working", worktreeId: "wt-1", location: "grid" },
      ],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.state).toBe("working");
    expect(result.waitingCount).toBe(0);
  });

  it("ignores terminals attached to unknown worktrees", async () => {
    setPanelTerminals(
      [{ id: "t1", agentState: "waiting", worktreeId: "wt-orphan", location: "grid" }],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.focused).toBe(false);
    expect(result.state).toBe("none");
  });
});
