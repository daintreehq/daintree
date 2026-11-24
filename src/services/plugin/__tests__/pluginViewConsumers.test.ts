import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replayPluginViewConsumers,
  resetPluginViewConsumersForTests,
  retainPluginViewConsumer,
} from "@/services/plugin/pluginViewConsumers";

let report: ReturnType<typeof vi.fn<(viewIds: string[]) => Promise<void>>>;

/** Drain the microtask-coalesced flush and return every snapshot sent so far. */
async function drainReports(): Promise<string[][]> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return report.mock.calls.map(([viewIds]) => viewIds);
}

beforeEach(() => {
  resetPluginViewConsumersForTests();
  report = vi.fn<(viewIds: string[]) => Promise<void>>(() => Promise.resolve());
  vi.stubGlobal("window", { electron: { plugin: { reportViewConsumers: report } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPluginViewConsumersForTests();
});

describe("pluginViewConsumers (#17068)", () => {
  it("sends one full snapshot per tick, once per mount", async () => {
    retainPluginViewConsumer("plugin-view:acme/side");
    retainPluginViewConsumer("acme.dash");
    retainPluginViewConsumer("acme.dash");

    expect(await drainReports()).toEqual([["acme.dash", "acme.dash", "plugin-view:acme/side"]]);
  });

  it("sends the empty snapshot when the last mount goes, and nothing before any mount", async () => {
    expect(await drainReports()).toEqual([]);

    const release = retainPluginViewConsumer("plugin-view:acme/side");
    await drainReports();
    release();

    expect(await drainReports()).toEqual([["plugin-view:acme/side"], []]);
  });

  it("releases only its own mount, so a stale cleanup can't drop a live one", async () => {
    const first = retainPluginViewConsumer("acme.dash");
    const second = retainPluginViewConsumer("acme.dash");
    await drainReports();

    first();
    first();
    expect((await drainReports()).at(-1)).toEqual(["acme.dash"]);
    second();
    expect((await drainReports()).at(-1)).toEqual([]);
  });

  it("stays silent when a tick ends where it started, as a StrictMode replay does", async () => {
    const live = retainPluginViewConsumer("acme.dash");
    await drainReports();
    report.mockClear();

    live();
    retainPluginViewConsumer("acme.dash");
    expect(await drainReports()).toEqual([]);
  });

  it("retries a failed report while the view sits open, backing off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    report
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockRejectedValueOnce(new Error("ipc down"));
    retainPluginViewConsumer("acme.dash");
    await drainReports();

    vi.advanceTimersByTime(1_000);
    expect(await drainReports()).toEqual([["acme.dash"], ["acme.dash"]]);
    // Doubled after the second failure: nothing at the first interval again.
    vi.advanceTimersByTime(1_000);
    expect(await drainReports()).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(await drainReports()).toEqual([["acme.dash"], ["acme.dash"], ["acme.dash"]]);

    vi.advanceTimersByTime(60_000);
    expect(await drainReports()).toHaveLength(3);
  });

  it("backs off to a minute at most, and starts over after a report lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    report.mockRejectedValue(new Error("ipc down"));
    retainPluginViewConsumer("acme.dash");
    await drainReports();

    // 1, 2, 4, 8, 16, 32 seconds, then a minute each time.
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const before = report.mock.calls.length;
      vi.advanceTimersByTime(delay - 1);
      await drainReports();
      expect(report.mock.calls.length, `before ${delay}`).toBe(before);
      vi.advanceTimersByTime(1);
      await drainReports();
      expect(report.mock.calls.length, `at ${delay}`).toBe(before + 1);
    }

    report.mockResolvedValue(undefined);
    vi.advanceTimersByTime(60_000);
    await drainReports();
    const landed = report.mock.calls.length;

    report.mockRejectedValueOnce(new Error("ipc down"));
    retainPluginViewConsumer("plugin-view:acme/side");
    await drainReports();
    vi.advanceTimersByTime(1_000);
    await drainReports();
    expect(report.mock.calls.length).toBe(landed + 2);
  });

  it("retries a failed empty report, so main doesn't hold a closed view open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const release = retainPluginViewConsumer("acme.dash");
    await drainReports();
    report.mockRejectedValueOnce(new Error("ipc down"));
    release();
    await drainReports();

    vi.advanceTimersByTime(1_000);
    expect(await drainReports()).toEqual([["acme.dash"], [], []]);
  });

  it("replays its mounts for a host that lost them, and nothing when it never had one", async () => {
    replayPluginViewConsumers();
    expect(await drainReports()).toEqual([]);

    retainPluginViewConsumer("acme.dash");
    await drainReports();
    replayPluginViewConsumers();
    expect(await drainReports()).toEqual([["acme.dash"], ["acme.dash"]]);
  });
});
