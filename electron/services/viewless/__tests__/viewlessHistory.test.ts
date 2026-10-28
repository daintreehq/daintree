import { describe, expect, it } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { makeDeps, makeHosts, makeWorktree, PROJECT, request } from "./viewlessTestDeps.js";

const RECORD = {
  sessionId: "sess-1",
  agentId: "claude",
  worktreeId: "/repo",
  title: "Fix the thing",
  projectId: PROJECT.id,
  savedAt: 100,
  bookmark: {
    bookmarkedAt: 5,
    label: "keep",
    sourcePanelId: "panel-1",
    titleMode: "custom",
  },
};

const PULSE = {
  worktreeId: "/repo",
  worktreePath: "/repo",
  branch: "main",
  mainBranch: "main",
  rangeDays: 60,
  generatedAt: 1,
  heatmap: [{ date: "2026-01-01", count: 2, level: 1, extra: "dropped" }],
  commitsInRange: 2,
  activeDays: 1,
  projectAgeDays: 10,
  recentCommits: [{ sha: "abc", subject: "feat", timestamp: 1, body: "dropped" }],
};

function historyDeps(answers: Record<string, unknown>) {
  const made = makeDeps({ getWorkspaceHosts: () => makeHosts() });
  const fallback = made.invoke.getMockImplementation()!;
  made.invoke.mockImplementation(async (projectId, channel, args) =>
    Object.hasOwn(answers, channel) ? answers[channel] : fallback(projectId, channel, args)
  );
  return made;
}

describe("session history with no frontend (#14549)", () => {
  it("lists the project's journal in the agent-facing shape", async () => {
    const { deps, invoke } = historyDeps({ [CHANNELS.AGENT_SESSION_LIST]: [RECORD] });

    const result = await executeViewlessAction(request("agentSessionHistory.list", {}), deps);

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.AGENT_SESSION_LIST, [
      { projectId: PROJECT.id },
    ]);
    expect(result).toEqual({
      ok: true,
      result: {
        sessions: [{ ...RECORD, bookmark: { bookmarkedAt: 5, label: "keep" } }],
        total: 1,
        hasMore: false,
      },
    });
  });

  it("pages the journal and narrows to a named worktree", async () => {
    const records = [1, 2, 3].map((n) => ({ ...RECORD, sessionId: `s${n}` }));
    const { deps, invoke } = historyDeps({ [CHANNELS.AGENT_SESSION_LIST]: records });

    const result = await executeViewlessAction(
      request("agentSessionHistory.list", { worktreeId: "/repo", limit: 1, offset: 1 }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.AGENT_SESSION_LIST, [
      { worktreeId: "/repo", projectId: PROJECT.id },
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: { sessions: [{ sessionId: "s2" }], total: 3, hasMore: true },
    });
  });

  it("refuses another project's history", async () => {
    const { deps, invoke } = historyDeps({ [CHANNELS.AGENT_SESSION_LIST]: [RECORD] });

    const result = await executeViewlessAction(
      request("agentSessionHistory.list", { projectId: "other" }),
      deps
    );

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalledWith(
      expect.anything(),
      CHANNELS.AGENT_SESSION_LIST,
      expect.anything()
    );
  });
});

describe("project pulse with no frontend (#14549)", () => {
  const feature = makeWorktree({
    id: "/repo-wt/feature",
    worktreeId: "/repo-wt/feature",
    path: "/repo-wt/feature",
    name: "feature",
    branch: "feature",
    isMainWorktree: false,
  });

  function pulseDeps() {
    const made = makeDeps(
      { getWorkspaceHosts: () => makeHosts() },
      { worktrees: [makeWorktree(), feature], state: { activeWorktreeId: "/repo" } as never }
    );
    const fallback = made.invoke.getMockImplementation()!;
    made.invoke.mockImplementation(async (projectId, channel, args) =>
      channel === CHANNELS.GIT_GET_PROJECT_PULSE ? PULSE : fallback(projectId, channel, args)
    );
    return made;
  }

  it("reads the saved active worktree's pulse, projected as a view projects it", async () => {
    const { deps, invoke } = pulseDeps();

    const result = await executeViewlessAction(request("git.getProjectPulse", {}), deps);

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.GIT_GET_PROJECT_PULSE, [
      { worktreeId: "/repo", rangeDays: 60 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        commitsInRange: 2,
        heatmap: [{ date: "2026-01-01", count: 2, level: 1 }],
        recentCommits: [{ sha: "abc", subject: "feat", timestamp: 1 }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("dropped");
  });

  it("resolves a worktree by path and forwards the options", async () => {
    const { deps, invoke } = pulseDeps();

    await executeViewlessAction(
      request("git.getProjectPulse", {
        worktreePath: "/repo-wt/feature",
        rangeDays: 120,
        includeDelta: true,
      }),
      deps
    );

    expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.GIT_GET_PROJECT_PULSE, [
      { worktreeId: "/repo-wt/feature", rangeDays: 120, includeDelta: true },
    ]);
  });

  it("refuses a worktree the project does not own", async () => {
    const { deps, invoke } = pulseDeps();

    const byId = await executeViewlessAction(
      request("git.getProjectPulse", { worktreeId: "/elsewhere" }),
      deps
    );
    const byPath = await executeViewlessAction(
      request("git.getProjectPulse", { worktreePath: "/elsewhere" }),
      deps
    );

    expect(byId).toMatchObject({ ok: false });
    expect(byPath).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(invoke).not.toHaveBeenCalledWith(
      expect.anything(),
      CHANNELS.GIT_GET_PROJECT_PULSE,
      expect.anything()
    );
  });
});
