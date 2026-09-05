import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectStateManager, PROJECT_STATE_SCHEMA_VERSION } from "../ProjectStateManager.js";
import { generateProjectId, stateFilePath } from "../projectStorePaths.js";
import type { ProjectState } from "../../types/index.js";
import { markPerformance, withPerformanceSpan } from "../../utils/performance.js";
import { PERF_MARKS } from "../../../shared/perf/marks.js";

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  withPerformanceSpan: vi.fn(async (_mark: string, task: () => Promise<unknown>) => task()),
}));

function makeState(overrides?: Partial<ProjectState>): ProjectState {
  return {
    projectId: "test-project",
    sidebarWidth: 350,
    terminals: [
      {
        id: "t1",
        title: "Terminal 1",
        location: "grid" as const,
        kind: "terminal" as const,
        cwd: "/tmp",
      },
      {
        id: "t2",
        title: "Terminal 2",
        location: "dock" as const,
        kind: "terminal" as const,
        cwd: "/tmp",
      },
    ],
    terminalSizes: { t1: { cols: 80, rows: 24 } },
    focusPanelState: { sidebarWidth: 300, diagnosticsOpen: false },
    ...overrides,
  };
}

describe("ProjectStateManager clone isolation", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/project");

    const projectDir = path.join(tempDir, projectId);
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", async () => {
    const id = generateProjectId("/nonexistent/project");
    const result = await manager.getProjectState(id);
    expect(result).toBeNull();
  });

  it("returns deep clones on read — mutating one result does not affect the next", async () => {
    const state = makeState();
    await manager.saveProjectState(projectId, state);

    const first = await manager.getProjectState(projectId);
    expect(first).not.toBeNull();

    // Mutate nested fields on the first result
    first!.terminals[0].title = "MUTATED";
    first!.terminalSizes!.t1.cols = 999;
    first!.focusPanelState!.sidebarWidth = 999;

    // Second read should be unaffected
    const second = await manager.getProjectState(projectId);
    expect(second!.terminals[0].title).toBe("Terminal 1");
    expect(second!.terminalSizes!.t1.cols).toBe(80);
    expect(second!.focusPanelState!.sidebarWidth).toBe(300);
  });

  it("save-path isolation — mutating state after save does not corrupt the cache", async () => {
    const state = makeState();
    await manager.saveProjectState(projectId, state);

    // Mutate the original state object after saving
    state.terminals[0].title = "MUTATED";
    state.sidebarWidth = 9999;

    const result = await manager.getProjectState(projectId);
    expect(result!.terminals[0].title).toBe("Terminal 1");
    expect(result!.sidebarWidth).toBe(350);
  });

  it("round-trips mruList through disk so per-project MRU is read back (#9922)", async () => {
    const state = makeState({ mruList: ["terminal:t1", "worktree:wt-2"] });
    await manager.saveProjectState(projectId, state);

    // Fresh manager forces a disk read (no in-memory cache) — proves the
    // reconstruction whitelist actually rehydrates mruList rather than dropping it.
    const freshManager = new ProjectStateManager(tempDir);
    const result = await freshManager.getProjectState(projectId);
    expect(result!.mruList).toEqual(["terminal:t1", "worktree:wt-2"]);
  });

  it("drops non-string mruList entries on read", async () => {
    const state = makeState();
    // Write a payload with a polluted mruList directly to disk.
    await manager.saveProjectState(projectId, {
      ...state,
      mruList: ["terminal:t1", 42, null, "worktree:wt-2"] as unknown as string[],
    });

    const freshManager = new ProjectStateManager(tempDir);
    const result = await freshManager.getProjectState(projectId);
    expect(result!.mruList).toEqual(["terminal:t1", "worktree:wt-2"]);
  });
});

