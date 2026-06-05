import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { acquirePtyProcess } from "../terminalSpawn.js";
import { shouldEnablePtyPool, type PtyPool } from "../../PtyPool.js";
import type { PtySpawnOptions } from "../types.js";

interface FakePooledPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface FakeDataHandoff {
  takeOver: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeSpawnedPty extends FakePooledPty {
  onData: ReturnType<typeof vi.fn>;
  emitData: (chunk: string) => void;
  getDataHandlerCount: () => number;
}

function createFakePooledPty(): FakePooledPty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn(),
  };
}

function createFakeSpawnedPty(options: { emitDuringOnData?: string[] } = {}): FakeSpawnedPty {
  const dataHandlers = new Set<(chunk: string) => void>();
  return {
    ...createFakePooledPty(),
    onData: vi.fn((callback: (chunk: string) => void) => {
      dataHandlers.add(callback);
      for (const chunk of options.emitDuringOnData ?? []) {
        callback(chunk);
      }
      return {
        dispose: vi.fn(() => {
          dataHandlers.delete(callback);
        }),
      };
    }),
    emitData: (chunk: string) => {
      for (const handler of dataHandlers) handler(chunk);
    },
    getDataHandlerCount: () => dataHandlers.size,
  };
}

function createFakeDataHandoff(): FakeDataHandoff {
  return {
    takeOver: vi.fn(),
    dispose: vi.fn(),
  };
}

interface FakePoolOpts {
  defaultCwd: string;
  acquireByKey?: (cwd: string, envHash: string) => unknown;
  acquire?: () => unknown;
  warmForKey?: (cwd: string, env: Record<string, string> | undefined, envHash: string) => void;
}

function createFakePool(opts: FakePoolOpts): PtyPool {
  return {
    acquire: opts.acquire ?? vi.fn<() => unknown>(() => null),
    acquireByKey: opts.acquireByKey ?? vi.fn<(cwd: string, envHash: string) => unknown>(() => null),
    warmForKey:
      opts.warmForKey ??
      vi.fn<(cwd: string, env: Record<string, string> | undefined, envHash: string) => void>(),
    getDefaultCwd: () => opts.defaultCwd,
  } as unknown as PtyPool;
}

const baseOptions: PtySpawnOptions = {
  cwd: "/repo",
  cols: 80,
  rows: 24,
};

