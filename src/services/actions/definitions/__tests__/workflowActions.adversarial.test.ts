/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const worktreeClientMock = vi.hoisted(() => ({
  getAvailableBranch: vi.fn(),
  getDefaultPath: vi.fn(),
  create: vi.fn(),
  fetchPRBranch: vi.fn(),
}));

const forgeClientMock = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  assignIssue: vi.fn(),
  getIssue: vi.fn(),
  getPR: vi.fn(),
}));

const projectClientMock = vi.hoisted(() => ({
  detectRunners: vi.fn(),
}));

const copyTreeClientMock = vi.hoisted(() => ({
  injectToTerminal: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const recipeStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const preferencesStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const currentViewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const selectorMock = vi.hoisted(() => ({
  selectOrderedTerminals: vi.fn<() => unknown[]>(() => []),
}));

const gitGetStagingStatusMock = vi.hoisted(() => vi.fn());
const notifySpawnFailuresMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: notifySpawnFailuresMock,
}));
vi.mock("@/clients", () => ({
  worktreeClient: worktreeClientMock,
  forgeClient: forgeClientMock,
  projectClient: projectClientMock,
  copyTreeClient: copyTreeClientMock,
}));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/recipeStore", () => ({ useRecipeStore: recipeStoreMock }));
vi.mock("@/store/preferencesStore", () => ({ usePreferencesStore: preferencesStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/slices/panelRegistry", () => selectorMock);

(globalThis as unknown as { window: { electron: { git: { getStagingStatus: unknown } } } }).window =
  { electron: { git: { getStagingStatus: gitGetStagingStatusMock } } };

import { registerWorkflowActions } from "../workflowActions";
import { ActionService } from "@/services/ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import {
  clearPluginAgentRegistryForTests,
  setPluginAgentRegistry,
} from "@shared/config/pluginAgentRegistry";
import {
  buildCacheKey,
  getCache,
  getGeneration,
  setCache,
  _resetForTests as resetForgeResourceCache,
} from "@/lib/forgeResourceCache";
import type { Issue } from "@shared/types/forge";

const makeCacheIssue = (n: number, assignees: string[]): Issue => ({
  number: n,
  title: `Issue #${n}`,
  body: "",
  state: "open",
  rawState: "open",
  url: `https://fake.test/${n}`,
  assignees: assignees.map((login) => ({ login, avatarUrl: undefined, rawData: null })),
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

interface MockCallbacks {
  onLaunchAgent: ReturnType<typeof vi.fn>;
}

function makeCallbacks(): MockCallbacks & Pick<ActionCallbacks, "onLaunchAgent"> {
  return {
    onLaunchAgent: vi.fn().mockResolvedValue({
      terminalId: "term-1",
      location: "grid",
      // The launcher reports where it landed (#11547) — a real non-null result
      // always carries all four identity fields.
      worktreeId: "wt-new",
      worktreePath: "/repo/feature/issue-6609-add-tools",
      branch: "feature/issue-6609-add-tools",
      cwd: "/repo/feature/issue-6609-add-tools",
    }),
  };
}

/**
 * Parse a result through the action's own declared `resultSchema`. Nothing does
 * this at runtime — `ActionService` converts the schema for the manifest but
 * never validates against it — so a field `run()` forgets is invisible until an
 * MCP client rejects the structuredContent.
 */
function expectMatchesResultSchema(id: string, result: unknown) {
  const def = setupActions(makeCallbacks())(id);
  const schema = def.resultSchema;
  if (!schema) throw new Error(`${id} has no resultSchema`);
  const parsed = schema.safeParse(result);
  expect(parsed.success).toBe(true);
  // Zod strips unadvertised keys, so equality also catches a field `run()`
  // emits that the published schema never promised.
  if (parsed.success) expect(parsed.data).toEqual(result);
}

function setupActions(callbacks: MockCallbacks) {
  const actions: ActionRegistry = new Map();

  registerWorkflowActions(actions, callbacks as unknown as Pick<ActionCallbacks, "onLaunchAgent">);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);

    return factory() as unknown as AnyActionDefinition;
  };
}

/**
 * Register the workflow definitions into a real {@link ActionService} so a test
 * can exercise `dispatch()`'s gating rather than calling `run()` directly. The
 * recipe-argument confirmation tier lives in the service, so a direct `run()`
 * call is structurally blind to it (#11860).
 */
function registerThroughActionService(callbacks: MockCallbacks): ActionService {
  const actions: ActionRegistry = new Map();
  registerWorkflowActions(actions, callbacks as unknown as Pick<ActionCallbacks, "onLaunchAgent">);
  const service = new ActionService();
  for (const [, factory] of actions) {
    service.register(factory() as unknown as ActionDefinition<never, unknown>);
  }
  service.setContextProvider(() => ({}) as never);
  return service;
}

async function runWorkflow(
  id: string,
  args?: unknown,
  ctx?: Record<string, unknown>
): Promise<unknown> {
  const def = setupActions(makeCallbacks())(id);
  return def.run(args, (ctx ?? {}) as never);
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
  forgeClientMock.getCurrentUser.mockResolvedValue(username ? { login: username } : null);
}

function setAssignPreference(value: boolean) {
  preferencesStoreMock.getState.mockReturnValue({ assignWorktreeToSelf: value });
}

type SpawnResults = {
  spawned: Array<{ index: number; terminalId: string }>;
  failed: Array<{ index: number; error: string }>;
};

const OK_SPAWN_RESULTS: SpawnResults = {
  spawned: [{ index: 0, terminalId: "term-recipe" }],
  failed: [],
};

function setRecipe(recipeId: string | null, runImpl?: () => Promise<SpawnResults>) {
  const runRecipeWithResults = vi
    .fn()
    .mockImplementation(runImpl ?? (async () => OK_SPAWN_RESULTS));
  recipeStoreMock.getState.mockReturnValue({
    getRecipeById: vi.fn().mockReturnValue(recipeId ? { id: recipeId, name: "Recipe" } : null),
    runRecipeWithResults,
  });
  return runRecipeWithResults;
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
  worktreeClientMock.fetchPRBranch.mockResolvedValue(undefined);
  forgeClientMock.assignIssue.mockResolvedValue(undefined);
  copyTreeClientMock.injectToTerminal.mockResolvedValue(undefined);
  setProject({ id: "p1", path: "/repo" });
  setMainWorktree("main");
  setGithubUser(null);
  setAssignPreference(false);
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

describe("worktree.createWithRecipe", () => {
  it("happy path: resolves available branch, creates worktree, returns identifiers", async () => {
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run({ branchName: "feature/foo" }, {} as never)) as Record<
      string,
      unknown
    >;

    expect(worktreeClientMock.getAvailableBranch).toHaveBeenCalledWith("/repo", "feature/foo");
    expect(worktreeClientMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "main",
        newBranch: "feature/issue-6609-add-tools",
        path: "/repo/feature/issue-6609-add-tools",
        fromRemote: false,
        useExistingBranch: false,
      }),
      "/repo"
    );
    expect(forgeClientMock.getPR).not.toHaveBeenCalled();
    expect(worktreeClientMock.fetchPRBranch).not.toHaveBeenCalled();
    expect(result.worktreeId).toBe("wt-new");
    expect(result.branch).toBe("feature/issue-6609-add-tools");
    expect(result.recipeLaunched).toBe(false);
  });

  it("PR path: resolves head branch, fetches PR, creates worktree on existing local branch", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      headRef: "contrib/feature-x",
      title: "Some PR",
      url: "https://github.com/x/y/pull/42",
    });
    worktreeClientMock.getDefaultPath.mockResolvedValue("/repo/contrib/feature-x");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    const result = (await def.run({ pullRequestNumber: 42 }, {} as never)) as Record<
      string,
      unknown
    >;

    expect(forgeClientMock.getPR).toHaveBeenCalledWith("/repo", 42);
    expect(worktreeClientMock.fetchPRBranch).toHaveBeenCalledWith("/repo", 42, "contrib/feature-x");
    // PR path uses the head ref directly — must not call getAvailableBranch (which would suffix on conflict).
    expect(worktreeClientMock.getAvailableBranch).not.toHaveBeenCalled();
    expect(worktreeClientMock.getDefaultPath).toHaveBeenCalledWith("/repo", "contrib/feature-x");
    expect(worktreeClientMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "contrib/feature-x",
        newBranch: "contrib/feature-x",
        path: "/repo/contrib/feature-x",
        fromRemote: false,
        useExistingBranch: true,
      }),
      "/repo"
    );
    expect(result.branch).toBe("contrib/feature-x");
    expect(result.worktreeId).toBe("wt-new");
  });

  it("PR path throws when the PR is not found", async () => {
    forgeClientMock.getPR.mockResolvedValue(null);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({ pullRequestNumber: 999 }, {} as never)).rejects.toThrow(
      /Pull request #999 not found/
    );
    expect(worktreeClientMock.fetchPRBranch).not.toHaveBeenCalled();
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
  });

  it("PR path throws when headRef is missing on the resolved PR", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      title: "x",
      url: "u",
    });
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({ pullRequestNumber: 42 }, {} as never)).rejects.toThrow(/no head branch/);
    expect(worktreeClientMock.fetchPRBranch).not.toHaveBeenCalled();
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
  });

  it("PR path surfaces fetchPRBranch failures (no worktree created)", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      headRef: "contrib/x",
      title: "x",
      url: "u",
    });
    worktreeClientMock.fetchPRBranch.mockRejectedValue(new Error("git fetch failed"));
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({ pullRequestNumber: 42 }, {} as never)).rejects.toThrow(
      /git fetch failed/
    );
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
  });

  it("rejects calls that supply both issueNumber and pullRequestNumber", async () => {
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(
      def.run({ branchName: "feature/foo", issueNumber: 1, pullRequestNumber: 2 }, {} as never)
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("non-PR path requires branchName at runtime", async () => {
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({}, {} as never)).rejects.toThrow(/branchName is required/);
  });

  it("recipe context carries prNumber (not issueNumber) when pullRequestNumber is provided", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      headRef: "contrib/feature-x",
      title: "x",
      url: "u",
    });
    worktreeClientMock.getDefaultPath.mockResolvedValue("/repo/contrib/feature-x");
    const runRecipeWithResults = setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { pullRequestNumber: 42, recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;
    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "recipe-1",
      "/repo/contrib/feature-x",
      "wt-new",
      {
        worktreePath: "/repo/contrib/feature-x",
        branchName: "contrib/feature-x",
        issueNumber: undefined,
        prNumber: 42,
      },
      { spawnedBy: undefined, focusPolicy: undefined, dispatchSource: undefined }
    );
    expect(result.recipeLaunched).toBe(true);
  });

  it("passes spawnedBy through to recipes launched from MCP-created worktrees", async () => {
    const runRecipeWithResults = setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    await def.run(
      { branchName: "feature/foo", recipeId: "recipe-1", spawnedBy: "mcp" },
      {} as never
    );

    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "recipe-1",
      "/repo/feature/issue-6609-add-tools",
      "wt-new",
      expect.objectContaining({
        worktreePath: "/repo/feature/issue-6609-add-tools",
        branchName: "feature/issue-6609-add-tools",
      }),
      { spawnedBy: "mcp", focusPolicy: undefined, dispatchSource: undefined }
    );
  });

  it("forwards ctx.dispatchSource so agent-driven recipe runs stay capped", async () => {
    const runRecipeWithResults = setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    await def.run({ branchName: "feature/foo", recipeId: "recipe-1" }, {
      dispatchSource: "agent",
    } as never);

    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "recipe-1",
      expect.any(String),
      "wt-new",
      expect.any(Object),
      expect.objectContaining({ dispatchSource: "agent" })
    );
  });

  it("recipe failure after worktree creation throws PARTIAL_SUCCESS with worktree info", async () => {
    setRecipe("recipe-1", async () => {
      throw new Error("recipe boom");
    });
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    try {
      await def.run({ branchName: "feature/foo", recipeId: "recipe-1" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/^PARTIAL_SUCCESS:\s+\{/);
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(payload.message).toContain("recipe boom");
      expect(payload.partialResult.worktreeId).toBe("wt-new");
      expect(payload.partialResult.recipeLaunched).toBe(false);
    }
    expect(worktreeClientMock.create).toHaveBeenCalled();
  });

  it("reports recipeLaunched: false when every recipe terminal fails to spawn", async () => {
    const results = {
      spawned: [],
      failed: [
        { index: 0, error: "Panel limit reached" },
        { index: 1, error: "Panel limit reached" },
      ],
    };
    setRecipe("recipe-1", async () => results);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    const result = (await def.run(
      { branchName: "feature/foo", recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;

    expect(result.recipeLaunched).toBe(false);
    expect(result.spawnedTerminalCount).toBe(0);
    expect(result.failedTerminalCount).toBe(2);
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, {
      recipeName: "Recipe",
      projectId: "p1",
    });
  });

  it("reports recipeLaunched: true with failure counts on partial spawn", async () => {
    setRecipe("recipe-1", async () => ({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    }));
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    const result = (await def.run(
      { branchName: "feature/foo", recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;

    expect(result.recipeLaunched).toBe(true);
    expect(result.spawnedTerminalCount).toBe(1);
    expect(result.failedTerminalCount).toBe(1);
    // Only the child that actually started is reported — a dropped terminal
    // has no id, and the MCP ownership ledger must not attribute one (#11909).
    expect(result.spawnedTerminalIds).toEqual(["t-0"]);
  });

  it("does not notify spawn failures when all recipe terminals spawn", async () => {
    setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    const result = (await def.run(
      { branchName: "feature/foo", recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;

    expect(result.recipeLaunched).toBe(true);
    expect(result.spawnedTerminalCount).toBe(1);
    expect(result.failedTerminalCount).toBe(0);
    // The composite reports its child panels by id, so the caller (and the MCP
    // ownership ledger) can act on the terminals it just created (#11909).
    expect(result.spawnedTerminalIds).toEqual(["term-recipe"]);
    // The helper itself no-ops on zero failures; the action still routes
    // results through it so the gate lives in one place.
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(
      OK_SPAWN_RESULTS,
      expect.objectContaining({ recipeName: "Recipe" })
    );
  });

  it("does not notify when the recipe store throws (PARTIAL_SUCCESS path)", async () => {
    setRecipe("recipe-1", async () => {
      throw new Error("recipe boom");
    });
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    await expect(
      def.run({ branchName: "feature/foo", recipeId: "recipe-1" }, {} as never)
    ).rejects.toThrow(/PARTIAL_SUCCESS:/);
    expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
  });

  it("treats empty-string headRef the same as missing", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      headRef: "",
      title: "x",
      url: "u",
    });
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({ pullRequestNumber: 42 }, {} as never)).rejects.toThrow(/no head branch/);
    expect(worktreeClientMock.fetchPRBranch).not.toHaveBeenCalled();
  });

  it("treats whitespace-only headRef the same as missing", async () => {
    forgeClientMock.getPR.mockResolvedValue({
      number: 42,
      headRef: "   ",
      title: "x",
      url: "u",
    });
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await expect(def.run({ pullRequestNumber: 42 }, {} as never)).rejects.toThrow(/no head branch/);
    expect(worktreeClientMock.fetchPRBranch).not.toHaveBeenCalled();
  });
});

describe("workflow recipe-spawn plugin guard (issue #10582)", () => {
  // recipe.run is danger:"confirm" and ActionService hard-blocks plugin sources
  // from it. These workflow actions are danger:"safe" but spawn the same recipe
  // terminals when a recipeId is supplied — so a plugin must not be able to
  // bypass the gate by routing through them.
  it("worktree.createWithRecipe: plugin + recipeId throws before any side effect", async () => {
    const runRecipeWithResults = setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    await expect(
      def.run({ branchName: "feature/foo", recipeId: "recipe-1" }, {
        dispatchSource: "plugin",
      } as never)
    ).rejects.toThrow(/Plugins cannot spawn recipe terminals/);

    expect(worktreeClientMock.create).not.toHaveBeenCalled();
    expect(runRecipeWithResults).not.toHaveBeenCalled();
  });

  it("worktree.createWithRecipe: plugin without recipeId is unaffected", async () => {
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");

    const result = (await def.run({ branchName: "feature/foo" }, {
      dispatchSource: "plugin",
    } as never)) as Record<string, unknown>;

    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(result.worktreeId).toBe("wt-new");
    expect(result.recipeLaunched).toBe(false);
  });

  it("worktree.createWithRecipe: agent + recipeId is confirmation-gated before any effect", async () => {
    // Inverted from "is not blocked" (#11860). The gate is at the ActionService
    // layer, not inside run(), so this dispatches through the service — calling
    // def.run() directly could never observe it.
    const runRecipeWithResults = setRecipe("recipe-1");
    const service = registerThroughActionService(makeCallbacks());

    const blocked = await service.dispatch(
      "worktree.createWithRecipe" as ActionId,
      { branchName: "feature/foo", recipeId: "recipe-1" },
      { source: "agent" }
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("CONFIRMATION_REQUIRED");
    // Nothing was created — the point of gating before run() rather than
    // prompting after the worktree already exists.
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
    expect(runRecipeWithResults).not.toHaveBeenCalled();

    const approved = await service.dispatch(
      "worktree.createWithRecipe" as ActionId,
      { branchName: "feature/foo", recipeId: "recipe-1" },
      { source: "agent", confirmed: true }
    );
    expect(approved.ok).toBe(true);
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(runRecipeWithResults).toHaveBeenCalled();
  });

  it("worktree.createWithRecipe: agent without a recipeId still needs no confirmation", async () => {
    const service = registerThroughActionService(makeCallbacks());
    const result = await service.dispatch(
      "worktree.createWithRecipe" as ActionId,
      { branchName: "feature/foo" },
      { source: "agent" }
    );
    expect(result.ok).toBe(true);
    expect(worktreeClientMock.create).toHaveBeenCalled();
  });

  it("workflow.startWorkOnIssue: plugin + recipeId throws before any IPC", async () => {
    // getIssue is mocked but the guard must fire before it — a plugin must not
    // be able to probe issue existence through the rejected path.
    forgeClientMock.getIssue.mockResolvedValue({
      number: 6609,
      title: "Add workflow macro tools",
      url: "https://github.com/x/y/issues/6609",
    });
    const runRecipeWithResults = setRecipe("recipe-1");
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");

    await expect(
      def.run({ issueNumber: 6609, agentId: "claude", recipeId: "recipe-1" }, {
        dispatchSource: "plugin",
      } as never)
    ).rejects.toThrow(/Plugins cannot spawn recipe terminals/);

    expect(forgeClientMock.getIssue).not.toHaveBeenCalled();
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
    expect(runRecipeWithResults).not.toHaveBeenCalled();
  });

  it("workflow.startWorkOnIssue: plugin without recipeId is unaffected", async () => {
    forgeClientMock.getIssue.mockResolvedValue({
      number: 6609,
      title: "Add workflow macro tools",
      url: "https://github.com/x/y/issues/6609",
    });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");

    const result = (await def.run({ issueNumber: 6609, agentId: "claude" }, {
      dispatchSource: "plugin",
    } as never)) as Record<string, unknown>;

    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(result.worktreeId).toBe("wt-new");
    expect(result.recipeLaunched).toBe(false);
  });

  it("workflow.startWorkOnIssue: agent + recipeId is gated, then forwards dispatchSource once approved", async () => {
    // Inverted from "is not blocked" (#11860), same reasoning as the
    // worktree.createWithRecipe case above.
    forgeClientMock.getIssue.mockResolvedValue({
      number: 6609,
      title: "Add workflow macro tools",
      url: "https://github.com/x/y/issues/6609",
    });
    const runRecipeWithResults = setRecipe("recipe-1");
    const service = registerThroughActionService(makeCallbacks());

    const blocked = await service.dispatch(
      "workflow.startWorkOnIssue" as ActionId,
      { issueNumber: 6609, agentId: "claude", recipeId: "recipe-1" },
      { source: "agent" }
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("CONFIRMATION_REQUIRED");
    // The issue lookup is the first IPC this action makes; a gated dispatch
    // must not even probe issue existence.
    expect(forgeClientMock.getIssue).not.toHaveBeenCalled();
    expect(worktreeClientMock.create).not.toHaveBeenCalled();
    expect(runRecipeWithResults).not.toHaveBeenCalled();

    const approved = await service.dispatch(
      "workflow.startWorkOnIssue" as ActionId,
      { issueNumber: 6609, agentId: "claude", recipeId: "recipe-1" },
      { source: "agent", confirmed: true }
    );
    expect(approved.ok).toBe(true);
    expect(worktreeClientMock.create).toHaveBeenCalled();
    // The structured spawn-result plumbing (#10110) must survive the gate.
    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "recipe-1",
      expect.any(String),
      "wt-new",
      expect.any(Object),
      expect.objectContaining({ dispatchSource: "agent" })
    );
  });
});

describe("workflow.startWorkOnIssue", () => {
  it("happy path: fetches issue, creates worktree, launches agent, injects context", async () => {
    forgeClientMock.getIssue.mockResolvedValue({
      number: 6609,
      title: "Add workflow macro tools",
      url: "https://github.com/x/y/issues/6609",
    });
    const callbacks = makeCallbacks();
    const get = setupActions(callbacks);
    const def = get("workflow.startWorkOnIssue");
    const result = (await def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;

    expect(forgeClientMock.getIssue).toHaveBeenCalledWith("/repo", 6609);
    expect(worktreeClientMock.getAvailableBranch).toHaveBeenCalledWith(
      "/repo",
      "feature/issue-6609-add-workflow-macro-tools"
    );
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ worktreeId: "wt-new", cwd: "/repo/feature/issue-6609-add-tools" })
    );
    expect(copyTreeClientMock.injectToTerminal).toHaveBeenCalledWith(
      "term-1",
      "wt-new",
      undefined,
      undefined,
      // Workflow creation is its own surface in the run history (#11732) — not
      // a toolbar copy and not an agent tool call.
      "workflow"
    );
    expect(result.terminalId).toBe("term-1");
    expect(result.contextInjected).toBe(true);
    expect(result.recipeLaunched).toBe(false);
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
    expect(result.issueTitle).toBe("Add workflow macro tools");
    // The result is published as structuredContent now (#11547), so it has to
    // satisfy the schema MCP advertises for it.
    expectMatchesResultSchema("workflow.startWorkOnIssue", result);
  });

  it("reports contextInjected:false when CopyTree resolves with an error", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 42, title: "t", url: "u" });
    // CopyTree signals the common failures (terminal gone, generation failed)
    // by RESOLVING with an `error` field rather than rejecting — reporting that
    // as injected would tell a caller the agent has issue context it never got.
    copyTreeClientMock.injectToTerminal.mockResolvedValueOnce({
      content: "",
      fileCount: 0,
      error: "Terminal not found",
    });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");

    const result = (await def.run({ issueNumber: 42, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;

    expect(result.contextInjected).toBe(false);
    // Still a success overall — the agent is running and the user can re-inject.
    expect(result.terminalId).toBe("term-1");
    expectMatchesResultSchema("workflow.startWorkOnIssue", result);
  });

  it("passes spawnedBy through to agents launched by MCP workflow actions", async () => {
    forgeClientMock.getIssue.mockResolvedValue({
      number: 6959,
      title: "Assistant focus is stolen",
      url: "https://github.com/x/y/issues/6959",
    });
    const callbacks = makeCallbacks();
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");

    await def.run({ issueNumber: 6959, agentId: "claude", spawnedBy: "mcp" }, {} as never);

    expect(worktreeClientMock.getAvailableBranch).toHaveBeenCalledWith(
      "/repo",
      "feature/issue-6959-assistant-focus-is-stolen"
    );
    expect(callbacks.onLaunchAgent).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        worktreeId: "wt-new",
        spawnedBy: "mcp",
      })
    );
  });

  it("throws when project is missing", async () => {
    setProject(null);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await expect(def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)).rejects.toThrow(
      /No active project/
    );
  });

  describe("agentId validation runs before any side effect (#11547)", () => {
    /**
     * Every collaborator `run()` can reach after the validation point — reads
     * included, so a refactor that moves one of them above the guard fails
     * here rather than silently reintroducing the orphan worktree.
     * `useProjectStore` is excluded on purpose: its no-active-project guard is
     * meant to run first.
     */
    function expectNoSideEffects(callbacks: MockCallbacks) {
      expect(preferencesStoreMock.getState).not.toHaveBeenCalled();
      expect(forgeClientMock.getIssue).not.toHaveBeenCalled();
      expect(currentViewStoreMock.getCurrentViewStore).not.toHaveBeenCalled();
      expect(recipeStoreMock.getState).not.toHaveBeenCalled();
      expect(worktreeClientMock.getAvailableBranch).not.toHaveBeenCalled();
      expect(worktreeClientMock.getDefaultPath).not.toHaveBeenCalled();
      expect(worktreeClientMock.create).not.toHaveBeenCalled();
      expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
      expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
      expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
      expect(forgeClientMock.getCurrentUser).not.toHaveBeenCalled();
      expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    }

    it("rejects an unregistered agentId without creating an orphan worktree", async () => {
      forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "x", url: "u" });
      const runRecipeWithResults = setRecipe("recipe-1");
      const callbacks = makeCallbacks();
      const def = setupActions(callbacks)("workflow.startWorkOnIssue");

      // Before #11547 the id was only checked at line-of-spawn — by then the
      // worktree existed and the recipe terminals had already started.
      await expect(
        def.run({ issueNumber: 1, agentId: "clyde-the-agent", recipeId: "recipe-1" }, {} as never)
      ).rejects.toThrow(/Unknown agent ID 'clyde-the-agent'/);

      expectNoSideEffects(callbacks);
      expect(runRecipeWithResults).not.toHaveBeenCalled();
    });

    it.each(["browser", "dev-preview"])(
      "rejects '%s' because it opens a panel with no PTY",
      async (agentId) => {
        forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "x", url: "u" });
        const callbacks = makeCallbacks();
        const def = setupActions(callbacks)("workflow.startWorkOnIssue");

        // These reach their own non-PTY branches inside the launcher, so the
        // workflow would "succeed" with a panel that can never receive the
        // injected context the action promises.
        await expect(def.run({ issueNumber: 1, agentId }, {} as never)).rejects.toThrow(/no PTY/);

        expectNoSideEffects(callbacks);
      }
    );

    it("accepts 'terminal', which is PTY-backed despite being unregistered", async () => {
      forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "x", url: "u" });
      const callbacks = makeCallbacks();
      const def = setupActions(callbacks)("workflow.startWorkOnIssue");

      await def.run({ issueNumber: 1, agentId: "terminal" }, {} as never);

      expect(worktreeClientMock.create).toHaveBeenCalled();
      expect(callbacks.onLaunchAgent).toHaveBeenCalledWith("terminal", expect.any(Object));
    });

    it("accepts a plugin-contributed agentId, so the gate is not a built-in enum", async () => {
      forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "x", url: "u" });
      const callbacks = makeCallbacks();
      const def = setupActions(callbacks)("workflow.startWorkOnIssue");

      setPluginAgentRegistry({
        "acme-agent": { name: "Acme", command: "acme" } as never,
      });
      try {
        await def.run({ issueNumber: 1, agentId: "acme-agent" }, {} as never);
      } finally {
        // Repo convention — also clears per-plugin tracking and listeners,
        // which setPluginAgentRegistry({}) alone would leave behind.
        clearPluginAgentRegistryForTests();
      }

      expect(callbacks.onLaunchAgent).toHaveBeenCalledWith("acme-agent", expect.any(Object));
    });
  });

  it("throws when issue is not found", async () => {
    forgeClientMock.getIssue.mockResolvedValue(null);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await expect(def.run({ issueNumber: 999, agentId: "claude" }, {} as never)).rejects.toThrow(
      /Issue #999 not found/
    );
  });

  it("throws PARTIAL_SUCCESS when agent.launch returns null after worktree creation", async () => {
    forgeClientMock.getIssue.mockResolvedValue({
      number: 1,
      title: "x",
      url: "u",
    });
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValue(null);
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    await expect(def.run({ issueNumber: 1, agentId: "claude" }, {} as never)).rejects.toThrow(
      /PARTIAL_SUCCESS:/
    );
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
  });

  it("throws PARTIAL_SUCCESS without injecting when the CLI is missing (setup-diagnostic panel)", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 2, title: "x", url: "u" });
    const callbacks = makeCallbacks();
    // A missing CLI yields a real panel id but no PTY; the workflow must not
    // treat it as a launched agent or inject context into it.
    callbacks.onLaunchAgent.mockResolvedValue({
      terminalId: "diagnostic-1",
      location: "grid",
      spawnStatus: "missing-cli",
      // A real non-null launcher result always carries the identity too.
      worktreeId: "wt-new",
      worktreePath: "/repo/feature/issue-6609-add-tools",
      branch: "feature/issue-6609-add-tools",
      cwd: "/repo/feature/issue-6609-add-tools",
    });
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    try {
      await def.run({ issueNumber: 2, agentId: "claude" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/^PARTIAL_SUCCESS:/);
      expect(message).toMatch(/setup diagnostic|not available/i);
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(payload.partialResult.terminalId).toBeNull();
      expect(payload.partialResult.contextInjected).toBe(false);
    }
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
  });

  it("partial-success error embeds message + partial result as a single JSON envelope", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 7, title: "t", url: "u" });
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockResolvedValue(null);
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    try {
      await def.run({ issueNumber: 7, agentId: "claude" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/^PARTIAL_SUCCESS:\s+\{/);
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(typeof payload.message).toBe("string");
      expect(payload.partialResult.worktreeId).toBe("wt-new");
      expect(payload.partialResult.terminalId).toBeNull();
      expect(payload.partialResult.contextInjected).toBe(false);
      expect(payload.partialResult.assignedToSelf).toBe(false);
      expect(payload.partialResult.assignmentError).toBeNull();
    }
  });

  it("partial-success encoding stays parseable when the human message itself contains '{'", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 5, title: "t", url: "u" });
    setRecipe("recipe-1", async () => {
      throw new Error('config parse failed: {"key": null}');
    });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    try {
      await def.run({ issueNumber: 5, agentId: "claude", recipeId: "recipe-1" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(payload.message).toContain('config parse failed: {"key": null}');
      expect(payload.partialResult.recipeLaunched).toBe(false);
      expect(payload.partialResult.worktreeId).toBe("wt-new");
    }
  });

  it("recipe failure throws PARTIAL_SUCCESS with worktree info before agent is launched", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    setRecipe("recipe-1", async () => {
      throw new Error("recipe boom");
    });
    const callbacks = makeCallbacks();
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    await expect(
      def.run({ issueNumber: 1, agentId: "claude", recipeId: "recipe-1" }, {} as never)
    ).rejects.toThrow(/PARTIAL_SUCCESS:/);
    expect(worktreeClientMock.create).toHaveBeenCalled();
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("reports recipeLaunched: false when every recipe terminal fails to spawn", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    const results = {
      spawned: [],
      failed: [{ index: 0, error: "Panel limit reached" }],
    };
    setRecipe("recipe-1", async () => results);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");

    const result = (await def.run(
      { issueNumber: 1, agentId: "claude", recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;

    expect(result.recipeLaunched).toBe(false);
    expect(result.spawnedTerminalCount).toBe(0);
    expect(result.failedTerminalCount).toBe(1);
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, {
      recipeName: "Recipe",
      projectId: "p1",
    });
  });

  it("reports recipeLaunched: true with failure counts on partial spawn", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    setRecipe("recipe-1", async () => ({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "PTY spawn failed" }],
    }));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");

    const result = (await def.run(
      { issueNumber: 1, agentId: "claude", recipeId: "recipe-1" },
      {} as never
    )) as Record<string, unknown>;

    expect(result.recipeLaunched).toBe(true);
    expect(result.spawnedTerminalCount).toBe(1);
    expect(result.failedTerminalCount).toBe(1);
  });

  it("PARTIAL_SUCCESS from a failed agent launch preserves partial spawn counts", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    setRecipe("recipe-1", async () => ({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    }));
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValue(new Error("PTY spawn failed"));
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");

    try {
      await def.run({ issueNumber: 1, agentId: "claude", recipeId: "recipe-1" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("PARTIAL_SUCCESS:");
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(payload.partialResult.recipeLaunched).toBe(true);
      expect(payload.partialResult.spawnedTerminalCount).toBe(1);
      expect(payload.partialResult.failedTerminalCount).toBe(1);
    }
  });

  it("agent.launch throwing (not just returning null) becomes PARTIAL_SUCCESS", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    const callbacks = makeCallbacks();
    callbacks.onLaunchAgent.mockRejectedValue(new Error("PTY spawn failed"));
    const def = setupActions(callbacks)("workflow.startWorkOnIssue");
    try {
      await def.run({ issueNumber: 1, agentId: "claude" }, {} as never);
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("PARTIAL_SUCCESS:");
      const payload = JSON.parse(message.slice(message.indexOf("{")));
      expect(payload.message).toContain("PTY spawn failed");
      expect(payload.partialResult.worktreeId).toBe("wt-new");
      expect(payload.partialResult.terminalId).toBeNull();
    }
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
  });

  it("context injection failure is best-effort — agent stays launched, contextInjected: false", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    copyTreeClientMock.injectToTerminal.mockRejectedValue(new Error("nope"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run({ issueNumber: 1, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;
    expect(result.terminalId).toBe("term-1");
    expect(result.contextInjected).toBe(false);
  });

  it("injectContext: false skips injection entirely", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 1, title: "t", url: "u" });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 1, agentId: "claude", injectContext: false },
      {} as never
    )) as Record<string, unknown>;
    expect(copyTreeClientMock.injectToTerminal).not.toHaveBeenCalled();
    expect(result.contextInjected).toBe(false);
  });

  it("assignToSelf assigns the issue to the configured user", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6609, "ada");
    expect(result.assignedToSelf).toBe(true);
    expect(result.assignmentError).toBeNull();
  });

  it("assignToSelf is best-effort — failure surfaces in assignmentError without aborting the macro", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    forgeClientMock.assignIssue.mockRejectedValue(new Error("403 Forbidden"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("403 Forbidden");
    expect(result.terminalId).toBe("term-1");
  });

  it("assignToSelf omitted falls back to assignWorktreeToSelf preference (true)", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    setAssignPreference(true);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6609, "ada");
    expect(result.assignedToSelf).toBe(true);
    expect(result.assignmentError).toBeNull();
  });

  it("assignToSelf omitted with preference (false) does not assign", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    setAssignPreference(false);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
  });

  it("explicit assignToSelf: false overrides a true preference", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    setAssignPreference(true);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: false },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
  });

  it("assignToSelf with no GitHub username configured surfaces a descriptive assignmentError", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser(null);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("No forge viewer available");
    expect(result.terminalId).toBe("term-1");
  });

  it("preference fallback also surfaces 'No forge viewer available' when assignToSelf is omitted", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser(null);
    setAssignPreference(true);
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run({ issueNumber: 6609, agentId: "claude" }, {} as never)) as Record<
      string,
      unknown
    >;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("No forge viewer available");
  });

  it("assignment failure does not clobber other result fields", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    setGithubUser("ada");
    forgeClientMock.assignIssue.mockRejectedValue(new Error("rate limit"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(result.worktreeId).toBe("wt-new");
    expect(result.terminalId).toBe("term-1");
    expect(result.contextInjected).toBe(true);
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("rate limit");
  });

  it("getCurrentUser() rejection surfaces in assignmentError, worktree still returned", async () => {
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
    forgeClientMock.getCurrentUser.mockRejectedValue(new Error("IPC unavailable"));
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    const result = (await def.run(
      { issueNumber: 6609, agentId: "claude", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.worktreeId).toBe("wt-new");
    expect(result.terminalId).toBe("term-1");
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("IPC unavailable");
  });

  it("derives a sane branch name from the issue title when none is provided", async () => {
    forgeClientMock.getIssue.mockResolvedValue({
      number: 42,
      title: "Fix: weird $$$ characters & SPACES",
      url: "u",
    });
    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await def.run({ issueNumber: 42, agentId: "claude" }, {} as never);
    const call = worktreeClientMock.getAvailableBranch.mock.calls[0] ?? [];
    const branch = call[1] as string;
    expect(branch).toMatch(/^feature\/issue-42-/);
    expect(branch).not.toMatch(/[^a-z0-9/-]/);
  });
});

describe("worktree.createWithRecipe — issue assignment", () => {
  it("happy path returns assignmentError: null when nothing is requested", async () => {
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run({ branchName: "feature/foo" }, {} as never)) as Record<
      string,
      unknown
    >;
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
  });

  it("explicit assignToSelf: true with issueNumber assigns and returns null error", async () => {
    setGithubUser("ada");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6625, "ada");
    expect(result.assignedToSelf).toBe(true);
    expect(result.assignedUsername).toBe("ada");
    expect(result.assignmentError).toBeNull();
  });

  it("assignedUsername is null when no assignment occurs", async () => {
    setGithubUser("ada");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: false },
      {} as never
    )) as Record<string, unknown>;
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignedUsername).toBeNull();
  });

  it("assignedUsername is null when assignment fails", async () => {
    setGithubUser("ada");
    forgeClientMock.assignIssue.mockRejectedValue(new Error("403 Forbidden"));
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignedUsername).toBeNull();
    expect(result.assignmentError).toBe("403 Forbidden");
  });

  it("assignToSelf omitted falls back to assignWorktreeToSelf preference (true)", async () => {
    setGithubUser("ada");
    setAssignPreference(true);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625 },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6625, "ada");
    expect(result.assignedToSelf).toBe(true);
    expect(result.assignmentError).toBeNull();
  });

  it("assignToSelf omitted with preference (false) does not assign", async () => {
    setGithubUser("ada");
    setAssignPreference(false);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625 },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
  });

  it("explicit assignToSelf: false overrides a true preference", async () => {
    setGithubUser("ada");
    setAssignPreference(true);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: false },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
  });

  it("assignment failure surfaces in assignmentError but worktree still succeeds", async () => {
    setGithubUser("ada");
    forgeClientMock.assignIssue.mockRejectedValue(new Error("403 Forbidden"));
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(result.worktreeId).toBe("wt-new");
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("403 Forbidden");
  });

  it("missing GitHub username surfaces a descriptive assignmentError", async () => {
    setGithubUser(null);
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("No forge viewer available");
  });

  it("assignToSelf without issueNumber is a no-op (nothing to assign)", async () => {
    setGithubUser("ada");
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBeNull();
  });

  it("getCurrentUser() rejection during assignment surfaces in assignmentError, worktree still created", async () => {
    forgeClientMock.getCurrentUser.mockRejectedValue(new Error("IPC unavailable"));
    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6609, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;
    expect(forgeClientMock.assignIssue).not.toHaveBeenCalled();
    expect(result.worktreeId).toBe("wt-new");
    expect(result.assignedToSelf).toBe(false);
    expect(result.assignmentError).toBe("IPC unavailable");
  });
});

