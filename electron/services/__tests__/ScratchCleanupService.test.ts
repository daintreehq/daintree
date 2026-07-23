import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

/** Stub a git repo with the given status for the next `createHardenedGit` call. */
function mockGit(status: { files: unknown[]; ahead: number }, isRepo = true): void {
  mockedCreateHardenedGit.mockResolvedValue({
    checkIsRepo: async () => isRepo,
    status: async () => status,
  } as unknown as Awaited<ReturnType<typeof createHardenedGit>>);
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

/** A safety check that always allows deletion — used to exercise orchestration
 * without spawning git. */
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

  it("never inspects or tombstones the active scratch, even when stale", async () => {
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

    const result = await runScratchCleanup(NOW, store, ALWAYS_SAFE);

    expect(result.tombstoned).toBe(1);
    expect(store.rows.find((r) => r.id === "active")!.deletedAt).toBeNull();
    expect(store.rows.find((r) => r.id === "other")!.deletedAt).toBe(NOW);
    // Neither directory is removed in the tombstone phase.
    await expect(fs.access(activeDir)).resolves.toBeUndefined();
    await expect(fs.access(otherDir)).resolves.toBeUndefined();
  });

  it("does not tombstone a candidate opened during inspection (race)", async () => {
    const dir = path.join(tmpDir, "opened-midflight");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "opened-midflight", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    // Simulate the user opening the scratch while git status runs: lastOpened
    // becomes fresh, so the post-inspection re-validation must exclude it.
    const check: ScratchCleanupSafetyCheck = async () => {
      store.rows[0]!.lastOpened = NOW;
      store.currentScratchId = "opened-midflight";
      return { disposition: "safe", reason: "test-safe" };
    };

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("never runs more than three safety inspections concurrently", async () => {
    const rows: ScratchRow[] = [];
    for (let i = 0; i < 9; i++) {
      const dir = path.join(tmpDir, `c${i}`);
      await fs.mkdir(dir, { recursive: true });
      rows.push(row({ id: `c${i}`, path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }));
    }
    const store = makeStore(rows);

    let active = 0;
    let maxActive = 0;
    const check: ScratchCleanupSafetyCheck = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { disposition: "safe", reason: "test-safe" };
    };

    const result = await runScratchCleanup(NOW, store, check);

    expect(result.tombstoned).toBe(9);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThanOrEqual(2); // proves it is not serialized
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
    mockGit({ files: [{ path: "a.txt" }], ahead: 0 });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("dirty-git");
  });

  it("protects a git repo with unpushed (ahead) commits", async () => {
    const dir = await makeGitDir("ahead");
    mockGit({ files: [], ahead: 2 });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("unpushed-commits");
  });

  it("marks a clean, synced git repo safe", async () => {
    const dir = await makeGitDir("clean");
    mockGit({ files: [], ahead: 0 });

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("safe");
    expect(decision.reason).toBe("clean-git");
  });

  it("protects when the git check throws or times out (fail-closed)", async () => {
    const dir = await makeGitDir("git-error");
    mockedCreateHardenedGit.mockRejectedValue(new Error("git blew up"));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("git-check-failed");
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
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    // node_modules itself is fresh, but the only real content is old.
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

  it("protects when readdir fails with a non-ENOENT error (fail-closed)", async () => {
    const dir = path.join(tmpDir, "eacces");
    await fs.mkdir(dir, { recursive: true });
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

    const decision = await inspectScratchForCleanup(dir, cutoff, freshSignal());

    expect(decision.disposition).toBe("protect");
    expect(decision.reason).toBe("readdir-failed");
    readdirSpy.mockRestore();
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