describe("ProjectStateManager.enqueueProjectStateUpdate concurrency", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-queue-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/queue-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("concurrent updates to different fields both land (issue #9913)", async () => {
    await manager.saveProjectState(projectId, makeState({ tabGroups: [] }));
    manager.invalidateProjectStateCache(projectId);

    const newTerminals = [
      { id: "t9", title: "New", location: "grid" as const, kind: "terminal" as const, cwd: "/tmp" },
    ];
    const newTabGroups = [
      { id: "g1", location: "grid" as const, activeTabId: "t9", panelIds: ["t9"] },
    ];

    await Promise.all([
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        terminals: newTerminals,
      })),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        tabGroups: newTabGroups,
      })),
    ]);

    const result = await manager.getProjectState(projectId);
    expect(result!.terminals.map((t) => t.id)).toEqual(["t9"]);
    expect(result!.tabGroups).toEqual(newTabGroups);
  });

  it("each queued updater sees the previous update's committed state", async () => {
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 100 }));

    const seen: number[] = [];
    await Promise.all([
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing!.sidebarWidth);
        return { ...existing!, sidebarWidth: 200 };
      }),
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing!.sidebarWidth);
        return { ...existing!, sidebarWidth: existing!.sidebarWidth + 1 };
      }),
    ]);

    expect(seen).toEqual([100, 200]);
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(201);
  });

  it("a failing updater rejects its own caller but does not block later updates", async () => {
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 100 }));

    const failing = manager.enqueueProjectStateUpdate(projectId, () => {
      throw new Error("updater boom");
    });
    const following = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 400,
    }));

    await expect(failing).rejects.toThrow("updater boom");
    await expect(following).resolves.toBeUndefined();
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(400);
  });

  it("creates state through the queue when none exists yet", async () => {
    const seen: Array<ProjectState | null> = [];
    await manager.enqueueProjectStateUpdate(projectId, (existing) => {
      seen.push(existing);
      return makeState({ sidebarWidth: 777 });
    });

    expect(seen).toEqual([null]);
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(777);
  });

  it("updates for different projects do not serialize behind one another", async () => {
    const otherProjectId = generateProjectId("/test/queue-project-other");
    await fs.mkdir(path.join(tempDir, otherProjectId), { recursive: true });

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const order: string[] = [];

    const slow = manager.enqueueProjectStateUpdate(projectId, async () => {
      await gate;
      order.push("slow");
      return makeState();
    });
    const fast = manager.enqueueProjectStateUpdate(otherProjectId, () => {
      order.push("fast");
      return makeState({ projectId: otherProjectId });
    });

    await fast;
    expect(order).toEqual(["fast"]);

    releaseFirst();
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("both concurrent updates survive a disk read by a fresh manager instance", async () => {
    await Promise.all([
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...(existing ?? makeState()),
        sidebarWidth: 640,
      })),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...(existing ?? makeState()),
        draftInputs: { t1: "draft" },
      })),
    ]);

    const freshManager = new ProjectStateManager(tempDir);
    const result = await freshManager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(640);
    expect(result!.draftInputs).toEqual({ t1: "draft" });
  });

  it("sequential updates after the queue drains still see committed state", async () => {
    await manager.enqueueProjectStateUpdate(projectId, () => makeState({ sidebarWidth: 1 }));
    await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: existing!.sidebarWidth + 1,
    }));

    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(2);
  });
});

