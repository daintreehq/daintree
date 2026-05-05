import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { runScratchCleanup, SCRATCH_TTL_MS } from "../ScratchCleanupService.js";
import type { ScratchRow } from "../persistence/schema.js";

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

interface FakeStore {
  rows: ScratchRow[];
  getStaleScratchCandidates: (cutoffMs: number) => ScratchRow[];
  tombstoneScratch: (scratchId: string, deletedAt: number) => void;
}

function makeStore(rows: ScratchRow[]): FakeStore {
  const store: FakeStore = {
    rows,
    getStaleScratchCandidates(cutoffMs: number) {
      return store.rows.filter((r) => r.lastOpened < cutoffMs && r.deletedAt == null);
    },
    tombstoneScratch(scratchId: string, deletedAt: number) {
      const r = store.rows.find((x) => x.id === scratchId);
      if (!r) throw new Error(`not found: ${scratchId}`);
      r.deletedAt = deletedAt;
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
});

afterEach(async () => {
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
    expect(store.rows[0]!.deletedAt).toBe(NOW);
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("is idempotent — already-tombstoned rows are skipped", async () => {
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

    expect(result.candidates).toBe(0);
    expect(result.tombstoned).toBe(0);
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
});
