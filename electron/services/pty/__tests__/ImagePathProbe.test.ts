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

const {
  ImagePathProbe,
  IMAGE_PATH_RETRY_BASE_MS,
  IMAGE_PATH_RETRY_MAX_MS,
  IMAGE_PATH_EVICTION_TTL_MS,
} = await import("../ImagePathProbe.js");

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
 * Read `pid` once and report how many probes that read launched, failing the
 * launched one. The count comes from the mock's own call log rather than from
 * anything the probe exposes, so the reading survives a refactor of the cache
 * internals — and it is a COUNT rather than a boolean so a read that launched
 * twice cannot be recorded as a read that launched once.
 */
async function readAndFail(
  probe: InstanceType<typeof ImagePathProbe>,
  pid: number
): Promise<number> {
  const before = readlinkMock.calls.length;
  probe.readBasename(pid);
  const launched = readlinkMock.calls.length - before;
  // One read may schedule at most one probe. Anything else means the gate
  // fired twice and every launch count in these tests is understated.
  expect(launched).toBeLessThanOrEqual(1);
  if (launched === 1) await failNewestProbe();
  return launched;
}

/**
 * Drive a PID that has already failed once all the way to the backoff ceiling,
 * one failure per step.
 *
 * This is SETUP, and its assertions say only that each scheduled step landed —
 * a constant short delay would satisfy every one of them. What proves the
 * climb is the boundary assertion each caller makes afterwards. The step is
 * named in the assertion message so a setup failure is never mistaken for the
 * case under test.
 */
async function climbToCeiling(
  probe: InstanceType<typeof ImagePathProbe>,
  pid: number
): Promise<void> {
  let delay = IMAGE_PATH_RETRY_BASE_MS;
  while (delay < IMAGE_PATH_RETRY_MAX_MS) {
    vi.advanceTimersByTime(delay);
    expect(await readAndFail(probe, pid), `climb setup: pid ${pid} at ${delay}ms`).toBe(1);
    delay = Math.min(delay * 2, IMAGE_PATH_RETRY_MAX_MS);
  }
}

/**
 * The launch instants the published curve implies, at a fixed poll cadence and
 * with probes that settle instantly (which is what fake timers give us).
 *
 * Derived from the exported constants and the doubling rule rather than
 * written out, so retuning the curve retargets the expectation instead of
 * forcing a matching edit — while dropping the doubling still fails it.
 *
 * What it does NOT catch, so that the claim stays the size of the check: a
 * missing cap is invisible inside one minute (the first launch the cap moves
 * is at 141s), and launch-charged versus settle-charged cooldowns coincide
 * here because a mock-settled probe advances no fake time. Those two belong to
 * the dedicated ceiling and settlement tests below.
 */
