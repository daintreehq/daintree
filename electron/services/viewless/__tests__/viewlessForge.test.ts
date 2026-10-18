import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, makeHosts, makeWorktree, PROJECT, request } from "./viewlessTestDeps.js";

const PR = {
  number: 7,
  title: "Fix the thing",
  body: "Body",
  state: "open",
  isDraft: false,
  merged: false,
  url: "https://example.test/pr/7",
  baseRef: "main",
  headRef: "feature",
  rawData: { secret: "the provider's whole node" },
};

function forgeDeps(answers: Record<string, unknown> = {}) {
  const worktrees = [
    makeWorktree(),
    makeWorktree({
      id: "/repo-wt/feature",
      worktreeId: "/repo-wt/feature",
      path: "/repo-wt/feature",
      name: "feature",
      branch: "feature",
      isMainWorktree: false,
    }),
  ];
  const made = makeDeps({ getWorkspaceHosts: () => makeHosts() }, { worktrees });
  const fallback = made.invoke.getMockImplementation()!;
  made.invoke.mockImplementation(async (projectId, channel, args) =>
    Object.hasOwn(answers, channel) ? answers[channel] : fallback(projectId, channel, args)
  );
  return made;
}

describe("forge reads with no frontend (#13501)", () => {
  it("reads a pull request through the host's handler, dropping the provider's raw node", async () => {
    const { deps, invoke } = forgeDeps({ [CHANNELS.FORGE_GET_PR]: PR });

    const result = await executeViewlessAction(request("forge.getPR", { prNumber: 7 }), deps);

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_GET_PR, [
      { cwd: "/repo", prNumber: 7 },
    ]);
    expect(result).toMatchObject({ ok: true, result: { pr: { number: 7, headRef: "feature" } } });
    expect(JSON.stringify(result)).not.toContain("the provider's whole node");
  });

  it("answers a missing pull request or issue as empty, never as a failure", async () => {
    const { deps } = forgeDeps({ [CHANNELS.FORGE_GET_PR]: null, [CHANNELS.FORGE_GET_ISSUE]: null });

    expect(await executeViewlessAction(request("forge.getPR", { prNumber: 9 }), deps)).toEqual({
      ok: true,
      result: { pr: null },
    });
    expect(
      await executeViewlessAction(request("forge.getIssue", { issueNumber: 9 }), deps)
    ).toEqual({ ok: true, result: null });
  });

  it("asks about the worktree it names, by id or path, and refuses one this project doesn't own", async () => {
    const { deps, invoke } = forgeDeps({
      [CHANNELS.FORGE_GET_CI_STATUS]: {
        state: "success",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
      },
    });

    await executeViewlessAction(
      request("forge.getCIStatus", { prNumber: 7, worktreeId: "/repo-wt/feature" }),
      deps
    );
    await executeViewlessAction(
      request("forge.getCIStatus", { prNumber: 7, cwd: "/repo-wt/feature" }),
      deps
    );
    const foreign = await executeViewlessAction(
      request("forge.getCIStatus", { prNumber: 7, worktreePath: "/somewhere/else" }),
      deps
    );
    const unknown = await executeViewlessAction(
      request("forge.getCIStatus", { prNumber: 7, worktreeId: "/repo-wt/gone" }),
      deps
    );

    const cwds = invoke.mock.calls
      .filter(([, channel]) => channel === CHANNELS.FORGE_GET_CI_STATUS)
      .map(([, , args]) => (args[0] as { cwd: string }).cwd);
    expect(cwds).toEqual(["/repo-wt/feature", "/repo-wt/feature"]);
    expect(foreign).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(unknown).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });

  it("reads from anywhere inside the project or its worktrees, and nowhere outside", async () => {
    const { deps, invoke } = forgeDeps({ [CHANNELS.FORGE_GET_PR]: PR });
    const read = (cwd: string) =>
      executeViewlessAction(request("forge.getPR", { prNumber: 7, cwd }), deps);

    expect(await read("/repo/packages/app")).toMatchObject({ ok: true });
    expect(await read("/repo/")).toMatchObject({ ok: true });
    expect(await read("/repo-wt/feature/src")).toMatchObject({ ok: true });
    for (const outside of ["/repo/../etc", "/repo-other", "relative/path"]) {
      expect(await read(outside)).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
    const cwds = invoke.mock.calls
      .filter(([, channel]) => channel === CHANNELS.FORGE_GET_PR)
      .map(([, , args]) => (args[0] as { cwd: string }).cwd);
    expect(cwds).toEqual(["/repo/packages/app", "/repo/", "/repo-wt/feature/src"]);
  });

  it("falls back to the worktree a view last made active", async () => {
    const { deps, invoke, store } = forgeDeps({ [CHANNELS.FORGE_GET_PR]: PR });
    await store.enqueueProjectStateUpdate(PROJECT.id, () => ({
      projectId: PROJECT.id,
      sidebarWidth: 350,
      terminals: [],
      activeWorktreeId: "/repo-wt/feature",
    }));

    await executeViewlessAction(request("forge.getPR", { prNumber: 7 }), deps);

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_GET_PR, [
      { cwd: "/repo-wt/feature", prNumber: 7 },
    ]);
  });

  it("lists a page as a summary by default, passing only the provider's own options", async () => {
    const { deps, invoke } = forgeDeps({
      [CHANNELS.FORGE_LIST_PRS]: { items: [PR], nextCursor: "next", hasMore: true },
    });

    const result = await executeViewlessAction(
      request("forge.listPRs", { state: "merged", perPage: 5 }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_LIST_PRS, [
      { cwd: "/repo", opts: { state: "merged", perPage: 5 } },
    ]);
    expect(result).toMatchObject({ ok: true, result: { items: [{ number: 7 }] } });
    const [summary] = (result as { result: { items: Array<Record<string, unknown>> } }).result
      .items;
    expect(summary).not.toHaveProperty("body");
    expect(summary).not.toHaveProperty("rawData");
  });

  it("refuses a key its renderer action doesn't take, as a view's dispatch does", async () => {
    const { deps, invoke } = forgeDeps();

    const result = await executeViewlessAction(
      request("forge.listIssues", { state: "open", labels: ["bug"] }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalledWith(
      PROJECT.id,
      CHANNELS.FORGE_LIST_ISSUES,
      expect.anything()
    );
  });

  it("reports a provider that failed as the call's error", async () => {
    const { deps, invoke } = forgeDeps();
    invoke.mockImplementation(async (_projectId, channel) => {
      if (channel === CHANNELS.FORGE_GET_ISSUE) throw new Error("rate limited");
      return { worktrees: [makeWorktree()], gitBacked: true };
    });

    const result = await executeViewlessAction(request("forge.getIssue", { issueNumber: 3 }), deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("rate limited") },
    });
  });
});