describe("ProjectStateManager.enqueueProjectStateUpdate coalescing", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-coalesce-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/coalesce-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 100 }));
  });

  afterEach(async () => {
    // The sweep interval keeps an undisposed manager (and its cached state)
    // reachable for the life of the run.
    manager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Hold the queue open on a first update, so everything enqueued while it is
   * parked lands in ONE batch behind it. Without the gate the updates race the
   * runner and the batch boundary is a timing accident.
   */
  function openQueue(options?: { persist?: boolean }): {
    release: () => void;
    parked: Promise<void>;
  } {
    const persist = options?.persist ?? true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const parked = manager.enqueueProjectStateUpdate(projectId, async (existing) => {
      await gate;
      // `persist: false` declines the write, so the batch behind this one owns
      // the only save the test performs — which is what lets a test make that
      // save fail without the parked update consuming the failure first.
      return persist ? { ...existing!, sidebarWidth: 1 } : null;
    });
    return { release, parked };
  }

  it("folds every update queued behind an in-flight save into one write", async () => {
    const saves = vi.spyOn(manager, "saveProjectState");
    const { release, parked } = openQueue();

    const folded = [
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        focusMode: true,
      })),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        activeWorktreeId: "wt-9",
      })),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        draftInputs: { t1: "typed" },
      })),
    ];

    release();
    await Promise.all([parked, ...folded]);

    // One for the parked update, one for the three that piled up behind it.
    expect(saves).toHaveBeenCalledTimes(2);

    // Every field survives: a save that wrote only the last updater's object
    // would still land the draft and silently drop the other two.
    const result = await manager.getProjectState(projectId);
    expect(result!.focusMode).toBe(true);
    expect(result!.activeWorktreeId).toBe("wt-9");
    expect(result!.draftInputs).toEqual({ t1: "typed" });
    expect(result!.sidebarWidth).toBe(1);
  });

  it("applies folded updaters in order, each seeing the previous one's result", async () => {
    const { release, parked } = openQueue();
    const seen: number[] = [];

    const folded = [10, 100, 1000].map((step) =>
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing!.sidebarWidth);
        return { ...existing!, sidebarWidth: existing!.sidebarWidth + step };
      })
    );

    release();
    await Promise.all([parked, ...folded]);

    // The parked update committed 1, then each folded updater reads the one
    // before it — from memory, since only the batch's final state is saved.
    expect(seen).toEqual([1, 11, 111]);
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(1111);
  });

  it("rejects only the folded updater that throws, and still saves the rest", async () => {
    const { release, parked } = openQueue();

    const before = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      activeWorktreeId: "wt-before",
    }));
    const boom = manager.enqueueProjectStateUpdate(projectId, () => {
      throw new Error("updater boom");
    });
    const after = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      focusMode: true,
    }));

    release();
    await parked;
    await expect(boom).rejects.toThrow("updater boom");
    await expect(before).resolves.toBeUndefined();
    await expect(after).resolves.toBeUndefined();

    const result = await manager.getProjectState(projectId);
    expect(result!.activeWorktreeId).toBe("wt-before");
    expect(result!.focusMode).toBe(true);
  });

  it("discards a mutation made by a folded updater that then returns null", async () => {
    const { release, parked } = openQueue();

    const vandal = manager.enqueueProjectStateUpdate(projectId, (existing) => {
      // shutdown.ts and projectSessionJournal.ts both mutate in place like
      // this. Declining the write afterwards has to undo it.
      existing!.terminals[0]!.title = "should not be persisted";
      return null;
    });
    const follower = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      focusMode: true,
    }));

    release();
    await Promise.all([parked, vandal, follower]);

    const result = await manager.getProjectState(projectId);
    expect(result!.terminals[0]!.title).toBe("Terminal 1");
    expect(result!.focusMode).toBe(true);
  });

  it("discards a mutation made by a folded updater that then throws", async () => {
    const { release, parked } = openQueue();

    const vandal = manager.enqueueProjectStateUpdate(projectId, (existing) => {
      existing!.terminals[0]!.title = "should not be persisted";
      throw new Error("after mutating");
    });
    const follower = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      focusMode: true,
    }));

    release();
    await parked;
    await expect(vandal).rejects.toThrow("after mutating");
    await follower;

    const result = await manager.getProjectState(projectId);
    expect(result!.terminals[0]!.title).toBe("Terminal 1");
  });

  it("rejects every folded caller whose update the failed save carried", async () => {
    const { release, parked } = openQueue({ persist: false });

    const folded = [
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        focusMode: true,
      })),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        activeWorktreeId: "wt-9",
      })),
    ];
    // Declined the write, so the failure below is not its failure.
    const abstainer = manager.enqueueProjectStateUpdate(projectId, () => null);

    const saves = vi.spyOn(manager, "saveProjectState");
    saves.mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));

    release();
    await parked;
    await expect(folded[0]).rejects.toThrow("ENOSPC");
    await expect(folded[1]).rejects.toThrow("ENOSPC");
    await expect(abstainer).resolves.toBeUndefined();
  });

  it("keeps serving a batch that was already queued when an earlier save failed", async () => {
    const { release, parked } = openQueue({ persist: false });

    let doomedStarted!: () => void;
    const started = new Promise<void>((resolve) => (doomedStarted = resolve));
    let releaseDoomed!: () => void;
    const doomedGate = new Promise<void>((resolve) => (releaseDoomed = resolve));

    vi.spyOn(manager, "saveProjectState").mockRejectedValueOnce(
      Object.assign(new Error("EPIPE"), { code: "EPIPE" })
    );

    const doomed = manager.enqueueProjectStateUpdate(projectId, async (existing) => {
      doomedStarted();
      await doomedGate;
      return { ...existing!, focusMode: true };
    });
    const alsoDoomed = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      activeWorktreeId: "wt-doomed",
    }));

    release();
    // The doomed batch is now running and frozen, so this lands in the NEXT
    // one — a batch the runner is already holding when the failure hits, rather
    // than a fresh enqueue after the queue went idle, which a runner that
    // dropped its followers on failure would also survive.
    await started;
    const follower = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 512,
    }));
    releaseDoomed();

    await parked;
    await expect(doomed).rejects.toThrow("EPIPE");
    await expect(alsoDoomed).rejects.toThrow("EPIPE");
    await expect(follower).resolves.toBeUndefined();

    // Nothing the failed batch produced was committed, so the follower built on
    // the last state that actually reached disk.
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(512);
    expect(result!.focusMode).toBeUndefined();
    expect(result!.activeWorktreeId).not.toBe("wt-doomed");
  });

  it("lets a batch queued across a completed deletion recreate the state", async () => {
    // The batch takes its read when the RUNNER picks it up, before any of its
    // updaters run — so gating inside an updater is too late to order this
    // against the delete. Hold the first batch instead: the followers cannot
    // start, and therefore cannot read, until it is released.
    const { release, parked } = openQueue({ persist: false });

    const seen: Array<ProjectState | null> = [];
    const followers = [
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing);
        return makeState({ projectId, sidebarWidth: 777 });
      }),
      manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        activeWorktreeId: "wt-after-delete",
      })),
    ];

    // Fully awaited while the queue is still parked, so the unlink and the
    // cache invalidation are both finished before the next batch can begin.
    await manager.clearProjectState(projectId);
    release();
    await parked;
    await Promise.all(followers);

    // The batch read AFTER the delete, so it started from nothing.
    expect(seen).toEqual([null]);
    const fresh = new ProjectStateManager(tempDir);
    const result = await fresh.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(777);
    expect(result!.activeWorktreeId).toBe("wt-after-delete");
    fresh.dispose();
  });

  it("drains in order when a shutdown awaits each project's update in turn", async () => {
    const otherProjectId = generateProjectId("/test/coalesce-project-other");
    await fs.mkdir(path.join(tempDir, otherProjectId), { recursive: true });

    const order: string[] = [];
    // The shutdown shape: one project at a time, each awaited to completion, so
    // every write is on disk before the next project starts.
    for (const [id, width] of [
      [projectId, 11],
      [otherProjectId, 22],
    ] as const) {
      await manager.enqueueProjectStateUpdate(id, (existing) => {
        order.push(id);
        return makeState({ ...existing, projectId: id, sidebarWidth: width });
      });
    }

    expect(order).toEqual([projectId, otherProjectId]);
    const fresh = new ProjectStateManager(tempDir);
    expect((await fresh.getProjectState(projectId))!.sidebarWidth).toBe(11);
    expect((await fresh.getProjectState(otherProjectId))!.sidebarWidth).toBe(22);
    fresh.dispose();
  });

  it("keeps folded callers pending until the save that carries them lands", async () => {
    const { release, parked } = openQueue({ persist: false });

    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
    const realSave = manager.saveProjectState.bind(manager);
    const saves = vi.spyOn(manager, "saveProjectState").mockImplementation(async (id, state) => {
      await saveGate;
      return realSave(id, state);
    });

    const settled: string[] = [];
    const a = manager
      .enqueueProjectStateUpdate(projectId, (existing) => ({ ...existing!, focusMode: true }))
      .then(() => settled.push("a"));
    const b = manager
      .enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        activeWorktreeId: "wt-9",
      }))
      .then(() => settled.push("b"));

    release();
    await parked;
    // Both updaters have run and the save is dispatched and blocked. Drain the
    // microtask queue: anything that was going to settle early would have.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([]);

    releaseSave();
    await Promise.all([a, b]);
    expect(settled).toEqual(["a", "b"]);
  });

  it("survives an updater whose result cannot be structured-cloned", async () => {
    const { release, parked } = openQueue({ persist: false });

    // A function is not transferable, so cloning this to hand it to the next
    // updater throws DataCloneError. Escaping the batch would kill the runner
    // and leave every caller — and everything queued behind — pending forever.
    const poisoner = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      onSomething: () => {},
    }));
    const follower = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      focusMode: true,
    }));

    release();
    await parked;
    // The guarantee is that everything SETTLES rather than hanging.
    const outcomes = await Promise.allSettled([poisoner, follower]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);

    // And the runner is still alive for the next update.
    await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 321,
    }));
    const result = await manager.getProjectState(projectId);
    expect(result!.sidebarWidth).toBe(321);
  });

  it("writes nothing when every folded updater declines", async () => {
    const { release, parked } = openQueue({ persist: false });
    const saves = vi.spyOn(manager, "saveProjectState");

    const declined = [
      manager.enqueueProjectStateUpdate(projectId, () => null),
      manager.enqueueProjectStateUpdate(projectId, () => null),
    ];

    release();
    await parked;
    await expect(Promise.all(declined)).resolves.toEqual([undefined, undefined]);
    expect(saves).not.toHaveBeenCalled();
  });

  it("writes nothing when every folded updater throws, and each caller gets its own error", async () => {
    const { release, parked } = openQueue({ persist: false });
    const saves = vi.spyOn(manager, "saveProjectState");

    const first = manager.enqueueProjectStateUpdate(projectId, () => {
      throw new Error("first boom");
    });
    const second = manager.enqueueProjectStateUpdate(projectId, () => {
      throw new Error("second boom");
    });

    release();
    await parked;
    await expect(first).rejects.toThrow("first boom");
    await expect(second).rejects.toThrow("second boom");
    expect(saves).not.toHaveBeenCalled();
  });

  it("picks up an update enqueued from inside a running updater", async () => {
    const { release, parked } = openQueue({ persist: false });

    let reentrant!: Promise<void>;
    const outer = manager.enqueueProjectStateUpdate(projectId, (existing) => {
      // Fire-and-forget from inside a running batch. It cannot join this batch,
      // which is already frozen, so it must be picked up by a later one rather
      // than left sitting in the queue with no runner.
      reentrant = manager.enqueueProjectStateUpdate(projectId, (later) => ({
        ...later!,
        activeWorktreeId: "wt-reentrant",
      }));
      return { ...existing!, focusMode: true };
    });
    const sibling = manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 246,
    }));

    release();
    await Promise.all([parked, outer, sibling]);
    await reentrant;

    const result = await manager.getProjectState(projectId);
    expect(result!.activeWorktreeId).toBe("wt-reentrant");
    expect(result!.focusMode).toBe(true);
    expect(result!.sidebarWidth).toBe(246);
  });

  it("still costs one save per update when nothing overlaps", async () => {
    const saves = vi.spyOn(manager, "saveProjectState");

    await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 2,
    }));
    await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 3,
    }));

    // Nothing to coalesce: each update was durable before the next was made.
    expect(saves).toHaveBeenCalledTimes(2);
  });
});

