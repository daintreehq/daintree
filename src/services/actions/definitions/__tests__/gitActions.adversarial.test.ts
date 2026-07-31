import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerGitActions } from "../gitActions";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { utf8ByteLength } from "@shared/utils/boundedOutput";
import {
  GIT_COMMIT_BODY_MAX_BYTES,
  GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
  GIT_FILE_DIFF_MAX_BYTES,
  GIT_LIST_COMMITS_LIMIT_MAX,
  GIT_SUBJECT_MAX_BYTES,
  PULSE_RECENT_COMMITS_MAX,
} from "@shared/config/gitReadLimits";

/**
 * `git.push` now awaits a deferred-Promise confirm gate (#8242). In a unit
 * context there is no mounted `GitPushConfirmDialog`, so resolve the pending
 * request explicitly once `run()` has registered it.
 */
async function resolvePushConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPushConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPushConfirmStore.getState().resolveConfirmation(ok);
}

/** Same deferred-Promise gate, for `git.pullRebase` (#8242). */
async function resolvePullRebaseConfirm(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useGitPullRebaseConfirmStore.getState().resolveConfirmation(ok);
}

type GitStub = {
  [
    K in
      | "stageAll"
      | "unstageAll"
      | "stageFile"
      | "unstageFile"
      | "commit"
      | "push"
      | "pullRebase"
      | "getFileDiff"
      | "listCommits"
      | "getStagingStatus"
      | "getProjectPulse"
  ]: ReturnType<typeof vi.fn>;
};

function makeGitStub(): GitStub {
  return {
    stageAll: vi.fn().mockResolvedValue(undefined),
    unstageAll: vi.fn().mockResolvedValue(undefined),
    stageFile: vi.fn().mockResolvedValue(undefined),
    unstageFile: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: "abc" }),
    push: vi.fn().mockResolvedValue({ ok: true }),
    pullRebase: vi.fn().mockResolvedValue(undefined),
    getFileDiff: vi.fn().mockResolvedValue({
      content: "diff",
      offset: 0,
      totalBytes: 4,
      truncated: false,
      nextOffset: null,
    }),
    listCommits: vi.fn().mockResolvedValue({ items: [], hasMore: false, total: 0 }),
    getStagingStatus: vi.fn().mockResolvedValue({}),
    getProjectPulse: vi.fn().mockResolvedValue({}),
  };
}

function makeCommit(index: number, overrides: Record<string, unknown> = {}) {
  return {
    hash: `hash-${index}`,
    shortHash: `h${index}`,
    message: `subject ${index}`,
    body: `body ${index}`,
    author: { name: "Ada", email: "ada@example.com" },
    date: "2026-01-01",
    ...overrides,
  };
}

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
  git: GitStub;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerGitActions(actions, callbacks);
  const git = makeGitStub();
  return {
    git,
    run: async (id, args, ctx) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      Object.defineProperty(globalThis, "window", {
        value: { electron: { git } },
        configurable: true,
        writable: true,
      });
      return def.run(args, (ctx ?? {}) as never);
    },
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  // Both stores are module singletons. A test that fails mid-gate would
  // otherwise leave a pending request behind and contaminate the next one.
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(false);
  }
  if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
  }
});

