// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPluginPanelAttentionStoreForTest,
  usePluginPanelAttentionStore,
} from "../pluginPanelAttentionStore";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

let onProvenance: (() => void) | null = null;
const offProvenance = vi.fn();
const listPanelAttention = vi.fn<() => Promise<string[]>>();

function installBridge(): void {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      plugin: {
        onProvenanceChanged: vi.fn((cb: () => void) => {
          onProvenance = cb;
          return offProvenance;
        }),
      },
      pluginCapability: { listPanelAttention },
    },
  });
}

const store = () => usePluginPanelAttentionStore.getState();

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  _resetPluginPanelAttentionStoreForTest();
  onProvenance = null;
  offProvenance.mockReset();
  listPanelAttention.mockReset();
  installBridge();
});

afterEach(() => {
  _resetPluginPanelAttentionStoreForTest();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("pluginPanelAttentionStore grants", () => {
  it("starts with nothing granted and pulls the switched-on plugins on init", async () => {
    listPanelAttention.mockResolvedValue(["acme"]);
    expect(store().grantedPluginIds.size).toBe(0);

    store().init();
    await flush();

    expect([...store().grantedPluginIds]).toEqual(["acme"]);
  });

  it("pulls again on every provenance change, which is how a flip anywhere arrives", async () => {
    listPanelAttention.mockResolvedValueOnce(["acme"]).mockResolvedValueOnce([]);
    store().init();
    await flush();

    onProvenance!();
    await flush();

    expect(store().grantedPluginIds.size).toBe(0);
  });

  it("fails closed: a failed pull shows no plugin rows", async () => {
    listPanelAttention.mockResolvedValueOnce(["acme"]).mockRejectedValueOnce(new Error("down"));
    store().init();
    await flush();
    onProvenance!();
    await flush();

    expect(store().grantedPluginIds.size).toBe(0);
  });

  it("lets only the newest pull land, so a slow one cannot bring a revoked grant back", async () => {
    let resolveSlow: (ids: string[]) => void = () => {};
    listPanelAttention
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce([]);
    store().init();
    onProvenance!();
    await flush();
    resolveSlow(["acme"]);
    await flush();

    expect(store().grantedPluginIds.size).toBe(0);
  });

  it("stays retryable until the bridge is there", async () => {
    Reflect.deleteProperty(window, "electron");
    store().init();
    installBridge();
    listPanelAttention.mockResolvedValue(["acme"]);

    store().init();
    await flush();

    expect(store().grantedPluginIds.has("acme")).toBe(true);
  });

  it("drops a revoked plugin's parks and snoozes with its grant", () => {
    store().setGranted("acme", true);
    store().setGranted("other", true);
    store().park("p1", "acme", 3);
    store().park("p2", "other", 4);

    store().setGranted("acme", false);

    expect(store().shelfByPanelId.p1).toBeUndefined();
    expect(store().shelfByPanelId.p2).toMatchObject({ kind: "parked", pluginId: "other" });
  });

  it("holds a switch saved here against an older pull still in flight", async () => {
    let resolveOld: (ids: string[]) => void = () => {};
    listPanelAttention.mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)));
    store().init();

    store().setGranted("acme", true);
    resolveOld([]);
    await flush();

    expect(store().grantedPluginIds.has("acme")).toBe(true);
  });
});

describe("pluginPanelAttentionStore shelves", () => {
  beforeEach(() => store().setGranted("acme", true));

  it("parks a report by revision and lifts it on release", () => {
    store().park("p1", "acme", 7);
    expect(store().shelfByPanelId.p1).toMatchObject({ kind: "parked", revision: 7 });

    store().release("p1");
    expect(store().shelfByPanelId.p1).toBeUndefined();
  });

  it("replaces a park with a snooze rather than holding both", () => {
    store().park("p1", "acme", 7);
    store().snooze("p1", "acme", "15m");
    expect(store().shelfByPanelId.p1?.kind).toBe("snoozed");
  });

  it("wakes a snooze when it runs out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    store().snooze("p1", "acme", "15m");
    store().snooze("p2", "acme", "30m");

    vi.advanceTimersByTime(15 * 60_000);

    expect(store().shelfByPanelId.p1).toBeUndefined();
    expect(store().shelfByPanelId.p2?.kind).toBe("snoozed");

    vi.advanceTimersByTime(15 * 60_000);
    expect(store().shelfByPanelId.p2).toBeUndefined();
  });

  it("drops a closed panel's shelf", () => {
    store().snooze("p1", "acme", "6h");
    store().removePanel("p1");
    expect(store().shelfByPanelId).toEqual({});
  });
});