describe("ProjectStateManager telemetry", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    vi.mocked(withPerformanceSpan).mockClear();
    vi.mocked(markPerformance).mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-telemetry-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/telemetry-project");

    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("records a PROJECT_STATE_WRITE span with projectId and non-zero bytes on save", async () => {
    await manager.saveProjectState(projectId, makeState());

    const writeCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_WRITE);

    expect(writeCall).toBeDefined();
    const meta = writeCall![2] as { projectId: string; bytes: number };
    expect(meta.projectId).toBe(projectId);
    expect(meta.bytes).toBeGreaterThan(0);
  });

  it("records a PROJECT_STATE_READ span with projectId on disk-read load", async () => {
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);
    vi.mocked(withPerformanceSpan).mockClear();

    await manager.getProjectState(projectId);

    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);

    expect(readCall).toBeDefined();
    const meta = readCall![2] as { projectId: string };
    expect(meta.projectId).toBe(projectId);
  });

  it("does not emit PROJECT_STATE_READ on a cache hit", async () => {
    await manager.saveProjectState(projectId, makeState());
    await manager.getProjectState(projectId);
    vi.mocked(withPerformanceSpan).mockClear();

    await manager.getProjectState(projectId);

    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);
    expect(readCall).toBeUndefined();
  });

  it("still emits PROJECT_STATE_READ when the file is absent — captures the attempted read", async () => {
    // Removing the existsSync TOCTOU gate means every cache miss attempts the
    // read and lets ENOENT bubble up. The span correctly records that attempt
    // even though the result is null.
    const missingId = generateProjectId("/missing/telemetry-project");

    const result = await manager.getProjectState(missingId);

    expect(result).toBeNull();
    const readCall = vi
      .mocked(withPerformanceSpan)
      .mock.calls.find((call) => call[0] === PERF_MARKS.PROJECT_STATE_READ);
    expect(readCall).toBeDefined();
  });

  it("emits PROJECT_STATE_QUARANTINE when a corrupted state file is quarantined", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    expect(vi.mocked(markPerformance)).toHaveBeenCalledWith(PERF_MARKS.PROJECT_STATE_QUARANTINE, {
      projectId,
    });
  });
});

