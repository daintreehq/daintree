import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import { waitFor } from "../../link/__tests__/linkTestUtils.js";
import type { ElapsedStamp } from "../../link/elapsed.js";
import { HostMetricsSampler, type HostSampleSources } from "../sampler.js";
import { SummaryLoop } from "../summaryLoop.js";
import { receiveSummary, sampleFreshness } from "../summaryReceipt.js";

describe("SummaryLoop sample age (#14462)", () => {
  it("dates a sample from when its read began, on this machine's clocks", async () => {
    let t = 1_000;
    let mono = 1_000;
    let finish: ((summary: HostMetricsSummary) => void) | null = null;
    const loop = new SummaryLoop(
      {
        sample: () =>
          new Promise<HostMetricsSummary>((resolve) => {
            finish = resolve;
          }),
      },
      60_000,
      () => ({ wall: t, mono })
    );
    const off = loop.subscribe(() => {});
    const sampled = { sampledAt: 5 } as HostMetricsSummary;
    // A slow read counts toward the age.
    t = mono = 3_000;
    finish!(sampled);
    await waitFor(() => loop.latest() === sampled);
    t = mono = 4_000;
    expect(loop.ageOf(sampled)).toBe(3_000);
    t = mono = 6_000;
    expect(loop.ageOf(sampled)).toBe(5_000);
    // Asleep a minute: only the wall clock moved.
    t = 66_000;
    expect(loop.ageOf(sampled)).toBe(65_000);
    // The wall clock stepped back: the monotonic clock still counts.
    t = 0;
    mono = 8_000;
    expect(loop.ageOf(sampled)).toBe(7_000);
    expect(loop.receiptOf(sampled)).toEqual({
      receivedAt: 1_000,
      at: { wall: 1_000, mono: 1_000 },
      hostAgeMs: 0,
      maxAgeMs: 0,
      timed: true,
    });
    // Only the summary it holds has an age here.
    expect(loop.ageOf({ ...sampled })).toBeNull();
    expect(loop.receiptOf({ ...sampled })).toBeNull();
    off();
    expect(loop.ageOf(sampled)).toBeNull();
  });
});

describe("SummaryLoop on a busy host (#15735)", () => {
  afterEach(() => vi.useRealTimers());

  it("streams a fresh frame on cadence while a forge read takes 5 s", async () => {
    vi.useFakeTimers({ now: 0 });
    const clock = (): ElapsedStamp => ({ wall: Date.now(), mono: Date.now() });
    let forgeReads = 0;
    let running = 0;
    let overlapped = false;
    const sources: HostSampleSources = {
      platform: "linux",
      cpus: () => [{ user: Date.now(), nice: 0, sys: 0, idle: Date.now(), irq: 0 }],
      totalmem: () => 8 * 1024 ** 3,
      systemMemorySnapshot: () => null,
      loadavg: () => [8, 8, 8],
      readText: async (path) =>
        path === "/proc/meminfo" ? "MemTotal: 1000 kB\nMemAvailable: 400 kB\n" : null,
      run: async () => null,
      listDir: async () => [],
      thermalState: () => null,
      agents: async () => ({ working: 8, waiting: 0, idle: 0 }),
      projects: async () => ({ projectCount: 2, worktreeCount: 8 }),
      driver: () => null,
      agentClis: async () => [],
      // The first account lookup takes its full 5 s; after that the account is cached.
      forges: async () => {
        forgeReads += 1;
        overlapped ||= running > 0;
        running += 1;
        try {
          if (forgeReads === 1) await new Promise((resolve) => setTimeout(resolve, 5_000));
          return [
            {
              providerId: "daintree.github.github",
              name: "GitHub",
              hasCredential: true,
              account: "greg",
            },
          ];
        } finally {
          running -= 1;
        }
      },
      now: () => Date.now(),
    };
    const loop = new SummaryLoop(new HostMetricsSampler(sources), 5_000, clock);
    const frames: Array<{ at: number; summary: HostMetricsSummary; sampleAgeMs: number | null }> =
      [];
    const off = loop.subscribe((summary) =>
      frames.push({ at: Date.now(), summary, sampleAgeMs: loop.ageOf(summary) })
    );

    await vi.advanceTimersByTimeAsync(10_000);
    off();

    expect(frames.map((frame) => frame.at)).toEqual([2_000, 5_000, 10_000]);
    expect(frames[0]!.summary).toMatchObject({
      memoryUsedBytes: 600 * 1024,
      agentsObserved: { working: 8, waiting: 0, idle: 0 },
      forges: null,
    });
    expect(frames[0]!.sampleAgeMs).toBe(2_000);
    expect(frames[2]!.summary.forges).toEqual([expect.objectContaining({ account: "greg" })]);
    expect(overlapped).toBe(false);

    // The Shell's view of the first frame in the worst ping phase: posted just
    // before the next ping reached the host, so it names the one sent 5 s
    // earlier, at -3 s. Each way takes 100 ms. It reads fresh until the next
    // frame lands, and still across one that is dropped.
    const stamp = (ms: number): ElapsedStamp => ({ wall: ms, mono: ms });
    const pingSentAt = (nonce: number) => (nonce === 0 ? stamp(-3_000) : null);
    const timing = { sampleAgeMs: frames[0]!.sampleAgeMs, afterPing: 0 };
    const receipt = receiveSummary(timing, pingSentAt, stamp(frames[0]!.at + 100));
    expect(receipt.maxAgeMs).toBe(7_100);
    const justBefore = (frame: (typeof frames)[number]) =>
      sampleFreshness(frames[0]!.summary, receipt, stamp(frame.at + 99));
    expect(justBefore(frames[1]!)).toMatchObject({ ageMs: 10_099, stale: false });
    expect(justBefore(frames[2]!)).toMatchObject({ ageMs: 15_099, stale: false });
  });
});
