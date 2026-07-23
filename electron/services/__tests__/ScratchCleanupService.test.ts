import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  runScratchCleanup,
  inspectScratchForCleanup,
  type ScratchCleanupStore,
  type ScratchCleanupSafetyCheck,
  type ScratchCleanupSafetyDecision,
} from "../ScratchCleanupService.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";
import {
  SCRATCH_CLEANUP_TTL_MS as SCRATCH_TTL_MS,
  SCRATCH_CLEANUP_GRACE_MS as GRACE_MS,
} from "../../../shared/config/scratchCleanup.js";
import { createHardenedGit } from "../../utils/hardenedGit.js";
import type { ScratchRow } from "../persistence/schema.js";

const scratchTestRoot = { current: "" };

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../scratchStorePaths.js", () => ({
  isValidScratchId: (id: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
  getScratchesRoot: () => scratchTestRoot.current,
  getScratchDir: (root: string, id: string) => root + "/" + id,
}));

// Fully replace hardenedGit so the default classifier's git branch is driven by
// a mock and no real git process is ever spawned. GIT_BLOCK_TIMEOUT_MS is a
// plain constant the sweep only feeds to setTimeout, so a fixed stand-in is fine.
vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(),
  GIT_BLOCK_TIMEOUT_MS: 30_000,
}));

const mockedCreateHardenedGit = vi.mocked(createHardenedGit);

interface GitMock {
  checkIsRepo: Mock;
  status: Mock;
  stashList: Mock;
  raw: Mock;
}

/** Stub the next `createHardenedGit` with a repo of the given shape. Returns the
 * mock so tests can assert which probes ran. */
function mockGit(
  opts: { isRepo?: boolean; files?: unknown[]; stashTotal?: number; localCommits?: string } = {}
): GitMock {
  const git: GitMock = {
    checkIsRepo: vi.fn(async () => opts.isRepo ?? true),
    status: vi.fn(async () => ({ files: opts.files ?? [] })),
    stashList: vi.fn(async () => ({ total: opts.stashTotal ?? 0, all: [], latest: null })),
    raw: vi.fn(async () => `${opts.localCommits ?? "0"}\n`),
  };
  mockedCreateHardenedGit.mockResolvedValue(
    git as unknown as Awaited<ReturnType<typeof createHardenedGit>>
  );
  return git;
}

interface FakeStore extends ScratchCleanupStore {
  rows: ScratchRow[];
  currentScratchId: string | null;
}

function makeStore(rows: ScratchRow[], currentScratchId: string | null = null): FakeStore {
  const store: FakeStore = {
    rows,
    currentScratchId,
    getStaleScratchCandidates(cutoffMs: number) {
      return store.rows.filter(
        (r) => (r.lastOpened < cutoffMs && r.deletedAt == null) || r.deletedAt != null
      );
    },
    tombstoneScratch(scratchId: string, deletedAt: number) {
      const r = store.rows.find((x) => x.id === scratchId);
      if (!r) throw new Error(`not found: ${scratchId}`);
      r.deletedAt = deletedAt;
    },
    hardDeleteScratch(scratchId: string) {
      const idx = store.rows.findIndex((x) => x.id === scratchId);
      if (idx === -1) throw new Error(`not found: ${scratchId}`);
      store.rows.splice(idx, 1);
    },
    getCurrentScratchId() {
      return store.currentScratchId;
    },
    clearCurrentScratch() {
      store.currentScratchId = null;
    },
  };
  return store;
}

function row(overrides: Partial<ScratchRow> & Pick<ScratchRow, "id" | "path">): ScratchRow {
  return {
    id: overrides.id,
    path: overrides.path,
    name: overrides.name ?? "test scratch",
    createdAt: overrides.createdAt ?? 0,
    lastOpened: overrides.lastOpened ?? 0,
    deletedAt: overrides.deletedAt ?? null,
  };
}

/** A safety check that always allows deletion — exercises orchestration without
 * spawning git. */
const ALWAYS_SAFE: ScratchCleanupSafetyCheck = async () => ({
  disposition: "safe",
  reason: "test-safe",
});

