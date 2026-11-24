import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPtyTerminalProcesses: vi.fn(),
  getPtyClient: vi.fn(() => ({})),
  getWorkspaceClientRef: vi.fn(),
  resolveForCwd: vi.fn(),
  getProjectState: vi.fn(),
  wasStateUnreadableThisSession: vi.fn(() => false),
}));

vi.mock("electron", () => ({ webContents: { fromId: vi.fn() } }));
vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../../ipc/handlers/forgeResolution.js", () => ({
  resolveForCwd: mocks.resolveForCwd,
}));
vi.mock("../../../store.js", () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: mocks.getPtyClient,
  getWorkspaceClientRef: mocks.getWorkspaceClientRef,
}));
vi.mock("../../GitServiceCache.js", () => ({ gitServiceCache: { getGitService: vi.fn() } }));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getProjectState: mocks.getProjectState,
    wasStateUnreadableThisSession: mocks.wasStateUnreadableThisSession,
  },
}));
vi.mock("../../mcp-server/worktreeProcessGuard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp-server/worktreeProcessGuard.js")>()),
  readPtyTerminalProcesses: mocks.readPtyTerminalProcesses,
}));

import { createMergedWorktreeReads } from "../mergedWorktreeCleanupLive.js";

const project = { id: "p1", path: "/repo", name: "Repo" };
const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wasStateUnreadableThisSession.mockReturnValue(false);
});

describe("createMergedWorktreeReads", () => {
  it("reads the PTY census once per pass and places each record by worktree", async () => {
    mocks.readPtyTerminalProcesses.mockResolvedValue([
      { id: "t1", worktreeId: "/wt/a", cwd: "/wt/a" },
      { id: "t2", worktreeId: "/wt/a", cwd: "/wt/a/sub", isExited: true },
    ]);
    const reads = createMergedWorktreeReads(project, signal, "sweep");

    expect(await reads.countTerminals("/wt/a")).toEqual({ count: 2, complete: true });
    expect(await reads.countTerminals("/wt/b")).toEqual({ count: 0, complete: true });
    expect(mocks.readPtyTerminalProcesses).toHaveBeenCalledTimes(1);

    await createMergedWorktreeReads(project, signal, "sweep").countTerminals("/wt/a");
    expect(mocks.readPtyTerminalProcesses).toHaveBeenCalledTimes(2);
  });

  it("rejects when the census is partial, so the worktree is left alone", async () => {
    mocks.readPtyTerminalProcesses.mockRejectedValue(new Error("A pty host shard did not answer."));
    await expect(
      createMergedWorktreeReads(project, signal, "sweep").countTerminals("/wt/a")
    ).rejects.toThrow("shard");
  });

  it.each([
    ["sweep", true],
    ["preview", false],
  ] as const)("reads the PR by number with fresh %s → %s", async (purpose, fresh) => {
    const impl = { findPRByBranch: vi.fn(async () => null), getPR: vi.fn(async () => null) };
    const repoRef = { owner: "o", repo: "r" };
    mocks.resolveForCwd.mockResolvedValue({ impl, repoRef });
    const forge = await createMergedWorktreeReads(project, signal, purpose).resolveForge();

    await forge.findPRByBranch("feature/x");
    await forge.getPR(42);
    expect(mocks.resolveForCwd).toHaveBeenCalledWith("/repo");
    expect(impl.findPRByBranch).toHaveBeenCalledWith(repoRef, "feature/x");
    expect(impl.getPR).toHaveBeenCalledWith(repoRef, 42, { fresh });
  });

  it("reads the saved layout's panels and active worktree, and refuses one read unreadable", async () => {
    mocks.getProjectState.mockResolvedValue({
      terminals: [{ worktreeId: "/wt/a" }],
      activeWorktreeId: "/wt/b",
    });
    const reads = createMergedWorktreeReads(project, signal, "sweep");
    expect(await reads.readSavedLayout()).toEqual({
      panels: [{ worktreeId: "/wt/a" }],
      activeWorktreeId: "/wt/b",
    });

    mocks.getProjectState.mockResolvedValue(null);
    mocks.wasStateUnreadableThisSession.mockReturnValue(true);
    await expect(reads.readSavedLayout()).rejects.toThrow("couldn't be read");
  });

  describe("readHostRefusal", () => {
    const risk = {
      entries: [],
      dirtyFiles: [],
      untrackedFiles: [],
      atRiskCommits: [],
      requiresMechanicalForce: false,
      incomplete: false,
    };
    const refusal = (preview: unknown) => {
      mocks.getWorkspaceClientRef.mockReturnValue({
        getDeletePreview: vi.fn(async () => preview),
      });
      return createMergedWorktreeReads(project, signal, "preview").readHostRefusal!("/wt/a");
    };

    it("claims nothing when no host is running to ask", async () => {
      mocks.getWorkspaceClientRef.mockReturnValue(null);
      expect(
        await createMergedWorktreeReads(project, signal, "preview").readHostRefusal!("/wt/a")
      ).toBeNull();
      expect(await refusal(null)).toBeNull();
    });

    it("names teardown the host won't run and submodules git won't remove", async () => {
      expect(await refusal({ changes: {}, risk, teardown: { phases: [] } })).toBeNull();
      expect(
        await refusal({
          changes: {},
          risk,
          teardown: { phases: [{ phase: "teardown", commands: ["x"], approved: true }] },
        })
      ).toBe("teardown");
      expect(
        await refusal({
          changes: {},
          risk: { ...risk, entries: [{ path: "vendor/lib" }] },
          teardown: { phases: [] },
        })
      ).toBeNull();
      for (const atRisk of [
        { requiresMechanicalForce: true },
        { dirtyFiles: [{ path: "vendor/lib/a" }] },
        { untrackedFiles: [{ path: "vendor/lib/b" }] },
        { atRiskCommits: [{ sha: "x" }] },
      ]) {
        expect(
          await refusal({ changes: {}, risk: { ...risk, ...atRisk }, teardown: { phases: [] } })
        ).toBe("submodules");
      }
    });

    it("rejects when the host couldn't read what deleting it would do", async () => {
      await expect(
        refusal({ changes: {}, risk: "unreadable", teardown: { phases: [] } })
      ).rejects.toThrow("couldn't read");
      await expect(
        refusal({ changes: {}, risk: { ...risk, incomplete: true }, teardown: { phases: [] } })
      ).rejects.toThrow("couldn't finish");
    });
  });
});
