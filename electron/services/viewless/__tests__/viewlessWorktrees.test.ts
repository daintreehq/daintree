import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { DEV_PREVIEW_METHOD_CHANNELS } from "../../../ipc/handlers/devPreview.preload.js";
import { WORKTREE_BRANCH_KEPT_MARKER } from "../../../../shared/utils/worktreeSummary.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, makeHosts, makeWorktree, PROJECT, request } from "./viewlessTestDeps.js";

const FEATURE = makeWorktree({
  id: "/repo-wt/feature",
  worktreeId: "/repo-wt/feature",
  path: "/repo-wt/feature",
  branch: "feature",
  isMainWorktree: false,
  isCurrent: false,
  setupStatus: { state: "ready" },
} as never);

describe("worktree.list with no frontend", () => {
  it("lists the host's worktrees with the layout's active one marked", async () => {
    const hosts = makeHosts(false);
    const { deps } = makeDeps(
      { getWorkspaceHosts: () => hosts },
      {
        worktrees: [makeWorktree(), FEATURE],
        state: {
          projectId: PROJECT.id,
          sidebarWidth: 350,
          terminals: [],
          activeWorktreeId: FEATURE.id,
        },
      }
    );

    const result = await executeViewlessAction(request("worktree.list", undefined), deps);

    expect(hosts.prewarmProject).toHaveBeenCalledWith(PROJECT.path);
    expect(result).toMatchObject({
      ok: true,
      result: {
        worktrees: [
          { id: "/repo", isMain: true, isActive: false, setupState: "unknown" },
          { id: "/repo-wt/feature", branch: "feature", isActive: true, setupState: "ready" },
        ],
      },
    });
  });

  it("answers with no worktrees when there is no workspace service", async () => {
    const { deps } = makeDeps();

    const result = await executeViewlessAction(request("worktree.list", undefined), deps);

    expect(result).toEqual({ ok: true, result: { worktrees: [] } });
  });
});

describe("worktree.waitUntilReady with no frontend", () => {
  it("reads the host's setup status for a worktree named by path", async () => {
    const { deps } = makeDeps({ getWorkspaceHosts: () => makeHosts() }, { worktrees: [FEATURE] });

    const result = await executeViewlessAction(
      request("worktree.waitUntilReady", { worktreePath: FEATURE.path, timeoutMs: 0 }),
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      result: { worktreeId: FEATURE.path, setupState: "ready", timedOut: false },
    });
  });

  it("fails for a worktree the host does not have", async () => {
    const { deps } = makeDeps({ getWorkspaceHosts: () => makeHosts() }, { worktrees: [] });

    const result = await executeViewlessAction(
      request("worktree.waitUntilReady", { worktreeId: "/repo-wt/gone", timeoutMs: 0 }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
  });
});

describe("worktree.delete with no frontend", () => {
  it("is refused unapproved, since nobody can be asked", async () => {
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts() });

    const result = await executeViewlessAction(
      request("worktree.delete", { worktreeId: FEATURE.id }),
      deps
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: { confirmationChannel: "unavailable" } },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops the worktree's dev preview, then deletes it, once approved", async () => {
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts() });

    const result = await executeViewlessAction(
      request("worktree.delete", { worktreeId: FEATURE.id }, { confirmed: true }),
      deps
    );

    expect(result).toEqual({ ok: true, result: undefined });
    const channels = invoke.mock.calls.map(([, channel]) => channel);
    expect(channels).toEqual([
      DEV_PREVIEW_METHOD_CHANNELS.stopByWorktree,
      CHANNELS.WORKTREE_DELETE,
    ]);
    expect(invoke.mock.calls[1]?.[2]).toEqual([
      { worktreeId: FEATURE.id, force: undefined, deleteBranch: undefined },
    ]);
  });

  it("will not delete a worktree the host cannot place in this project", async () => {
    const hosts = makeHosts();
    hosts.isWorktreeOwnedByProject.mockResolvedValue(false);
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => hosts });

    const result = await executeViewlessAction(
      request("worktree.delete", { worktreeId: "/other/repo-wt" }, { confirmed: true }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses to close terminals it has no view to restore them into", async () => {
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts() });

    const result = await executeViewlessAction(
      request(
        "worktree.delete",
        { worktreeId: FEATURE.id, closeTerminals: true },
        { confirmed: true }
      ),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a kept branch as a finished delete", async () => {
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts() });
    invoke.mockImplementation(async (_projectId, channel) => {
      if (channel === CHANNELS.WORKTREE_DELETE) {
        throw new Error(`Worktree removed. Branch 'feature' ${WORKTREE_BRANCH_KEPT_MARKER}.`);
      }
      return undefined;
    });

    const result = await executeViewlessAction(
      request("worktree.delete", { worktreeId: FEATURE.id }, { confirmed: true }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "PARTIAL_SUCCESS" } });
  });
});
