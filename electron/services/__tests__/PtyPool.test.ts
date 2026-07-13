import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyPool, destroyPty } from "../PtyPool.js";
import { computePoolEnvHash } from "../pty/ptyPoolEnvHash.js";
import type { IPty } from "node-pty";

const spawnMock = vi.fn();

vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface FakePtyProcess {
  pid?: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emitExit: (exitCode: number) => void;
}

interface FakePtyProcessWithEmit extends FakePtyProcess {
  emitData: (chunk: string) => void;
  getDataHandlerCount: () => number;
}

function createFakeProcess(
  pid: number | "missing" = 100,
  options: { emitDuringOnData?: string[]; markDeadOnAcquire?: boolean } = {}
): FakePtyProcessWithEmit {
  let onExitHandler: ((event: { exitCode: number }) => void) | null = null;
  const dataHandlers = new Set<(chunk: string) => void>();
  let alive = true;
  const process: FakePtyProcessWithEmit = {
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
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      onExitHandler = callback;
    }),
    emitData: (chunk: string) => {
      for (const handler of dataHandlers) handler(chunk);
    },
    getDataHandlerCount: () => dataHandlers.size,
    // Real node-pty kill() triggers onExit asynchronously. Mirror that here so
    // drain tests exercise the onExit→refill cascade against the epoch guard.
    kill: vi.fn(() => {
      if (alive) {
        alive = false;
        onExitHandler?.({ exitCode: 0 });
      }
    }),
    // destroy() is called by destroyPty() to close the master FD. Real node-pty
    // also fires onExit via SIGHUP, but the helper calls kill() too so the
    // mock doesn't need to double-emit here.
    destroy: vi.fn(),
    emitExit: (exitCode: number) => {
      alive = false;
      onExitHandler?.({ exitCode });
    },
  };
  if (pid !== "missing") {
    process.pid = pid;
  }
  return process;
}

/**
 * Wait one microtask tick. `warmForKey` is fire-and-forget, so callers need
 * to flush the microtask queue before asserting on its side effects.
 */
const flushMicrotasks = () => Promise.resolve();

/**
 * Drain enough microtask ticks for `refillPool`'s `.then().catch().finally()`
 * chain to clear `refillInProgress`. A single `await Promise.resolve()` only
 * advances one microtask, but the chain needs ~3-4 to settle.
 */
const settleRefill = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

