import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScheduledCall {
  cmd: string;
  args: readonly string[] | null | undefined;
  options: Record<string, unknown>;
  resolve: (stdout: string) => void;
  reject: (err: Error) => void;
}

const execFileMock = vi.hoisted(() => {
  const calls: ScheduledCall[] = [];
  const fn = (..._args: unknown[]) => {
    throw new Error("execFile mock was called with callback form (unexpected)");
  };
  Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
    value: (
      cmd: string,
      args: readonly string[] | null | undefined,
      options: Record<string, unknown>
    ) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        calls.push({
          cmd,
          args,
          options,
          resolve: (stdout) => resolve({ stdout, stderr: "" }),
          reject: (err) => reject(err),
        });
      }),
  });
  return Object.assign(fn, { calls });
});

const readlinkMock = vi.hoisted(() => {
  const queue: Array<{ resolve: (value: string) => void; reject: (err: Error) => void }> = [];
  const calls: string[] = [];
  const fn = (target: string) => {
    calls.push(target);
    return new Promise<string>((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  };
  return Object.assign(fn, { queue, calls });
});

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  readlink: readlinkMock,
}));

const { ImagePathProbe, IMAGE_PATH_RETRY_BASE_MS, IMAGE_PATH_RETRY_MAX_MS } =
  await import("../ImagePathProbe.js");

