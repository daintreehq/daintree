import { afterEach, describe, expect, it, vi } from "vitest";
import type { PR } from "../../../../shared/types/forge.js";
import type { ProjectSettings } from "../../../../shared/types/project.js";
import {
  MERGED_WORKTREE_GRACE_MS,
  type MergedWorktreeRemovalReceipt,
} from "../../../../shared/types/mergedWorktreeCleanup.js";
import type { ListedWorktree, MergedWorktreeReads } from "../evaluateMergedWorktrees.js";
import {
  MERGED_WORKTREE_RECEIPT_CAP,
  MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS,
  MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS,
  MergedWorktreeCleanupService,
  type MergedWorktreeCleanupDeps,
} from "../MergedWorktreeCleanupService.js";

const HEAD = "c".repeat(40);
const MERGED_AT = 1_700_000_000_000;
const NOW = MERGED_AT + MERGED_WORKTREE_GRACE_MS + 60_000;
const project = { id: "p1", path: "/repo", name: "Repo" };
const listed: ListedWorktree[] = [
  { path: "/repo", branch: "develop", bare: false, isMainWorktree: true },
  { path: "/wt/feature-x", branch: "feature/x", bare: false, isMainWorktree: false },
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

function cleanReads(getFreshPR: () => Promise<PR | null> = async () => mergedPR()) {
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
    resolveForge: async () => ({
      findPRByBranch: async () => mergedPR(),
      getFreshPR,
    }),
    now: () => NOW,
  });
}

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
    readsFor: cleanReads(),
    removeWorktree: vi.fn(async () => undefined),
    loadReceipts: () => receipts,
    saveReceipts: vi.fn((next: MergedWorktreeRemovalReceipt[]) => {
      receipts = next;
    }),
    announceReceipts: vi.fn(),
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
    receipts: () => receipts,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MergedWorktreeCleanupService", () => {
  it("removes a qualifying worktree without force or branch deletion, and records a receipt", async () => {
    const { service, deps, receipts } = setup();
    await service.sweep();
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree).toHaveBeenCalledWith(project, "/wt/feature-x", {
      expectedBranch: "feature/x",
      expectedHead: HEAD,
    });
    expect(receipts()).toEqual([
      expect.objectContaining({
        projectId: "p1",
        projectName: "Repo",
        branch: "feature/x",
        prNumber: 7,
        worktreePath: "/wt/feature-x",
        removedAt: NOW,
      }),
    ]);
    expect(deps.announceReceipts).toHaveBeenCalledTimes(1);
  });

  it("reads nothing past the settings for a project that hasn't opted in", async () => {
    const { service, deps, setSettings } = setup();
    setSettings({ runCommands: [] });
    await service.sweep();
    expect(deps.listWorktrees).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("judges the worktree again right before removing it", async () => {
    let reads = 0;
    const { service, deps } = setup({
      readsFor: cleanReads(async () =>
        ++reads === 1 ? mergedPR() : mergedPR({ headSha: "d".repeat(40) })
      ),
    });
    await service.sweep();
    expect(reads).toBe(2);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("stops before the removal when the switch goes off during the sweep", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, deps } = setup({
      readsFor: cleanReads(async () => {
        await gate;
        return mergedPR();
      }),
    });
    const sweeping = service.sweep();
    await vi.waitFor(() => expect(deps.listWorktrees).toHaveBeenCalled());
    await service.setEnabled("p1", false);
    release();
    await sweeping;
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("records no receipt when the host refuses the removal", async () => {
    const { service, deps, receipts } = setup({
      removeWorktree: vi.fn(async () => Promise.reject(new Error("The worktree has changes"))),
    });
    await service.sweep();
    expect(receipts()).toEqual([]);
    expect(deps.announceReceipts).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalled();
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

  it("keeps receipts until acked, and only the acked ones go", async () => {
    const { service, receipts } = setup({
      listWorktrees: vi.fn(async () => [
        ...listed,
        { path: "/wt/feature-y", branch: "feature/x", bare: false, isMainWorktree: false },
      ]),
    });
    await service.sweep();
    const taken = service.takeReceipts();
    expect(taken).toHaveLength(2);
    service.ackReceipts([taken[0]!.id]);
    expect(receipts().map((receipt) => receipt.id)).toEqual([taken[1]!.id]);
  });

  it("caps the receipts it keeps, dropping the oldest", async () => {
    const old = Array.from({ length: MERGED_WORKTREE_RECEIPT_CAP }, (_, index) => ({
      id: `old-${index}`,
      projectId: "p1",
      projectName: "Repo",
      worktreePath: `/wt/${index}`,
      branch: "b",
      prNumber: index,
      prUrl: "",
      removedAt: index,
    }));
    const harness = setup();
    harness.deps.saveReceipts(old);
    await harness.service.sweep();
    const kept = harness.receipts();
    expect(kept).toHaveLength(MERGED_WORKTREE_RECEIPT_CAP);
    expect(kept[0]!.id).toBe("old-1");
    expect(kept.at(-1)!.branch).toBe("feature/x");
  });

  it("waits out startup before its first sweep, and sweeps soon after the switch goes on", async () => {
    vi.useFakeTimers();
    const { service, deps } = setup();
    service.start();
    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_STARTUP_DELAY_MS - 1);
    expect(deps.listWorktrees).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(deps.listWorktrees).toHaveBeenCalledTimes(1));

    await service.setEnabled("p1", true);
    await vi.advanceTimersByTimeAsync(MERGED_WORKTREE_SWEEP_AFTER_ENABLE_MS);
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
