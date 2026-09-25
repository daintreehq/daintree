import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../utils/systemMemory.js", () => ({
  readElectronSwapUsage: vi.fn(),
}));

import { execFile } from "node:child_process";
import { logInfo, logWarn } from "../../utils/logger.js";
import { readElectronSwapUsage, type SwapUsage } from "../../utils/systemMemory.js";
import type { SystemMemoryPressurePayload } from "../../../shared/types/ipc/system.js";
import {
  createDefaultSystemMemoryPressureMonitor,
  createSystemMemoryPressureMonitor,
  EPISODE_CLEAR_SAMPLES,
  EPISODE_OPEN_SAMPLES,
  FSEVENTSD_RSS_THRESHOLD_MB,
  parseDarwinSwapUsage,
  parseFseventsdRssMb,
  parseKernelPressureLevel,
  type KernelPressureLevel,
  SAMPLE_INTERVAL_MS,
  SWAP_USED_PERCENT_THRESHOLD,
} from "../SystemMemoryPressureMonitor.js";

const SWAP_TOTAL_MB = 4096;
const swapAt = (percent: number): SwapUsage => ({
  usedMb: (SWAP_TOTAL_MB * percent) / 100,
  totalMb: SWAP_TOTAL_MB,
});
const HEALTHY_SWAP = swapAt(20);
const FULL_SWAP = swapAt(91);

/** Yields `readings` in order (null included), then `rest` forever. */
function sequence(readings: Array<SwapUsage | null>, rest: SwapUsage): () => SwapUsage | null {
  let i = 0;
  return () => (i < readings.length ? readings[i++]! : rest);
}

function systemHealthRecords(mock: typeof logWarn | typeof logInfo, state: "over" | "recovered") {
  return vi
    .mocked(mock)
    .mock.calls.filter(
      ([event, ctx]) =>
        event === "system-health" && (ctx as { state?: string } | undefined)?.state === state
    );
}

describe("parseDarwinSwapUsage", () => {
  it("parses encrypted swap output", () => {
    expect(
      parseDarwinSwapUsage("total = 2048.00M  used = 642.75M  free = 1405.25M  (encrypted)\n")
    ).toEqual({ totalMb: 2048, usedMb: 642.75 });
  });

  it("parses output without the encrypted tail and with mixed units", () => {
    expect(parseDarwinSwapUsage("total = 4.00G  used = 512.00K  free = 3.99G")).toEqual({
      totalMb: 4096,
      usedMb: 0.5,
    });
  });

  it("reads an empty swap file as zero of zero", () => {
    expect(parseDarwinSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  ")).toEqual({
      totalMb: 0,
      usedMb: 0,
    });
  });

  it("rejects malformed or inconsistent output", () => {
    expect(parseDarwinSwapUsage("")).toBeNull();
    expect(parseDarwinSwapUsage("sysctl: unknown oid 'vm.swapusage'")).toBeNull();
    expect(parseDarwinSwapUsage("total = 1024.00M  free = 1024.00M")).toBeNull();
    expect(parseDarwinSwapUsage("total = 1024.00M  used = 2048.00M  free = 0.00M")).toBeNull();
  });
});

describe("parseKernelPressureLevel", () => {
  it("accepts exactly the three levels XNU defines", () => {
    expect(parseKernelPressureLevel("1\n")).toBe(1);
    expect(parseKernelPressureLevel("2\n")).toBe(2);
    expect(parseKernelPressureLevel("4\n")).toBe(4);
  });

  it("reads anything else as no reading", () => {
    expect(parseKernelPressureLevel("")).toBeNull();
    expect(parseKernelPressureLevel("3")).toBeNull();
    expect(parseKernelPressureLevel("0")).toBeNull();
    expect(parseKernelPressureLevel("sysctl: unknown oid")).toBeNull();
    expect(parseKernelPressureLevel("41")).toBeNull();
  });
});

