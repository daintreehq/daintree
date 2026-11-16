import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginViewConsumersForTests,
  retainPluginViewConsumer,
} from "@/services/plugin/pluginViewConsumers";

let report: ReturnType<typeof vi.fn<(viewIds: string[]) => Promise<void>>>;

/** Drain the microtask-coalesced flush and return every snapshot sent so far. */
async function drainReports(): Promise<string[][]> {
  await Promise.resolve();
  await Promise.resolve();
  return report.mock.calls.map(([viewIds]) => viewIds);
}

beforeEach(() => {
  resetPluginViewConsumersForTests();
  report = vi.fn<(viewIds: string[]) => Promise<void>>(() => Promise.resolve());
  vi.stubGlobal("window", { electron: { plugin: { reportViewConsumers: report } } });
});

afterEach(() => {
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

  it("resends after a failed report, so main isn't left with a stale snapshot", async () => {
    report.mockRejectedValueOnce(new Error("ipc down"));
    retainPluginViewConsumer("acme.dash");
    await drainReports();
    await drainReports();

    // A tick that nets out to the same mounts sends again, since main never got it.
    retainPluginViewConsumer("plugin-view:acme/side")();
    expect(await drainReports()).toEqual([["acme.dash"], ["acme.dash"]]);
  });
});
