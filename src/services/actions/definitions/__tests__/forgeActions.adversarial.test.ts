import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const forgeClientMock = vi.hoisted(() => ({
  openIssues: vi.fn(),
  openPRs: vi.fn(),
  openCommits: vi.fn(),
  openIssue: vi.fn(),
  openPR: vi.fn(),
  getIssueUrl: vi.fn(),
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
  approvePR: vi.fn(),
  requestChanges: vi.fn(),
  dismissReview: vi.fn(),
  requestReviewers: vi.fn(),
  validateToken: vi.fn(),
  getRepoStats: vi.fn(),
  listIssues: vi.fn(),
  listPRs: vi.fn(),
  getIssue: vi.fn(),
  getCIStatus: vi.fn(),
  closePR: vi.fn(),
  reopenPR: vi.fn(),
  mergePR: vi.fn(),
  convertPRToDraft: vi.fn(),
  markPRReadyForReview: vi.fn(),
  commentOnPR: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/clients", () => ({ forgeClient: forgeClientMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));

import { registerForgeActions } from "../forgeActions";
import {
  buildCacheKey,
  getCache,
  setCache,
  _resetForTests as resetForgeResourceCache,
} from "@/lib/forgeResourceCache";
import type { Issue } from "@shared/types/forge";

const makeIssue = (n: number, assignees: string[]): Issue => ({
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

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerForgeActions(actions, callbacks);
  return (id: string) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
}

async function runAction(
  id: string,
  args?: unknown,
  ctx?: Record<string, unknown>
): Promise<unknown> {
  const def = setupActions()(id);
  return def.run(args, (ctx ?? {}) as never);
}

function setCurrentProject(project: { path?: string } | null) {
  projectStoreMock.getState.mockReturnValue({ currentProject: project });
}

// Provider results the write actions now project into their published result
// (#11546). Deliberately wider than the schemas — `rawData` and the extra
// normalized fields must not survive into what an MCP client receives.
const providerUser = (login: string) => ({
  login,
  avatarUrl: `https://avatars/${login}`,
  rawData: { login, secret: "raw" },
});

const providerReview = {
  id: "8801",
  state: "approved",
  rawState: "APPROVED",
  body: "LGTM",
  url: "https://forge.test/pull/12#review-8801",
  author: providerUser("octocat"),
  submittedAt: 1_700_000_000_000,
  commitId: "deadbeef",
  rawData: { everything: "raw" },
};

const providerPR = {
  number: 12,
  title: "Add dark mode",
  body: "Body",
  state: "closed",
  rawState: "closed",
  isDraft: false,
  merged: false,
  url: "https://forge.test/pull/12",
  author: providerUser("octocat"),
  baseRef: "main",
  headRef: "feature",
  mergeable: null,
  createdAt: 1,
  updatedAt: 2,
  closedAt: 3,
  mergedAt: null,
  rawData: { everything: "raw" },
};

const providerComment = {
  id: "55501",
  body: "Looks good",
  url: "https://forge.test/pull/12#comment-55501",
  author: providerUser("octocat"),
  createdAt: 1_700_000_000_000,
  rawData: { everything: "raw" },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(forgeClientMock)) fn.mockResolvedValue(undefined);
  forgeClientMock.assignIssue.mockResolvedValue([providerUser("bob")]);
  forgeClientMock.unassignIssue.mockResolvedValue([]);
  forgeClientMock.approvePR.mockResolvedValue(providerReview);
  forgeClientMock.requestChanges.mockResolvedValue({
    ...providerReview,
    state: "changes_requested",
    rawState: "CHANGES_REQUESTED",
  });
  forgeClientMock.dismissReview.mockResolvedValue({
    ...providerReview,
    state: "dismissed",
    rawState: "DISMISSED",
  });
  forgeClientMock.requestReviewers.mockResolvedValue({
    prNumber: 12,
    requestedUsers: ["octocat"],
    requestedTeams: ["core-team"],
  });
  forgeClientMock.closePR.mockResolvedValue(providerPR);
  forgeClientMock.reopenPR.mockResolvedValue({ ...providerPR, state: "open" });
  forgeClientMock.mergePR.mockResolvedValue({
    prNumber: 12,
    sha: "9fceb02",
    merged: true,
    message: "Pull Request successfully merged",
  });
  forgeClientMock.convertPRToDraft.mockResolvedValue({ prNumber: 12, isDraft: true });
  forgeClientMock.markPRReadyForReview.mockResolvedValue({ prNumber: 12, isDraft: false });
  forgeClientMock.commentOnPR.mockResolvedValue(providerComment);
});

describe("forge.getCIStatus", () => {
  const summary = { state: "success" as const, total: 3, passed: 3, failed: 0, pending: 0 };

  it("wraps the client result so a missing PR is {ciStatus:null}, never a bare null", async () => {
    // A bare null result would be dropped by the MCP structured-content path;
    // the wrapper is what keeps "PR not found" expressible to an MCP caller.
    forgeClientMock.getCIStatus.mockResolvedValue(null);

    const result = await runAction(
      "forge.getCIStatus",
      { prNumber: 7 },
      { activeWorktreePath: "/repo" }
    );

    expect(result).toEqual({ ciStatus: null });
  });

  it("wraps a resolved status under the ciStatus key", async () => {
    forgeClientMock.getCIStatus.mockResolvedValue(summary);

    const result = await runAction(
      "forge.getCIStatus",
      { prNumber: 7 },
      { activeWorktreePath: "/repo" }
    );

    expect(result).toEqual({ ciStatus: summary });
  });

  it("falls back to the active worktree path when cwd is omitted", async () => {
    forgeClientMock.getCIStatus.mockResolvedValue(summary);

    await runAction("forge.getCIStatus", { prNumber: 9 }, { activeWorktreePath: "/active" });

    expect(forgeClientMock.getCIStatus).toHaveBeenCalledWith("/active", 9);
  });

  it("prefers an explicit cwd over the active worktree path", async () => {
    forgeClientMock.getCIStatus.mockResolvedValue(summary);

    await runAction(
      "forge.getCIStatus",
      { cwd: "/explicit", prNumber: 9 },
      { activeWorktreePath: "/active" }
    );

    expect(forgeClientMock.getCIStatus).toHaveBeenCalledWith("/explicit", 9);
  });

  it("throws without calling the client when no cwd and no active worktree", async () => {
    await expect(runAction("forge.getCIStatus", { prNumber: 9 }, {})).rejects.toThrow(
      /No active worktree/
    );
    expect(forgeClientMock.getCIStatus).not.toHaveBeenCalled();
  });

  it("rejects a non-positive prNumber through the args schema", async () => {
    const def = setupActions()("forge.getCIStatus");
    expect(def.argsSchema?.safeParse({ prNumber: 0 }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ prNumber: 1.5 }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ prNumber: 12 }).success).toBe(true);
  });
});