describe("gitActions adversarial", () => {
  it("git.stageAll uses ctx.activeWorktreePath when no cwd arg is provided", async () => {
    const { run, git } = setupActions();
    await run("git.stageAll", undefined, { activeWorktreePath: "/repo" });
    expect(git.stageAll).toHaveBeenCalledWith("/repo");
  });

  it("git.stageAll rejects cleanly when neither arg nor context has a cwd", async () => {
    const { run, git } = setupActions();
    await expect(run("git.stageAll")).rejects.toThrow("No active worktree");
    expect(git.stageAll).not.toHaveBeenCalled();
  });

  it("git.commit rejects whitespace-only messages rather than forwarding them to git", async () => {
    const { run, git } = setupActions();

    await expect(run("git.commit", { cwd: "/repo", message: "   " })).rejects.toThrow(
      /Commit message/
    );

    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.commit rejects newline-only messages", async () => {
    const { run, git } = setupActions();
    await expect(run("git.commit", { cwd: "/repo", message: "\n\n\t" })).rejects.toThrow(
      /Commit message/
    );
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.commit falls back to ctx.activeWorktreePath when cwd is not supplied", async () => {
    const { run, git } = setupActions();
    await run("git.commit", { message: "feat: x" }, { activeWorktreePath: "/repo" });
    expect(git.commit).toHaveBeenCalledWith("/repo", "feat: x");
  });

  it("git.push preserves explicit setUpstream:false (doesn't convert it to undefined)", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo", setUpstream: false });
    await resolvePushConfirm(true);
    await p;
    expect(git.push).toHaveBeenCalledWith("/repo", false);
  });

  it("git.push preserves explicit setUpstream:true", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo", setUpstream: true });
    await resolvePushConfirm(true);
    await p;
    expect(git.push).toHaveBeenCalledWith("/repo", true);
  });

  it("git.push does not reach IPC when the confirm gate is declined", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" });
    await resolvePushConfirm(false);
    await p;
    expect(git.push).not.toHaveBeenCalled();
  });

  it("git.pullRebase fires IPC only after the confirm gate is accepted", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" });
    expect(git.pullRebase).not.toHaveBeenCalled();
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.pullRebase does not reach IPC when the confirm gate is declined", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" });
    await resolvePullRebaseConfirm(false);
    await p;
    expect(git.pullRebase).not.toHaveBeenCalled();
  });

  // #11538: an agent dispatch reaching run() already cleared ActionService's
  // host-attested confirm gate against the MCP bridge's own modal. The deferred
  // store here resolves only from a renderer dialog, which a headless MCP client
  // can never click — so awaiting it again hangs the push forever.
  it("git.push skips the renderer confirm store entirely for agent dispatch", async () => {
    const { run, git } = setupActions();
    await run("git.push", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(git.push).toHaveBeenCalledWith("/repo", undefined);
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("git.pullRebase skips the renderer confirm store entirely for agent dispatch", async () => {
    const { run, git } = setupActions();
    await run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("git.push carries setUpstream through the agent bypass unchanged", async () => {
    const { run, git } = setupActions();
    await run("git.push", { cwd: "/repo", setUpstream: false }, { dispatchSource: "agent" });
    expect(git.push).toHaveBeenCalledWith("/repo", false);
  });

  // The bypass is keyed to "agent" alone — no other source has been through the
  // MCP confirm, so widening this to any non-foreground source would let plugin
  // dispatch push with no confirmation at all.
  it("git.push still gates plugin dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" }, { dispatchSource: "plugin" });
    await resolvePushConfirm(false);
    await p;
    expect(git.push).not.toHaveBeenCalled();
  });

  it("git.pullRebase still gates user dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "user" });
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.pullRebase still gates plugin dispatch on the confirm store", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "plugin" });
    await resolvePullRebaseConfirm(false);
    await p;
    expect(git.pullRebase).not.toHaveBeenCalled();
  });

  // A reverted bypass would otherwise only surface as a suite timeout. Assert
  // the store stays empty synchronously, before awaiting, so the failure is
  // immediate and legible.
  it("git.push registers no pending confirm at all for agent dispatch", async () => {
    const { run, git } = setupActions();
    const p = run("git.push", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(useGitPushConfirmStore.getState().pendingConfirm).toBeNull();
    await p;
    expect(git.push).toHaveBeenCalled();
  });

  it("git.pullRebase registers no pending confirm at all for agent dispatch", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", { cwd: "/repo" }, { dispatchSource: "agent" });
    expect(useGitPullRebaseConfirmStore.getState().pendingConfirm).toBeNull();
    await p;
    expect(git.pullRebase).toHaveBeenCalled();
  });

  it("git.pullRebase falls back to ctx.activeWorktreePath when no cwd arg is given", async () => {
    const { run, git } = setupActions();
    const p = run("git.pullRebase", undefined, { activeWorktreePath: "/repo" });
    await resolvePullRebaseConfirm(true);
    await p;
    expect(git.pullRebase).toHaveBeenCalledWith("/repo");
  });

  it("git.getFileDiff forwards cwd, filePath, and status positionally without mutation", async () => {
    const { run, git } = setupActions();
    await run("git.getFileDiff", {
      cwd: "/repo",
      filePath: "src/file with spaces.ts",
      status: "renamed",
    });
    expect(git.getFileDiff).toHaveBeenCalledWith(
      "/repo",
      "src/file with spaces.ts",
      "renamed",
      undefined,
      { offset: 0, maxBytes: GIT_FILE_DIFF_DEFAULT_MAX_BYTES }
    );
  });

  it("git.stageFile rejects when filePath is empty — schema guard", async () => {
    const { run, git } = setupActions();
    // Schema allows empty string; this documents current behavior.
    // If it becomes a validation gate, this assertion should flip.
    await run("git.stageFile", { cwd: "/repo", filePath: "" });
    expect(git.stageFile).toHaveBeenCalledWith("/repo", "");
  });

  it("git.commit rejects missing message (undefined) before touching git", async () => {
    const { run, git } = setupActions();
    await expect(run("git.commit", { cwd: "/repo" })).rejects.toThrow(/Commit message is required/);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("git.getStagingStatus falls back to ctx.activeWorktreePath when no args", async () => {
    const { run, git } = setupActions();
    await run("git.getStagingStatus", undefined, { activeWorktreePath: "/repo" });
    expect(git.getStagingStatus).toHaveBeenCalledWith("/repo");
  });

  it("git.getStagingStatus prefers explicit cwd over ctx", async () => {
    const { run, git } = setupActions();
    await run("git.getStagingStatus", { cwd: "/explicit" }, { activeWorktreePath: "/ctx" });
    expect(git.getStagingStatus).toHaveBeenCalledWith("/explicit");
  });

  it("git.getStagingStatus throws when no cwd and no ctx", async () => {
    const { run } = setupActions();
    await expect(run("git.getStagingStatus")).rejects.toThrow("No active worktree");
  });

  it("git.getFileDiff falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run(
      "git.getFileDiff",
      { filePath: "x.ts", status: "modified" },
      { activeWorktreePath: "/repo" }
    );
    expect(git.getFileDiff).toHaveBeenCalledWith("/repo", "x.ts", "modified", undefined, {
      offset: 0,
      maxBytes: GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
    });
  });

  it("git.listCommits falls back to ctx.activeWorktreePath and forwards filters", async () => {
    const { run, git } = setupActions();
    await run("git.listCommits", { search: "fix", limit: 5 }, { activeWorktreePath: "/repo" });
    expect(git.listCommits).toHaveBeenCalledWith({
      cwd: "/repo",
      search: "fix",
      skip: 0,
      limit: 5,
    });
  });

  it("git.stageFile falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.stageFile", { filePath: "a.ts" }, { activeWorktreePath: "/repo" });
    expect(git.stageFile).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("git.unstageFile falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.unstageFile", { filePath: "a.ts" }, { activeWorktreePath: "/repo" });
    expect(git.unstageFile).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("git.unstageAll falls back to ctx.activeWorktreePath", async () => {
    const { run, git } = setupActions();
    await run("git.unstageAll", undefined, { activeWorktreePath: "/repo" });
    expect(git.unstageAll).toHaveBeenCalledWith("/repo");
  });

  it("git.getProjectPulse falls back to ctx.activeWorktreeId and defaults rangeDays to 60", async () => {
    const { run, git } = setupActions();
    await run("git.getProjectPulse", undefined, { activeWorktreeId: "wt-1" });
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-1", rangeDays: 60 })
    );
  });

  it("git.getProjectPulse preserves explicit rangeDays and forwards include flags", async () => {
    const { run, git } = setupActions();
    await run(
      "git.getProjectPulse",
      { worktreeId: "wt-2", rangeDays: 180, includeDelta: true },
      { activeWorktreeId: "wt-ctx" }
    );
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-2", rangeDays: 180, includeDelta: true })
    );
  });

  it("git.getProjectPulse preserves explicit rangeDays even when worktreeId falls back to ctx", async () => {
    const { run, git } = setupActions();
    await run("git.getProjectPulse", { rangeDays: 120 }, { activeWorktreeId: "wt-ctx" });
    expect(git.getProjectPulse).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "wt-ctx", rangeDays: 120 })
    );
  });
});

