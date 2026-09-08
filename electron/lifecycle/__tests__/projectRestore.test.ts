/**
 * The startup background-project restore queue (#12320).
 *
 * The rules here are the ones that are silent when they break: a second boot
 * starting before the first finished, a window's remaining projects surviving
 * its close, and the pending set that keeps the manifest describing what the
 * session is becoming rather than the partial state it is in mid-boot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setPendingBackgroundRestores = vi.fn<(windowId: number, ids: readonly string[]) => void>();
const clearPendingBackgroundRestores = vi.fn<(windowId: number) => void>();

// Explicit factory rather than importOriginal(): the real tracker reaches the
// store (better-sqlite3) and shutdownCoordinator (electron), either of which
// turns this into a suite that passes locally and fails on CI.
vi.mock("../../window/openWindowsTracker.js", () => ({
  setPendingBackgroundRestores: (windowId: number, ids: readonly string[]) =>
    setPendingBackgroundRestores(windowId, ids),
  clearPendingBackgroundRestores: (windowId: number) => clearPendingBackgroundRestores(windowId),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  cancelBackgroundRestores,
  enqueueBackgroundRestores,
  resetBackgroundRestoreQueueForTests,
  type BackgroundRestoreJob,
} from "../projectRestore.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

type RestoreResult = Awaited<ReturnType<ProjectViewManager["restoreInBackground"]>>;

interface FakeManager {
  manager: ProjectViewManager;
  calls: string[];
  /** Settle the oldest outstanding restore. */
  settle: (result?: RestoreResult) => void;
  outstanding: () => number;
  dispose: () => void;
}

function createFakeManager(): FakeManager {
  const calls: string[] = [];
  const pending: Array<(result: RestoreResult) => void> = [];
  let disposed = false;

  const manager = {
    get disposed() {
      return disposed;
    },
    restoreInBackground: (projectId: string) => {
      calls.push(projectId);
      return new Promise<RestoreResult>((resolve) => pending.push(resolve));
    },
  } as unknown as ProjectViewManager;

  return {
    manager,
    calls,
    settle: (result = { status: "restored" }) => {
      const next = pending.shift();
      next?.(result);
    },
    outstanding: () => pending.length,
    dispose: () => {
      disposed = true;
    },
  };
}

function job(overrides: Partial<BackgroundRestoreJob> & Pick<BackgroundRestoreJob, "getManager">) {
  return {
    windowId: 1,
    projectIds: ["a", "b"],
    resolveWorkspacePath: (id: string) => `/${id}`,
    ...overrides,
  } satisfies BackgroundRestoreJob;
}

