import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { acquirePtyProcess } from "../terminalSpawn.js";
import type { PtyPool } from "../../PtyPool.js";
import type { PtySpawnOptions } from "../types.js";

interface FakePooledPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function createFakePooledPty(): FakePooledPty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

function createFakePool(overrides: { defaultCwd: string; acquire: () => unknown }): PtyPool {
  return {
    acquire: overrides.acquire,
    getDefaultCwd: () => overrides.defaultCwd,
  } as unknown as PtyPool;
}

const baseOptions: PtySpawnOptions = {
  cwd: "/repo",
  cols: 80,
  rows: 24,
};

describe("acquirePtyProcess pool handling (issue #5097)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("acquires a pooled PTY when the pool's default cwd matches options.cwd", () => {
    const pooled = createFakePooledPty();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquire: vi.fn(() => pooled),
    });

    const result = acquirePtyProcess("t1", baseOptions, {}, "/bin/bash", [], pool, () => {});

    expect(result).toBe(pooled);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT write a shell-level `cd` command or any preamble to pooled PTYs (#5097 regression guard)", () => {
    const pooled = createFakePooledPty();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquire: vi.fn(() => pooled),
    });

    acquirePtyProcess("t1", baseOptions, {}, "/bin/bash", [], pool, () => {});

    const writes = pooled.write.mock.calls.map((c) => String(c[0]));
    for (const w of writes) {
      // The old fragile fixup would send `cd "..."` or `cd /d "..."` — which user
      // aliases (zoxide/direnv/oh-my-zsh chpwd) could intercept. Must not happen.
      expect(w).not.toMatch(/\bcd\b/);
    }
    // No screen-clear preamble is written on pool acquire (removed in hard-break).
    expect(pooled.write).not.toHaveBeenCalled();
  });

  it("skips the pool and falls back to direct spawn when pool cwd doesn't match request", () => {
    const acquire = vi.fn();
    const pool = createFakePool({
      defaultCwd: "/repo-a",
      acquire,
    });
    const spawnedPty = { fake: "pty" };
    spawnMock.mockReturnValue(spawnedPty);

    const result = acquirePtyProcess(
      "t2",
      { ...baseOptions, cwd: "/repo-b" },
      { PATH: "/usr/bin" },
      "/bin/bash",
      ["-i"],
      pool,
      () => {}
    );

    // Pool was NOT consulted — acquire() must not be called when cwd mismatches.
    expect(acquire).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo-b" });
    expect(result).toBe(spawnedPty);
  });

  it("falls back to direct spawn when pool is null", () => {
    const spawnedPty = { fake: "pty" };
    spawnMock.mockReturnValue(spawnedPty);

    const result = acquirePtyProcess("t3", baseOptions, {}, "/bin/bash", ["-i"], null, () => {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(spawnedPty);
  });
});