/**
 * `resultSchema` is advertised documentation — `ActionService.dispatch` returns
 * `run()` output unvalidated — so every assertion here calls `run()` and checks
 * the value it actually returned. Asserting against `resultSchema.parse()` would
 * prove nothing about what reaches an agent (#11531).
 */
describe("gitActions bounded reads", () => {
  it("git.listCommits bounds a runaway page from the IPC layer", async () => {
    const { run, git } = setupActions();
    git.listCommits.mockResolvedValue({
      items: Array.from({ length: 500 }, (_, i) => makeCommit(i)),
      hasMore: true,
      total: 5000,
    });

    const result = (await run(
      "git.listCommits",
      { limit: 10 },
      { activeWorktreePath: "/repo" }
    )) as { items: unknown[] };

    // limit + 1 is the real ceiling — a hash-prefix search pins its match ahead
    // of a full page of message matches.
    expect(result.items.length).toBeLessThanOrEqual(11);
  });

  it("git.listCommits advances nextSkip by limit so a pinned hash match skips nothing", async () => {
    const { run, git } = setupActions();
    // Shape produced by a hash-prefix search: the pinned match plus a full page.
    git.listCommits.mockResolvedValue({
      items: [
        makeCommit(999, { hash: "pinned" }),
        ...Array.from({ length: 10 }, (_, i) => makeCommit(i)),
      ],
      hasMore: true,
      total: 5000,
    });

    const result = (await run(
      "git.listCommits",
      { limit: 10 },
      { activeWorktreePath: "/repo" }
    )) as { items: { hash: string }[]; nextSkip: number | null };

    // All ten message commits survive alongside the pin: cutting to `limit`
    // would drop message commit 9, which nextSkip then steps over for good.
    expect(result.items.map((c) => c.hash)).toContain("hash-9");
    expect(result.nextSkip).toBe(10);
  });

  it("git.listCommits clamps an over-ceiling limit instead of forwarding it", async () => {
    const { run, git } = setupActions();
    git.listCommits.mockResolvedValue({
      items: Array.from({ length: 5000 }, (_, i) => makeCommit(i)),
      hasMore: true,
      total: 5000,
    });

    const result = (await run(
      "git.listCommits",
      { limit: 5000 },
      { activeWorktreePath: "/repo" }
    )) as { items: unknown[]; limit: number };

    expect(git.listCommits).toHaveBeenCalledWith(
      expect.objectContaining({ limit: GIT_LIST_COMMITS_LIMIT_MAX })
    );
    // limit + 1 leaves room for a pinned hash match alongside a full page.
    expect(result.items).toHaveLength(GIT_LIST_COMMITS_LIMIT_MAX + 1);
    expect(result.limit).toBe(GIT_LIST_COMMITS_LIMIT_MAX);
  });

  it("git.listCommits truncates each commit body and flags it", async () => {
    const { run, git } = setupActions();
    git.listCommits.mockResolvedValue({
      items: [makeCommit(0, { body: "x".repeat(50_000) }), makeCommit(1, { body: "short" })],
      hasMore: false,
      total: 2,
    });

    const result = (await run("git.listCommits", undefined, { activeWorktreePath: "/repo" })) as {
      items: { body?: string; bodyTruncated: boolean }[];
    };

    expect(utf8ByteLength(result.items[0]?.body ?? "")).toBe(GIT_COMMIT_BODY_MAX_BYTES);
    expect(result.items[0]?.bodyTruncated).toBe(true);
    expect(result.items[1]?.body).toBe("short");
    expect(result.items[1]?.bodyTruncated).toBe(false);
  });

  it("git.listCommits caps every free-text field by BYTES, not UTF-16 units", async () => {
    const { run, git } = setupActions();
    // Multibyte throughout: a .slice(n) implementation would pass a length
    // check while still shipping 3x the byte budget.
    git.listCommits.mockResolvedValue({
      items: [
        makeCommit(0, {
          message: "実".repeat(5000),
          body: "😀".repeat(5000),
          author: { name: "あ".repeat(5000), email: "え".repeat(5000) },
        }),
      ],
      hasMore: false,
      total: 1,
    });

    const result = (await run("git.listCommits", undefined, { activeWorktreePath: "/repo" })) as {
      items: { message: string; body?: string; author: { name: string; email: string } }[];
    };
    const commit = result.items[0];

    expect(utf8ByteLength(commit?.message ?? "")).toBeLessThanOrEqual(GIT_SUBJECT_MAX_BYTES);
    expect(utf8ByteLength(commit?.body ?? "")).toBeLessThanOrEqual(GIT_COMMIT_BODY_MAX_BYTES);
    expect(utf8ByteLength(commit?.author.name ?? "")).toBeLessThanOrEqual(GIT_SUBJECT_MAX_BYTES);
    expect(utf8ByteLength(commit?.author.email ?? "")).toBeLessThanOrEqual(GIT_SUBJECT_MAX_BYTES);
    // Cutting mid-character would leave a replacement character behind.
    expect(`${commit?.message}${commit?.body}${commit?.author.name}`).not.toContain("�");
  });

  it("git.listCommits leaves an absent body absent rather than inventing an empty one", async () => {
    const { run, git } = setupActions();
    git.listCommits.mockResolvedValue({
      items: [makeCommit(0, { body: undefined })],
      hasMore: false,
      total: 1,
    });

    const result = (await run("git.listCommits", undefined, { activeWorktreePath: "/repo" })) as {
      items: { body?: string; bodyTruncated: boolean }[];
    };

    expect(result.items[0]?.body).toBeUndefined();
    expect(result.items[0]?.bodyTruncated).toBe(false);
  });

  it("git.listCommits drops fields the schema does not advertise", async () => {
    const { run, git } = setupActions();
    git.listCommits.mockResolvedValue({
      items: [makeCommit(0, { refs: "HEAD -> main", diff: "a".repeat(10_000) })],
      hasMore: false,
      total: 1,
    });

    const result = (await run("git.listCommits", undefined, { activeWorktreePath: "/repo" })) as {
      items: Record<string, unknown>[];
    };

    expect(result.items[0]).not.toHaveProperty("refs");
    expect(result.items[0]).not.toHaveProperty("diff");
    expect(result.items[0]?.hash).toBe("hash-0");
  });

  it("git.getFileDiff defaults to the 24KB window and forwards an explicit one", async () => {
    const { run, git } = setupActions();

    await run("git.getFileDiff", { filePath: "a.ts", status: "modified" }, { activeWorktreePath: "/repo" });
    expect(git.getFileDiff).toHaveBeenCalledWith("/repo", "a.ts", "modified", undefined, {
      offset: 0,
      maxBytes: GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
    });

    await run(
      "git.getFileDiff",
      { filePath: "a.ts", status: "modified", offset: 2048, maxBytes: 4096 },
      { activeWorktreePath: "/repo" }
    );
    expect(git.getFileDiff).toHaveBeenLastCalledWith("/repo", "a.ts", "modified", undefined, {
      offset: 2048,
      maxBytes: 4096,
    });
  });

  it("git.getFileDiff clamps an over-ceiling maxBytes reaching run() unvalidated", async () => {
    const { run, git } = setupActions();
    await run(
      "git.getFileDiff",
      { filePath: "a.ts", status: "modified", maxBytes: 999_999_999 },
      { activeWorktreePath: "/repo" }
    );
    expect(git.getFileDiff).toHaveBeenCalledWith(
      "/repo",
      "a.ts",
      "modified",
      undefined,
      { offset: 0, maxBytes: GIT_FILE_DIFF_MAX_BYTES }
    );
  });

  it("git.getFileDiff surfaces the continuation cursor for an oversized diff", async () => {
    const { run, git } = setupActions();
    git.getFileDiff.mockResolvedValue({
      content: "chunk",
      offset: 0,
      totalBytes: 5_000_000,
      truncated: true,
      nextOffset: 24576,
    });

    const result = (await run(
      "git.getFileDiff",
      { filePath: "big.lock", status: "modified" },
      { activeWorktreePath: "/repo" }
    )) as { truncated: boolean; nextOffset: number | null; totalBytes: number };

    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(24576);
    expect(result.totalBytes).toBe(5_000_000);
  });

  it("git.getStagingStatus pages every file list and reports per-list totals", async () => {
    const { run, git } = setupActions();
    const entry = (i: number) => ({
      path: `file-${i}.ts`,
      status: "modified",
      insertions: 1,
      deletions: 0,
    });
    git.getStagingStatus.mockResolvedValue({
      staged: Array.from({ length: 500 }, (_, i) => entry(i)),
      unstaged: Array.from({ length: 30 }, (_, i) => entry(i)),
      conflicted: [],
      conflictedFiles: [],
      isDetachedHead: false,
      currentBranch: "main",
      hasRemote: true,
      repoState: "DIRTY",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });

    const result = (await run("git.getStagingStatus", undefined, {
      activeWorktreePath: "/repo",
    })) as {
      staged: unknown[];
      unstaged: unknown[];
      totals: { staged: number; unstaged: number };
      hasMore: { staged: boolean; unstaged: boolean };
    };

    expect(result.staged).toHaveLength(100);
    expect(result.unstaged).toHaveLength(30);
    expect(result.totals.staged).toBe(500);
    expect(result.hasMore.staged).toBe(true);
    expect(result.hasMore.unstaged).toBe(false);
  });

  it("git.getStagingStatus reports a cursor when ANY list has more, not just staged", async () => {
    const { run, git } = setupActions();
    const entry = (i: number) => ({
      path: `file-${i}.ts`,
      status: "modified",
      insertions: null,
      deletions: null,
    });
    // staged is short and unstaged is long — a regression to `staged.nextOffset`
    // alone would strand every unstaged entry past the first page.
    git.getStagingStatus.mockResolvedValue({
      staged: [entry(0)],
      unstaged: Array.from({ length: 500 }, (_, i) => entry(i)),
      conflicted: [],
      conflictedFiles: [],
      isDetachedHead: false,
      currentBranch: "main",
      hasRemote: true,
      repoState: "DIRTY",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });

    const first = (await run("git.getStagingStatus", { limit: 10 }, {
      activeWorktreePath: "/repo",
    })) as { nextOffset: number | null };
    expect(first.nextOffset).toBe(10);

    const second = (await run("git.getStagingStatus", { offset: 10, limit: 10 }, {
      activeWorktreePath: "/repo",
    })) as { staged: unknown[]; unstaged: { path: string }[] };

    // The short list is exhausted; the long one keeps producing.
    expect(second.staged).toEqual([]);
    expect(second.unstaged[0]?.path).toBe("file-10.ts");
  });

  it("git.getStagingStatus summarizes the rebase sequence instead of shipping the todo", async () => {
    const { run, git } = setupActions();
    git.getStagingStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflicted: [],
      conflictedFiles: [],
      isDetachedHead: false,
      currentBranch: "feature",
      hasRemote: true,
      repoState: "REBASING",
      rebaseStep: 2,
      rebaseTotalSteps: 400,
      rebaseSequence: {
        backend: "merge",
        entries: [
          ...Array.from({ length: 200 }, () => ({
            action: "pick",
            sha: "abc",
            subject: "done work",
            state: "done",
          })),
          { action: "pick", sha: "def", subject: "current work", state: "current" },
          ...Array.from({ length: 199 }, () => ({
            action: "pick",
            sha: "ghi",
            subject: "later work",
            state: "pending",
          })),
        ],
      },
    });

    const result = (await run("git.getStagingStatus", undefined, {
      activeWorktreePath: "/repo",
    })) as {
      rebaseSummary: {
        backend: string;
        totalEntries: number;
        completedEntries: number;
        pendingEntries: number;
        currentSubject: string | null;
      } | null;
    };

    expect(result).not.toHaveProperty("rebaseSequence");
    expect(result.rebaseSummary).toEqual({
      backend: "merge",
      totalEntries: 400,
      completedEntries: 200,
      pendingEntries: 199,
      currentSubject: "current work",
    });
  });

  it("git.getStagingStatus keeps the legacy conflicted list aligned with the paged entries", async () => {
    const { run, git } = setupActions();
    git.getStagingStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflicted: Array.from({ length: 500 }, (_, i) => `c-${i}.ts`),
      conflictedFiles: Array.from({ length: 500 }, (_, i) => ({
        path: `c-${i}.ts`,
        xy: "UU",
        label: "both modified",
      })),
      isDetachedHead: false,
      currentBranch: "main",
      hasRemote: true,
      repoState: "MERGING",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });

    const result = (await run("git.getStagingStatus", { limit: 5 }, {
      activeWorktreePath: "/repo",
    })) as { conflicted: string[]; conflictedFiles: { path: string }[] };

    expect(result.conflicted).toHaveLength(5);
    expect(result.conflictedFiles).toHaveLength(5);
    expect(result.conflicted).toEqual(result.conflictedFiles.map((f) => f.path));
  });

  it("git.getProjectPulse projects the heatmap whole and caps recent commits", async () => {
    const { run, git } = setupActions();
    git.getProjectPulse.mockResolvedValue({
      worktreeId: "wt-1",
      worktreePath: "/repo",
      mainBranch: "main",
      rangeDays: 60,
      generatedAt: 1,
      heatmap: Array.from({ length: 60 }, (_, i) => ({
        date: `2026-01-${i}`,
        count: i,
        level: 1,
        internalNote: "should not ship",
      })),
      commitsInRange: 12,
      activeDays: 5,
      projectAgeDays: 100,
      recentCommits: Array.from({ length: 50 }, (_, i) => ({
        sha: `sha-${i}`,
        subject: "s".repeat(5000),
        timestamp: i,
      })),
    });

    const result = (await run("git.getProjectPulse", undefined, { activeWorktreeId: "wt-1" })) as {
      heatmap: Record<string, unknown>[];
      recentCommits: { subject: string }[];
    };

    // The renderer pulse card charts every cell, so the heatmap is projected whole.
    expect(result.heatmap).toHaveLength(60);
    expect(result.heatmap[0]).not.toHaveProperty("internalNote");
    expect(result.recentCommits).toHaveLength(PULSE_RECENT_COMMITS_MAX);
    expect(utf8ByteLength(result.recentCommits[0]?.subject ?? "")).toBeLessThanOrEqual(
      GIT_SUBJECT_MAX_BYTES
    );
  });

  it("git.getProjectPulse keeps the churn fields PulseSummary renders", async () => {
    const { run, git } = setupActions();
    git.getProjectPulse.mockResolvedValue({
      worktreeId: "wt-1",
      worktreePath: "/repo",
      mainBranch: "main",
      rangeDays: 60,
      generatedAt: 1,
      heatmap: [{ date: "d", count: 1, level: 1, isBeforeProject: true, isMostRecentActive: true }],
      commitsInRange: 1,
      activeDays: 1,
      projectAgeDays: 1,
      currentStreakDays: 3,
      recentCommits: [],
      uncommitted: { changedFiles: 4, insertions: 9, deletions: 2, lastUpdated: 7 },
      deltaToMain: {
        baseBranch: "main",
        headBranch: "feature",
        ahead: 2,
        behind: 1,
        filesChanged: 5,
        insertions: 100,
        deletions: 20,
      },
    });

    const result = (await run("git.getProjectPulse", undefined, { activeWorktreeId: "wt-1" })) as {
      deltaToMain: Record<string, unknown>;
      uncommitted: Record<string, unknown>;
      currentStreakDays?: number;
      heatmap: Record<string, unknown>[];
    };

    // PulseSummary renders +insertions/-deletions; a projection that drops them
    // blanks the churn readout in the pulse card.
    expect(result.deltaToMain.insertions).toBe(100);
    expect(result.deltaToMain.deletions).toBe(20);
    expect(result.deltaToMain.filesChanged).toBe(5);
    expect(result.uncommitted.changedFiles).toBe(4);
    expect(result.currentStreakDays).toBe(3);
    // Heatmap cell flags drive the card's "before project" / "most recent" styling.
    expect(result.heatmap[0]?.isBeforeProject).toBe(true);
    expect(result.heatmap[0]?.isMostRecentActive).toBe(true);
  });

  it("git.getProjectPulse trims a heatmap longer than the requested range", async () => {
    const { run, git } = setupActions();
    git.getProjectPulse.mockResolvedValue({
      worktreeId: "wt-1",
      worktreePath: "/repo",
      mainBranch: "main",
      rangeDays: 60,
      generatedAt: 1,
      heatmap: Array.from({ length: 900 }, (_, i) => ({ date: `d-${i}`, count: 0, level: 0 })),
      commitsInRange: 0,
      activeDays: 0,
      projectAgeDays: 0,
      recentCommits: [],
    });

    const result = (await run("git.getProjectPulse", { rangeDays: 60 }, {
      activeWorktreeId: "wt-1",
    })) as { heatmap: { date: string }[] };

    expect(result.heatmap).toHaveLength(60);
    // Keeps the newest window, not the oldest.
    expect(result.heatmap.at(-1)?.date).toBe("d-899");
  });
});