describe("forge.* navigation adversarial", () => {
  it("openIssues falls back to current project path when no arg is given", async () => {
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("forge.openIssues");
    await def.run({}, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, undefined);
  });

  it("openIssues throws loudly when neither arg nor current project has a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openIssues");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
    expect(forgeClientMock.openIssues).not.toHaveBeenCalled();
  });

  it("openPRs also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openPRs");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openCommits also throws loudly without a path", async () => {
    setCurrentProject(null);
    const def = setupActions()("forge.openCommits");
    await expect(def.run({}, {} as never)).rejects.toThrow(/No project path/);
  });

  it("openIssues: explicit projectPath takes precedence over current project", async () => {
    setCurrentProject({ path: "/stale" });
    const def = setupActions()("forge.openIssues");
    await def.run({ projectPath: "/explicit", query: "bug", state: "open" }, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/explicit", "bug", "open");
  });

  it("openIssues schema accepts arbitrary state strings (runtime gap vs list schema)", async () => {
    // ForgeListOptionsSchema restricts state to an enum, but openIssues uses
    // z.string().optional() — mismatch. Documenting the gap.
    setCurrentProject({ path: "/repo" });
    const def = setupActions()("forge.openIssues");
    await def.run({ state: "wat" }, {} as never);
    expect(forgeClientMock.openIssues).toHaveBeenCalledWith("/repo", undefined, "wat");
  });

  it("openIssue forwards cwd + issueNumber positionally", async () => {
    const def = setupActions()("forge.openIssue");
    await def.run({ cwd: "/repo", issueNumber: 42 }, {} as never);
    expect(forgeClientMock.openIssue).toHaveBeenCalledWith("/repo", 42);
  });

  it("openIssue falls back to ctx.activeWorktreePath", async () => {
    await runAction("forge.openIssue", { issueNumber: 7 }, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.openIssue).toHaveBeenCalledWith("/repo", 7);
  });

  it("openPR forwards cwd + prNumber positionally", async () => {
    const def = setupActions()("forge.openPR");
    await def.run({ cwd: "/repo", prNumber: 12 }, {} as never);
    expect(forgeClientMock.openPR).toHaveBeenCalledWith("/repo", 12);
  });

  it("openPR falls back to ctx.activeWorktreePath", async () => {
    await runAction("forge.openPR", { prNumber: 3 }, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.openPR).toHaveBeenCalledWith("/repo", 3);
  });

  it("openPR throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(runAction("forge.openPR", { prNumber: 3 })).rejects.toThrow("No active worktree");
    expect(forgeClientMock.openPR).not.toHaveBeenCalled();
  });

  it("validateToken forwards providerId + token positionally (including whitespace)", async () => {
    const def = setupActions()("forge.validateToken");
    await def.run({ providerId: "daintree.github.github", token: "  ghp_123  " }, {} as never);
    expect(forgeClientMock.validateToken).toHaveBeenCalledWith(
      "daintree.github.github",
      "  ghp_123  "
    );
  });

  it("assignIssue forwards cwd, issueNumber, and username positionally", async () => {
    const def = setupActions()("forge.assignIssue");
    await def.run({ cwd: "/repo", issueNumber: 42, username: "bob" }, {} as never);
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 42, "bob");
  });

  it("assignIssue falls back to ctx.activeWorktreePath when cwd omitted", async () => {
    await runAction(
      "forge.assignIssue",
      { issueNumber: 7, username: "alice" },
      { activeWorktreePath: "/repo" }
    );
    expect(forgeClientMock.assignIssue).toHaveBeenCalledWith("/repo", 7, "alice");
  });

  it("assignIssue throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(
      runAction("forge.assignIssue", { issueNumber: 7, username: "bob" })
    ).rejects.toThrow("No active worktree");
  });

  describe("issue-cache patching from the authoritative assignee list (#11087, #11546)", () => {
    const seedIssueSlot = (projectPath: string, issue: Issue): string => {
      const key = buildCacheKey(projectPath, "issue", "open", "created");
      setCache(key, { items: [issue], nextCursor: null, hasMore: false, timestamp: 1 });
      return key;
    };

    const assigneesOn = (key: string, issueNumber: number): string[] | undefined => {
      const item = getCache(key)?.items.find((i) => i.number === issueNumber);
      return item && "assignees" in item ? item.assignees.map((a) => a.login) : undefined;
    };

    beforeEach(() => {
      resetForgeResourceCache();
    });

    it("assignIssue adds the username to the cached issue so the dropdown reflects it at once", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, []));

      await runAction("forge.assignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" });

      expect(assigneesOn(key, 42)).toEqual(["bob"]);
    });

    it("unassignIssue removes the username — the Quick Create Undo path", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, ["bob"]));
      forgeClientMock.unassignIssue.mockResolvedValueOnce([]);

      await runAction("forge.unassignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" });

      expect(assigneesOn(key, 42)).toEqual([]);
    });

    it("does NOT add an assignee the forge silently dropped", async () => {
      // GitHub ignores assignees without push access: the call succeeds but the
      // user is absent from the resulting list. Trusting the request instead of
      // the response would show an assignment that never landed.
      const key = seedIssueSlot("/repo", makeIssue(42, []));
      forgeClientMock.assignIssue.mockResolvedValueOnce([]);

      await runAction("forge.assignIssue", { cwd: "/repo", issueNumber: 42, username: "no-access" });

      expect(assigneesOn(key, 42)).toEqual([]);
    });

    it("keeps an assignee the forge reports as still present after a refused unassign", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, ["bob"]));
      forgeClientMock.unassignIssue.mockResolvedValueOnce([providerUser("bob")]);

      await runAction("forge.unassignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" });

      expect(assigneesOn(key, 42)).toEqual(["bob"]);
    });

    it("caches the login spelling and avatar the forge returned, not the requested casing", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, []));
      forgeClientMock.assignIssue.mockResolvedValueOnce([providerUser("Octocat")]);

      await runAction("forge.assignIssue", { cwd: "/repo", issueNumber: 42, username: "octocat" });

      expect(assigneesOn(key, 42)).toEqual(["Octocat"]);
      const item = getCache(key)?.items.find((i) => i.number === 42);
      const assignees = item && "assignees" in item ? item.assignees : [];
      expect(assignees[0]?.avatarUrl).toBe("https://avatars/Octocat");
    });

    it("leaves the cache untouched when the forge rejects the assign", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, []));
      forgeClientMock.assignIssue.mockRejectedValueOnce(new Error("HTTP 403"));

      await expect(
        runAction("forge.assignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" })
      ).rejects.toThrow("HTTP 403");

      expect(assigneesOn(key, 42)).toEqual([]);
    });

    it("leaves the cache untouched when the forge rejects the unassign", async () => {
      const key = seedIssueSlot("/repo", makeIssue(42, ["bob"]));
      forgeClientMock.unassignIssue.mockRejectedValueOnce(new Error("HTTP 500"));

      await expect(
        runAction("forge.unassignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" })
      ).rejects.toThrow("HTTP 500");

      expect(assigneesOn(key, 42)).toEqual(["bob"]);
    });

    it("patches the project the caller named, not some other cached project", async () => {
      const target = seedIssueSlot("/repo", makeIssue(42, []));
      const other = seedIssueSlot("/other-repo", makeIssue(42, []));

      await runAction("forge.assignIssue", { cwd: "/repo", issueNumber: 42, username: "bob" });

      expect(assigneesOn(target, 42)).toEqual(["bob"]);
      expect(assigneesOn(other, 42)).toEqual([]);
    });

    it("patches the project root when cwd defaults to a linked worktree path", async () => {
      // The forge call targets the worktree, but the cache keys on the project
      // root — patching the worktree path would silently match no slot.
      setCurrentProject({ path: "/repo" });
      const key = seedIssueSlot("/repo", makeIssue(42, []));

      await runAction(
        "forge.assignIssue",
        { issueNumber: 42, username: "bob" },
        { activeWorktreePath: "/repo/.worktrees/feature" }
      );

      expect(forgeClientMock.assignIssue).toHaveBeenCalledWith(
        "/repo/.worktrees/feature",
        42,
        "bob"
      );
      expect(assigneesOn(key, 42)).toEqual(["bob"]);
    });

    it("completes the mutation even when no project is open to patch", async () => {
      setCurrentProject(null);

      await expect(
        runAction(
          "forge.assignIssue",
          { issueNumber: 42, username: "bob" },
          { activeWorktreePath: "/repo/.worktrees/feature" }
        )
      ).resolves.not.toThrow();

      expect(forgeClientMock.assignIssue).toHaveBeenCalled();
    });
  });

  it("approvePR forwards cwd, prNumber, and optional body positionally", async () => {
    const def = setupActions()("forge.approvePR");
    await def.run({ cwd: "/repo", prNumber: 12, body: "LGTM" }, {} as never);
    expect(forgeClientMock.approvePR).toHaveBeenCalledWith("/repo", 12, "LGTM");
  });

  it("approvePR falls back to ctx.activeWorktreePath and passes undefined body", async () => {
    await runAction("forge.approvePR", { prNumber: 3 }, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.approvePR).toHaveBeenCalledWith("/repo", 3, undefined);
  });

  it("approvePR throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(runAction("forge.approvePR", { prNumber: 3 })).rejects.toThrow(
      "No active worktree"
    );
    expect(forgeClientMock.approvePR).not.toHaveBeenCalled();
  });

  it("requestChanges forwards cwd, prNumber, and body positionally", async () => {
    const def = setupActions()("forge.requestChanges");
    await def.run({ cwd: "/repo", prNumber: 4, body: "fix types" }, {} as never);
    expect(forgeClientMock.requestChanges).toHaveBeenCalledWith("/repo", 4, "fix types");
  });

  it("requestChanges schema rejects a whitespace-only body (matches the IPC guard)", () => {
    const def = setupActions()("forge.requestChanges");
    expect(def.argsSchema?.safeParse({ prNumber: 4, body: "   " }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ prNumber: 4, body: "real" }).success).toBe(true);
  });

  it("dismissReview schema rejects a whitespace-only message", () => {
    const def = setupActions()("forge.dismissReview");
    expect(def.argsSchema?.safeParse({ prNumber: 5, reviewId: 9, message: "  " }).success).toBe(
      false
    );
  });

  it("requestReviewers schema rejects when neither users nor teams is supplied", () => {
    const def = setupActions()("forge.requestReviewers");
    expect(def.argsSchema?.safeParse({ prNumber: 6 }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ prNumber: 6, users: [], teams: [] }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ prNumber: 6, users: ["a"] }).success).toBe(true);
  });

  it("dismissReview forwards cwd, prNumber, reviewId, and message positionally", async () => {
    const def = setupActions()("forge.dismissReview");
    await def.run({ cwd: "/repo", prNumber: 5, reviewId: 99, message: "stale" }, {} as never);
    expect(forgeClientMock.dismissReview).toHaveBeenCalledWith("/repo", 5, 99, "stale");
  });

  it("requestReviewers forwards cwd, prNumber, and the users/teams object", async () => {
    const def = setupActions()("forge.requestReviewers");
    await def.run({ cwd: "/repo", prNumber: 6, users: ["octocat"], teams: ["core"] }, {} as never);
    expect(forgeClientMock.requestReviewers).toHaveBeenCalledWith("/repo", 6, {
      users: ["octocat"],
      teams: ["core"],
    });
  });

  it("requestReviewers falls back to ctx.activeWorktreePath", async () => {
    await runAction(
      "forge.requestReviewers",
      { prNumber: 6, users: ["octocat"] },
      { activeWorktreePath: "/repo" }
    );
    expect(forgeClientMock.requestReviewers).toHaveBeenCalledWith("/repo", 6, {
      users: ["octocat"],
      teams: undefined,
    });
  });
});

