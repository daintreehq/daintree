import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { PR } from "../../../../shared/types/forge.js";
import type { ProjectSettings } from "../../../../shared/types/project.js";
import type { MergedWorktreeRemovalReceipt } from "../../../../shared/types/mergedWorktreeCleanup.js";
import type { ListedWorktree, MergedWorktreeReads } from "../evaluateMergedWorktrees.js";
import {
  MERGED_WORKTREE_PENDING_SETTLE_MS,
  MERGED_WORKTREE_REMOVAL_DEADLINE_MS,
  MERGED_WORKTREE_RECEIPT_CAP,
  MERGED_WORKTREE_RECEIPT_LEASE_MS,
  MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS,
  MERGED_WORKTREE_SWEEP_INTERVAL_MS,
  MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS,
  MergedWorktreeCleanupService,
  type MergedWorktreeCleanupDeps,
} from "../MergedWorktreeCleanupService.js";

const DAY = 24 * 60 * 60 * 1000;
const HEAD = "c".repeat(40);
const MERGED_AT = 1_700_000_000_000;
const NOW = MERGED_AT + DAY + 60_000;
const project = { id: "p1", path: path.resolve("/repo"), name: "Repo" };
const worktreePath = path.resolve("/wt/feature-x");
const listed: ListedWorktree[] = [
  { path: project.path, branch: "develop", bare: false, isMainWorktree: true },
  { path: worktreePath, branch: "feature/x", bare: false, isMainWorktree: false },
];

function mergedPR(overrides: Partial<PR> = {}): PR {
  return {
    number: 7,
    title: "Feature x",
    body: "",
    state: "merged",
    rawState: "MERGED",
    isDraft: false,
    merged: true,
    url: "https://forge.test/o/r/pull/7",
    author: { login: "a" },
    baseRef: "develop",
    headRef: "feature/x",
    headSha: HEAD,
    createdAt: 0,
    updatedAt: MERGED_AT,
    closedAt: MERGED_AT,
    mergedAt: MERGED_AT,
    rawData: null,
    ...overrides,
  } as PR;
}

function cleanReads(getPR: () => Promise<PR | null> = async () => mergedPR()) {
  return (): MergedWorktreeReads => ({
    pathExists: async () => true,
    readGitDir: async () => "/repo/.git/worktrees/feature-x",
    readStamp: async () => ({ createdAt: 1, branch: "feature/x" }),
    readStatus: async () => ({
      headOid: HEAD,
      branch: "feature/x",
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      hiddenFromStatus: 0,
    }),
    countTerminals: async () => ({ count: 0, complete: true }),
    readSavedLayout: async () => null,
    resolveForge: async () => ({ findPRByBranch: async () => mergedPR(), getPR }),
    now: () => NOW,
  });
}

/** A host that asks `confirm` first, as the real one does once it's ready. */
const confirmingHost = () =>
  vi.fn<MergedWorktreeCleanupDeps["removeWorktree"]>(async (_p, _id, _guard, confirm) =>
    (await confirm()) ? { outcome: "removed" } : { outcome: "declined" }
  );

function setup(overrides: Partial<MergedWorktreeCleanupDeps> = {}) {
  let settings: ProjectSettings = { runCommands: [], removeMergedWorktrees: true };
  let receipts: MergedWorktreeRemovalReceipt[] = [];
  const deps: MergedWorktreeCleanupDeps = {
    listProjects: () => [project],
    readSettings: vi.fn(async () => settings),
    writeEnabled: vi.fn(async (_id: string, enabled: boolean) => {
      settings = { ...settings, removeMergedWorktrees: enabled ? true : undefined };
    }),
    listWorktrees: vi.fn(async () => listed),
    readsFor: vi.fn(cleanReads()),
    removeWorktree: confirmingHost(),
    pathExists: vi.fn(async () => true),
    loadReceipts: () => receipts,
    saveReceipts: vi.fn((next: MergedWorktreeRemovalReceipt[]) => {
      receipts = next;
    }),
    announceReceipts: vi.fn(),
    isLiveView: vi.fn(() => true),
    now: () => NOW,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
  };
  const service = new MergedWorktreeCleanupService(deps);
  return {
    service,
    deps,
    setSettings: (next: ProjectSettings) => {
      settings = next;
    },
    setReceipts: (next: MergedWorktreeRemovalReceipt[]) => {
      receipts = next;
    },
    receipts: () => receipts,
  };
}