/** Let the queue's awaits and its setImmediate yield run. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

beforeEach(() => {
  resetBackgroundRestoreQueueForTests();
  setPendingBackgroundRestores.mockClear();
  clearPendingBackgroundRestores.mockClear();
});

afterEach(() => {
  resetBackgroundRestoreQueueForTests();
});

describe("enqueueBackgroundRestores", () => {
  it("boots one project at a time", async () => {
    // Two React cold boots at once on a machine that just started N renderers
    // makes both slower without making either finish sooner.
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager }));
    await tick();

    expect(fake.calls).toEqual(["a"]);
    expect(fake.outstanding()).toBe(1);

    fake.settle();
    await tick();
    expect(fake.calls).toEqual(["a", "b"]);
  });

  it("restores in the order it was given", async () => {
    const fake = createFakeManager();
    enqueueBackgroundRestores(
      job({ getManager: () => fake.manager, projectIds: ["newest", "middle", "oldest"] })
    );
    await tick();
    fake.settle();
    await tick();
    fake.settle();
    await tick();
    expect(fake.calls).toEqual(["newest", "middle", "oldest"]);
  });

  it("finishes one window's projects before starting the next window's", async () => {
    const first = createFakeManager();
    const second = createFakeManager();
    enqueueBackgroundRestores(
      job({ windowId: 1, getManager: () => first.manager, projectIds: ["a"] })
    );
    enqueueBackgroundRestores(
      job({ windowId: 2, getManager: () => second.manager, projectIds: ["z"] })
    );
    await tick();

    expect(second.calls).toEqual([]);
    first.settle();
    await tick();
    expect(second.calls).toEqual(["z"]);
  });

  it("narrows the pending set as each project comes back", async () => {
    // A manifest written mid-restore must describe what is left to do, not
    // re-promise what is already back.
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds: ["a", "b", "c"] }));
    await tick();

    expect(setPendingBackgroundRestores.mock.calls[0]).toEqual([1, ["a", "b", "c"]]);
    expect(setPendingBackgroundRestores.mock.calls.at(-1)).toEqual([1, ["b", "c"]]);

    fake.settle();
    await tick();
    expect(setPendingBackgroundRestores.mock.calls.at(-1)).toEqual([1, ["c"]]);
  });

  it("clears the pending set once a window's pass drains", async () => {
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds: ["a"] }));
    await tick();
    fake.settle();
    await tick();
    expect(clearPendingBackgroundRestores).toHaveBeenCalledWith(1);
  });

  it("skips a workspace that no longer exists without stopping the pass", async () => {
    // Skipped, never substituted — the same rule the window restore follows.
    const fake = createFakeManager();
    enqueueBackgroundRestores(
      job({
        getManager: () => fake.manager,
        projectIds: ["gone", "b"],
        resolveWorkspacePath: (id) => (id === "gone" ? null : `/${id}`),
      })
    );
    await tick();
    expect(fake.calls).toEqual(["b"]);
  });

  it("abandons a window's remaining projects once it hits its warm-view ceiling", async () => {
    // Every remaining project would hit the same wall, and their agents are
    // still running and still resumable the moment the user opens them.
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds: ["a", "b", "c"] }));
    await tick();
    fake.settle({ status: "deferred", reason: "capacity" });
    await tick();

    expect(fake.calls).toEqual(["a"]);
    expect(clearPendingBackgroundRestores).toHaveBeenCalledWith(1);
  });

  it("drops a window's remaining projects when its manager is disposed while queued", async () => {
    // The manager is read lazily at execution time precisely so a window that
    // closes while its projects wait in line takes them with it, rather than
    // booting renderers into a destroyed window.
    const first = createFakeManager();
    const closing = createFakeManager();
    const third = createFakeManager();
    enqueueBackgroundRestores(
      job({ windowId: 1, getManager: () => first.manager, projectIds: ["a"] })
    );
    enqueueBackgroundRestores(
      job({ windowId: 2, getManager: () => closing.manager, projectIds: ["b", "c"] })
    );
    enqueueBackgroundRestores(
      job({ windowId: 3, getManager: () => third.manager, projectIds: ["z"] })
    );
    await tick();

    // Window 2's job is queued behind window 1's in-flight boot.
    closing.dispose();
    first.settle();
    await tick();

    expect(closing.calls).toEqual([]);
    expect(clearPendingBackgroundRestores).toHaveBeenCalledWith(2);
    expect(third.calls).toEqual(["z"]);
  });

  it("survives a restore that throws", async () => {
    const throwing = {
      disposed: false,
      restoreInBackground: vi.fn(() => Promise.reject(new Error("boom"))),
    } as unknown as ProjectViewManager;
    enqueueBackgroundRestores(job({ getManager: () => throwing, projectIds: ["a", "b"] }));
    await tick();
    expect(throwing.restoreInBackground).toHaveBeenCalledTimes(2);
  });

  it("ignores an empty project list", () => {
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds: [] }));
    expect(setPendingBackgroundRestores).not.toHaveBeenCalled();
  });

  it("copies the list it was given, so the caller's array is not mutated", async () => {
    const fake = createFakeManager();
    const projectIds = ["a", "b"];
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds }));
    await tick();
    expect(projectIds).toEqual(["a", "b"]);
  });
});

describe("cancelBackgroundRestores", () => {
  it("drops queued work and its pending intent", async () => {
    // A project still queued when the quit commits was never restored, so
    // persisting it as pending would promise the next launch a fleet this one
    // did not have.
    const fake = createFakeManager();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager, projectIds: ["a", "b", "c"] }));
    await tick();
    cancelBackgroundRestores();

    expect(clearPendingBackgroundRestores).toHaveBeenCalledWith(1);
    fake.settle();
    await tick();
    expect(fake.calls).toEqual(["a"]);
  });

  it("refuses further enqueues once stopped", () => {
    const fake = createFakeManager();
    cancelBackgroundRestores();
    enqueueBackgroundRestores(job({ getManager: () => fake.manager }));
    expect(setPendingBackgroundRestores).not.toHaveBeenCalled();
  });
});

describe("restore recency", () => {
  it("steps lastUsed further back with each project, preserving the given order", async () => {
    // The queue consumes `projectIds` destructively, so deriving recency from
    // the remaining length would hand the LEAST recently used project the
    // NEWEST timestamp and invert the LRU order the manifest recorded.
    const seen: number[] = [];
    const manager = {
      disposed: false,
      restoreInBackground: vi.fn((_id: string, _path: string, opts: { lastUsed: number }) => {
        seen.push(opts.lastUsed);
        return Promise.resolve({ status: "restored" } as RestoreResult);
      }),
    } as unknown as ProjectViewManager;

    enqueueBackgroundRestores(
      job({ getManager: () => manager, projectIds: ["newest", "middle", "oldest"] })
    );
    await tick();

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeGreaterThan(seen[1]);
    expect(seen[1]).toBeGreaterThan(seen[2]);
  });

  it("holds the order even when a boot takes longer than the rank step", async () => {
    // The failure this guards: reading Date.now() per project instead of a
    // fixed epoch lets wall-clock advance beat the one-second step, so a first
    // boot taking three seconds leaves the SECOND, older project with the
    // newer timestamp — inverting the LRU order the manifest recorded.
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      const pending: Array<(result: RestoreResult) => void> = [];
      const manager = {
        disposed: false,
        restoreInBackground: vi.fn((_id: string, _path: string, opts: { lastUsed: number }) => {
          seen.push(opts.lastUsed);
          return new Promise<RestoreResult>((resolve) => pending.push(resolve));
        }),
      } as unknown as ProjectViewManager;

      enqueueBackgroundRestores(
        job({ getManager: () => manager, projectIds: ["newest", "older"] })
      );
      await vi.advanceTimersByTimeAsync(0);

      // The first boot takes far longer than the step between ranks.
      await vi.advanceTimersByTimeAsync(5_000);
      pending.shift()?.({ status: "restored" });
      await vi.advanceTimersByTimeAsync(0);

      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeGreaterThan(seen[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("queue error containment", () => {
  it("keeps draining when resolving a workspace throws", async () => {
    // The resolver runs a synchronous database lookup. Before this boundary
    // existed, a throw rejected `drain()` itself — which is launched
    // fire-and-forget — killing the queue for every remaining window.
    const fake = createFakeManager();
    enqueueBackgroundRestores(
      job({
        getManager: () => fake.manager,
        projectIds: ["explodes", "b"],
        resolveWorkspacePath: (id) => {
          if (id === "explodes") throw new Error("database is locked");
          return `/${id}`;
        },
      })
    );
    await tick();
    expect(fake.calls).toEqual(["b"]);
  });

  it("keeps draining when reading the manager throws", async () => {
    const other = createFakeManager();
    enqueueBackgroundRestores(
      job({
        windowId: 1,
        getManager: () => {
          throw new Error("window registry is disposing");
        },
        projectIds: ["a"],
      })
    );
    enqueueBackgroundRestores(
      job({ windowId: 2, getManager: () => other.manager, projectIds: ["z"] })
    );
    await tick();
    expect(other.calls).toEqual(["z"]);
  });
});

describe("cancelling an in-flight boot", () => {
  it("aborts the manager whose restore is already running", async () => {
    // A restore mid-hydration when the quit commits would otherwise go on to
    // respawn agents after `gracefulKillByProject` already swept that project,
    // leaving PTYs the capture pass never sees again.
    const cancelBackgroundRestoresOnManager = vi.fn();
    const manager = {
      disposed: false,
      restoreInBackground: vi.fn(() => new Promise<RestoreResult>(() => {})),
      cancelBackgroundRestores: cancelBackgroundRestoresOnManager,
    } as unknown as ProjectViewManager;

    enqueueBackgroundRestores(job({ getManager: () => manager, projectIds: ["a"] }));
    await tick();
    cancelBackgroundRestores();

    expect(cancelBackgroundRestoresOnManager).toHaveBeenCalledTimes(1);
  });

  it("survives a manager that throws while being cancelled", async () => {
    const manager = {
      disposed: false,
      restoreInBackground: vi.fn(() => new Promise<RestoreResult>(() => {})),
      cancelBackgroundRestores: vi.fn(() => {
        throw new Error("already tearing down");
      }),
    } as unknown as ProjectViewManager;

    enqueueBackgroundRestores(job({ getManager: () => manager, projectIds: ["a"] }));
    await tick();
    expect(() => cancelBackgroundRestores()).not.toThrow();
  });
});