describe("ProjectStateManager quarantine recovery", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-recovery-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/recovery-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("surfaces the quarantined path when state JSON is invalid", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toMatch(/\.corrupted\.\d+$/);
    await expect(fs.access(result.quarantinedPath!)).resolves.toBeUndefined();
  });

  it("drains the quarantine signal after one read — subsequent reads return no path", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    const first = await manager.getProjectStateWithRecovery(projectId);
    expect(first.quarantinedPath).toMatch(/\.corrupted\.\d+$/);

    const second = await manager.getProjectStateWithRecovery(projectId);
    expect(second.state).toBeNull();
    expect(second.quarantinedPath).toBeUndefined();
  });

  it("returns no quarantinedPath when state is valid", async () => {
    await manager.saveProjectState(projectId, makeState());

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).not.toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
  });

  it("surfaces the quarantine when a preceding getProjectState() triggered it", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    // windowServices.ts-style caller reads state via the plain method — this
    // triggers quarantine but discards the recovery signal.
    const firstState = await manager.getProjectState(projectId);
    expect(firstState).toBeNull();

    // Hydration path later reads via the recovery-aware method and should
    // still receive the quarantined path.
    const result = await manager.getProjectStateWithRecovery(projectId);
    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toMatch(/\.corrupted\.\d+$/);
  });
});

