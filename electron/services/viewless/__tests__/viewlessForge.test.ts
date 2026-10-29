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
    expect(await read("/repo/..cache/src")).toMatchObject({ ok: true });
    for (const outside of ["/repo/../etc", "/repo-other", "relative/path"]) {
      expect(await read(outside)).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
    const cwds = invoke.mock.calls
      .filter(([, channel]) => channel === CHANNELS.FORGE_GET_PR)
      .map(([, , args]) => (args[0] as { cwd: string }).cwd);
    expect(cwds).toEqual([
      "/repo/packages/app",
      "/repo/",
      "/repo-wt/feature/src",
      "/repo/..cache/src",
    ]);
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

describe("triage reads with no frontend (#15399)", () => {
  it("pages an issue's thread with the cursor it was given, dropping the provider's raw node", async () => {
    const { deps, invoke } = forgeDeps({
      [CHANNELS.FORGE_LIST_ISSUE_COMMENTS]: {
        items: [
          {
            id: "c2",
            body: "Second",
            url: "https://example.test/issue/3#c2",
            createdAt: 2,
            author: { login: "octo", rawData: { secret: "the provider's whole node" } },
          },
        ],
        nextCursor: "c3",
        hasMore: true,
        totalCount: 5,
      },
    });

    const result = await executeViewlessAction(
      request("forge.listIssueComments", { issueNumber: 3, cursor: "c1", perPage: 50 }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_LIST_ISSUE_COMMENTS, [
      { cwd: "/repo", issueNumber: 3, opts: { cursor: "c1", perPage: 50 } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        items: [{ id: "c2", author: { login: "octo" } }],
        nextCursor: "c3",
        hasMore: true,
        totalCount: 5,
      },
    });
    expect(JSON.stringify(result)).not.toContain("the provider's whole node");
  });

  it("keeps a failed lookup apart from a missing pull request in a batch", async () => {
    const { deps, invoke } = forgeDeps({
      [CHANNELS.FORGE_GET_PRS_BY_NUMBERS]: [
        { number: 7, status: "found", pr: PR },
        { number: 8, status: "not_found" },
        { number: 9, status: "unresolved", reason: "provider_error" },
      ],
    });

    const result = await executeViewlessAction(
      request("forge.getPRs", { prNumbers: [7, 8, 9] }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_GET_PRS_BY_NUMBERS, [
      { cwd: "/repo", numbers: [7, 8, 9] },
    ]);
    expect(result).toEqual({
      ok: true,
      result: {
        results: [
          { number: 7, status: "found", pr: expect.objectContaining({ number: 7 }) },
          { number: 8, status: "not_found" },
          { number: 9, status: "unresolved", reason: "provider_error" },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("the provider's whole node");
  });

  it("refuses a batch of one number or of repeats, as the renderer action does", async () => {
    const { deps, invoke } = forgeDeps();

    for (const prNumbers of [[7], [7, 7]]) {
      const result = await executeViewlessAction(request("forge.getPRs", { prNumbers }), deps);
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(invoke).not.toHaveBeenCalledWith(
      PROJECT.id,
      CHANNELS.FORGE_GET_PRS_BY_NUMBERS,
      expect.anything()
    );
  });

  it("tells a PR with no checks from no such PR", async () => {
    const { deps, invoke } = forgeDeps({
      [CHANNELS.FORGE_GET_CHECKS]: {
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://ci/1",
            rawData: { secret: "the provider's whole node" },
          },
          { name: "test", status: "in_progress" },
        ],
      },
    });

    const listed = await executeViewlessAction(request("forge.getChecks", { prNumber: 7 }), deps);
    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.FORGE_GET_CHECKS, [
      { cwd: "/repo", prNumber: 7 },
    ]);
    expect(listed).toEqual({
      ok: true,
      result: {
        checks: [
          { name: "lint", status: "completed", conclusion: "failure", detailsUrl: "https://ci/1" },
          { name: "test", status: "in_progress" },
        ],
      },
    });

    const empty = forgeDeps({ [CHANNELS.FORGE_GET_CHECKS]: { checks: [] } });
    expect(
      await executeViewlessAction(request("forge.getChecks", { prNumber: 7 }), empty.deps)
    ).toEqual({ ok: true, result: { checks: [] } });
  });

  it("answers a missing PR's checks as null and a provider that can't read them as an error", async () => {
    const { deps, invoke } = forgeDeps({ [CHANNELS.FORGE_GET_CHECKS]: null });

    expect(await executeViewlessAction(request("forge.getChecks", { prNumber: 9 }), deps)).toEqual({
      ok: true,
      result: { checks: null },
    });

    invoke.mockImplementation(async (_projectId, channel) => {
      if (channel === CHANNELS.FORGE_GET_CHECKS) {
        throw new Error("The active forge provider does not support reading individual CI checks");
      }
      return { worktrees: [makeWorktree()], gitBacked: true };
    });
    expect(
      await executeViewlessAction(request("forge.getChecks", { prNumber: 9 }), deps)
    ).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("does not support") },
    });
  });
});
