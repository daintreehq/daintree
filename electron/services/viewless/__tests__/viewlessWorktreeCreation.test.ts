import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, makeHosts, makeWorktree, PROJECT, request } from "./viewlessTestDeps.js";

function creationDeps(answers: Record<string, unknown | ((args: unknown) => unknown)> = {}) {
  const made = makeDeps({ getWorkspaceHosts: () => makeHosts() });
  const fallback = made.invoke.getMockImplementation()!;
  made.invoke.mockImplementation(async (projectId, channel, args) => {
    if (!Object.hasOwn(answers, channel)) {
      if (channel === CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH) {
        return `${(args[0] as { branchName: string }).branchName}-2`;
      }
      if (channel === CHANNELS.WORKTREE_GET_DEFAULT_PATH) {
        return `/repo-wt/${(args[0] as { branchName: string }).branchName}`;
      }
      return fallback(projectId, channel, args);
    }
    const answer = answers[channel];
    return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args[0]) : answer;
  });
  return made;
}

const channelsCalled = (invoke: ReturnType<typeof makeDeps>["invoke"]) =>
  invoke.mock.calls.map(([, channel]) => channel);

describe("worktree.createWithRecipe with no frontend (#13501)", () => {
  it("branches off the main worktree's branch under a free name, as the managed creator does", async () => {
    const { deps, invoke } = creationDeps();

    const result = await executeViewlessAction(
      request("worktree.createWithRecipe", { source: { kind: "newBranch", branchName: "topic" } }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.WORKTREE_CREATE, [
      {
        rootPath: "/repo",
        options: {
          baseBranch: "main",
          newBranch: "topic-2",
          path: "/repo-wt/topic-2",
          fromRemote: false,
          useExistingBranch: false,
          collisionPolicy: "suffix",
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      result: {
        worktreeId: "/repo-wt/feature",
        worktreePath: "/repo-wt/topic-2",
        branch: "feature",
        requestedBranch: "topic",
        effectiveBranch: "feature",
        recipeLaunched: false,
        spawnedTerminalCount: 0,
        spawnedTerminalIds: [],
        failedTerminalCount: 0,
        setupState: "pending",
        assignedToSelf: false,
        assignedUsername: null,
        assignmentError: null,
      },
    });
  });

  it("checks out an existing branch exactly as named, never suffixed", async () => {
    const { deps, invoke } = creationDeps();

    await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "existingBranch", branchName: "topic" },
      }),
      deps
    );

    expect(channelsCalled(invoke)).not.toContain(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH);
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.WORKTREE_CREATE, [
      expect.objectContaining({
        options: expect.objectContaining({ newBranch: "topic", useExistingBranch: true }),
      }),
    ]);
  });

  it("fetches a pull request's head branch first, and says how to recover when that fails", async () => {
    const pr = { number: 4, headRef: "contrib/fix" };
    const ok = creationDeps({ [CHANNELS.FORGE_GET_PR]: pr });

    await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "pullRequest", pullRequestNumber: 4 },
      }),
      ok.deps
    );
    expect(ok.invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.WORKTREE_FETCH_PR_BRANCH, [
      { rootPath: "/repo", prNumber: 4, headRefName: "contrib/fix" },
    ]);

    const failing = creationDeps({
      [CHANNELS.FORGE_GET_PR]: pr,
      [CHANNELS.WORKTREE_FETCH_PR_BRANCH]: () => {
        throw new Error("couldn't find remote ref");
      },
    });
    const result = await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "pullRequest", pullRequestNumber: 4 },
      }),
      failing.deps
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "EXECUTION_ERROR",
        message: expect.stringContaining('source.kind="existingBranch"'),
      },
    });
    expect(channelsCalled(failing.invoke)).not.toContain(CHANNELS.WORKTREE_CREATE);
  });

  it("refuses a recipe before creating anything, saying only a window runs one", async () => {
    const { deps, invoke } = creationDeps();

    const result = await executeViewlessAction(
      request(
        "worktree.createWithRecipe",
        { source: { kind: "newBranch", branchName: "topic" }, recipeId: "r-1" },
        // Approved, so the refusal is about the recipe, not the confirmation it needs.
        { confirmed: true }
      ),
      deps
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR", message: expect.stringContaining("Nothing was created") },
    });
    expect(channelsCalled(invoke)).not.toContain(CHANNELS.WORKTREE_CREATE);
  });

  it("assigns the issue only when asked, and says why it didn't with no choice given", async () => {
    const assigned = creationDeps({
      [CHANNELS.FORGE_GET_CURRENT_USER]: { login: "greg" },
      [CHANNELS.FORGE_ASSIGN_ISSUE]: [{ login: "greg" }],
    });
    const asked = await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "newBranch", branchName: "topic", issueNumber: 12, assignToSelf: true },
      }),
      assigned.deps
    );
    expect(asked).toMatchObject({
      ok: true,
      result: { assignedToSelf: true, assignedUsername: "greg", assignmentError: null },
    });
    expect(assigned.invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_ASSIGN_ISSUE, [
      { cwd: "/repo", issueNumber: 12, username: "greg" },
    ]);

    const unasked = creationDeps();
    const left = await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "newBranch", branchName: "topic", issueNumber: 12 },
      }),
      unasked.deps
    );
    expect(left).toMatchObject({
      ok: true,
      result: { assignedToSelf: false, assignmentError: expect.stringContaining("assignToSelf") },
    });
    expect(channelsCalled(unasked.invoke)).not.toContain(CHANNELS.FORGE_ASSIGN_ISSUE);
  });

  it("refuses a field borrowed from another mode, as the renderer's schema does", async () => {
    const { deps, invoke } = creationDeps();

    const result = await executeViewlessAction(
      request("worktree.createWithRecipe", {
        source: { kind: "existingBranch", branchName: "topic", baseBranch: "main" },
      }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks for a base branch when the project has no main worktree to branch from", async () => {
    const made = makeDeps(
      { getWorkspaceHosts: () => makeHosts() },
      { worktrees: [makeWorktree({ isMainWorktree: false })] }
    );

    const result = await executeViewlessAction(
      request("worktree.createWithRecipe", { source: { kind: "newBranch", branchName: "topic" } }),
      made.deps
    );

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("source.baseBranch") },
    });
  });
});