describe("ProjectStateManager unreadable-session tracking", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-unreadable-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/unreadable-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not mark a project whose state file is absent (ENOENT)", async () => {
    expect(await manager.getProjectState(projectId)).toBeNull();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(false);
  });

  it("does not mark a project whose state reads back valid from disk", async () => {
    await manager.saveProjectState(projectId, makeState());
    // Drop the write-through cache so getProjectState exercises the real
    // disk-read path rather than returning the just-saved in-memory state.
    manager.invalidateProjectStateCache(projectId);

    expect(await manager.getProjectState(projectId)).not.toBeNull();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(false);
  });

  it("marks a project whose parsed state has a non-array terminals field", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(
      filePath,
      JSON.stringify({ projectId, terminals: { not: "an array" } }),
      "utf-8"
    );

    const state = await manager.getProjectState(projectId);

    // The state is still usable (terminals fall back to empty)...
    expect(state).not.toBeNull();
    expect(state!.terminals).toEqual([]);
    // ...but the incomplete enumeration must protect its restore files.
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });

  it("does not mark a project whose terminals field is absent (legitimately empty)", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, JSON.stringify({ projectId }), "utf-8");

    const state = await manager.getProjectState(projectId);

    expect(state).not.toBeNull();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(false);
  });

  it("marks a project whose state JSON is corrupt", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    await manager.getProjectState(projectId);

    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });

  it("marks a project whose state is a future schema version", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(
      filePath,
      JSON.stringify({ _schemaVersion: 99, projectId, terminals: [] }),
      "utf-8"
    );

    await manager.getProjectState(projectId);

    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });

  it("scopes the mark per project — an unrelated project stays unmarked", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");
    await manager.getProjectState(projectId);

    const otherId = generateProjectId("/test/healthy-project");
    await fs.mkdir(path.join(tempDir, otherId), { recursive: true });

    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
    expect(manager.wasStateUnreadableThisSession(otherId)).toBe(false);
  });

  it("keeps the mark across drain and a valid re-save (non-draining, append-only)", async () => {
    const filePath = stateFilePath(tempDir, projectId)!;
    await fs.writeFile(filePath, "{ not valid json", "utf-8");

    // First recovery read triggers quarantine and drains pendingQuarantines.
    const first = await manager.getProjectStateWithRecovery(projectId);
    expect(first.quarantinedPath).toMatch(/\.corrupted\.\d+$/);

    // Second recovery read proves pendingQuarantines was already drained...
    const second = await manager.getProjectStateWithRecovery(projectId);
    expect(second.quarantinedPath).toBeUndefined();

    // ...while the unreadable-session mark stays set across repeated peeks.
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);

    // And it survives a successful re-save + fresh disk read: recovering into a
    // valid (possibly empty) state does not prove the original terminal ids came
    // back, so the sweep stays conservative for the rest of the session.
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);
    expect(await manager.getProjectState(projectId)).not.toBeNull();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });
});