/** A safety check that always protects — simulates "live work found". */
const ALWAYS_PROTECT: ScratchCleanupSafetyCheck = async () => ({
  disposition: "protect",
  reason: "test-protect",
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scratch-cleanup-test-"));
  scratchTestRoot.current = tmpDir;
  mockedCreateHardenedGit.mockReset();
});

afterEach(async () => {
  // Restore fs.* spies before the real-fs teardown, so a mid-test assertion
  // failure can never leave a one-shot fs.rm/readdir mock stubbing teardown.
  vi.restoreAllMocks();
  resetWritesSuppressedForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("runScratchCleanup — phase 2 (inspect + tombstone)", () => {
  it("does not touch scratches younger than the TTL and never inspects them", async () => {
    const dir = path.join(tmpDir, "fresh");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "fresh", path: dir, lastOpened: NOW - SCRATCH_TTL_MS / 2 }),
    ]);
    const check = vi.fn(ALWAYS_SAFE);

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("tombstones a stale abandoned scratch but preserves its directory", async () => {
    const dir = path.join(tmpDir, "stale");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hello");
    const store = makeStore([
      row({ id: "stale", path: dir, lastOpened: NOW - (SCRATCH_TTL_MS + 86_400_000) }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.tombstoned).toBe(1);
    expect(result.directoriesRemoved).toBe(0);
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    // The directory survives until a later sweep past the grace window.
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("leaves a scratch alone when the safety check protects it", async () => {
    const dir = path.join(tmpDir, "protected");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "protected", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_PROTECT);

    expect(result.tombstoned).toBe(0);
    expect(result.protectedCount).toBe(1);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("skips rows with falsy lastOpened without inspecting them (PR #3721 lesson)", async () => {
    const store = makeStore([row({ id: "zero", path: tmpDir, lastOpened: 0 })]);
    const check = vi.fn(ALWAYS_SAFE);

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("respects the 30-day boundary at exactly the cutoff", async () => {
    // lastOpened == cutoff is NOT stale (sweep uses `<`).
    const at = path.join(tmpDir, "boundary");
    await fs.mkdir(at, { recursive: true });
    const store = makeStore([row({ id: "boundary", path: at, lastOpened: NOW - SCRATCH_TTL_MS })]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.candidates).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("inspects only the non-active stale scratch and tombstones it", async () => {
    const activeDir = path.join(tmpDir, "active");
    await fs.mkdir(activeDir, { recursive: true });
    const otherDir = path.join(tmpDir, "other");
    await fs.mkdir(otherDir, { recursive: true });
    const store = makeStore(
      [
        row({ id: "active", path: activeDir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
        row({ id: "other", path: otherDir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
      ],
      "active"
    );
    const check = vi.fn(ALWAYS_SAFE);

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(1);
    // The active scratch is never even inspected.
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toContain("other");
    expect(store.rows.find((r) => r.id === "active")!.deletedAt).toBeNull();
    expect(store.rows.find((r) => r.id === "other")!.deletedAt).toBe(NOW);
    await expect(fs.access(activeDir)).resolves.toBeUndefined();
    await expect(fs.access(otherDir)).resolves.toBeUndefined();
  });

  it("does not tombstone a candidate whose lastOpened became fresh during inspection", async () => {
    const dir = path.join(tmpDir, "reopened");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "reopened", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    // Only lastOpened is refreshed (the user opened it); the current pointer is
    // left null to isolate the stale-recheck guard.
    const check: ScratchCleanupSafetyCheck = async () => {
      store.rows[0]!.lastOpened = NOW;
      return { disposition: "safe", reason: "test-safe" };
    };

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("does not tombstone a candidate that became current during inspection", async () => {
    const dir = path.join(tmpDir, "became-current");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "became-current", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    // Only the current pointer changes (lastOpened stays stale) to isolate the
    // current-scratch guard.
    const check: ScratchCleanupSafetyCheck = async () => {
      store.currentScratchId = "became-current";
      return { disposition: "safe", reason: "test-safe" };
    };

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("protects a candidate whose inspection throws, without aborting the batch", async () => {
    const boomDir = path.join(tmpDir, "boom");
    await fs.mkdir(boomDir, { recursive: true });
    const okDir = path.join(tmpDir, "ok");
    await fs.mkdir(okDir, { recursive: true });
    const store = makeStore([
      row({ id: "boom", path: boomDir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
      row({ id: "ok", path: okDir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    const check: ScratchCleanupSafetyCheck = async (dir) => {
      if (dir.includes("boom")) throw new Error("kaboom");
      return { disposition: "safe", reason: "test-safe" };
    };

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.protectedCount).toBe(1);
    expect(result.tombstoned).toBe(1);
    expect(store.rows.find((r) => r.id === "boom")!.deletedAt).toBeNull();
    expect(store.rows.find((r) => r.id === "ok")!.deletedAt).toBe(NOW);
  });

  it("protects a candidate whose inspection never settles once the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const dir = path.join(tmpDir, "hang");
      const store = makeStore([
        row({ id: "hang", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
      ]);
      const check: ScratchCleanupSafetyCheck = () =>
        new Promise<ScratchCleanupSafetyDecision>(() => {
          /* never settles — only the runner's abort timeout can end it */
        });

      const pending = runScratchCleanup(NOW, store, check);
      await vi.runAllTimersAsync(); // fire the inspection abort timeout
      const result = await pending;

      expect(result.protectedCount).toBe(1);
      expect(result.tombstoned).toBe(0);
      expect(store.rows[0]!.deletedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one concurrency-3 budget across concurrent sweeps (module-scoped queue)", async () => {
    const makeRows = (prefix: string) =>
      Array.from({ length: 4 }, (_, i) =>
        row({
          id: `${prefix}${i}`,
          path: path.join(tmpDir, `${prefix}${i}`),
          lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        })
      );
    const storeA = makeStore(makeRows("a"));
    const storeB = makeStore(makeRows("b"));

    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check: ScratchCleanupSafetyCheck = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await barrier;
      active -= 1;
      return { disposition: "safe", reason: "test-safe" };
    };

    const sweepA = runScratchCleanup(NOW, storeA, check);
    const sweepB = runScratchCleanup(NOW, storeB, check);
    // Let the shared queue saturate — 8 tasks, 3 slots.
    await new Promise((r) => setTimeout(r, 30));
    // A per-sweep queue would allow 6 concurrent; the module-scoped one caps at 3.
    expect(maxActive).toBe(3);

    release();
    await Promise.all([sweepA, sweepB]);
    expect(maxActive).toBe(3);
  });
});

describe("runScratchCleanup — phase 1 (reap after grace)", () => {
  it("reaps a tombstoned scratch whose grace window has elapsed", async () => {
    const dir = path.join(tmpDir, "mature");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "left.txt"), "leftover");
    const store = makeStore([
      row({
        id: "mature",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("does not reap a tombstone still inside the grace window", async () => {
    const dir = path.join(tmpDir, "young-tombstone");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({
        id: "young-tombstone",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - GRACE_MS / 2,
      }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.directoriesRemoved).toBe(0);
    expect(store.rows).toHaveLength(1);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("treats a tombstone at exactly the grace cutoff as not-yet-ready", async () => {
    // Uses strict `<`: deletedAt == reapCutoff is inside the window.
    const dir = path.join(tmpDir, "edge");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({
        id: "edge",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - GRACE_MS,
      }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.directoriesRemoved).toBe(0);
    expect(store.rows).toHaveLength(1);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("hard-deletes a mature tombstone whose directory is already missing", async () => {
    const store = makeStore([
      row({
        id: "gone",
        path: path.join(tmpDir, "missing"),
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
    ]);

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
  });

  it("finishes a mature tombstoned-current scratch when removeScratch crashed mid-flight", async () => {
    // removeScratch tombstones, clears the current pointer, then rms. If it dies
    // between the tombstone and clearCurrentScratch, a later sweep sees a
    // tombstoned row whose ID still equals currentScratchId; once past grace it
    // must be reaped, not protected by the active-scratch guard.
    const dir = path.join(tmpDir, "stranded");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore(
      [
        row({
          id: "stranded",
          path: dir,
          lastOpened: NOW - 1000,
          deletedAt: NOW - 2 * GRACE_MS,
        }),
      ],
      "stranded"
    );

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.candidates).toBe(1);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
    expect(store.currentScratchId).toBeNull();
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("leaves the row tombstoned when reap fs.rm fails, then completes on a retry sweep", async () => {
    const dir = path.join(tmpDir, "retry");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "x.txt"), "data");
    const store = makeStore([
      row({
        id: "retry",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
    ]);

    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("EPERM"));

    const first = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(first.directoriesRemoved).toBe(0);
    expect(first.directoriesFailed).toBe(1);
    expect(store.rows).toHaveLength(1);
    await expect(fs.access(dir)).resolves.toBeUndefined();

    rmSpy.mockRestore();

    const second = await runScratchCleanup(NOW + 1, store, ALWAYS_SAFE);

    expect(second.directoriesRemoved).toBe(1);
    expect(second.directoriesFailed).toBe(0);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("tombstones this sweep, then reaps on a later sweep past the grace window", async () => {
    const dir = path.join(tmpDir, "two-sweep");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "data");
    const store = makeStore([
      row({ id: "two-sweep", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const first = await runScratchCleanup(NOW, store, ALWAYS_SAFE);
    expect(first.tombstoned).toBe(1);
    expect(first.directoriesRemoved).toBe(0);
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    await expect(fs.access(dir)).resolves.toBeUndefined();

    const second = await runScratchCleanup(NOW + 2 * GRACE_MS, store, ALWAYS_SAFE);
    expect(second.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("reaps a mature tombstone and tombstones a live stale row in the same sweep", async () => {
    const matureDir = path.join(tmpDir, "batch-mature");
    await fs.mkdir(matureDir, { recursive: true });
    const liveDir = path.join(tmpDir, "batch-live");
    await fs.mkdir(liveDir, { recursive: true });
    const store = makeStore([
      row({
        id: "batch-mature",
        path: matureDir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
      row({ id: "batch-live", path: liveDir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    const check = vi.fn(ALWAYS_SAFE);

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.candidates).toBe(2);
    expect(result.directoriesRemoved).toBe(1);
    expect(result.tombstoned).toBe(1);
    // The safety check runs only for the live-stale row, never the tombstone.
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toContain("batch-live");
    expect(store.rows.find((r) => r.id === "batch-mature")).toBeUndefined();
    expect(store.rows.find((r) => r.id === "batch-live")!.deletedAt).toBe(NOW);
    await expect(fs.access(matureDir)).rejects.toBeDefined();
    await expect(fs.access(liveDir)).resolves.toBeUndefined();
  });
});

describe("runScratchCleanup — disk-pressure suppression (#9537/#11353)", () => {
  it("tombstones unconditionally under suppression but does not reap the fresh directory", async () => {
    const dir = path.join(tmpDir, "suppressed");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "data");
    const store = makeStore([
      row({ id: "suppressed", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    const tombstoneSpy = vi.spyOn(store, "tombstoneScratch");

    setWritesSuppressed(true);
    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    // The tombstone write is now unconditional so no live row dangles at a
    // directory that is about to be reaped — this is the #11353 fix.
    expect(tombstoneSpy).toHaveBeenCalledWith("suppressed", NOW);
    expect(result.tombstoned).toBe(1);
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    // The directory is untouched — it will be reaped on a later sweep past grace.
    expect(result.directoriesRemoved).toBe(0);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("still inspects (and protects) live work under suppression — suppression never bypasses the gate", async () => {
    const dir = path.join(tmpDir, "suppressed-dirty");
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    mockGit({ files: [{ path: "wip.ts" }] });
    const store = makeStore([
      row({ id: "suppressed-dirty", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    setWritesSuppressed(true);
    const result = await runScratchCleanup(NOW, store); // default classifier

    expect(result.protectedCount).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("reaps a mature tombstone under suppression but defers the hard-delete", async () => {
    const dir = path.join(tmpDir, "mature-suppressed");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({
        id: "mature-suppressed",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
    ]);
    const hardDeleteSpy = vi.spyOn(store, "hardDeleteScratch");

    setWritesSuppressed(true);
    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    // Space is reclaimed, but the hidden row lingers until writes resume.
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(result.directoriesRemoved).toBe(1);
    await expect(fs.access(dir)).rejects.toBeDefined();

    // Once writes resume, the lingering row is finished on the next sweep.
    resetWritesSuppressedForTesting();
    const second = await runScratchCleanup(NOW + 1, store, ALWAYS_SAFE);
    expect(second.candidates).toBe(1);
    expect(store.rows).toHaveLength(0);
  });

  it("re-reads suppression at each reap write point, not once at entry", async () => {
    const dir = path.join(tmpDir, "flip");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({
        id: "flip",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 2 * GRACE_MS,
      }),
    ]);
    const hardDeleteSpy = vi.spyOn(store, "hardDeleteScratch");

    // Start suppressed, then lift suppression during the async fs.rm — the guard
    // re-read after the event-loop yield must see the new value.
    setWritesSuppressed(true);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementationOnce(async () => {
      setWritesSuppressed(false);
    });

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.directoriesRemoved).toBe(1);
    expect(hardDeleteSpy).toHaveBeenCalledWith("flip");
    expect(store.rows).toHaveLength(0);

    rmSpy.mockRestore();
  });
});

describe("inspectScratchForCleanup — default safety classifier", () => {
  const cutoff = NOW - SCRATCH_TTL_MS;

  function freshSignal(): AbortSignal {
    return new AbortController().signal;
  }

  async function makeGitDir(name: string): Promise<string> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    return dir;
  }

  it("protects a git repo with uncommitted or untracked changes", async () => {
    const dir = await makeGitDir("dirty");
    mockGit({ files: [{ path: "a.txt" }] });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("dirty-git");
  });

  it("protects a git repo with stashed work", async () => {
    const dir = await makeGitDir("stashed");
    const git = mockGit({ files: [], stashTotal: 2 });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("stashed-work");
    expect(git.raw).not.toHaveBeenCalled(); // short-circuits before rev-list
  });

  it("protects a git repo with unpushed local-only commits", async () => {
    const dir = await makeGitDir("unpushed");
    mockGit({ files: [], stashTotal: 0, localCommits: "3" });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("unpushed-commits");
  });

  it("marks a clean, fully-pushed git repo safe", async () => {
    const dir = await makeGitDir("clean");
    mockGit({ files: [], stashTotal: 0, localCommits: "0" });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("safe");
    expect(decision.reason).toBe("clean-git");
  });

  it("protects when the local-commit probe returns unexpected/empty output (fail-closed)", async () => {
    const dir = await makeGitDir("weird-revlist");
    // Only an exact "0" is treated as no-local-work; empty output must protect.
    mockGit({ files: [], stashTotal: 0, localCommits: "" });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("unpushed-commits");
  });

  it("protects when the git check throws or times out (fail-closed)", async () => {
    const dir = await makeGitDir("git-error");
    mockedCreateHardenedGit.mockRejectedValue(new Error("git blew up"));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("git-check-failed");
  });

  it("protects a .git directory that does not resolve to a repo (never falls to mtime)", async () => {
    const dir = await makeGitDir("corrupt-git");
    // Recent file that a naive mtime fallthrough would have to inspect.
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "recent");
    await fs.utimes(file, new Date(NOW), new Date(NOW));
    const git = mockGit({ isRepo: false });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("git-repo-unverified");
    expect(git.status).not.toHaveBeenCalled();
  });

  it("protects a non-git directory with a recent top-level entry", async () => {
    const dir = path.join(tmpDir, "recent");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "edited recently");
    await fs.utimes(file, new Date(NOW), new Date(NOW)); // mtime newer than cutoff

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("recent-activity");
    expect(mockedCreateHardenedGit).not.toHaveBeenCalled();
  });

  it("protects a non-git directory whose recent edit is nested below an old top-level dir", async () => {
    const dir = path.join(tmpDir, "nested-recent");
    const srcDir = path.join(dir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const deep = path.join(srcDir, "app.ts");
    await fs.writeFile(deep, "edited today");
    // The nested file is recent; the top-level dir is old (a content edit does
    // not bump the parent directory's mtime — the recursive scan must find it).
    await fs.utimes(deep, new Date(NOW), new Date(NOW));
    await fs.utimes(srcDir, new Date(NOW - 2 * SCRATCH_TTL_MS), new Date(NOW - 2 * SCRATCH_TTL_MS));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("recent-activity");
  });

  it("marks a non-git directory whose entries are all old safe", async () => {
    const dir = path.join(tmpDir, "old");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "ancient");
    await fs.utimes(file, new Date(NOW - 2 * SCRATCH_TTL_MS), new Date(NOW - 2 * SCRATCH_TTL_MS));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("safe");
    expect(decision.reason).toBe("inactive-non-git");
  });

  it("ignores recent generated-directory churn (node_modules) in a non-git scratch", async () => {
    const dir = path.join(tmpDir, "with-node-modules");
    const nodeModules = path.join(dir, "node_modules");
    await fs.mkdir(nodeModules, { recursive: true });
    await fs.utimes(nodeModules, new Date(NOW), new Date(NOW)); // fresh, but ignored
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "ancient");
    await fs.utimes(file, new Date(NOW - 2 * SCRATCH_TTL_MS), new Date(NOW - 2 * SCRATCH_TTL_MS));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("safe");
  });

  it("treats a missing directory as safe (nothing left to protect)", async () => {
    const decision = await inspectScratchForCleanup(
      path.join(tmpDir, "does-not-exist"),
      cutoff,
      freshSignal()
    );

    expect(decision.disposition).toBe("safe");
    expect(decision.reason).toBe("missing-directory");
  });

  it("protects when directory enumeration fails with a non-ENOENT error (fail-closed)", async () => {
    const dir = path.join(tmpDir, "eacces");
    await fs.mkdir(dir, { recursive: true });
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("readdir-failed");
  });

  it("protects when an entry lstat fails (fail-closed)", async () => {
    const dir = path.join(tmpDir, "lstat-fail");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error("io"), { code: "EIO" }));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("stat-failed");
  });

  it("protects when the inspection signal is already aborted (non-git scan)", async () => {
    const dir = path.join(tmpDir, "aborted");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "old");
    const controller = new AbortController();
    controller.abort();

    const decision: ScratchCleanupSafetyDecision = await inspectScratchForCleanup(
      dir,
      cutoff,
      controller.signal
    );

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("inspection-aborted");
  });
});

describe("runScratchCleanup — end-to-end with the real default classifier", () => {
  it("protects a dirty git scratch through a full sweep (no injected checker)", async () => {
    const dir = path.join(tmpDir, "e2e-dirty");
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    mockGit({ files: [{ path: "wip.ts" }] });
    const store = makeStore([
      row({ id: "e2e-dirty", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const result = await runScratchCleanup(NOW, store); // default classifier

    expect(result.protectedCount).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("protects a non-git scratch with activity inside the TTL window (proves the cutoff is TTL, not now)", async () => {
    const dir = path.join(tmpDir, "e2e-recent");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "edited two weeks ago");
    // Opened in-app 60 days ago (stale) but a file was touched ~15 days ago.
    // A sweep passing `now` (instead of now-TTL) as the activity cutoff would
    // treat this 15-day-old edit as safe-to-delete; the correct cutoff protects.
    await fs.utimes(file, new Date(NOW - SCRATCH_TTL_MS / 2), new Date(NOW - SCRATCH_TTL_MS / 2));
    const store = makeStore([
      row({ id: "e2e-recent", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const result = await runScratchCleanup(NOW, store); // default classifier

    expect(result.protectedCount).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("tombstones a genuinely abandoned non-git scratch through a full sweep", async () => {
    const dir = path.join(tmpDir, "e2e-abandoned");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "old");
    await fs.utimes(file, new Date(NOW - 2 * SCRATCH_TTL_MS), new Date(NOW - 2 * SCRATCH_TTL_MS));
    const store = makeStore([
      row({ id: "e2e-abandoned", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const result = await runScratchCleanup(NOW, store); // default classifier

    expect(result.tombstoned).toBe(1);
    expect(result.directoriesRemoved).toBe(0);
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });
});