describe("acquirePtyProcess pool handling", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  // Pin platform to a non-Windows value so the pool path is exercised on every
  // runner — shouldEnablePtyPool() returns false on win32, which would short-circuit
  // every pool-targeted test if we inherited the Windows runner's process.platform.
  // The single "skips the pool on Windows" test below overrides this explicitly.
  beforeEach(() => {
    spawnMock.mockReset();
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("acquires a pooled PTY when an env-keyed slot is available for the request cwd", () => {
    const pooled = createFakePooledPty();
    const dataHandoff = createFakeDataHandoff();
    const acquireByKey = vi.fn<
      (
        cwd: string,
        envHash: string
      ) => {
        process: FakePooledPty;
        prelude: string;
        dataHandoff: FakeDataHandoff;
      }
    >(() => ({ process: pooled, prelude: "", dataHandoff }));
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
    });

    const result = acquirePtyProcess("t1", baseOptions, {}, "/bin/bash", [], pool, () => {});

    expect(acquireByKey).toHaveBeenCalledTimes(1);
    expect(acquireByKey.mock.calls[0]?.[0]).toBe("/repo");
    expect(typeof acquireByKey.mock.calls[0]?.[1]).toBe("string");
    expect(result.ptyProcess).toBe(pooled);
    expect(result.prelude).toBe("");
    expect(result.dataHandoff).toBe(dataHandoff);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("hits a pool slot warmed at a restored worktree cwd, not just the project root (#9774)", () => {
    const pooled = createFakePooledPty();
    const dataHandoff = createFakeDataHandoff();
    // The pool root is the project path, but the restored panel spawns at its
    // own worktree cwd. Pre-warming that cwd (the #9774 fix) means acquireByKey
    // is consulted with — and hits on — the worktree cwd, so no cold spawn.
    const worktreeCwd = "/repo/.worktrees/feature-a";
    const acquireByKey = vi.fn<
      (
        cwd: string,
        envHash: string
      ) => {
        process: FakePooledPty;
        prelude: string;
        dataHandoff: FakeDataHandoff;
      } | null
    >((cwd) => (cwd === worktreeCwd ? { process: pooled, prelude: "", dataHandoff } : null));
    const warmForKey =
      vi.fn<(cwd: string, env: Record<string, string> | undefined, envHash: string) => void>();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
      warmForKey,
    });

    const result = acquirePtyProcess(
      "t1",
      { ...baseOptions, cwd: worktreeCwd },
      {},
      "/bin/bash",
      [],
      pool,
      () => {}
    );

    expect(acquireByKey).toHaveBeenCalledTimes(1);
    expect(acquireByKey.mock.calls[0]?.[0]).toBe(worktreeCwd);
    expect(result.ptyProcess).toBe(pooled);
    // Hit ⇒ no fresh cold spawn and no background warm needed for this key.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warmForKey).not.toHaveBeenCalled();
  });

  it("does NOT write a shell-level `cd` command or any preamble to pooled PTYs (#5097 regression guard)", () => {
    const pooled = createFakePooledPty();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey: vi.fn(() => ({ process: pooled, prelude: "" })),
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

  it("propagates the pool prelude unchanged so the renderer can replay it", () => {
    const pooled = createFakePooledPty();
    const prelude = "myhost:project user$ ";
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey: vi.fn(() => ({ process: pooled, prelude })),
    });

    const result = acquirePtyProcess("t1", baseOptions, {}, "/bin/bash", [], pool, () => {});

    expect(result.ptyProcess).toBe(pooled);
    expect(result.prelude).toBe(prelude);
  });

  it("disposes the pool data handoff before falling back when pooled resize fails", () => {
    const pooled = createFakePooledPty();
    pooled.resize.mockImplementation(() => {
      throw new Error("resize failed");
    });
    const dataHandoff = createFakeDataHandoff();
    const spawnedPty = createFakeSpawnedPty();
    spawnMock.mockReturnValue(spawnedPty);
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey: vi.fn(() => ({ process: pooled, prelude: "", dataHandoff })),
    });

    const result = acquirePtyProcess("t1", baseOptions, {}, "/bin/bash", [], pool, () => {});

    expect(dataHandoff.dispose).toHaveBeenCalledTimes(1);
    // destroyPty() closes the master FD (destroy) and signals the process
    // (kill); without destroy the /dev/ptmx FD leaks on every resize-failure
    // fallback. See #7892.
    expect(pooled.destroy).toHaveBeenCalledTimes(1);
    expect(pooled.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.ptyProcess).toBe(spawnedPty);
    expect(result.dataHandoff).toBeDefined();
  });

  it("falls back to direct spawn when the pool has no entry for the (cwd, envHash) key", () => {
    const acquireByKey = vi.fn<(cwd: string, envHash: string) => null>(() => null);
    const warmForKey =
      vi.fn<(cwd: string, env: Record<string, string> | undefined, envHash: string) => void>();
    const pool = createFakePool({
      defaultCwd: "/repo-a",
      acquireByKey,
      warmForKey,
    });
    const spawnedPty = createFakeSpawnedPty();
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

    // Pool was consulted with the requested cwd, missed, and a background
    // warm was kicked off so the next spawn with the same shape hits the pool.
    expect(acquireByKey).toHaveBeenCalledTimes(1);
    expect(acquireByKey.mock.calls[0]?.[0]).toBe("/repo-b");
    expect(warmForKey).toHaveBeenCalledTimes(1);
    expect(warmForKey.mock.calls[0]?.[0]).toBe("/repo-b");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo-b" });
    expect(result.ptyProcess).toBe(spawnedPty);
    expect(result.prelude).toBe("");
  });

  it("computes distinct envHash keys for differing options.env, isolating pool slots", () => {
    const acquireByKey = vi.fn<(cwd: string, envHash: string) => null>(() => null);
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
    });
    spawnMock.mockReturnValue(createFakeSpawnedPty());

    acquirePtyProcess(
      "a",
      { ...baseOptions, env: { FOO: "1" } },
      {},
      "/bin/bash",
      [],
      pool,
      () => {}
    );
    acquirePtyProcess(
      "b",
      { ...baseOptions, env: { FOO: "2" } },
      {},
      "/bin/bash",
      [],
      pool,
      () => {}
    );
    acquirePtyProcess("c", baseOptions, {}, "/bin/bash", [], pool, () => {});

    const envHashes = acquireByKey.mock.calls.map((c) => c[1]);
    // Three different env shapes → three distinct hashes
    const unique = new Set(envHashes);
    expect(unique.size).toBe(3);
  });

  it("uses the same envHash for the same options.env shape", () => {
    const acquireByKey = vi.fn<(cwd: string, envHash: string) => null>(() => null);
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
    });
    spawnMock.mockReturnValue(createFakeSpawnedPty());

    const env1 = { FOO: "1", BAR: "2" };
    const env2 = { BAR: "2", FOO: "1" }; // same content, different key order
    acquirePtyProcess("a", { ...baseOptions, env: env1 }, {}, "/bin/bash", [], pool, () => {});
    acquirePtyProcess("b", { ...baseOptions, env: env2 }, {}, "/bin/bash", [], pool, () => {});

    expect(acquireByKey.mock.calls[0]?.[1]).toBe(acquireByKey.mock.calls[1]?.[1]);
  });

  it("on miss, passes the same envHash to acquireByKey and warmForKey", () => {
    const acquireByKey = vi.fn<(cwd: string, envHash: string) => null>(() => null);
    const warmForKey =
      vi.fn<(cwd: string, env: Record<string, string> | undefined, envHash: string) => void>();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
      warmForKey,
    });
    spawnMock.mockReturnValue(createFakeSpawnedPty());

    const callerEnv = { FOO: "1", BAR: "2" };
    acquirePtyProcess("p", { ...baseOptions, env: callerEnv }, {}, "/bin/bash", [], pool, () => {});

    expect(acquireByKey).toHaveBeenCalledTimes(1);
    expect(warmForKey).toHaveBeenCalledTimes(1);
    // Same hash on the lookup side and the warm side — guarantees the
    // background warm actually populates the slot the next acquire will
    // look up.
    expect(acquireByKey.mock.calls[0]?.[1]).toBe(warmForKey.mock.calls[0]?.[2]);
  });

  it("falls back to direct spawn when pool is null", () => {
    const spawnedPty = createFakeSpawnedPty();
    spawnMock.mockReturnValue(spawnedPty);

    const result = acquirePtyProcess("t3", baseOptions, {}, "/bin/bash", ["-i"], null, () => {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.ptyProcess).toBe(spawnedPty);
    expect(result.prelude).toBe("");
    expect(result.dataHandoff).toBeDefined();
  });

  it("buffers fresh-spawn output until TerminalProcess takes over the data listener", () => {
    const spawnedPty = createFakeSpawnedPty({ emitDuringOnData: ["early prompt"] });
    spawnMock.mockReturnValue(spawnedPty);

    const result = acquirePtyProcess("t4", baseOptions, {}, "/bin/bash", ["-i"], null, () => {});

    spawnedPty.emitData("\r\nready");
    const received: string[] = [];
    const disposable = result.dataHandoff?.takeOver((chunk) => received.push(chunk));

    expect(received).toEqual(["early prompt", "\r\nready"]);
    spawnedPty.emitData(" live");
    expect(received).toEqual(["early prompt", "\r\nready", " live"]);

    disposable?.dispose();
    expect(spawnedPty.getDataHandlerCount()).toBe(0);
  });

  it("skips the pool entirely for dev-preview panes", () => {
    const acquireByKey = vi.fn();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
    });
    spawnMock.mockReturnValue(createFakeSpawnedPty());

    acquirePtyProcess(
      "dp1",
      { ...baseOptions, kind: "dev-preview" },
      {},
      "/bin/bash",
      [],
      pool,
      () => {}
    );

    expect(acquireByKey).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("skips the pool on Windows and directly spawns a PTY", () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    const acquireByKey = vi.fn();
    const warmForKey = vi.fn();
    const pool = createFakePool({
      defaultCwd: "C:\\repo",
      acquireByKey,
      warmForKey,
    });
    const spawnedPty = createFakeSpawnedPty();
    spawnMock.mockReturnValue(spawnedPty);

    const result = acquirePtyProcess(
      "win1",
      { cwd: "C:\\repo", cols: 80, rows: 24 },
      { PATH: "C:\\Windows\\System32" },
      "powershell.exe",
      [],
      pool,
      () => {}
    );

    expect(shouldEnablePtyPool()).toBe(false);
    expect(acquireByKey).not.toHaveBeenCalled();
    expect(warmForKey).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.ptyProcess).toBe(spawnedPty);
  });

  it("skips the pool when caller provides a custom shell or args", () => {
    const acquireByKey = vi.fn();
    const pool = createFakePool({
      defaultCwd: "/repo",
      acquireByKey,
    });
    spawnMock.mockReturnValue(createFakeSpawnedPty());

    acquirePtyProcess(
      "x1",
      { ...baseOptions, shell: "/bin/zsh" },
      {},
      "/bin/zsh",
      [],
      pool,
      () => {}
    );
    acquirePtyProcess(
      "x2",
      { ...baseOptions, args: ["-l"] },
      {},
      "/bin/bash",
      ["-l"],
      pool,
      () => {}
    );

    expect(acquireByKey).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