function expectedLaunchOffsets(reads: number, intervalMs: number): number[] {
  const offsets: number[] = [];
  let delay = 0;
  let eligibleAt = 0;
  for (let read = 0; read < reads; read += 1) {
    const now = read * intervalMs;
    if (now < eligibleAt) continue;
    offsets.push(now);
    delay = delay === 0 ? IMAGE_PATH_RETRY_BASE_MS : Math.min(delay * 2, IMAGE_PATH_RETRY_MAX_MS);
    eligibleAt = now + delay;
  }
  return offsets;
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
          baselineLaunches += await readAndFail(fresh, 123);
          fresh.dispose();

          vi.advanceTimersByTime(POLL_INTERVAL_MS);
        }

        // Every read in the baseline arm launched: 40 `lsof`/PowerShell starts
        // a minute for one PID the probe can never read.
        expect(baselineLaunches).toBe(POLL_READS);
        // The whole ladder, against a schedule re-derived from the published
        // curve rather than a copy of it. Catches a missing cap, a missing
        // doubling, and a cooldown charged from launch instead of settle.
        expect(launchOffsets).toEqual(expectedLaunchOffsets(POLL_READS, POLL_INTERVAL_MS));
        // The bar the issue sets for shipping this at all. Note which way the
        // ratio can be gamed: a probe that stopped retrying scores BETTER
        // here. The exact-ladder assertion above is what refuses that — a
        // stopped implementation produces a shorter array — and the ceiling
        // test is what proves retries continue past the ceiling indefinitely.
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
        await climbToCeiling(probe, 123);

        // Two more failures at the ceiling: the gap must stop growing, and
        // must still be exactly the ceiling rather than creeping past it.
        for (let step = 0; step < 2; step++) {
          vi.advanceTimersByTime(IMAGE_PATH_RETRY_MAX_MS - 1);
          expect(await readAndFail(probe, 123)).toBe(0);
          vi.advanceTimersByTime(1);
          expect(await readAndFail(probe, 123)).toBe(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("recovers from a PID that has been failing at the ceiling", async () => {
      // The direction the storm test cannot see: a probe that stopped retrying
      // altogether posts the best launch count in the suite, so recovery after
      // a long run of failures has to be asserted on its own.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();
        await climbToCeiling(probe, 123);

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_MAX_MS);
        probe.readBasename(123);
        await resolveNewestProbe("/opt/homebrew/bin/claude");

        expect(probe.readBasename(123)).toBe("claude");
      } finally {
        vi.useRealTimers();
      }
    });

    it("caches the eventual success and stops probing for good", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS);
        expect(await readAndFail(probe, 123)).toBe(1);

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

    it("keeps one PID's backoff out of every other PID's way", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();
        await climbToCeiling(probe, 123);

        // A second PID arriving mid-cooldown probes at once — and when IT
        // fails it must earn the BASE delay, not the ceiling its neighbour is
        // sitting on. Checking only the first read would miss a pooled delay
        // entirely: a fresh entry's gate is `now >= 0 + delay`, and Date.now()
        // is an epoch, so an inherited delay is invisible until the first
        // failure charges it.
        expect(await readAndFail(probe, 456)).toBe(1);
        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - 1);
        expect(await readAndFail(probe, 456)).toBe(0);
        vi.advanceTimersByTime(1);
        expect(await readAndFail(probe, 456)).toBe(1);

        // Only the base delay has elapsed for 123, nowhere near its ceiling.
        expect(await readAndFail(probe, 123)).toBe(0);

        // A third PID resolving must not clear 123's cooldown either.
        probe.readBasename(789);
        await resolveNewestProbe("/usr/bin/codex");
        expect(probe.readBasename(789)).toBe("codex");

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_MAX_MS - IMAGE_PATH_RETRY_BASE_MS - 1);
        expect(await readAndFail(probe, 123)).toBe(0);
        vi.advanceTimersByTime(1);
        expect(await readAndFail(probe, 123)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("evict() clears the backoff so a recycled PID starts from the base delay", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();
        await climbToCeiling(probe, 123);

        // A neighbour that stays in the map across the eviction, so an
        // implementation that pooled retry state between entries would have
        // something for the recreated entry to inherit.
        probe.readBasename(999);
        await failNewestProbe();

        // Deep into a ceiling-length cooldown, the number is handed to a
        // different process.
        probe.evict(123);
        expect(await readAndFail(probe, 123)).toBe(1);

        // The new entry's FIRST failure must earn the base delay, not resume
        // the streak the previous process built up. Checked on the boundary in
        // both directions, so a retained ceiling is caught rather than assumed.
        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - 1);
        expect(await readAndFail(probe, 123)).toBe(0);
        vi.advanceTimersByTime(1);
        expect(await readAndFail(probe, 123)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a suppressed read counting as a reference against the eviction TTL", async () => {
      // `lastReadAt` is updated on every read, including the ones the backoff
      // suppresses. If it were only updated when a probe launched, a PID being
      // polled every 1.5s would be swept mid-cooldown and re-probe at once —
      // silently undoing the backoff for exactly the PIDs it exists for.
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();
        await climbToCeiling(probe, 123);

        // Poll it across the eviction TTL without ever launching anything.
        const settled = readlinkMock.calls.length;
        for (let elapsed = 0; elapsed < IMAGE_PATH_EVICTION_TTL_MS + 5_000; elapsed += 1_500) {
          vi.advanceTimersByTime(1_500);
          probe.readBasename(123);
        }
        expect(readlinkMock.calls).toHaveLength(settled);

        // Creating another entry runs the sweep; the actively read 123 must
        // survive it and keep its cooldown.
        probe.readBasename(456);
        await failNewestProbe();
        expect(await readAndFail(probe, 123)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dedupes reads against an in-flight retry, not just an in-flight first probe", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        await failNewestProbe();

        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS);
        probe.readBasename(123); // retry launches
        expect(readlinkMock.calls).toHaveLength(2);

        // Further polls while that retry is in flight must add nothing, even
        // though the gate itself is open.
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        probe.readBasename(123);
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
        probe.readBasename(123);
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
        await climbToCeiling(probe, 123);

        // Idle past the eviction TTL but well short of the ceiling.
        vi.advanceTimersByTime(IMAGE_PATH_EVICTION_TTL_MS + 1_000);
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

    it("launches nothing more when a refresh settles into a disposed probe", async () => {
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

        // Settle the RECREATED entry first, so it owns a base-delay cooldown
        // of its own. Resolving it instead would wipe any cooldown the stale
        // completion wrote and hide exactly the bug this guards.
        readlinkMock.queue[1]!.reject(new Error("EACCES"));
        await flush();

        // Time moves between the two completions on purpose: with identical
        // timestamps a stale write that only re-stamped `updatedAt` would be
        // invisible, and that write alone is enough to push the retry out.
        const gapMs = 500;
        vi.advanceTimersByTime(gapMs);

        // Now the superseded refresh fails. Its checkId no longer matches, so
        // it must not touch the live entry's basename or advance its cooldown.
        readlinkMock.queue[0]!.reject(new Error("EACCES"));
        await flush();

        // Still on the BASE delay measured from the LIVE entry's own
        // completion — neither doubled nor re-stamped by the stale one.
        vi.advanceTimersByTime(IMAGE_PATH_RETRY_BASE_MS - gapMs - 1);
        expect(await readAndFail(probe, 123)).toBe(0);
        vi.advanceTimersByTime(1);
        expect(await readAndFail(probe, 123)).toBe(1);
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
        // 456's own probe, not 123's — queue[0] settled two lines above, and
        // resolving it again left 456 pending forever.
        await resolveNewestProbe("/usr/bin/codex");

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