describe("self-assign patches the issues dropdown cache (#11087)", () => {
  const seedIssueSlot = (issue: Issue, filter = "open", sort = "created"): string => {
    const key = buildCacheKey("/repo", "issue", filter, sort);
    setCache(key, { items: [issue], nextCursor: null, hasMore: false, timestamp: 1 });
    return key;
  };

  const assigneesOn = (key: string, issueNumber: number) => {
    const item = getCache(key)?.items.find((i) => i.number === issueNumber);
    return item && "assignees" in item ? item.assignees : undefined;
  };

  beforeEach(() => {
    resetForgeResourceCache();
    forgeClientMock.getIssue.mockResolvedValue({ number: 6609, title: "t", url: "u" });
  });

  it("worktree.createWithRecipe — the palette path — adds the viewer to every cached slot", async () => {
    setGithubUser("ada");
    const openSlot = seedIssueSlot(makeCacheIssue(6625, []));
    const updatedSlot = seedIssueSlot(makeCacheIssue(6625, []), "open", "updated");

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    );

    expect(assigneesOn(openSlot, 6625)?.map((a) => a.login)).toEqual(["ada"]);
    expect(assigneesOn(updatedSlot, 6625)?.map((a) => a.login)).toEqual(["ada"]);
  });

  it("workflow.startWorkOnIssue adds the viewer to the cached issue", async () => {
    setGithubUser("ada");
    const key = seedIssueSlot(makeCacheIssue(6609, []));

    const def = setupActions(makeCallbacks())("workflow.startWorkOnIssue");
    await def.run({ issueNumber: 6609, agentId: "claude", assignToSelf: true }, {} as never);

    expect(assigneesOn(key, 6609)?.map((a) => a.login)).toEqual(["ada"]);
  });

  it("the optimistic assignee carries the avatar the forge reported for the viewer", async () => {
    forgeClientMock.getCurrentUser.mockResolvedValue({
      login: "ada",
      avatarUrl: "https://fake.test/ada.png",
    });
    const key = seedIssueSlot(makeCacheIssue(6625, []));

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    );

    expect(assigneesOn(key, 6625)?.[0]?.avatarUrl).toBe("https://fake.test/ada.png");
  });

  it("marks the slot stale so the next revalidate refetches instead of trusting the backend's cached page", async () => {
    setGithubUser("ada");
    const key = buildCacheKey("/repo", "issue", "open", "created");
    setCache(key, {
      items: [makeCacheIssue(6625, [])],
      nextCursor: null,
      hasMore: false,
      timestamp: 1,
      countAtWrite: 3,
    });

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    );

    expect(getCache(key)?.stale).toBe(true);
  });

  it("a failed assign leaves the cache untouched", async () => {
    setGithubUser("ada");
    forgeClientMock.assignIssue.mockRejectedValue(new Error("403 Forbidden"));
    const key = seedIssueSlot(makeCacheIssue(6625, []));

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;

    expect(result.assignedToSelf).toBe(false);
    expect(assigneesOn(key, 6625)).toEqual([]);
  });

  it("does not touch an issue that is already assigned to the viewer", async () => {
    setGithubUser("ada");
    const key = seedIssueSlot(makeCacheIssue(6625, ["ada"]));
    const genBefore = getGeneration(key);

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    );

    expect(assigneesOn(key, 6625)?.map((a) => a.login)).toEqual(["ada"]);
    expect(getGeneration(key)).toBe(genBefore);
  });

  it("a cache-layer throw does not turn a successful assign into an assignmentError", async () => {
    setGithubUser("ada");
    // Simulate a corrupt cached row: reading `assignees` blows up inside the
    // patch. The server-side assign has already succeeded by then, so the
    // action must still report success.
    const corrupt = makeCacheIssue(6625, []);
    Object.defineProperty(corrupt, "assignees", {
      enumerable: true,
      get() {
        throw new Error("corrupt cache entry");
      },
    });
    seedIssueSlot(corrupt);

    const def = setupActions(makeCallbacks())("worktree.createWithRecipe");
    const result = (await def.run(
      { branchName: "feature/foo", issueNumber: 6625, assignToSelf: true },
      {} as never
    )) as Record<string, unknown>;

    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 6625, "ada");
    expect(result.assignedToSelf).toBe(true);
    expect(result.assignedUsername).toBe("ada");
    expect(result.assignmentError).toBeNull();
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
    expect(result.detectedRunners).toEqual([{ id: "test", name: "Test", command: "npm test" }]);
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
    projectClientMock.detectRunners.mockResolvedValue([{ id: "x", name: "x", command: "x" }]);
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

  it("falls back to ctx.activeWorktreePath when cwd is omitted", async () => {
    gitGetStagingStatusMock.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflictedFiles: [],
      currentBranch: "feature/x",
      repoState: "CLEAN",
    });
    projectClientMock.detectRunners.mockResolvedValue([]);
    await runWorkflow("workflow.prepBranchForReview", {}, { activeWorktreePath: "/repo/active" });
    expect(gitGetStagingStatusMock).toHaveBeenCalledWith("/repo/active");
  });

  it("throws when cwd is omitted and no active worktree in ctx", async () => {
    await expect(runWorkflow("workflow.prepBranchForReview", {})).rejects.toThrow(
      "No active worktree"
    );
  });
});