describe("ProjectStateManager schema version", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;
  let filePath: string;

  beforeEach(async () => {
    vi.mocked(markPerformance).mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-schema-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/schema-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
    filePath = stateFilePath(tempDir, projectId)!;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeRaw(content: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(content), "utf-8");
    manager.invalidateProjectStateCache(projectId);
  }

  it("reads a legacy unversioned file successfully", async () => {
    await writeRaw({
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);
    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(350);
  });

  it("reads a v1 file successfully", async () => {
    await writeRaw({
      _schemaVersion: 1,
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);
    expect(result).not.toBeNull();
  });

  it("quarantines a future-version file to .future-vN and returns null", async () => {
    await writeRaw({
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      mysteryNewField: "data we must not destroy",
    });

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    await expect(fs.access(`${filePath}.future-v2`)).resolves.toBeUndefined();
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(`${filePath}.corrupted`)).rejects.toThrow();
  });

  it("preserves the future-version file contents intact under the quarantine path", async () => {
    const original = {
      _schemaVersion: 99,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      futureFeature: { nested: ["a", "b"] },
    };
    await writeRaw(original);

    await manager.getProjectState(projectId);

    const preserved = JSON.parse(await fs.readFile(`${filePath}.future-v99`, "utf-8"));
    expect(preserved).toEqual(original);
  });

  it("emits PROJECT_STATE_QUARANTINE for future-version reads", async () => {
    await writeRaw({
      _schemaVersion: 2,
      projectId,
      terminals: [],
    });

    await manager.getProjectState(projectId);

    expect(vi.mocked(markPerformance)).toHaveBeenCalledWith(PERF_MARKS.PROJECT_STATE_QUARANTINE, {
      projectId,
    });
  });

  it("surfaces the future-version quarantine path through getProjectStateWithRecovery", async () => {
    await writeRaw({
      _schemaVersion: 7,
      projectId,
      terminals: [],
    });

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBe(`${filePath}.future-v7`);
  });

  it("stamps _schemaVersion on every save", async () => {
    await manager.saveProjectState(projectId, makeState());

    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw._schemaVersion).toBe(PROJECT_STATE_SCHEMA_VERSION);
  });

  it("does not leak _schemaVersion into the in-memory ProjectState returned to callers", async () => {
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>)._schemaVersion).toBeUndefined();
  });

  it("round-trips: save then invalidate cache then read returns equivalent state", async () => {
    const original = makeState();
    await manager.saveProjectState(projectId, original);
    manager.invalidateProjectStateCache(projectId);

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(original.sidebarWidth);
    expect(result!.terminals).toHaveLength(original.terminals.length);
    expect(result!.terminalSizes).toEqual(original.terminalSizes);
  });

  it("treats a non-numeric _schemaVersion as legacy v0 and reads successfully", async () => {
    await writeRaw({
      _schemaVersion: "2",
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
    expect(result!.sidebarWidth).toBe(350);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("treats a negative _schemaVersion as legacy v0 and reads successfully", async () => {
    await writeRaw({
      _schemaVersion: -1,
      projectId,
      sidebarWidth: 350,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).not.toBeNull();
  });

  it("preserves a prior quarantine when a second future-version file lands at the same version", async () => {
    const firstPayload = {
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      featureA: "first quarantine — must survive",
    };
    await writeRaw(firstPayload);
    await manager.getProjectState(projectId);

    const originalQuarantine = JSON.parse(await fs.readFile(`${filePath}.future-v2`, "utf-8"));
    expect(originalQuarantine).toEqual(firstPayload);

    const secondPayload = {
      _schemaVersion: 2,
      projectId,
      sidebarWidth: 350,
      terminals: [],
      featureA: "second quarantine — must NOT clobber the first",
    };
    await writeRaw(secondPayload);
    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    // Original quarantine still intact at the canonical path.
    const stillThere = JSON.parse(await fs.readFile(`${filePath}.future-v2`, "utf-8"));
    expect(stillThere).toEqual(firstPayload);

    // Second future-version file moved to a timestamp-suffixed sibling.
    const dir = path.dirname(filePath);
    const entries = await fs.readdir(dir);
    const suffixed = entries.find((name) => /^state\.json\.future-v2\.\d+$/.test(name));
    expect(suffixed).toBeDefined();
    const suffixedContent = JSON.parse(await fs.readFile(path.join(dir, suffixed!), "utf-8"));
    expect(suffixedContent).toEqual(secondPayload);
  });

  it("quarantines a very large future-version number to .future-v{N}", async () => {
    await writeRaw({
      _schemaVersion: 999999,
      projectId,
      terminals: [],
    });

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    await expect(fs.access(`${filePath}.future-v999999`)).resolves.toBeUndefined();
  });
});

describe("ProjectStateManager ENOENT race", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;
  let filePath: string;

  beforeEach(async () => {
    vi.mocked(markPerformance).mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-state-enoent-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/enoent-project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
    filePath = stateFilePath(tempDir, projectId)!;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns null without quarantining when state file disappears between cache miss and read", async () => {
    // Simulates the TOCTOU window: the file is gone by the time the disk read
    // happens. Before the fix, this would land in the corruption-recovery
    // branch and create a misleading .corrupted.* artifact.
    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();

    const projectDir = path.dirname(filePath);
    const entries = await fs.readdir(projectDir);
    expect(entries.find((name) => name.includes(".corrupted."))).toBeUndefined();
    expect(entries.find((name) => name.includes(".future-v"))).toBeUndefined();
    expect(vi.mocked(markPerformance)).not.toHaveBeenCalledWith(
      PERF_MARKS.PROJECT_STATE_QUARANTINE,
      expect.anything()
    );
  });

  it("does not surface a quarantinedPath when the state file is simply absent", async () => {
    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
  });

  it("returns null when file is unlinked between cache invalidation and disk read", async () => {
    await manager.saveProjectState(projectId, makeState());
    manager.invalidateProjectStateCache(projectId);

    // Race: file vanishes between the cache miss and the readFile call.
    await fs.unlink(filePath);

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    const entries = await fs.readdir(path.dirname(filePath));
    expect(entries.find((name) => name.includes(".corrupted."))).toBeUndefined();
  });
});

/**
 * The post-write hook behind the switcher's resume count (#11801). What matters
 * is that it reports exactly what reached disk, and never reports at all when a
 * write failed — a count describing state that isn't there is worse than a
 * stale one, because the row makes a promise nothing can keep.
 */
describe("ProjectStateManager state-persisted observer", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;
  let seen: { projectId: string; state: ProjectState | null }[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-observer-"));
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/observer");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });

    seen = [];
    manager.setStatePersistedObserver((id, state) => seen.push({ projectId: id, state }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports the state a successful save actually wrote", async () => {
    await manager.saveProjectState(projectId, makeState());

    expect(seen).toHaveLength(1);
    expect(seen[0].projectId).toBe(projectId);
    expect(seen[0].state?.terminals.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("reports the validated state, not the caller's, so derived values match disk", async () => {
    // An entry the snapshot schema rejects never lands on disk. An observer
    // handed the caller's array would count a panel that will not restore.
    const withJunk = makeState({
      terminals: [
        ...makeState().terminals,
        { id: "", title: "Invalid", location: "grid", kind: "terminal" } as never,
      ],
    });

    await manager.saveProjectState(projectId, withJunk);

    const onDisk = await manager.getProjectState(projectId);
    expect(seen[0].state?.terminals.map((t) => t.id)).toEqual(onDisk?.terminals.map((t) => t.id));
  });

  it("stays silent when the write fails", async () => {
    // An invalid project id can't resolve a state path, so nothing is written.
    await expect(manager.saveProjectState("../escape", makeState())).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("reports emptiness when the state is cleared away", async () => {
    await manager.saveProjectState(projectId, makeState());
    seen = [];

    await manager.clearProjectState(projectId);

    expect(seen).toEqual([{ projectId, state: null }]);
  });

  it("reports emptiness when there was nothing to clear", async () => {
    // Already absent is the state the caller asked for, so it is just as
    // authoritative as an unlink that did work.
    await manager.clearProjectState(projectId);
    expect(seen).toEqual([{ projectId, state: null }]);
  });

  it("does not let an observer failure fail the save", async () => {
    manager.setStatePersistedObserver(() => {
      throw new Error("derived metadata write failed");
    });

    // The file is committed before the hook runs; reporting the save as failed
    // would make the caller retry a write that already succeeded.
    await expect(manager.saveProjectState(projectId, makeState())).resolves.toBeUndefined();
    expect(await manager.getProjectState(projectId)).not.toBeNull();
  });

  it("stops reporting once detached", async () => {
    manager.setStatePersistedObserver(null);
    await manager.saveProjectState(projectId, makeState());
    expect(seen).toHaveLength(0);
  });
});