function receipt(id: string, extra: Partial<MergedWorktreeRemovalReceipt> = {}) {
  return {
    id,
    projectId: "p1",
    projectName: "Repo",
    worktreePath: `/wt/${id}`,
    branch: "b",
    prNumber: 1,
    prUrl: "",
    removedAt: 1,
    ...extra,
  } satisfies MergedWorktreeRemovalReceipt;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MergedWorktreeCleanupService", () => {
  it("removes a qualifying worktree under the guard, and settles its receipt", async () => {
    const { service, deps, receipts } = setup();
    await service.sweep();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      project,
      worktreePath,
      {
        expectedBranch: "feature/x",
        expectedHead: HEAD,
        notAfter: NOW + MERGED_WORKTREE_REMOVAL_DEADLINE_MS,
      },
      expect.any(Function)
    );
    expect(receipts()).toEqual([
      {
        id: expect.any(String),
        projectId: "p1",
        projectName: "Repo",
        branch: "feature/x",
        prNumber: 7,
        prUrl: "https://forge.test/o/r/pull/7",
        worktreePath,
        removedAt: NOW,
      },
    ]);
    expect(deps.announceReceipts).toHaveBeenCalledTimes(1);
  });

  it("records the receipt as pending before git is asked", async () => {
    let seen: MergedWorktreeRemovalReceipt[] = [];
    const harness = setup({
      removeWorktree: vi.fn(async (_p, _id, _guard, confirm) => {
        seen = harness.receipts();
        return (await confirm())
          ? { outcome: "removed" as const }
          : { outcome: "declined" as const };
      }),
    });
    await harness.service.sweep();
    expect(seen).toEqual([expect.objectContaining({ pending: true, branch: "feature/x" })]);
    expect(harness.receipts()[0]).not.toHaveProperty("pending");
  });

  it("reads past the forge's caches for a sweep, and lets a preview use them", async () => {
    const { service, deps } = setup();
    await service.preview("p1");
    expect(vi.mocked(deps.readsFor).mock.calls.map((call) => call[2])).toEqual(["preview"]);
    await service.sweep();
    expect(
      vi
        .mocked(deps.readsFor)
        .mock.calls.slice(1)
        .map((call) => call[2])
    ).toEqual(["sweep", "sweep"]);
  });

  it("reads nothing past the settings for a project that hasn't opted in", async () => {
    const { service, deps, setSettings } = setup();
    setSettings({ runCommands: [] });
    await service.sweep();
    expect(deps.listWorktrees).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("judges the worktree again once the host is ready, and sends nothing when it no longer qualifies", async () => {
    let reads = 0;
    const { service, deps, receipts } = setup({
      readsFor: vi.fn(
        cleanReads(async () => (++reads === 1 ? mergedPR() : mergedPR({ headSha: "d".repeat(40) })))
      ),
    });
    await service.sweep();
    expect(reads).toBe(2);
    expect(await vi.mocked(deps.removeWorktree).mock.results[0]!.value).toEqual({
      outcome: "declined",
    });
    expect(receipts()).toEqual([]);
    expect(deps.announceReceipts).not.toHaveBeenCalled();
  });

  it("stops before the removal when the switch goes off and on again during the sweep", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, deps } = setup({
      readsFor: vi.fn(
        cleanReads(async () => {
          await gate;
          return mergedPR();
        })
      ),
    });
    const sweeping = service.sweep();
    await vi.waitFor(() => expect(deps.listWorktrees).toHaveBeenCalled());
    await service.setEnabled("p1", false);
    await service.setEnabled("p1", true);
    release();
    await sweeping;
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(["not-sent", "refused"] as const)(
    "drops the receipt when the removal was %s, without asking the disk",
    async (outcome) => {
      const { service, deps, receipts } = setup({
        removeWorktree: vi.fn(async () => ({ outcome, error: "The worktree has changes" })),
        pathExists: vi.fn(async () => false),
      });
      await service.sweep();
      expect(receipts()).toEqual([]);
      expect(deps.announceReceipts).not.toHaveBeenCalled();
      expect(deps.logWarn).toHaveBeenCalled();
      expect(deps.pathExists).not.toHaveBeenCalled();
    }
  );

  it("previews a worktree whose last removal hasn't answered as waiting on it", async () => {
    const harness = setup({
      removeWorktree: vi.fn(async () => ({ outcome: "lost" as const, error: "TIMEOUT" })),
    });
    await harness.service.sweep();
    const preview = await harness.service.preview("p1");
    expect(preview.worktrees).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "removal-pending",
        pr: expect.anything(),
      }),
    ]);
  });

  it.each([
    ["keeps", NOW - 60_000, [true]],
    ["drops", NOW - MERGED_WORKTREE_PENDING_SETTLE_MS, []],
  ] as const)(
    "%s a pending receipt whose folder can't be read, by its age",
    async (_label, removedAt, pending) => {
      const harness = setup({
        pathExists: vi.fn(async () => Promise.reject(new Error("EACCES"))),
        listWorktrees: vi.fn(async () => [listed[0]!]),
      });
      harness.setReceipts([receipt("x", { pending: true, removedAt })]);
      await harness.service.sweep();
      expect(harness.receipts().map((entry) => entry.pending ?? false)).toEqual(pending);
    }
  );

  it("doesn't retry a checkout whose last removal never answered", async () => {
    const harness = setup({
      removeWorktree: vi.fn(async () => ({ outcome: "lost" as const, error: "TIMEOUT" })),
    });
    await harness.service.sweep();
    await harness.service.sweep();
    expect(harness.deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(harness.receipts()).toHaveLength(1);
  });

  it("keeps a lost answer pending, and a later sweep settles it once the checkout is gone", async () => {
    let gone = false;
    const harness = setup({
      removeWorktree: vi.fn(async () => ({ outcome: "lost" as const, error: "TIMEOUT" })),
      pathExists: vi.fn(async () => !gone),
    });
    await harness.service.sweep();
    expect(harness.receipts()).toEqual([expect.objectContaining({ pending: true })]);
    expect(harness.deps.announceReceipts).not.toHaveBeenCalled();

    gone = true;
    harness.deps.listWorktrees = vi.fn(async () => [listed[0]!]);
    await harness.service.sweep();
    expect(harness.receipts()).toEqual([expect.objectContaining({ branch: "feature/x" })]);
    expect(harness.receipts()[0]).not.toHaveProperty("pending");
    expect(harness.deps.announceReceipts).toHaveBeenCalledTimes(1);
  });

  it("settles a pending receipt whose checkout is gone, drops a stale one whose checkout stayed, and waits on a recent one", async () => {
    const harness = setup({
      pathExists: vi.fn(async (target: string) => target !== "/wt/gone"),
      listWorktrees: vi.fn(async () => [listed[0]!]),
    });
    harness.setReceipts([
      receipt("gone", { pending: true, removedAt: NOW }),
      receipt("stale", { pending: true, removedAt: NOW - MERGED_WORKTREE_PENDING_SETTLE_MS }),
      receipt("recent", { pending: true, removedAt: NOW - 60_000 }),
      receipt("done"),
    ]);
    await harness.service.sweep();
    expect(harness.receipts().map((entry) => [entry.id, entry.pending ?? false])).toEqual([
      ["gone", false],
      ["recent", true],
      ["done", false],
    ]);
    expect(harness.deps.announceReceipts).toHaveBeenCalledTimes(1);
  });

  it("removes nothing while the receipts nobody has taken are full", async () => {
    const harness = setup();
    harness.setReceipts(
      Array.from({ length: MERGED_WORKTREE_RECEIPT_CAP }, (_, index) => receipt(`r${index}`))
    );
    await harness.service.sweep();
    expect(harness.deps.removeWorktree).not.toHaveBeenCalled();
    expect(harness.receipts()).toHaveLength(MERGED_WORKTREE_RECEIPT_CAP);
    expect(harness.receipts()[0]!.id).toBe("r0");
  });

  it("joins a sweep already running instead of starting a second", async () => {
    const { service, deps } = setup();
    await Promise.all([service.sweep(), service.sweep()]);
    expect(deps.listWorktrees).toHaveBeenCalledTimes(1);
  });

  it("previews what a sweep would do while the switch is off, removing nothing", async () => {
    const { service, deps, setSettings } = setup();
    setSettings({ runCommands: [] });
    const preview = await service.preview("p1");
    expect(preview.enabled).toBe(false);
    expect(preview.checkedAt).toBe(NOW);
    expect(preview.worktrees).toEqual([
      expect.objectContaining({ status: "removable", branch: "feature/x" }),
    ]);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("previews a worktree list that can't be read as an error, not as nothing", async () => {
    const { service } = setup({
      listWorktrees: vi.fn(async () => Promise.reject(new Error("not a git repository"))),
    });
    const preview = await service.preview("p1");
    expect(preview.worktrees).toEqual([]);
    expect(preview.error).toContain("not a git repository");
  });

  describe("receipts", () => {
    it("hands out only settled receipts, and drops only the acked ones", () => {
      const harness = setup();
      harness.setReceipts([receipt("a"), receipt("b", { pending: true }), receipt("c")]);
      expect(harness.service.takeReceipts(1).map((entry) => entry.id)).toEqual(["a", "c"]);
      harness.service.ackReceipts(["a", "b"]);
      expect(harness.receipts().map((entry) => entry.id)).toEqual(["b", "c"]);
    });

    it("announces again when a hold another view never filed lapses", async () => {
      vi.useFakeTimers();
      const harness = setup();
      harness.setReceipts([receipt("a")]);
      harness.service.takeReceipts(1);
      expect(harness.service.takeReceipts(2)).toEqual([]);
      await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_RECEIPT_LEASE_MS - 1);
      expect(harness.deps.announceReceipts).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.deps.announceReceipts).toHaveBeenCalledTimes(1);
    });

    it("holds receipts for the view that took them until it acks or the hold lapses", () => {
      let at = NOW;
      const live = new Set([1, 2]);
      const harness = setup({ now: () => at, isLiveView: (id) => live.has(id) });
      harness.setReceipts([receipt("a")]);
      expect(harness.service.takeReceipts(1)).toHaveLength(1);
      expect(harness.service.takeReceipts(2)).toEqual([]);
      expect(harness.service.takeReceipts(1)).toHaveLength(1);
      at += MERGED_WORKTREE_RECEIPT_LEASE_MS;
      expect(harness.service.takeReceipts(2)).toHaveLength(1);
      live.delete(2);
      expect(harness.service.takeReceipts(1)).toHaveLength(1);
    });
  });

  it("waits out startup, sweeps on the hour, and soon after the switch goes on", async () => {
    vi.useFakeTimers();
    const { service, deps, setSettings } = setup();
    setSettings({ runCommands: [] });
    service.start();
    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS);
    expect(deps.readSettings).toHaveBeenCalledTimes(1);
    expect(deps.listWorktrees).not.toHaveBeenCalled();

    await service.setEnabled("p1", true);
    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS - 1);
    expect(deps.listWorktrees).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(deps.listWorktrees).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(deps.listWorktrees).toHaveBeenCalledTimes(2));
    await service.dispose();
  });

  it("starts nothing after dispose", async () => {
    vi.useFakeTimers();
    const { service, deps } = setup();
    service.start();
    await service.dispose();
    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS * 2);
    await service.sweep();
    expect(deps.listWorktrees).not.toHaveBeenCalled();
  });
});