describe("parseFseventsdRssMb", () => {
  it("matches the exact process name and converts KB to MB", () => {
    const out = [
      "  1024 launchd         ",
      " 82192 fseventsd       ",
      "204800 Google Chrome He",
      "999999 fseventsd-helper",
    ].join("\n");
    expect(parseFseventsdRssMb(out)).toBeCloseTo(82192 / 1024);
  });

  it("returns 0 when fseventsd is not running", () => {
    expect(parseFseventsdRssMb("  1024 launchd\n  2048 WindowServer\n")).toBe(0);
  });

  it("takes the largest instance when several are listed", () => {
    expect(parseFseventsdRssMb(" 1024 fseventsd\n 4096 fseventsd\n 2048 fseventsd")).toBe(4);
  });
});

describe("createSystemMemoryPressureMonitor", () => {
  let now: number;
  let publish: Mock<(payload: SystemMemoryPressurePayload) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 0;
    publish = vi.fn();
  });

  function makeMonitor(opts: {
    isDarwin?: boolean;
    swap: () => SwapUsage | null;
    fseventsdRssMb?: () => number | null;
    kernelPressureLevel?: () => KernelPressureLevel | null;
  }) {
    const readSwap = vi.fn(async () => opts.swap());
    const readFseventsdRssMb = vi.fn(async () => (opts.fseventsdRssMb ?? (() => 100))());
    const readKernelPressureLevel = vi.fn(async () =>
      (opts.kernelPressureLevel ?? ((): KernelPressureLevel | null => 1))()
    );
    const monitor = createSystemMemoryPressureMonitor({
      isDarwin: opts.isDarwin ?? true,
      swapKind: "swap",
      readSwap,
      readFseventsdRssMb,
      readKernelPressureLevel,
      publish,
      now: () => now,
    });
    const tick = async (count = 1) => {
      for (let i = 0; i < count; i++) {
        await monitor.sample();
        now += SAMPLE_INTERVAL_MS;
      }
    };
    return { monitor, readSwap, readFseventsdRssMb, readKernelPressureLevel, tick };
  }

  it("samples at most once per interval however often the poll calls it", async () => {
    const { monitor, readSwap } = makeMonitor({ swap: () => HEALTHY_SWAP });

    await monitor.sample();
    now += SAMPLE_INTERVAL_MS / 2;
    await monitor.sample();
    expect(readSwap).toHaveBeenCalledTimes(1);

    now += SAMPLE_INTERVAL_MS / 2;
    await monitor.sample();
    expect(readSwap).toHaveBeenCalledTimes(2);
  });

  it("never starts a second sample while one is still in flight", async () => {
    let release!: (value: SwapUsage) => void;
    const readSwap = vi.fn(
      () =>
        new Promise<SwapUsage>((resolve) => {
          release = resolve;
        })
    );
    const monitor = createSystemMemoryPressureMonitor({
      isDarwin: false,
      swapKind: "swap",
      readSwap,
      readFseventsdRssMb: vi.fn(),
      readKernelPressureLevel: vi.fn(),
      publish,
      now: () => now,
    });

    const first = monitor.sample();
    now += 10 * SAMPLE_INTERVAL_MS;
    void monitor.sample();
    expect(readSwap).toHaveBeenCalledTimes(1);

    release(HEALTHY_SWAP);
    await first;
    const second = monitor.sample();
    expect(readSwap).toHaveBeenCalledTimes(2);
    release(HEALTHY_SWAP);
    await second;
  });

  it("logs every over-threshold sample and publishes once when the episode opens", async () => {
    const { tick } = makeMonitor({ swap: () => FULL_SWAP });

    await tick(EPISODE_OPEN_SAMPLES - 1);
    expect(publish).not.toHaveBeenCalled();

    await tick(3);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: 91,
      swapKind: "swap",
      fseventsdRssMb: null,
      kernelPressureLevel: null,
    });

    const records = systemHealthRecords(logWarn, "over");
    expect(records).toHaveLength(EPISODE_OPEN_SAMPLES + 2);
    expect(records[0]![1]).toEqual({
      state: "over",
      swapUsedPercent: 91,
      swapUsedMb: Math.round(FULL_SWAP.usedMb),
      swapTotalMb: SWAP_TOTAL_MB,
      swapKind: "swap",
      fseventsdRssMb: 100,
      kernelPressureLevel: 1,
      consecutiveSamples: 1,
    });
  });

  it("requires the over-threshold samples to be consecutive", async () => {
    const readings = [FULL_SWAP, FULL_SWAP, HEALTHY_SWAP, FULL_SWAP, FULL_SWAP];
    const { tick } = makeMonitor({ swap: () => readings.shift()! });

    await tick(5);
    expect(publish).not.toHaveBeenCalled();
  });

  it("opens on an fseventsd footprint over threshold and reports only that figure", async () => {
    const rssMb = 36 * 1024;
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP, fseventsdRssMb: () => rssMb });

    await tick(EPISODE_OPEN_SAMPLES);
    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: null,
      swapKind: "swap",
      fseventsdRssMb: rssMb,
      kernelPressureLevel: null,
    });
  });

  it("opens on a kernel warning alone and reports the level macOS gave (#12799)", async () => {
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP, kernelPressureLevel: () => 2 });

    await tick(EPISODE_OPEN_SAMPLES);
    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: null,
      swapKind: "swap",
      fseventsdRssMb: null,
      kernelPressureLevel: "warn",
    });
  });

  it("reports a critical level and closes once the kernel reads normal", async () => {
    let level: KernelPressureLevel = 4;
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP, kernelPressureLevel: () => level });

    await tick(EPISODE_OPEN_SAMPLES);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "degraded", kernelPressureLevel: "critical" })
    );
    level = 1;
    await tick(EPISODE_CLEAR_SAMPLES);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "normal", kernelPressureLevel: null })
    );
  });

  it("never proves recovery on Darwin without a kernel reading", async () => {
    let level: KernelPressureLevel | null = 4;
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP, kernelPressureLevel: () => level });

    await tick(EPISODE_OPEN_SAMPLES);
    level = null;
    await tick(EPISODE_CLEAR_SAMPLES + 2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not trip on an fseventsd footprint exactly at the threshold", async () => {
    const { tick } = makeMonitor({
      swap: () => HEALTHY_SWAP,
      fseventsdRssMb: () => FSEVENTSD_RSS_THRESHOLD_MB,
    });

    await tick(EPISODE_OPEN_SAMPLES);
    expect(publish).not.toHaveBeenCalled();
    expect(systemHealthRecords(logWarn, "over")).toHaveLength(0);
  });

  it("closes after consecutive clear samples with one recovery record and one publish", async () => {
    let swap = FULL_SWAP;
    const { tick } = makeMonitor({ swap: () => swap });

    await tick(EPISODE_OPEN_SAMPLES);
    swap = HEALTHY_SWAP;
    await tick(EPISODE_CLEAR_SAMPLES - 1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(systemHealthRecords(logInfo, "recovered")).toHaveLength(0);

    await tick(5);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      status: "normal",
      swapUsedPercent: null,
      swapKind: "swap",
      fseventsdRssMb: null,
      kernelPressureLevel: null,
    });
    expect(systemHealthRecords(logInfo, "recovered")).toHaveLength(1);
  });

  it("opens a fresh episode after a recovery", async () => {
    let swap = FULL_SWAP;
    const { tick } = makeMonitor({ swap: () => swap });

    await tick(EPISODE_OPEN_SAMPLES);
    swap = HEALTHY_SWAP;
    await tick(EPISODE_CLEAR_SAMPLES);
    swap = FULL_SWAP;
    await tick(EPISODE_OPEN_SAMPLES);

    expect(publish.mock.calls.map(([p]) => p.status)).toEqual(["degraded", "normal", "degraded"]);
  });

  it("logs the recovery of a blip that never opened an episode without publishing", async () => {
    const readings = [FULL_SWAP, HEALTHY_SWAP, HEALTHY_SWAP, HEALTHY_SWAP];
    const { tick } = makeMonitor({ swap: () => readings.shift()! });

    await tick(readings.length);
    expect(systemHealthRecords(logWarn, "over")).toHaveLength(1);
    expect(systemHealthRecords(logInfo, "recovered")).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("stays silent while everything is clear", async () => {
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP });

    await tick(10);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets a failed reading break an over-threshold run", async () => {
    const { tick } = makeMonitor({
      swap: sequence([FULL_SWAP, FULL_SWAP, null, FULL_SWAP, FULL_SWAP], FULL_SWAP),
    });

    await tick(5);
    expect(publish).not.toHaveBeenCalled();
    await tick(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("lets a failed reading break a recovery run without closing the episode", async () => {
    const readings: Array<SwapUsage | null> = [
      ...Array<SwapUsage>(EPISODE_OPEN_SAMPLES).fill(FULL_SWAP),
      HEALTHY_SWAP,
      HEALTHY_SWAP,
      null,
      HEALTHY_SWAP,
      HEALTHY_SWAP,
    ];
    const { tick } = makeMonitor({ swap: sequence(readings, HEALTHY_SWAP) });

    await tick(EPISODE_OPEN_SAMPLES + 5);
    expect(publish).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "normal" }));
  });

  it("lets a new over-threshold sample restart a partial recovery", async () => {
    const readings: SwapUsage[] = [
      ...Array<SwapUsage>(EPISODE_OPEN_SAMPLES).fill(FULL_SWAP),
      HEALTHY_SWAP,
      HEALTHY_SWAP,
      FULL_SWAP,
      HEALTHY_SWAP,
      HEALTHY_SWAP,
    ];
    const { tick } = makeMonitor({ swap: sequence(readings, HEALTHY_SWAP) });

    await tick(EPISODE_OPEN_SAMPLES + 5);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(systemHealthRecords(logInfo, "recovered")).toHaveLength(0);
    await tick(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("trips on swap just over the threshold but not exactly at it", async () => {
    const atThreshold = makeMonitor({ swap: () => swapAt(SWAP_USED_PERCENT_THRESHOLD) });
    await atThreshold.tick(EPISODE_OPEN_SAMPLES);
    expect(publish).not.toHaveBeenCalled();

    const justOver = makeMonitor({ swap: () => swapAt(SWAP_USED_PERCENT_THRESHOLD + 1) });
    await justOver.tick(EPISODE_OPEN_SAMPLES);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("never proves recovery from samples with a failed reading", async () => {
    let fseventsd: number | null = 36 * 1024;
    const { tick } = makeMonitor({ swap: () => HEALTHY_SWAP, fseventsdRssMb: () => fseventsd });

    await tick(EPISODE_OPEN_SAMPLES);
    fseventsd = null;
    await tick(10);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(systemHealthRecords(logInfo, "recovered")).toHaveLength(0);
  });

  it("survives a reader that throws synchronously and samples again next time", async () => {
    const readSwap = vi
      .fn<() => Promise<SwapUsage | null>>()
      .mockImplementationOnce(() => {
        throw new Error("not a promise");
      })
      .mockResolvedValue(HEALTHY_SWAP);
    const monitor = createSystemMemoryPressureMonitor({
      isDarwin: false,
      swapKind: "swap",
      readSwap,
      readFseventsdRssMb: vi.fn(),
      readKernelPressureLevel: vi.fn(),
      publish,
      now: () => now,
    });

    await expect(monitor.sample()).resolves.toBeUndefined();
    now += SAMPLE_INTERVAL_MS;
    await monitor.sample();
    expect(readSwap).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected reader as a failed reading", async () => {
    const monitor = createSystemMemoryPressureMonitor({
      isDarwin: false,
      swapKind: "swap",
      readSwap: vi.fn().mockRejectedValue(new Error("sysctl timed out")),
      readFseventsdRssMb: vi.fn(),
      readKernelPressureLevel: vi.fn(),
      publish,
      now: () => now,
    });

    await expect(monitor.sample()).resolves.toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("never reads fseventsd off Darwin and treats swap alone as a full observation", async () => {
    let swap = FULL_SWAP;
    const { tick, readFseventsdRssMb, readKernelPressureLevel } = makeMonitor({
      isDarwin: false,
      swap: () => swap,
    });

    await tick(EPISODE_OPEN_SAMPLES);
    swap = HEALTHY_SWAP;
    await tick(EPISODE_CLEAR_SAMPLES);

    expect(readFseventsdRssMb).not.toHaveBeenCalled();
    expect(readKernelPressureLevel).not.toHaveBeenCalled();
    expect(publish.mock.calls.map(([p]) => p.status)).toEqual(["degraded", "normal"]);
  });

  it("reads a machine with no swap as clear rather than failed", async () => {
    let swap: SwapUsage = FULL_SWAP;
    const { tick } = makeMonitor({ isDarwin: false, swap: () => swap });

    await tick(EPISODE_OPEN_SAMPLES);
    swap = { usedMb: 0, totalMb: 0 };
    await tick(EPISODE_CLEAR_SAMPLES);

    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "normal" }));
  });
});

describe("createDefaultSystemMemoryPressureMonitor", () => {
  const originalPlatform = process.platform;
  let clock: number;

  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clock = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  it("probes Darwin with sysctl and an rss-first ucomm ps, and publishes what they show", async () => {
    setPlatform("darwin");
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void
    ) => {
      cb(
        null,
        file !== "/usr/sbin/sysctl"
          ? `  1024 launchd\n${36 * 1024 * 1024} fseventsd\n`
          : args.includes("vm.swapusage")
            ? "total = 2048.00M  used = 1966.08M  free = 81.92M  (encrypted)"
            : "4\n"
      );
    }) as unknown as typeof execFile);
    const publish = vi.fn();
    const monitor = createDefaultSystemMemoryPressureMonitor(publish);

    for (let i = 0; i < EPISODE_OPEN_SAMPLES; i++) {
      await monitor.sample();
      clock += SAMPLE_INTERVAL_MS;
    }

    const calls = vi.mocked(execFile).mock.calls.map(([file, args]) => [file, args]);
    expect(calls).toContainEqual(["/usr/sbin/sysctl", ["-n", "vm.swapusage"]]);
    expect(calls).toContainEqual(["/bin/ps", ["-axo", "rss=,ucomm="]]);
    expect(calls).toContainEqual([
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
    ]);
    expect(readElectronSwapUsage).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: 96,
      swapKind: "swap",
      fseventsdRssMb: 36 * 1024,
      kernelPressureLevel: "critical",
    });
  });

  it("opens on the kernel level alone when swap and fseventsd are healthy", async () => {
    setPlatform("darwin");
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void
    ) => {
      cb(
        null,
        file !== "/usr/sbin/sysctl"
          ? "  1024 launchd\n  2048 fseventsd\n"
          : args.includes("vm.swapusage")
            ? "total = 2048.00M  used = 204.80M  free = 1843.20M  (encrypted)"
            : "2\n"
      );
    }) as unknown as typeof execFile);
    const publish = vi.fn();
    const monitor = createDefaultSystemMemoryPressureMonitor(publish);

    for (let i = 0; i < EPISODE_OPEN_SAMPLES; i++) {
      await monitor.sample();
      clock += SAMPLE_INTERVAL_MS;
    }

    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: null,
      swapKind: "swap",
      fseventsdRssMb: null,
      kernelPressureLevel: "warn",
    });
  });

  it("runs the Darwin probes under the C locale and reads a failed spawn as missing", async () => {
    setPlatform("darwin");
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void
    ) => {
      cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "");
    }) as unknown as typeof execFile);
    const publish = vi.fn();
    const monitor = createDefaultSystemMemoryPressureMonitor(publish);

    await expect(monitor.sample()).resolves.toBeUndefined();

    const options = vi
      .mocked(execFile)
      .mock.calls.map((call) => (call as unknown[])[2] as { env?: NodeJS.ProcessEnv });
    expect(options).toHaveLength(3);
    for (const opts of options) expect(opts.env?.LC_ALL).toBe("C");
    expect(logWarn).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("spawns nothing on Windows and labels its swap figure as commit", async () => {
    setPlatform("win32");
    vi.mocked(readElectronSwapUsage).mockReturnValue({ usedMb: 950, totalMb: 1000 });
    const publish = vi.fn();
    const monitor = createDefaultSystemMemoryPressureMonitor(publish);

    for (let i = 0; i < EPISODE_OPEN_SAMPLES; i++) {
      await monitor.sample();
      clock += SAMPLE_INTERVAL_MS;
    }

    expect(execFile).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({
      status: "degraded",
      swapUsedPercent: 95,
      swapKind: "commit",
      fseventsdRssMb: null,
      kernelPressureLevel: null,
    });
  });
});
