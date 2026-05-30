import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { runScratchCleanup } from "../ScratchCleanupService.js";
import { setWritesSuppressed, resetWritesSuppressedForTesting } from "../diskPressureState.js";
import { SCRATCH_CLEANUP_TTL_MS as SCRATCH_TTL_MS } from "../../../shared/config/scratchCleanup.js";
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

interface FakeStore {
  rows: ScratchRow[];
  currentScratchId: string | null;
  getStaleScratchCandidates: (cutoffMs: number) => ScratchRow[];
  tombstoneScratch: (scratchId: string, deletedAt: number) => void;
  hardDeleteScratch: (scratchId: string) => void;
  clearCurrentScratch: () => void;
  getCurrentScratchId: () => string | null;
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scratch-cleanup-test-"));
  scratchTestRoot.current = tmpDir;
});

afterEach(async () => {
  resetWritesSuppressedForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("runScratchCleanup", () => {
  it("does not touch scratches younger than the TTL", async () => {
    const dir = path.join(tmpDir, "fresh");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({ id: "fresh", path: dir, lastOpened: NOW - SCRATCH_TTL_MS / 2 }),
    ]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it("tombstones and removes scratches older than the TTL", async () => {
    const dir = path.join(tmpDir, "stale");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hello");
    const store = makeStore([
      row({ id: "stale", path: dir, lastOpened: NOW - (SCRATCH_TTL_MS + 86_400_000) }),
    ]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.tombstoned).toBe(1);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("hard-deletes already-tombstoned rows whose directory is missing", async () => {
    const store = makeStore([
      row({
        id: "tombstoned",
        path: path.join(tmpDir, "missing"),
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 1000,
      }),
    ]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
  });

  it("treats a missing directory as removed (no failure)", async () => {
    const store = makeStore([
      row({
        id: "ghost",
        path: path.join(tmpDir, "does-not-exist"),
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
      }),
    ]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.tombstoned).toBe(1);
    expect(result.directoriesRemoved).toBe(1);
    expect(result.directoriesFailed).toBe(0);
  });

  it("skips rows with falsy lastOpened (PR #3721 lesson)", async () => {
    const store = makeStore([row({ id: "zero", path: tmpDir, lastOpened: 0 })]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    // lastOpened 0 < cutoff so it surfaces as a candidate, but we skip it.
    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("respects the 30-day boundary at exactly the cutoff", async () => {
    // lastOpened == cutoff is NOT stale (sweep uses `<`).
    const at = path.join(tmpDir, "boundary");
    await fs.mkdir(at, { recursive: true });
    const store = makeStore([row({ id: "boundary", path: at, lastOpened: NOW - SCRATCH_TTL_MS })]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.candidates).toBe(0);
    expect(store.rows[0]!.deletedAt).toBeNull();
  });

  it("finishes a tombstoned-current scratch when removeScratch crashed mid-flight", async () => {
    // removeScratch tombstones, then clears the current pointer, then rms.
    // If the process dies between the tombstone and clearCurrentScratch, the
    // next sweep sees a tombstoned row whose ID still equals currentScratchId.
    // It must NOT be excluded by the active-scratch guard — the user already
    // asked for it gone.
    const dir = path.join(tmpDir, "stranded");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore(
      [
        row({
          id: "stranded",
          path: dir,
          lastOpened: NOW - 1000,
          deletedAt: NOW - 500,
        }),
      ],
      "stranded"
    );

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.candidates).toBe(1);
    expect(result.directoriesRemoved).toBe(1);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("never deletes the active scratch even when stale", async () => {
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

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.tombstoned).toBe(1);
    expect(store.rows.find((r) => r.id === "active")!.deletedAt).toBeNull();
    expect(store.rows.find((r) => r.id === "other")).toBeUndefined();
    await expect(fs.access(activeDir)).resolves.toBeUndefined();
    await expect(fs.access(otherDir)).rejects.toBeDefined();
  });

  it("retries tombstoned rows whose directory still exists", async () => {
    const ghost = path.join(tmpDir, "ghost");
    await fs.mkdir(ghost, { recursive: true });
    await fs.writeFile(path.join(ghost, "left.txt"), "leftover");
    // A prior sweep (or a `removeScratch` call) tombstoned the row but failed
    // to remove the directory. The next sweep must finish the job.
    const store = makeStore([
      row({
        id: "ghost",
        path: ghost,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 86_400_000,
      }),
    ]);

    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(result.candidates).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(result.directoriesRemoved).toBe(1);
    expect(result.directoriesFailed).toBe(0);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(ghost)).rejects.toBeDefined();
  });

  it("leaves the row tombstoned when fs.rm fails, then completes on a retry sweep", async () => {
    const dir = path.join(tmpDir, "retry");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "x.txt"), "data");
    const store = makeStore([
      row({ id: "retry", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);

    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("EPERM"));

    const first = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(first.tombstoned).toBe(1);
    expect(first.directoriesRemoved).toBe(0);
    expect(first.directoriesFailed).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    await expect(fs.access(dir)).resolves.toBeUndefined();

    rmSpy.mockRestore();

    const second = await runScratchCleanup(
      NOW + 1,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(second.candidates).toBe(1);
    expect(second.tombstoned).toBe(0);
    expect(second.directoriesRemoved).toBe(1);
    expect(second.directoriesFailed).toBe(0);
    expect(store.rows).toHaveLength(0);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("reclaims the directory but skips the tombstone DB write while suppressed (#9537)", async () => {
    const dir = path.join(tmpDir, "suppressed");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "data");
    const store = makeStore([
      row({ id: "suppressed", path: dir, lastOpened: NOW - 2 * SCRATCH_TTL_MS }),
    ]);
    const tombstoneSpy = vi.spyOn(store, "tombstoneScratch");
    const hardDeleteSpy = vi.spyOn(store, "hardDeleteScratch");

    setWritesSuppressed(true);
    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    // No DB writes while suppressed...
    expect(tombstoneSpy).not.toHaveBeenCalled();
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(result.tombstoned).toBe(0);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.deletedAt).toBeNull();
    // ...but the directory was still reclaimed.
    expect(result.directoriesRemoved).toBe(1);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("skips hard-delete of an already-tombstoned row while suppressed but still removes the directory (#9537)", async () => {
    const dir = path.join(tmpDir, "tombstoned-suppressed");
    await fs.mkdir(dir, { recursive: true });
    const store = makeStore([
      row({
        id: "tombstoned-suppressed",
        path: dir,
        lastOpened: NOW - 2 * SCRATCH_TTL_MS,
        deletedAt: NOW - 1000,
      }),
    ]);
    const hardDeleteSpy = vi.spyOn(store, "hardDeleteScratch");

    setWritesSuppressed(true);
    const result = await runScratchCleanup(
      NOW,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );

    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(result.directoriesRemoved).toBe(1);
    await expect(fs.access(dir)).rejects.toBeDefined();

    // Once writes resume, the lingering row is finished on the next sweep.
    resetWritesSuppressedForTesting();
    const second = await runScratchCleanup(
      NOW + 1,
      store as unknown as Parameters<typeof runScratchCleanup>[1]
    );
    expect(second.candidates).toBe(1);
    expect(store.rows).toHaveLength(0);
  });
});