describe("PtyPool", () => {
  const originalShell = process.env.SHELL;
  const originalHome = process.env.HOME;
  const originalCi = process.env.CI;
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    process.env.SHELL = "/bin/bash";
    process.env.HOME = "/home/tester";
    process.env.CI = "true";
    delete process.env.LANG;
    delete process.env.LC_ALL;
    // buildSpawnEnv inherits from process.env and now yields to NO_COLOR
    // (#11118), so a host shell exporting either colour variable would decide
    // the spawn-env assertions instead of the code under test.
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  // Assigning `undefined` to process.env stringifies it to "undefined", which
  // leaves an absent var looking *set* (a restored CI="undefined" is truthy).
  const restoreEnv = (key: string, original: string | undefined) => {
    if (original !== undefined) process.env[key] = original;
    else delete process.env[key];
  };

  afterEach(() => {
    restoreEnv("SHELL", originalShell);
    restoreEnv("HOME", originalHome);
    restoreEnv("CI", originalCi);
    restoreEnv("LANG", originalLang);
    restoreEnv("LC_ALL", originalLcAll);
    restoreEnv("NO_COLOR", originalNoColor);
    restoreEnv("FORCE_COLOR", originalForceColor);
  });

  it("falls back to default pool size when configured pool size is invalid", () => {
    const pool = new PtyPool({ poolSize: -2 });
    expect(pool.getMaxPoolSize()).toBe(2);
    pool.dispose();
  });

  it("falls back to default maxEntries when configured value is invalid", () => {
    const pool = new PtyPool({ poolSize: 2, maxEntries: -1 });
    expect(pool.getMaxEntries()).toBe(8);
    pool.dispose();
  });

  it("ensures maxEntries is at least poolSize", () => {
    const pool = new PtyPool({ poolSize: 4, maxEntries: 2 });
    expect(pool.getMaxEntries()).toBe(4);
    pool.dispose();
  });

  it("ignores blank cwd updates from drainAndRefill", async () => {
    spawnMock.mockReturnValue(createFakeProcess(101));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/initial" });
    await pool.warmPool();

    await pool.drainAndRefill("   ");

    expect(pool.getDefaultCwd()).toBe("/initial");
    // Only the initial warm spawn — drainAndRefill with blank cwd is a no-op.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("drainAndRefill repoints pool to new cwd and kills stale entries", async () => {
    const initial = createFakeProcess(601);
    const refilled = createFakeProcess(602);
    spawnMock.mockReturnValueOnce(initial).mockReturnValueOnce(refilled);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await pool.drainAndRefill("/repo");

    expect(pool.getDefaultCwd()).toBe("/repo");
    expect(initial.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({ cwd: "/repo" });
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("drainAndRefill short-circuits when already warmed at requested cwd", async () => {
    spawnMock.mockReturnValueOnce(createFakeProcess(701));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await pool.drainAndRefill("/repo");

    // No drain or extra spawn — pool was already at /repo with poolSize entries.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("drainAndRefill suppresses onExit refill of drained entries", async () => {
    const initial = createFakeProcess(801);
    const refilled = createFakeProcess(802);
    spawnMock.mockReturnValueOnce(initial).mockReturnValueOnce(refilled);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();

    await pool.drainAndRefill("/repo");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Simulate onExit firing on the (already killed) initial entry after drain.
    // A naive implementation would call refillPool() → extra spawn at the new cwd.
    // The drain epoch guard must prevent that cascade.
    initial.emitExit(0);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("sequential drainAndRefill calls converge to the last cwd", async () => {
    const first = createFakeProcess(901);
    const second = createFakeProcess(902);
    const third = createFakeProcess(903);
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();

    await pool.drainAndRefill("/repo-a");
    await pool.drainAndRefill("/repo-b");

    expect(pool.getDefaultCwd()).toBe("/repo-b");
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[2]?.[2]).toMatchObject({ cwd: "/repo-b" });
    expect(first.kill).toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalled();
    pool.dispose();
  });

  it("drainAndRefill is a no-op after dispose", async () => {
    spawnMock.mockReturnValueOnce(createFakeProcess(1001));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    pool.dispose();
    await expect(pool.drainAndRefill("/another")).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("drops dead pooled terminals on acquire and refills the pool", async () => {
    spawnMock
      .mockReturnValueOnce(createFakeProcess("missing"))
      .mockReturnValueOnce(createFakeProcess(202));

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    const acquired = pool.acquire();
    expect(acquired).toBeNull();
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("refills when a pooled terminal exits unexpectedly", async () => {
    const first = createFakeProcess(301);
    const second = createFakeProcess(302);
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    first.emitExit(1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("sanitizes spawn environment", async () => {
    spawnMock.mockReturnValue(createFakeProcess(401));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.CI).toBeUndefined();
    expect(spawnOptions.env?.TERM).toBe("xterm-256color");
    expect(spawnOptions.env?.COLORTERM).toBe("truecolor");
    expect(spawnOptions.env?.FORCE_COLOR).toBe("3");
    expect(spawnOptions.env?.LANG).toBe("en_US.UTF-8");
    expect(spawnOptions.env?.LC_ALL).toBeUndefined();
    pool.dispose();
  });

  it.each([
    ["a non-empty NO_COLOR", "1"],
    ["an empty NO_COLOR", ""],
  ])("does not inject FORCE_COLOR into a warm shell when the host exports %s", async (_, value) => {
    process.env.NO_COLOR = value;
    spawnMock.mockReturnValue(createFakeProcess(402));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.FORCE_COLOR).toBeUndefined();
    expect(spawnOptions.env?.NO_COLOR).toBe(value);
    // The depth hints survive: they inform colour support, they don't force it.
    expect(spawnOptions.env?.COLORTERM).toBeDefined();
    pool.dispose();
  });

  it("does not inject FORCE_COLOR into a warm shell when the caller sets NO_COLOR", async () => {
    spawnMock.mockReturnValue(createFakeProcess(403));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    pool.warmForKey("/repo", { NO_COLOR: "1" }, computePoolEnvHash({ NO_COLOR: "1" }));
    await flushMicrotasks();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.FORCE_COLOR).toBeUndefined();
    expect(spawnOptions.env?.NO_COLOR).toBe("1");
    pool.dispose();
  });

  it("preserves an explicit caller FORCE_COLOR rather than rewriting it", async () => {
    spawnMock.mockReturnValue(createFakeProcess(404));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    pool.warmForKey("/repo", { FORCE_COLOR: "0" }, computePoolEnvHash({ FORCE_COLOR: "0" }));
    await flushMicrotasks();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.FORCE_COLOR).toBe("0");
    pool.dispose();
  });

  it("never hands a colour-forcing warm shell to a NO_COLOR caller", async () => {
    // The pooled half of the NO_COLOR fix rests on the env hash isolating the
    // slot: a shell already warmed with the FORCE_COLOR default must not
    // satisfy an acquire from a caller that opted out of colour.
    spawnMock.mockReturnValue(createFakeProcess(405));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    const warmed = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(warmed.env?.FORCE_COLOR).toBeDefined();

    expect(pool.acquireByKey("/repo", computePoolEnvHash({ NO_COLOR: "1" }))).toBeNull();
    pool.dispose();
  });

  it("keeps FORCE_COLOR out of the shell that refills an acquired NO_COLOR slot", async () => {
    // acquireByKey refills the same key from the entry's caller env. The
    // replacement shell has to inherit the opt-out too, not quietly fall back
    // to the default the way the acquired one would have.
    spawnMock.mockReturnValue(createFakeProcess(406));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    const envHash = computePoolEnvHash({ NO_COLOR: "1" });

    pool.warmForKey("/repo", { NO_COLOR: "1" }, envHash);
    await settleRefill();
    expect(pool.acquireByKey("/repo", envHash)).not.toBeNull();
    await settleRefill();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const refill = spawnMock.mock.calls[1]?.[2] as { env?: Record<string, string> };
    expect(refill.env?.FORCE_COLOR).toBeUndefined();
    expect(refill.env?.NO_COLOR).toBe("1");
    pool.dispose();
  });

  it("filters secrets out of caller env before baking into the pool entry", async () => {
    spawnMock.mockReturnValue(createFakeProcess(411));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    pool.warmForKey(
      "/repo",
      {
        ANTHROPIC_API_KEY: "sk-secret",
        GITHUB_TOKEN: "ghp-x",
        OPENAI_API_KEY: "sk-openai",
        MY_SERVICE_PASSWORD: "pw",
        FOO: "bar",
      },
      "env-empty"
    );
    await flushMicrotasks();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnOptions.env?.GITHUB_TOKEN).toBeUndefined();
    expect(spawnOptions.env?.OPENAI_API_KEY).toBeUndefined();
    expect(spawnOptions.env?.MY_SERVICE_PASSWORD).toBeUndefined();
    expect(spawnOptions.env?.FOO).toBe("bar");
    pool.dispose();
  });

  it("preserves caller-supplied non-secret env when warming a key", async () => {
    spawnMock.mockReturnValue(createFakeProcess(412));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    pool.warmForKey("/repo", { ANTHROPIC_BASE_URL: "https://api.example", ANOTHER: "x" }, "env-x");
    await flushMicrotasks();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.ANTHROPIC_BASE_URL).toBe("https://api.example");
    expect(spawnOptions.env?.ANOTHER).toBe("x");
    pool.dispose();
  });

  it("preserves caller-supplied DAINTREE_* keys (e.g. agent preset metadata)", async () => {
    // Regression: 5572d21de ran caller env through the full filterEnvironment,
    // which strips DAINTREE_*. That broke caller-supplied agent preset env
    // (DAINTREE_E2E_AGENT_COLOR, custom metadata). DAINTREE_* in caller env
    // is intentional and must reach the spawned shell. Anti-spoofing of
    // inherited process.env is handled separately and still strips DAINTREE_*.
    spawnMock.mockReturnValue(createFakeProcess(413));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    pool.warmForKey(
      "/repo",
      {
        DAINTREE_E2E_AGENT_COLOR: "#3366ff",
        DAINTREE_E2E_PROVIDER: "claude",
      },
      "env-color"
    );
    await flushMicrotasks();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.DAINTREE_E2E_AGENT_COLOR).toBe("#3366ff");
    expect(spawnOptions.env?.DAINTREE_E2E_PROVIDER).toBe("claude");
    pool.dispose();
  });

  it("preserves user's UTF-8 LANG instead of overriding to en_US", async () => {
    process.env.LANG = "ja_JP.UTF-8";
    spawnMock.mockReturnValue(createFakeProcess(501));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.LANG).toBe("ja_JP.UTF-8");
    pool.dispose();
  });

  it("falls back to en_US.UTF-8 when LANG is non-UTF-8", async () => {
    process.env.LANG = "C";
    spawnMock.mockReturnValue(createFakeProcess(502));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.LANG).toBe("en_US.UTF-8");
    pool.dispose();
  });

  describe("env-keyed acquire", () => {
    it("acquireByKey hits the pool for the env-empty key after warmPool", async () => {
      const proc = createFakeProcess(1101);
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.process).toBe(proc);
      expect(acquired?.prelude).toBe("");
      pool.dispose();
    });

    it("buffers shell-init output during pool residency and returns it as prelude on acquire", async () => {
      const proc = createFakeProcess(1102);
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      // Simulate zsh printing its banner + prompt while the entry sits in the pool.
      // Without the prelude buffer, this output would be discarded and the
      // renderer xterm would attach to a blank shell on acquire (#7625 root cause).
      proc.emitData("Welcome to zsh\r\n");
      proc.emitData("repo % ");

      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.process).toBe(proc);
      expect(acquired?.prelude).toBe("Welcome to zsh\r\nrepo % ");
      pool.dispose();
    });

    it("captures shell-init output emitted during listener registration", async () => {
      const proc = createFakeProcess(1106, { emitDuringOnData: ["instant prompt"] });
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.prelude).toBe("instant prompt");
      pool.dispose();
    });

    it("buffers post-acquire output until the live owner takes over the data listener", async () => {
      const proc = createFakeProcess(1104);
      const replacement = createFakeProcess(1105);
      spawnMock.mockReturnValueOnce(proc).mockReturnValueOnce(replacement);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      proc.emitData("repo % ");
      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.process).toBe(proc);
      expect(acquired?.prelude).toBe("repo % ");

      proc.emitData("late prompt");
      proc.emitData("\r\n");
      const received: string[] = [];
      const disposable = acquired?.dataHandoff.takeOver((chunk) => received.push(chunk));

      expect(received).toEqual(["late prompt", "\r\n"]);

      proc.emitData("live chunk");
      expect(received).toEqual(["late prompt", "\r\n", "live chunk"]);

      disposable?.dispose();
      expect(proc.getDataHandlerCount()).toBe(0);
      proc.emitData("ignored");
      expect(received).toEqual(["late prompt", "\r\n", "live chunk"]);

      pool.dispose();
    });

    it("caps the prelude buffer to bound memory under noisy shell init", async () => {
      const proc = createFakeProcess(1103);
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      // 64 KB cap; emit 70 KB and verify the tail is dropped, not the head
      // (preserving the prompt-bearing prefix is more important than tail).
      const big = "x".repeat(70 * 1024);
      proc.emitData(big);

      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.prelude.length).toBe(64 * 1024);
      expect(acquired?.prelude.startsWith("xxxx")).toBe(true);
      pool.dispose();
    });

    it("acquireByKey misses on a different cwd", async () => {
      spawnMock.mockReturnValueOnce(createFakeProcess(1201));
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo-a" });
      await pool.warmPool();

      const acquired = pool.acquireByKey("/repo-b", "env-empty");
      expect(acquired).toBeNull();
      pool.dispose();
    });

    it("acquireByKey misses on a different envHash", async () => {
      spawnMock.mockReturnValueOnce(createFakeProcess(1301));
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      const acquired = pool.acquireByKey("/repo", "env-some-other-hash");
      expect(acquired).toBeNull();
      pool.dispose();
    });

    it("acquireByKey triggers a same-key warm so the next acquire is instant", async () => {
      const first = createFakeProcess(1401);
      const second = createFakeProcess(1402);
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      const acquired = pool.acquireByKey("/repo", "env-empty");
      expect(acquired?.process).toBe(first);

      // Background warm for the same key fires asynchronously.
      await flushMicrotasks();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(pool.getPoolSize()).toBe(1);
      pool.dispose();
    });

    it("warmForKey populates a slot for an arbitrary (cwd, envHash) and a later acquireByKey hits", async () => {
      const proc = createFakeProcess(1501);
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

      pool.warmForKey("/repo", { ANTHROPIC_BASE_URL: "https://api.example" }, "env-foo");
      await flushMicrotasks();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo" });

      // First acquire on a different key (env-empty) misses; the env-foo slot
      // remains, and a subsequent acquire on env-foo hits.
      expect(pool.acquireByKey("/repo", "env-empty")).toBeNull();
      expect(pool.acquireByKey("/repo", "env-foo")?.process).toBe(proc);
      pool.dispose();
    });

    it("warmForKey is idempotent under concurrent calls for the same key (no stampede)", async () => {
      let inFlightResolve!: () => void;
      const inFlightPromise = new Promise<void>((resolve) => {
        inFlightResolve = resolve;
      });

      // Make spawn block until we explicitly resolve. Three concurrent
      // warmForKey calls should still produce only one spawn while the
      // first is in flight.
      spawnMock.mockImplementation(() => {
        return createFakeProcess(1601);
      });

      const pool = new PtyPool({ poolSize: 2, defaultCwd: "/repo" });

      pool.warmForKey("/repo", undefined, "env-x");
      pool.warmForKey("/repo", undefined, "env-x");
      pool.warmForKey("/repo", undefined, "env-x");

      await flushMicrotasks();
      // Only one spawn for the key, because warmsInFlight blocks duplicates
      // until the first resolves.
      expect(spawnMock).toHaveBeenCalledTimes(1);

      inFlightResolve();
      await inFlightPromise;
      pool.dispose();
    });

    it("respects the per-key poolSize cap when warming", async () => {
      spawnMock.mockReturnValue(createFakeProcess(1701));
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

      pool.warmForKey("/repo", undefined, "env-cap");
      await flushMicrotasks();
      // Second call should be a no-op because the per-key cap (poolSize=1)
      // is already met.
      pool.warmForKey("/repo", undefined, "env-cap");
      await flushMicrotasks();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      pool.dispose();
    });

    it("warms multiple restored panel cwds after drainAndRefill so each later acquire hits (#9774)", async () => {
      const root = createFakeProcess(1801);
      const wtA = createFakeProcess(1802);
      const wtB = createFakeProcess(1803);
      spawnMock.mockReturnValueOnce(root).mockReturnValueOnce(wtA).mockReturnValueOnce(wtB);

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });

      // Mirror the connection handler: root drain/refill first, then warm each
      // restored panel cwd at the env-empty key.
      await pool.drainAndRefill("/repo");
      pool.warmForKey("/repo/wt-a", undefined, "env-empty");
      pool.warmForKey("/repo/wt-b", undefined, "env-empty");
      await flushMicrotasks();

      expect(spawnMock).toHaveBeenCalledTimes(3);
      expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({ cwd: "/repo/wt-a" });
      expect(spawnMock.mock.calls[2]?.[2]).toMatchObject({ cwd: "/repo/wt-b" });

      // A restored panel spawning at its own worktree cwd now hits the pool
      // instead of paying a full cold spawn.
      expect(pool.acquireByKey("/repo/wt-a", "env-empty")?.process).toBe(wtA);
      expect(pool.acquireByKey("/repo/wt-b", "env-empty")?.process).toBe(wtB);
      pool.dispose();
    });

    it("survives the drain epoch when panel cwds are warmed after drainAndRefill resolves (#9774)", async () => {
      const stale = createFakeProcess(1901);
      const root = createFakeProcess(1902);
      const panel = createFakeProcess(1903);
      spawnMock.mockReturnValueOnce(stale).mockReturnValueOnce(root).mockReturnValueOnce(panel);

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/old" });
      await pool.warmPool();

      // drainAndRefill bumps the epoch and kills the stale entry; the panel
      // warm fires only after it resolves, so the new entry is tagged with the
      // current epoch and is not rejected as stale.
      await pool.drainAndRefill("/repo");
      pool.warmForKey("/repo/wt-a", undefined, "env-empty");
      await flushMicrotasks();

      expect(pool.acquireByKey("/repo/wt-a", "env-empty")?.process).toBe(panel);
      pool.dispose();
    });

    it("keeps total entries bounded by maxEntries when warming many panel cwds (#9774)", async () => {
      spawnMock.mockImplementation(() => createFakeProcess(2100 + spawnMock.mock.calls.length));
      const pool = new PtyPool({ poolSize: 1, maxEntries: 3, defaultCwd: "/home/tester" });

      await pool.drainAndRefill("/repo");
      // Warm more distinct cwds than the global cap allows; LRU eviction must
      // hold the pool at maxEntries rather than growing unbounded.
      pool.warmForKey("/repo/wt-a", undefined, "env-empty");
      pool.warmForKey("/repo/wt-b", undefined, "env-empty");
      pool.warmForKey("/repo/wt-c", undefined, "env-empty");
      pool.warmForKey("/repo/wt-d", undefined, "env-empty");
      await flushMicrotasks();

      expect(pool.getPoolSize()).toBeLessThanOrEqual(3);
      pool.dispose();
    });

    it("destroys the pooled PTY on unexpected exit so the master FD is released (#7892)", async () => {
      const first = createFakeProcess(2001);
      const second = createFakeProcess(2002);
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      // emitExit simulates the kernel teardown (e.g. shell rc syntax error
      // killing the shell on startup). destroy() must be called by the pool
      // so /dev/ptmx is closed; kill() alone leaves it open and contributes
      // to the system-wide ptmx_max leak that #7892 reported.
      first.emitExit(1);

      expect(first.destroy).toHaveBeenCalledTimes(1);
      pool.dispose();
    });

    it("destroys pooled PTYs during dispose() so dispose leaks no FDs", async () => {
      const proc = createFakeProcess(2101);
      spawnMock.mockReturnValueOnce(proc);
      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      pool.dispose();

      expect(proc.destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys pooled PTYs during drainAndRefill() so cwd transitions leak no FDs", async () => {
      const initial = createFakeProcess(2201);
      const refilled = createFakeProcess(2202);
      spawnMock.mockReturnValueOnce(initial).mockReturnValueOnce(refilled);

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
      await pool.warmPool();

      await pool.drainAndRefill("/repo");

      expect(initial.destroy).toHaveBeenCalledTimes(1);
      pool.dispose();
    });

    it("destroys pooled PTYs during LRU eviction so capacity transitions leak no FDs", async () => {
      const procs = [createFakeProcess(2301), createFakeProcess(2302), createFakeProcess(2303)];
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(2399));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo", maxEntries: 2 });

      pool.warmForKey("/repo", undefined, "env-a");
      await flushMicrotasks();
      pool.warmForKey("/repo", undefined, "env-b");
      await flushMicrotasks();
      pool.warmForKey("/repo", undefined, "env-c");
      await flushMicrotasks();

      // env-a was the victim — must be destroyed (not just killed).
      expect(procs[0]?.destroy).toHaveBeenCalledTimes(1);
      pool.dispose();
    });

    it("blocks refill after MAX_KEY_FAILURES fast exits to prevent crash-loop FD leak (#7892)", async () => {
      // Consecutive fast exits should trip the circuit breaker. The refill
      // that would otherwise be triggered by the post-trip onExit→refillPool
      // must NOT happen — otherwise a misconfigured shell crash-loops the
      // pool and burns ~60 FDs per cycle (the FD leak in #7892).
      const procs = Array.from({ length: 8 }, (_, idx) => createFakeProcess(3000 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(3999));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      // Walk the chain: each emitExit removes the current entry and (when
      // the breaker is open) refillPool replaces it synchronously. We must
      // drain the `.then().finally()` chain between exits to clear
      // `refillInProgress`; otherwise sequential refills are dropped.
      let callIdx = 0;
      while (callIdx < procs.length) {
        const before = spawnMock.mock.calls.length;
        procs[callIdx]?.emitExit(1);
        await settleRefill();
        const after = spawnMock.mock.calls.length;
        callIdx += 1;
        if (after === before) {
          // No new spawn — breaker is now blocking refill.
          break;
        }
      }

      // The breaker should have tripped before exhausting all the procs.
      // We don't pin the exact spawn count (it depends on timing of
      // `refillInProgress` clearing across microtasks); we pin the
      // observable invariant: pool ends up empty AND the next fast exit
      // does not trigger a new spawn.
      expect(pool.getPoolSize()).toBe(0);
      const spawnsAtBlock = spawnMock.mock.calls.length;
      procs[callIdx]?.emitExit(1);
      await settleRefill();
      expect(spawnMock).toHaveBeenCalledTimes(spawnsAtBlock);
      pool.dispose();
    });

    it("blocks warmForKey for a key whose breaker has tripped", async () => {
      // Force the breaker on env-x by tripping fast exits via warmForKey,
      // then verify a fresh warmForKey for the same key is a no-op.
      const procs = Array.from({ length: 6 }, (_, idx) => createFakeProcess(3500 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(3599));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

      // First warmForKey + immediate fast exit, repeated. Each fast exit
      // calls refillPool, but refillPool only warms the env-empty key — for
      // arbitrary keys we drive the loop manually via warmForKey.
      for (let k = 0; k < 5; k++) {
        pool.warmForKey("/repo", undefined, "env-x");
        await settleRefill();
        // Find the entry in the pool for env-x (if any) and emit exit on
        // the underlying fake. We use the test-known proc index since each
        // warmForKey produces exactly one spawn until the breaker trips.
        const spawnedCount = spawnMock.mock.calls.length;
        const proc = procs[spawnedCount - 1];
        if (proc) proc.emitExit(1);
        await settleRefill();
      }

      const spawnsAtBlock = spawnMock.mock.calls.length;
      pool.warmForKey("/repo", undefined, "env-x");
      await settleRefill();
      // No new spawn — breaker is gating warmForKey.
      expect(spawnMock).toHaveBeenCalledTimes(spawnsAtBlock);
      pool.dispose();
    });

    it("does not count long-lived idle exits toward the circuit breaker", async () => {
      // Long-lived (>FAST_EXIT_THRESHOLD_MS) exits should never trip the
      // breaker — only fast exits indicate a misconfigured key. Use a
      // monotonically-advancing Date.now mock so each entry's lifetime
      // crosses the threshold without relying on fake timers (which
      // wouldn't help since the implementation reads Date.now() directly).
      const procs = Array.from({ length: 8 }, (_, idx) => createFakeProcess(4000 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(4999));

      const realNow = Date.now.bind(Date);
      let nowOffset = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowOffset);

      try {
        const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
        await pool.warmPool();

        // Walk many exits, advancing well past the fast-exit window between
        // them. If long-lived exits counted, the breaker would trip after
        // MAX_KEY_FAILURES; with the threshold check they should not.
        for (let k = 0; k < 6; k++) {
          nowOffset += 10_000;
          const spawned = spawnMock.mock.calls.length;
          const proc = procs[spawned - 1];
          if (!proc) break;
          proc.emitExit(0);
          await settleRefill();
        }

        // The pool should still be refilling; if the breaker had tripped,
        // the pool would be empty for at least the cooldown window.
        expect(pool.getPoolSize()).toBe(1);
        pool.dispose();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("circuit breaker is per-key — a tripped key does not block other keys", async () => {
      // Trip env-a's breaker; env-b must still warm freely.
      const procs = Array.from({ length: 10 }, (_, idx) => createFakeProcess(5000 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(5999));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

      // Drive env-a into a fast-exit loop until warmForKey is gated.
      let lastSpawnCount = 0;
      for (let k = 0; k < 6; k++) {
        pool.warmForKey("/repo", undefined, "env-a");
        await settleRefill();
        const spawned = spawnMock.mock.calls.length;
        const proc = procs[spawned - 1];
        if (proc && spawned > lastSpawnCount) {
          lastSpawnCount = spawned;
          proc.emitExit(1);
          await settleRefill();
        } else {
          // warmForKey was a no-op → breaker is now blocking env-a.
          break;
        }
      }

      const callsAfterEnvA = spawnMock.mock.calls.length;

      // env-b should still warm freely — distinct key, distinct breaker.
      pool.warmForKey("/repo", undefined, "env-b");
      await settleRefill();

      expect(spawnMock).toHaveBeenCalledTimes(callsAfterEnvA + 1);
      expect(spawnMock.mock.calls[callsAfterEnvA]?.[2]).toMatchObject({ cwd: "/repo" });
      pool.dispose();
    });

    it("warmPool respects the breaker — drainAndRefill back to a blocked cwd is a no-op", async () => {
      // Regression for #7892: drainAndRefill() ends with warmPool(). Without
      // a breaker check in warmPool, switching to /repo-b and back to /repo
      // after the breaker tripped on /repo would re-enter the crash loop.
      const procs = Array.from({ length: 12 }, (_, idx) => createFakeProcess(8000 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(8999));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
      await pool.warmPool();

      // Trip the breaker on /repo env-empty via fast exits.
      let lastSpawn = 1;
      for (let k = 0; k < 8; k++) {
        const spawned = spawnMock.mock.calls.length;
        const proc = procs[spawned - 1];
        if (!proc) break;
        proc.emitExit(1);
        await settleRefill();
        const after = spawnMock.mock.calls.length;
        if (after === spawned) {
          lastSpawn = after;
          break;
        }
      }

      const spawnsAtBlock = spawnMock.mock.calls.length;
      expect(lastSpawn).toBeGreaterThan(0);

      // Switch away to /repo-b (warmPool there is fine — different key).
      await pool.drainAndRefill("/repo-b");
      // /repo-b warm did spawn one entry.
      expect(spawnMock.mock.calls.length).toBe(spawnsAtBlock + 1);
      const spawnsAfterB = spawnMock.mock.calls.length;

      // Switch back to /repo — warmPool must see the still-blocked breaker
      // and refuse to spawn. Without the fix, this re-enters the crash loop.
      await pool.drainAndRefill("/repo");
      expect(spawnMock).toHaveBeenCalledTimes(spawnsAfterB);
      pool.dispose();
    });

    it("circuit breaker cools down and resumes refill after the backoff window", async () => {
      // Drive the breaker into the blocked state for env-empty, advance
      // virtual time past KEY_BACKOFF_MS, then verify a fresh warmForKey
      // succeeds. We mock Date.now directly because the implementation
      // reads it inline and fake timers wouldn't intercept that.
      const procs = Array.from({ length: 12 }, (_, idx) => createFakeProcess(6000 + idx));
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(6999));

      const realNow = Date.now.bind(Date);
      let nowOffset = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowOffset);

      try {
        const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
        await pool.warmPool();

        // Drive fast exits until the breaker engages.
        let lastSpawn = 0;
        for (let k = 0; k < 8; k++) {
          const spawned = spawnMock.mock.calls.length;
          const proc = procs[spawned - 1];
          if (!proc) break;
          proc.emitExit(1);
          await settleRefill();
          const after = spawnMock.mock.calls.length;
          if (after === spawned) {
            lastSpawn = after;
            break;
          }
        }

        // Breaker should now be blocking — additional emitExit drives no
        // new spawn. (Pool is empty at this point.)
        expect(pool.getPoolSize()).toBe(0);

        // Advance virtual time past the 30s cooldown.
        nowOffset += 31_000;
        pool.warmForKey("/repo", undefined, "env-empty");
        await settleRefill();

        expect(spawnMock.mock.calls.length).toBeGreaterThan(lastSpawn);
        pool.dispose();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("evicts an idle entry from a different key when global cap is reached", async () => {
      // Capture the first three procs so we can identify the victim.
      const procs = [
        createFakeProcess(1801),
        createFakeProcess(1802),
        createFakeProcess(1803),
        createFakeProcess(1804),
      ];
      let i = 0;
      spawnMock.mockImplementation(() => procs[i++] ?? createFakeProcess(1899));

      const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo", maxEntries: 2 });

      pool.warmForKey("/repo", undefined, "env-a");
      await flushMicrotasks();
      pool.warmForKey("/repo", undefined, "env-b");
      await flushMicrotasks();

      expect(pool.getPoolSize()).toBe(2);

      // Third key would breach the global cap; the older env-a entry must
      // be evicted (killed) before the env-c entry is registered.
      pool.warmForKey("/repo", undefined, "env-c");
      await flushMicrotasks();

      expect(pool.getPoolSize()).toBe(2);
      expect(procs[0]?.kill).toHaveBeenCalledTimes(1);
      expect(procs[1]?.kill).not.toHaveBeenCalled();
      // env-c entry is now in the pool
      expect(pool.acquireByKey("/repo", "env-c")?.process).toBe(procs[2]);
      pool.dispose();
    });
  });
});

describe("destroyPty — Windows ConPTY double-free guard (#9551)", () => {
  const realPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  afterEach(() => {
    setPlatform(realPlatform);
  });

  function fakePty(overrides: Record<string, unknown> = {}): {
    pty: IPty;
    destroy: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  } {
    const destroy = vi.fn();
    const kill = vi.fn();
    const pty = { kill, destroy, ...overrides } as unknown as IPty;
    return { pty, destroy, kill };
  }

  it("skips destroy()/kill() on Windows once the pty agent has recorded an exit", () => {
    setPlatform("win32");
    const { pty, destroy, kill } = fakePty({ _agent: { exitCode: 0 } });

    destroyPty(pty);

    expect(destroy).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("issues a single kill() on a live Windows pty and never destroy() (avoids the double native kill)", () => {
    setPlatform("win32");
    const { pty, destroy, kill } = fakePty({ _agent: { exitCode: undefined } });

    destroyPty(pty);

    // destroy() + kill() would both route to _ptyNative.kill, double-freeing the
    // pseudoconsole. Exactly one native kill is the safe maximum on Windows.
    expect(destroy).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("always tears down on non-Windows even after exit (releases the master fd)", () => {
    setPlatform("linux");
    const { pty, destroy, kill } = fakePty({ _agent: { exitCode: 0 } });

    destroyPty(pty);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("tears down mocks without an agent on Windows (no exit signal available)", () => {
    setPlatform("win32");
    const { pty, destroy, kill } = fakePty();

    destroyPty(pty);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