describe("forge.* write actions return the state they changed (#11546)", () => {
  const run = (id: string, args: Record<string, unknown>) =>
    runAction(id, { cwd: "/repo", ...args });

  it("mergePR returns the merge acknowledgement", async () => {
    const result = await run("forge.mergePR", { prNumber: 12 });

    expect(result).toEqual({
      prNumber: 12,
      sha: "9fceb02",
      merged: true,
      message: "Pull Request successfully merged",
    });
  });

  it("assignIssue reports the resulting assignee list alongside the issue", async () => {
    const result = await run("forge.assignIssue", { issueNumber: 42, username: "bob" });

    expect(result).toEqual({ issueNumber: 42, assignees: [{ login: "bob", avatarUrl: "https://avatars/bob" }] });
  });

  it("unassignIssue reports the emptied assignee list", async () => {
    const result = await run("forge.unassignIssue", { issueNumber: 42, username: "bob" });

    expect(result).toEqual({ issueNumber: 42, assignees: [] });
  });

  it.each([
    ["forge.approvePR", { prNumber: 12 }, "approved"],
    ["forge.requestChanges", { prNumber: 12, body: "fix" }, "changes_requested"],
    ["forge.dismissReview", { prNumber: 12, reviewId: 5, message: "stale" }, "dismissed"],
  ])("%s returns the review carrying its verdict", async (id, args, state) => {
    const result = (await run(id, args)) as { state: string; id: string };

    expect(result.state).toBe(state);
    expect(result.id).toBe("8801");
  });

  it("requestReviewers returns the PR's resulting reviewer requests", async () => {
    const result = await run("forge.requestReviewers", { prNumber: 12, users: ["octocat"] });

    expect(result).toEqual({
      prNumber: 12,
      requestedUsers: ["octocat"],
      requestedTeams: ["core-team"],
    });
  });

  it.each([
    ["forge.convertPRToDraft", true],
    ["forge.markPRReadyForReview", false],
  ])("%s returns the resulting draft state", async (id, isDraft) => {
    expect(await run(id, { prNumber: 12 })).toEqual({ prNumber: 12, isDraft });
  });

  it("closePR and reopenPR return the updated PR", async () => {
    const closed = (await run("forge.closePR", { prNumber: 12 })) as { state: string };
    const reopened = (await run("forge.reopenPR", { prNumber: 12 })) as { state: string };

    expect(closed.state).toBe("closed");
    expect(reopened.state).toBe("open");
  });

  it("commentOnPR returns the created comment", async () => {
    const result = (await run("forge.commentOnPR", { prNumber: 12, body: "Looks good" })) as {
      id: string;
      url: string;
    };

    expect(result.id).toBe("55501");
    expect(result.url).toBe(providerComment.url);
  });

  // Nothing downstream strips a run() return before it reaches MCP
  // structuredContent (buildStructuredContent casts without parsing), so the
  // projection has to happen here or the provider's raw payload ships verbatim.
  it.each([
    ["forge.approvePR", { prNumber: 12 }],
    ["forge.requestChanges", { prNumber: 12, body: "fix" }],
    ["forge.dismissReview", { prNumber: 12, reviewId: 5, message: "stale" }],
    ["forge.closePR", { prNumber: 12 }],
    ["forge.reopenPR", { prNumber: 12 }],
    ["forge.commentOnPR", { prNumber: 12, body: "hi" }],
    ["forge.assignIssue", { issueNumber: 42, username: "bob" }],
    ["forge.unassignIssue", { issueNumber: 42, username: "bob" }],
  ])("%s publishes no rawData, at any depth", async (id, args) => {
    const result = await run(id, args);

    expect(JSON.stringify(result)).not.toContain("rawData");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("drops the provider's extra PR fields that the published schema doesn't name", async () => {
    const result = (await run("forge.closePR", { prNumber: 12 })) as Record<string, unknown>;

    // `mergeable`/`closedAt`/`author` are on the normalized PR but outside the
    // declared result contract — leaking them would make the schema a lie.
    expect(Object.keys(result)).not.toContain("mergeable");
    expect(Object.keys(result)).not.toContain("closedAt");
    expect(Object.keys(result)).not.toContain("author");
  });

  it("still returns the result when the renderer cache patch throws", async () => {
    // The forge mutation already succeeded — a cache-layer failure must not
    // turn a completed assignment into a failed action.
    setCurrentProject(null);

    const result = await runAction(
      "forge.assignIssue",
      { issueNumber: 42, username: "bob" },
      { activeWorktreePath: "/repo/.worktrees/feature" }
    );

    expect(result).toEqual({
      issueNumber: 42,
      assignees: [{ login: "bob", avatarUrl: "https://avatars/bob" }],
    });
  });
});

describe("forge.* query adversarial", () => {
  it("listIssues forwards cwd positionally and the filters as options", async () => {
    forgeClientMock.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    const def = setupActions()("forge.listIssues");
    await def.run({ cwd: "/repo", search: "q", state: "open", cursor: "c1" }, {} as never);
    expect(forgeClientMock.listIssues).toHaveBeenCalledWith("/repo", {
      search: "q",
      state: "open",
      cursor: "c1",
    });
  });

  it("listIssues falls back to ctx.activeWorktreePath when cwd omitted", async () => {
    forgeClientMock.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    await runAction("forge.listIssues", {}, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.listIssues).toHaveBeenCalledWith("/repo", expect.any(Object));
  });

  it("listIssues throws when no cwd and no ctx.activeWorktreePath", async () => {
    await expect(runAction("forge.listIssues", {})).rejects.toThrow("No active worktree");
  });

  it("listIssues prefers explicit cwd over ctx", async () => {
    forgeClientMock.listIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    await runAction("forge.listIssues", { cwd: "/explicit" }, { activeWorktreePath: "/ctx" });
    expect(forgeClientMock.listIssues).toHaveBeenCalledWith("/explicit", expect.any(Object));
  });

  it("listPRs preserves all filter fields when falling back to ctx", async () => {
    forgeClientMock.listPRs.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
    await runAction(
      "forge.listPRs",
      { search: "q", state: "all", cursor: "c1" },
      { activeWorktreePath: "/repo" }
    );
    expect(forgeClientMock.listPRs).toHaveBeenCalledWith("/repo", {
      search: "q",
      state: "all",
      cursor: "c1",
    });
  });

  it("getRepoStats forwards cwd + bypassCache", async () => {
    const def = setupActions()("forge.getRepoStats");
    await def.run({ cwd: "/repo", bypassCache: true }, {} as never);
    expect(forgeClientMock.getRepoStats).toHaveBeenCalledWith("/repo", true);
  });

  it("getRepoStats falls back to ctx.activeWorktreePath", async () => {
    await runAction("forge.getRepoStats", {}, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.getRepoStats).toHaveBeenCalledWith("/repo", undefined);
  });

  it("getIssue forwards cwd + issueNumber and returns null when issue is missing", async () => {
    forgeClientMock.getIssue.mockResolvedValue(null);
    const def = setupActions()("forge.getIssue");
    const result = await def.run({ cwd: "/repo", issueNumber: 42 }, {} as never);
    expect(forgeClientMock.getIssue).toHaveBeenCalledWith("/repo", 42);
    expect(result).toBeNull();
  });

  it("getIssue falls back to ctx.activeWorktreePath", async () => {
    forgeClientMock.getIssue.mockResolvedValue(null);
    await runAction("forge.getIssue", { issueNumber: 5 }, { activeWorktreePath: "/repo" });
    expect(forgeClientMock.getIssue).toHaveBeenCalledWith("/repo", 5);
  });
});

describe("githubClient import boundary", () => {
  const rootDir = path.resolve(import.meta.dirname, "../../../../..");

  function collectSrcFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        files.push(...collectSrcFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
        files.push(full);
      }
    }
    return files;
  }

  const importPattern =
    /import\s+(?:type\s+)?\{[^}]*\bgithubClient\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/;

  function extractImportPath(importSource: string): string | null {
    if (importSource === "@/clients" || importSource === "@/clients/githubClient") {
      return importSource;
    }
    return null;
  }

  // The legacy GitHub client is retired from host code — every host consumer
  // now routes through forgeClient. Only the GitHub plugin's renderer may
  // still import it (plugin-internal usage of its own provider's surface).
  it("no production file under src/ imports githubClient", () => {
    const srcDir = path.join(rootDir, "src");
    const allFiles = collectSrcFiles(srcDir);
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, "/");
      if (relPath.startsWith("src/clients/")) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(importPattern);
        const importSource = m?.[1];
        if (importSource && extractImportPath(importSource)) {
          violations.push(`${relPath}: imports githubClient from "${importSource}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