describe("workflow.focusNextAttention", () => {
  it("prefers waiting agents over working ones and dispatches with the right args", async () => {
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
    const state = panelStoreMock.getState();
    expect(state.focusNextWaiting).toHaveBeenCalledTimes(1);
    const args = state.focusNextWaiting.mock.calls[0] ?? [];
    const isInTrashArg = args[0];
    const validIdsArg = args[1] as Set<string>;
    expect(isInTrashArg).toBe(state.isInTrash);
    expect(validIdsArg).toBeInstanceOf(Set);
    expect(validIdsArg.has("wt-1")).toBe(true);
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

  it("ignores background and excluded terminals (mirrors isTerminalVisible)", async () => {
    // A waiting terminal in a background panel and one excluded from
    // persistence would be skipped by focusNextWaiting — the macro must not
    // claim focused: true.
    setPanelTerminals(
      [
        { id: "t1", agentState: "waiting", worktreeId: "wt-1", location: "background" },
        { id: "t2", agentState: "waiting", worktreeId: "wt-1", location: "grid" },
      ],
      new Map([["wt-1", { worktreeId: "wt-1" }]])
    );
    // mark t2 as excluded from persistence
    selectorMock.selectOrderedTerminals.mockReturnValue([
      { id: "t1", agentState: "waiting", worktreeId: "wt-1", location: "background" },
      {
        id: "t2",
        agentState: "waiting",
        worktreeId: "wt-1",
        location: "grid",
        excludeFromPersistence: true,
      },
    ]);
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(result.focused).toBe(false);
    expect(result.state).toBe("none");
    expect(result.waitingCount).toBe(0);
  });

  it("respects isInTrash() function in addition to location === 'trash'", async () => {
    // Some terminals report location: "grid" but isInTrash returns true.
    // The macro must skip those just like isTerminalVisible does.
    selectorMock.selectOrderedTerminals.mockReturnValue([
      { id: "t1", agentState: "waiting", worktreeId: "wt-1", location: "grid" },
    ]);
    const isInTrashMock = vi.fn().mockReturnValue(true);
    panelStoreMock.getState.mockReturnValue({
      panelsById: {},
      panelIds: [],
      isInTrash: isInTrashMock,
      focusNextWaiting: vi.fn(),
      focusNextWorking: vi.fn(),
    });
    currentViewStoreMock.getCurrentViewStore.mockReturnValue({
      getState: () => ({ worktrees: new Map([["wt-1", { worktreeId: "wt-1" }]]) }),
    });
    const def = setupActions(makeCallbacks())("workflow.focusNextAttention");
    const result = (await def.run(undefined, {} as never)) as Record<string, unknown>;
    expect(isInTrashMock).toHaveBeenCalledWith("t1");
    expect(result.focused).toBe(false);
    expect(result.state).toBe("none");
  });
});