/** ProcessTreeCache's base poll interval — the cadence `readBasename` is read at. */
const POLL_INTERVAL_MS = 1_500;
/** Reads in a 60s window at that cadence: t = 0, 1500 … 58500. */
const POLL_READS = 40;

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function flush(): Promise<void> {
  // Drain microtasks so the async refresh writes back into the cache before
  // we make the next synchronous read.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Settle the most recently launched readlink probe as a failure. */
async function failNewestProbe(): Promise<void> {
  readlinkMock.queue[readlinkMock.queue.length - 1]!.reject(new Error("EACCES"));
  await flush();
}

/** Settle the most recently launched readlink probe with an image path. */
async function resolveNewestProbe(target: string): Promise<void> {
  readlinkMock.queue[readlinkMock.queue.length - 1]!.resolve(target);
  await flush();
}

/**
 * Read `pid` once and report whether that read launched a probe, failing it
 * when it did. The launch count is taken from the mock's own call log rather
 * than from anything the probe exposes, so the reading survives a refactor of
 * the cache internals.
 */
async function readAndFail(probe: InstanceType<typeof ImagePathProbe>, pid: number) {
  const before = readlinkMock.calls.length;
  probe.readBasename(pid);
  const launched = readlinkMock.calls.length > before;
  if (launched) await failNewestProbe();
  return launched;
}

describe("ImagePathProbe", () => {
  beforeEach(() => {
    execFileMock.calls.length = 0;
    readlinkMock.queue.length = 0;
    readlinkMock.calls.length = 0;
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("returns null on first read while the probe is in flight", () => {
    const probe = new ImagePathProbe();
    expect(probe.readBasename(123)).toBeNull();
    expect(readlinkMock.calls).toEqual(["/proc/123/exe"]);
  });

  it("returns null for invalid PIDs without scheduling a probe", () => {
    const probe = new ImagePathProbe();
    expect(probe.readBasename(0)).toBeNull();
    expect(probe.readBasename(-1)).toBeNull();
    expect(probe.readBasename(Number.NaN)).toBeNull();
    expect(readlinkMock.calls).toHaveLength(0);
  });

  it("returns null on unsupported platforms", () => {
    setPlatform("freebsd" as NodeJS.Platform);
    const probe = new ImagePathProbe();
    expect(probe.readBasename(123)).toBeNull();
    expect(readlinkMock.calls).toHaveLength(0);
    expect(execFileMock.calls).toHaveLength(0);
  });

  describe("Linux", () => {
    it("publishes the lowercased basename from /proc/<pid>/exe", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
      await flush();

      expect(probe.readBasename(123)).toBe("claude");
    });

    it("strips the trailing ' (deleted)' suffix from procfs symlinks", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/local/bin/claude (deleted)");
      await flush();

      expect(probe.readBasename(123)).toBe("claude");
    });

    it("persists null when readlink rejects", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.reject(new Error("ENOENT"));
      await flush();

      expect(probe.readBasename(123)).toBeNull();
    });

    it("does not schedule a refresh while one is already in flight", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      probe.readBasename(123);
      probe.readBasename(123);
      expect(readlinkMock.calls).toHaveLength(1);
    });

    it("returns the cached basename permanently for a live PID without re-probing", async () => {
      // A running process's executable image is immutable, so a successful
      // probe result holds for the PID's lifetime — no staleness window, no
      // background re-probe per detection pass.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
        await flush();

        vi.advanceTimersByTime(60_000);

        expect(probe.readBasename(123)).toBe("claude");
        expect(readlinkMock.calls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries a failed probe until one succeeds, once the backoff has elapsed", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        // Failure cached as null. Reads inside the backoff window are served
        // from the cache without launching anything — this is the whole fix.
        expect(probe.readBasename(123)).toBeNull();
        expect(readlinkMock.calls).toHaveLength(1);

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS);
        expect(probe.readBasename(123)).toBeNull();
        await resolveNewestProbe("/opt/homebrew/bin/claude");

        expect(probe.readBasename(123)).toBe("claude");
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("survives a 1500ms poll-interval tick without blanking the basename", async () => {
      // Regression guard for the hard-max=poll-interval timing bug. With the
      // ProcessTreeCache poll at 1500ms and (previously) the probe's max age
      // at 1500ms, every poll past the first one would fall past max-age
      // under setTimeout jitter, return null, and defeat hysteresis. A
      // successful result is now retained for the life of the entry, so the
      // cached basename survives any number of poll cycles.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
        await flush();

        vi.advanceTimersByTime(1500);
        expect(probe.readBasename(123)).toBe("claude");

        vi.advanceTimersByTime(1500);
        expect(probe.readBasename(123)).toBe("claude");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("macOS", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("invokes lsof with the expected arguments", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      expect(execFileMock.calls).toHaveLength(1);
      expect(execFileMock.calls[0]!.cmd).toBe("lsof");
      expect(execFileMock.calls[0]!.args).toEqual(["-a", "-d", "txt", "-p", "4242", "-Fn"]);
    });

    it("picks the executable basename from a multi-line lsof output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);

      // Realistic `lsof -Fn` output: each fd record is several lines, with
      // multiple text-segment mappings (the executable plus its dylibs).
      const lsofOutput = [
        "p4242",
        "n/opt/homebrew/bin/claude",
        "f257",
        "n/usr/lib/dyld",
        "f258",
        "n/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        "f259",
        "n/opt/homebrew/lib/libnode.dylib",
        "",
      ].join("\n");

      execFileMock.calls[0]!.resolve(lsofOutput);
      await flush();

      expect(probe.readBasename(4242)).toBe("claude");
    });

    it("falls back to the first absolute path when every entry is a library", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.resolve(
        ["p4242", "n/usr/lib/dyld", "n/System/Library/Frameworks/Foundation.framework", ""].join(
          "\n"
        )
      );
      await flush();

      expect(probe.readBasename(4242)).toBe("dyld");
    });

    it("returns null on empty output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.resolve("");
      await flush();
      expect(probe.readBasename(4242)).toBeNull();
    });

    it("persists null when lsof fails (process exited)", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.reject(new Error("lsof: no such process"));
      await flush();
      expect(probe.readBasename(4242)).toBeNull();
    });
  });

  describe("Windows", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("invokes PowerShell with Get-CimInstance", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      expect(execFileMock.calls).toHaveLength(1);
      expect(execFileMock.calls[0]!.cmd).toBe("powershell.exe");
      const args = execFileMock.calls[0]!.args ?? [];
      expect(args).toContain("-NoProfile");
      expect(args).toContain("-NonInteractive");
      expect(args[args.length - 1]).toContain("ProcessId=5005");
      expect(args[args.length - 1]).toContain("Win32_Process");
    });

    it("strips .exe and lowercases the result", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      execFileMock.calls[0]!.resolve("C:\\Program Files\\Claude\\Claude.exe\r\n");
      await flush();
      expect(probe.readBasename(5005)).toBe("claude");
    });

    it("returns null on empty output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      execFileMock.calls[0]!.resolve("");
      await flush();
      expect(probe.readBasename(5005)).toBeNull();
    });

    it("strips other Windows executable extensions", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5006);
      execFileMock.calls[0]!.resolve("C:\\npm\\claude.cmd\r\n");
      await flush();
      expect(probe.readBasename(5006)).toBe("claude");
    });
  });

  describe("failed-probe backoff", () => {
    it("collapses a failing PID's probe launches across a 60s poll window", async () => {
      // The headline reading for #12239, taken in both directions in one pass.
      //
      // The baseline arm is the pre-fix rule, MEASURED rather than asserted: a
      // read of a PID with no result scheduled a probe every time, which is
      // exactly what a fresh instance does on its first read. Both arms run at
      // the same cadence against the same failure, so the ratio between them
      // is the change and nothing else.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        const launchOffsets: number[] = [];
        const start = Date.now();
        let baselineLaunches = 0;

        for (let read = 0; read < POLL_READS; read++) {
          if (await readAndFail(probe, 123)) launchOffsets.push(Date.now() - start);

          const fresh = new ImagePathProbe();
          if (await readAndFail(fresh, 123)) baselineLaunches += 1;
          fresh.dispose();

          vi.advanceTimersByTime(POLL_INTERVAL_MS);
        }

        // Every read in the baseline arm launched: 40 `lsof`/PowerShell starts
        // a minute for one PID the probe can never read.
        expect(baselineLaunches).toBe(POLL_READS);
        // 3s, then 6, 12 and 24 — the ladder, stated as instants so a change
        // to the curve has to be a deliberate edit here.
        expect(launchOffsets).toEqual([0, 3_000, 9_000, 21_000, 45_000]);
        // The bar the issue sets for shipping this at all.
        expect(baselineLaunches / launchOffsets.length).toBeGreaterThanOrEqual(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("suppresses a retry up to the boundary and allows it on the boundary", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - 1);
        probe.readBasename(123);
        expect(readlinkMock.calls).toHaveLength(1);

        vi.advanceTimersByTime(1);
        probe.readBasename(123);
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts the backoff when the probe settles, not when it launched", async () => {
      // A probe that hangs to its 750ms timeout has already cost the wall time
      // it was going to cost; charging its cooldown from the launch would hand
      // back part of the window it was meant to buy.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);

        // In flight across a poll: dedupe holds, nothing new launches.
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        probe.readBasename(123);
        expect(readlinkMock.calls).toHaveLength(1);

        await failNewestProbe();

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - 1);
        probe.readBasename(123);
        expect(readlinkMock.calls).toHaveLength(1);

        vi.advanceTimersByTime(1);
        probe.readBasename(123);
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("caps the backoff at the ceiling", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        // Walk the ladder to the ceiling, one failure per step.
        let delay = IMAGE_PATH_RETRY_BASE_MS;
        while (delay < IMAGE_PATH_RETRY_MAX_MS) {
          vi.advanceTimersByTime(delay);
          expect(await readAndFail(probe, 123)).toBe(true);
          delay = Math.min(delay * 2, IMAGE_PATH_RETRY_MAX_MS);
        }

        // Two more failures at the ceiling: the gap must stop growing, and
        // must still be exactly the ceiling rather than creeping past it.
        for (let step = 0; step < 2; step++) {
          vi.advanceTimersByTime(IMAGE_PATH_RETRY_MAX_MS - 1);
          expect(await readAndFail(probe, 123)).toBe(false);
          vi.advanceTimersByTime(1);
          expect(await readAndFail(probe, 123)).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the backoff on success and stops probing for good", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS);
        expect(await readAndFail(probe, 123)).toBe(true);

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS * 2);
        probe.readBasename(123);
        await resolveNewestProbe("/opt/homebrew/bin/claude");
        expect(probe.readBasename(123)).toBe("claude");

        const afterSuccess = readlinkMock.calls.length;
        vi.advanceTimersByTime(IMAGE_PATH_RETRY_MAX_MS * 4);
        expect(probe.readBasename(123)).toBe("claude");
        expect(readlinkMock.calls).toHaveLength(afterSuccess);
      } finally {
        vi.useRealTimers();
      }
    });

    it("backs off each PID independently", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        // A second PID arriving mid-cooldown is a first-ever probe and must
        // not inherit anything from its neighbour.
        expect(await readAndFail(probe, 456)).toBe(true);
        expect(readlinkMock.calls).toEqual(["/proc/123/exe", "/proc/456/exe"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("evict() clears the backoff so a recycled PID probes immediately", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        // Deep into the cooldown, the number is handed to a different process.
        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS / 2);
        probe.evict(123);

        probe.readBasename(123);
        await resolveNewestProbe("/usr/bin/codex");
        expect(probe.readBasename(123)).toBe("codex");
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sweeps a backed-off entry at the eviction TTL rather than holding its cooldown", async () => {
      // The two windows overlap: the ceiling (48s) outlives the eviction TTL
      // (30s), so an entry that stops being read is dropped and the PID that
      // comes back probes at once instead of serving out a stale cooldown.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        let delay = IMAGE_PATH_RETRY_BASE_MS;
        while (delay < IMAGE_PATH_RETRY_MAX_MS) {
          vi.advanceTimersByTime(delay);
          expect(await readAndFail(probe, 123)).toBe(true);
          delay = Math.min(delay * 2, IMAGE_PATH_RETRY_MAX_MS);
        }

        // Idle past the eviction TTL but well short of the ceiling.
        vi.advanceTimersByTime(31_000);
        const before = readlinkMock.calls.length;
        // Reading any PID runs the sweep on entry creation.
        probe.readBasename(456);
        await failNewestProbe();

        probe.readBasename(123);
        expect(readlinkMock.calls.length).toBe(before + 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not launch or advance the backoff after dispose", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      probe.dispose();

      // The in-flight refresh settles into a disposed probe.
      await failNewestProbe();
      expect(probe.readBasename(123)).toBeNull();
      expect(readlinkMock.calls).toHaveLength(1);
    });

    it("backs off an empty result the same as a rejection", async () => {
      // On macOS a process the probe cannot read is an lsof that exits 0 with
      // nothing usable, not an error — the platform resolvers erase both into
      // null, so the gate has to treat them alike.
      setPlatform("darwin");
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(4242);
        execFileMock.calls[0]!.resolve("");
        await flush();
        expect(probe.readBasename(4242)).toBeNull();
        expect(execFileMock.calls).toHaveLength(1);

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - 1);
        probe.readBasename(4242);
        expect(execFileMock.calls).toHaveLength(1);

        vi.advanceTimersByTime(1);
        probe.readBasename(4242);
        expect(execFileMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let a stale in-flight failure back off a recreated entry", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123); // first refresh, in flight
        probe.evict(123);
        probe.readBasename(123); // new entry, second refresh in flight

        // The superseded refresh fails. Its checkId no longer matches, so it
        // must not stamp a cooldown onto the entry that replaced it.
        readlinkMock.queue[0]!.reject(new Error("EACCES"));
        await flush();

        readlinkMock.queue[1]!.resolve("/usr/bin/claude");
        await flush();
        expect(probe.readBasename(123)).toBe("claude");
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cache lifecycle", () => {
    it("evict() drops the cached entry so a recycled PID re-probes", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/bin/claude");
      await flush();
      expect(probe.readBasename(123)).toBe("claude");

      probe.evict(123);
      expect(probe.readBasename(123)).toBeNull();
      expect(readlinkMock.calls).toHaveLength(2);
    });

    it("dispose() blocks further reads and refreshes", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/bin/claude");
      await flush();

      probe.dispose();
      expect(probe.readBasename(123)).toBeNull();
      // Disposed probe must not schedule a new readlink call for the same PID.
      expect(readlinkMock.calls).toHaveLength(1);
    });

    it("does not overwrite a recreated entry with the stale in-flight resolution", async () => {
      // Regression guard for the checkId reset bug. PID 123 is probed and
      // its refresh is in flight. evict() drops the entry. A fresh read on
      // the same PID creates a new entry. When the old in-flight refresh
      // finally resolves it must NOT overwrite the new entry's state — the
      // global monotonic checkId ensures the old refresh's checkId no
      // longer matches.
      const probe = new ImagePathProbe();
      probe.readBasename(123); // schedules first refresh
      probe.evict(123); // drops entry; first refresh still in flight

      probe.readBasename(123); // creates new entry, schedules second refresh
      expect(readlinkMock.queue).toHaveLength(2);

      // Old refresh resolves with a stale result — must not be written into
      // the new entry.
      readlinkMock.queue[0]!.resolve("/old/stale/binary");
      await flush();
      expect(probe.readBasename(123)).toBeNull();

      // New refresh resolves with the fresh value.
      readlinkMock.queue[1]!.resolve("/new/bin/claude");
      await flush();
      expect(probe.readBasename(123)).toBe("claude");
    });

    it("drops stale entries past the 30s eviction TTL on the next read", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/usr/bin/claude");
        await flush();

        vi.advanceTimersByTime(35_000);

        // Reading a different PID re-runs eviction; the long-idle 123 entry
        // is dropped, so a subsequent read of 123 must re-probe.
        probe.readBasename(456);
        readlinkMock.queue[0]!.resolve("/usr/bin/codex");
        await flush();

        expect(probe.readBasename(123)).toBeNull();
        expect(readlinkMock.calls).toContain("/proc/123/exe");
        // 123 should appear twice in readlink history: original + post-eviction.
        const calls123 = readlinkMock.calls.filter((c) => c === "/proc/123/exe");
        expect(calls123.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
