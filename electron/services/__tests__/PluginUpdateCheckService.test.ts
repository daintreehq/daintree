import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const powerMonitorMock = vi.hoisted(() => ({
  getSystemIdleTime: vi.fn().mockReturnValue(120),
}));

const broadcastMock = vi.hoisted(() => vi.fn());

const storeState = vi.hoisted(() => ({
  value: { enabled: false, lastCheckedAt: null } as {
    enabled: boolean;
    lastCheckedAt: number | null;
  },
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string): unknown =>
    key === "pluginBackgroundUpdateCheck" ? storeState.value : undefined
  ),
  set: vi.fn((key: string, val: unknown) => {
    if (key === "pluginBackgroundUpdateCheck") {
      storeState.value = val as { enabled: boolean; lastCheckedAt: number | null };
    }
  }),
}));

const systemSleepMock = vi.hoisted(() => ({
  onSuspend: vi.fn(() => () => {}),
  onWake: vi.fn(() => () => {}),
}));

const pluginServiceMock = vi.hoisted(() => ({
  waitForCatalog: vi.fn(async () => {}),
  listPlugins: vi.fn(() => [] as unknown[]),
  checkForUpdate: vi.fn(
    async (_id: string, _options?: unknown) => ({ status: "up-to-date" }) as unknown
  ),
}));

// The catalog client is real, fed by a fake catalog fetch, so a pass reads the
// catalog the way it does in the app (#17805).
const catalogRef = vi.hoisted(() => ({ current: null as unknown, accessed: 0 }));

vi.mock("electron", () => ({ powerMonitor: powerMonitorMock }));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../../ipc/channels.js", () => ({ CHANNELS: { EVENTS_PUSH: "events:push" } }));
vi.mock("../SystemSleepService.js", () => ({ getSystemSleepService: () => systemSleepMock }));
vi.mock("../PluginService.js", () => ({ pluginService: pluginServiceMock }));
vi.mock("../plugin/PluginCatalogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin/PluginCatalogService.js")>();
  return {
    ...actual,
    getPluginCatalogService: () => {
      catalogRef.accessed += 1;
      return catalogRef.current;
    },
  };
});
vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PluginUpdateCheckService } from "../PluginUpdateCheckService.js";
import {
  PluginCatalogService,
  type PluginCatalogUpdateSource,
} from "../plugin/PluginCatalogService.js";

function urlPlugin(name: string, over: Record<string, unknown> = {}) {
  return {
    manifest: { name, version: "1.0.0", displayName: name },
    isBuiltin: false,
    originalUrl: `https://example.com/${name}.dntr`,
    archiveHash: "abc",
    ...over,
  };
}

function available(name: string, version: string) {
  return {
    status: "available",
    name,
    version,
    displayName: name,
    capabilities: ["commands"],
    archiveHash: "f".repeat(64),
  };
}

describe("PluginUpdateCheckService", () => {
  beforeEach(() => {
    storeState.value = { enabled: false, lastCheckedAt: null };
    powerMonitorMock.getSystemIdleTime.mockReturnValue(120);
    pluginServiceMock.waitForCatalog.mockResolvedValue(undefined);
    pluginServiceMock.listPlugins.mockReturnValue([]);
    pluginServiceMock.checkForUpdate.mockResolvedValue({ status: "up-to-date" });
    broadcastMock.mockClear();
    storeMock.set.mockClear();
    pluginServiceMock.checkForUpdate.mockClear();
    catalogRef.accessed = 0;
    catalogRef.current = new PluginCatalogService({
      cachePath: null,
      fetchImpl: async () => {
        throw new Error("unexpected catalog fetch");
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does nothing while disabled (the default)", async () => {
    const svc = new PluginUpdateCheckService();
    await svc.maybeRunDue("Periodic");
    expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("checks only URL-installed plugins and broadcasts available updates", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([
      urlPlugin("pub.a"),
      urlPlugin("pub.b"),
      // builtin — skipped
      {
        manifest: { name: "pub.builtin", version: "1.0.0" },
        isBuiltin: true,
        originalUrl: null,
        archiveHash: null,
      },
      // sideload (no url) — skipped
      {
        manifest: { name: "pub.side", version: "1.0.0" },
        isBuiltin: false,
        originalUrl: null,
        archiveHash: null,
      },
    ]);
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.a" ? available("pub.a", "2.0.0") : { status: "up-to-date" }
    );

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    const checkedIds = pluginServiceMock.checkForUpdate.mock.calls.map((c) => c[0]);
    expect(checkedIds.sort()).toEqual(["pub.a", "pub.b"]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [, payload] = broadcastMock.mock.calls[0];
    expect(payload.name).toBe("plugin:bg-update-available");
    expect(payload.payload.updates).toHaveLength(1);
    expect(payload.payload.updates[0].pluginId).toBe("pub.a");
    expect(payload.payload.signature).toBe("pub.a@2.0.0");
  });

  it("does not broadcast when nothing is available but still records lastCheckedAt", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
    pluginServiceMock.checkForUpdate.mockResolvedValue({ status: "up-to-date" });

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(storeState.value.lastCheckedAt).not.toBeNull();
  });

  it("records lastCheckedAt when only some checks fail (the pass still learned something)", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a"), urlPlugin("pub.b")]);
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.a" ? { status: "fetch-failed", message: "net" } : { status: "up-to-date" }
    );

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    expect(pluginServiceMock.checkForUpdate.mock.calls.map((c) => c[0]).sort()).toEqual([
      "pub.a",
      "pub.b",
    ]);
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(storeState.value.lastCheckedAt).not.toBeNull();
  });

  describe("offline passes", () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const STEP = 5 * 60 * 1000;
    const START = new Date("2026-01-10T12:00:00Z").getTime();

    // Only Date is faked: the passes are plain promise chains that need no timers.
    const freezeClock = () => vi.useFakeTimers({ toFake: ["Date"] });
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    // The installer reports an unreachable URL as a resolved result, not a throw.
    const goOffline = () =>
      pluginServiceMock.checkForUpdate.mockResolvedValue({
        status: "fetch-failed",
        message: "network down",
      });
    const goBroken = () =>
      pluginServiceMock.checkForUpdate.mockRejectedValue(new Error("network down"));
    const goOnline = () =>
      pluginServiceMock.checkForUpdate.mockResolvedValue({ status: "up-to-date" });
    const dueSetup = (lastCheckedAt: number | null = START - 2 * DAY) => {
      freezeClock();
      vi.setSystemTime(START);
      storeState.value = { enabled: true, lastCheckedAt };
      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a"), urlPlugin("pub.b")]);
      return new PluginUpdateCheckService();
    };
    // Steps the clock until an idle tick gets a pass through; returns the wait.
    const nextPassDelay = async (svc: PluginUpdateCheckService) => {
      let waited = 0;
      for (;;) {
        pluginServiceMock.checkForUpdate.mockClear();
        await svc.maybeRunDue("Periodic");
        if (pluginServiceMock.checkForUpdate.mock.calls.length > 0) return waited;
        advance(STEP);
        waited += STEP;
        expect(waited).toBeLessThan(DAY);
      }
    };
    // One plugin whose check stays pending until the test rejects it.
    const holdOneCheck = () => {
      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
      let rejectCheck: ((e: Error) => void) | undefined;
      pluginServiceMock.checkForUpdate.mockImplementation(
        () =>
          new Promise((_res, rej) => {
            rejectCheck = rej;
          })
      );
      return {
        started: async () => {
          await vi.waitFor(() => expect(rejectCheck).toBeDefined());
          return (e: Error) => rejectCheck?.(e);
        },
      };
    };

    it.each([
      ["resolved fetch-failed results", goOffline],
      ["rejected checks", goBroken],
    ] as const)("leaves lastCheckedAt alone when every check fails (%s)", async (_name, fail) => {
      const staleAt = START - 2 * DAY;
      const svc = dueSetup(staleAt);
      fail();

      await svc.maybeRunDue("Periodic");

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(2);
      expect(storeState.value.lastCheckedAt).toBe(staleAt);
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("recovers on a later idle tick once connectivity returns, without waiting a day", async () => {
      const svc = dueSetup();
      goOffline();
      await svc.maybeRunDue("Initial");
      pluginServiceMock.checkForUpdate.mockClear();

      // The hourly tick after reconnecting finds the update.
      pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
        id === "pub.a" ? available("pub.a", "2.0.0") : { status: "up-to-date" }
      );
      advance(HOUR);
      await svc.maybeRunDue("Periodic");

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(2);
      expect(svc.getLatest()?.signature).toBe("pub.a@2.0.0");
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(storeState.value.lastCheckedAt).toBe(Date.now());

      // The recovered pass is the day's check, so the daily gate applies again.
      pluginServiceMock.checkForUpdate.mockClear();
      advance(HOUR);
      await svc.maybeRunDue("Periodic");
      expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();
    });

    it("holds off retrying until the backoff window has passed", async () => {
      const svc = dueSetup();
      goOffline();
      await svc.maybeRunDue("Initial");
      pluginServiceMock.checkForUpdate.mockClear();

      // A tick (or a wake) right after the failure must not hit the network again.
      await svc.maybeRunDue("Resume");
      advance(10 * 60 * 1000);
      await svc.maybeRunDue("Periodic");
      expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();

      advance(HOUR);
      await svc.maybeRunDue("Resume");
      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalled();
    });

    it("keeps repeated failures rate-limited: the wait doubles, then holds at a ceiling under a day", async () => {
      const svc = dueSetup();
      goOffline();
      await svc.maybeRunDue("Periodic");

      const waits: number[] = [];
      for (let pass = 0; pass < 8; pass++) waits.push(await nextPassDelay(svc));

      expect(waits[0]).toBeGreaterThan(0);
      for (let i = 1; i < 4; i++) expect(waits[i]).toBe(waits[i - 1] * 2);
      const ceiling = waits[waits.length - 1];
      expect(ceiling).toBeGreaterThanOrEqual(waits[3]);
      expect(waits[waits.length - 2]).toBe(ceiling);
      expect(ceiling).toBeLessThan(DAY);
      expect(storeState.value.lastCheckedAt).toBe(START - 2 * DAY);
    });

    it("measures the wait from when the failed pass finished, not when it started", async () => {
      const svc = dueSetup();
      const hold = holdOneCheck();
      const pass = svc.maybeRunDue("Initial");
      const reject = await hold.started();
      advance(HOUR);
      reject(new Error("network down"));
      await pass;

      goOffline();
      expect(await nextPassDelay(svc)).toBeGreaterThan(0);
    });

    it("starts the backoff over once a pass gets an answer", async () => {
      const svc = dueSetup();
      goOffline();
      await svc.maybeRunDue("Periodic");
      const first = await nextPassDelay(svc);
      expect(await nextPassDelay(svc)).toBe(first * 2);

      goOnline();
      await nextPassDelay(svc);
      expect(storeState.value.lastCheckedAt).toBe(Date.now());

      // A new outage on a later day begins at the shortest wait again.
      advance(DAY);
      goOffline();
      await svc.maybeRunDue("Periodic");
      expect(await nextPassDelay(svc)).toBe(first);
    });

    it("lets a pass that throws before checking anything retry later, not never", async () => {
      const svc = dueSetup();
      pluginServiceMock.listPlugins.mockImplementation(() => {
        throw new Error("plugin service not ready");
      });

      await svc.maybeRunDue("Initial");
      expect(storeState.value.lastCheckedAt).toBe(START - 2 * DAY);

      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
      expect(await nextPassDelay(svc)).toBeGreaterThan(0);
    });

    it("treats an unavailable catalog on every install as an offline pass", async () => {
      const svc = dueSetup();
      pluginServiceMock.listPlugins.mockReturnValue([
        urlPlugin("pub.a", { source: "catalog", originalUrl: null, archiveHash: null }),
      ]);
      pluginServiceMock.checkForUpdate.mockResolvedValue({
        status: "catalog-unavailable",
        catalog: "unavailable",
        failure: "unreachable",
      });

      await svc.maybeRunDue("Periodic");
      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledWith("pub.a", {
        catalog: expect.anything(),
      });
      expect(storeState.value.lastCheckedAt).toBe(START - 2 * DAY);

      expect(await nextPassDelay(svc)).toBeGreaterThan(0);
    });

    it("counts a pass with nothing to check as conclusive", async () => {
      const svc = dueSetup();
      pluginServiceMock.listPlugins.mockReturnValue([]);

      await svc.maybeRunDue("Periodic");

      expect(storeState.value.lastCheckedAt).toBe(Date.now());
    });

    it("keeps the cached offer through an offline pass", async () => {
      const svc = dueSetup();
      pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
        id === "pub.a" ? available("pub.a", "2.0.0") : { status: "up-to-date" }
      );
      await svc._checkNowForTest();
      const cached = svc.getLatest();
      expect(cached).not.toBeNull();

      goOffline();
      await svc._checkNowForTest();

      expect(svc.getLatest()).toBe(cached);
    });

    it("does not stay locked out when the wall clock moves backwards", async () => {
      const svc = dueSetup(null);
      goOffline();
      await svc.maybeRunDue("Periodic");

      vi.setSystemTime(START - 3 * DAY);
      pluginServiceMock.checkForUpdate.mockClear();
      await svc.maybeRunDue("Periodic");

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalled();
    });

    it("starts over after the user turns the check off and on", async () => {
      const svc = dueSetup();
      goOffline();
      await svc.maybeRunDue("Initial");
      const first = await nextPassDelay(svc);
      await nextPassDelay(svc);

      try {
        svc.updateSettings({ enabled: false });
        svc.updateSettings({ enabled: true });
        pluginServiceMock.checkForUpdate.mockClear();
        await svc.maybeRunDue("Initial");
        expect(pluginServiceMock.checkForUpdate).toHaveBeenCalled();

        expect(await nextPassDelay(svc)).toBe(first);
      } finally {
        await svc.dispose();
      }
    });

    it("does not arm a backoff when the check was turned off during the failing pass", async () => {
      const svc = dueSetup();
      const hold = holdOneCheck();
      const pass = svc.maybeRunDue("Initial");
      const reject = await hold.started();
      storeState.value = { enabled: false, lastCheckedAt: storeState.value.lastCheckedAt };
      reject(new Error("network down"));
      await pass;

      storeState.value = { enabled: true, lastCheckedAt: storeState.value.lastCheckedAt };
      goOffline();
      pluginServiceMock.checkForUpdate.mockClear();
      await svc.maybeRunDue("Periodic");

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalled();
    });

    it("does not arm a backoff on the re-enabled check for a pass begun before the toggle", async () => {
      const svc = dueSetup();
      const hold = holdOneCheck();
      const pass = svc.maybeRunDue("Initial");
      const reject = await hold.started();

      try {
        svc.updateSettings({ enabled: false });
        svc.updateSettings({ enabled: true });
        reject(new Error("network down"));
        await pass;

        goOffline();
        pluginServiceMock.checkForUpdate.mockClear();
        await svc.maybeRunDue("Periodic");
        expect(pluginServiceMock.checkForUpdate).toHaveBeenCalled();
      } finally {
        await svc.dispose();
      }
    });
  });

  it("skips a due pass while the user is active (below the idle threshold)", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    powerMonitorMock.getSystemIdleTime.mockReturnValue(5);
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);

    const svc = new PluginUpdateCheckService();
    await svc.maybeRunDue("Periodic");

    expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();
    // Not run → timestamp untouched so it retries on the next idle tick.
    expect(storeState.value.lastCheckedAt).toBeNull();
  });

  it("skips when the last check was under a day ago", async () => {
    storeState.value = { enabled: true, lastCheckedAt: Date.now() - 60 * 60 * 1000 };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);

    const svc = new PluginUpdateCheckService();
    await svc.maybeRunDue("Periodic");

    expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();
  });

  it("runs a due pass when more than a day has elapsed", async () => {
    storeState.value = { enabled: true, lastCheckedAt: Date.now() - 25 * 60 * 60 * 1000 };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);

    const svc = new PluginUpdateCheckService();
    await svc.maybeRunDue("Periodic");

    expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledWith("pub.a", {
      catalog: expect.anything(),
    });
  });

  it("caps concurrency at 2", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue(
      Array.from({ length: 6 }, (_, i) => urlPlugin(`pub.${i}`))
    );
    let active = 0;
    let peak = 0;
    pluginServiceMock.checkForUpdate.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: "up-to-date" };
    });

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    expect(peak).toBeLessThanOrEqual(2);
    expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(6);
  });

  it("updateSettings persists enabled and starts/stops the wake listener", () => {
    const svc = new PluginUpdateCheckService();
    const on = svc.updateSettings({ enabled: true });
    expect(on.enabled).toBe(true);
    expect(storeState.value.enabled).toBe(true);
    expect(systemSleepMock.onWake).toHaveBeenCalled();

    const off = svc.updateSettings({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(storeState.value.enabled).toBe(false);
    expect(svc.getLatest()).toBeNull();
  });

  it("dispose stops the service and prevents further passes", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
    const svc = new PluginUpdateCheckService();
    await svc.dispose();
    await svc._checkNowForTest();
    expect(pluginServiceMock.checkForUpdate).not.toHaveBeenCalled();
  });

  it("clears a stale cache on a clean no-update pass", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
    pluginServiceMock.checkForUpdate.mockResolvedValue(available("pub.a", "2.0.0"));
    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();
    expect(svc.getLatest()).not.toBeNull();

    // A later pass finds nothing available (e.g. the user updated manually) —
    // the obsolete cache must not hydrate a fresh renderer.
    pluginServiceMock.checkForUpdate.mockResolvedValue({ status: "up-to-date" });
    await svc._checkNowForTest();
    expect(svc.getLatest()).toBeNull();
  });

  it("keeps the cache when a no-update pass is inconclusive (fetch failure)", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a"), urlPlugin("pub.b")]);
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.a" ? available("pub.a", "2.0.0") : { status: "up-to-date" }
    );
    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();
    expect(svc.getLatest()).not.toBeNull();

    // Now 0 available but one plugin couldn't be checked → don't clear the cache.
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.a" ? { status: "fetch-failed", message: "net" } : { status: "up-to-date" }
    );
    await svc._checkNowForTest();
    expect(svc.getLatest()).not.toBeNull();
  });

  // A catalog install is checked against the catalog, so it needs neither a
  // URL nor a baseline hash to be a target (#16781).
  const catalogPlugin = (name: string) =>
    urlPlugin(name, { source: "catalog", originalUrl: null, archiveHash: null });

  it("checks catalog installs and never offers a delisted one (#16781)", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([
      catalogPlugin("pub.listed"),
      catalogPlugin("pub.gone"),
    ]);
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.listed"
        ? available("pub.listed", "1.0.1")
        : { status: "delisted", scope: "plugin", version: "1.0.0" }
    );

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    const checkedIds = pluginServiceMock.checkForUpdate.mock.calls.map((c) => c[0]);
    expect(checkedIds.sort()).toEqual(["pub.gone", "pub.listed"]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(
      broadcastMock.mock.calls[0][1].payload.updates.map((u: { pluginId: string }) => u.pluginId)
    ).toEqual(["pub.listed"]);
  });

  it("reads a delisted result as a conclusive answer, clearing an obsolete cache", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([catalogPlugin("pub.a")]);
    pluginServiceMock.checkForUpdate.mockResolvedValue(available("pub.a", "2.0.0"));
    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();
    expect(svc.getLatest()).not.toBeNull();

    pluginServiceMock.checkForUpdate.mockResolvedValue({
      status: "delisted",
      scope: "release",
      version: "1.0.0",
    });
    await svc._checkNowForTest();
    expect(svc.getLatest()).toBeNull();
  });

  it.each(["stale", "unavailable"] as const)(
    "keeps the cache untouched when the catalog is %s",
    async (catalog) => {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue([catalogPlugin("pub.a")]);
      pluginServiceMock.checkForUpdate.mockResolvedValue(available("pub.a", "2.0.0"));
      const svc = new PluginUpdateCheckService();
      await svc._checkNowForTest();
      const cached = svc.getLatest();
      expect(cached).not.toBeNull();

      pluginServiceMock.checkForUpdate.mockResolvedValue({
        status: "catalog-unavailable",
        catalog,
        failure: "unreachable",
      });
      await svc._checkNowForTest();
      expect(svc.getLatest()).toBe(cached);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
    }
  );

  it("drops a cached offer the next pass found delisted, even when another check failed", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([catalogPlugin("pub.a"), urlPlugin("pub.b")]);
    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      available(id, "2.0.0")
    );
    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();
    expect(
      svc
        .getLatest()
        ?.updates.map((u) => u.pluginId)
        .sort()
    ).toEqual(["pub.a", "pub.b"]);

    pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
      id === "pub.a"
        ? { status: "delisted", scope: "plugin", version: "1.0.0" }
        : { status: "fetch-failed", message: "net" }
    );
    await svc._checkNowForTest();

    // pub.b couldn't be checked, so its offer stands; pub.a was checked and
    // has none.
    expect(svc.getLatest()).toMatchObject({
      updates: [{ pluginId: "pub.b" }],
      signature: "pub.b@2.0.0",
    });
  });

  describe("one catalog per pass (#17805)", () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `pub.p${i}`);

    function release(id: string, version: string) {
      const [owner, name] = id.split(".");
      const repo = `https://github.com/${owner}/${name}`;
      return {
        id,
        repo,
        version,
        url: `${repo}/releases/download/v${version}/${id}-${version}.dntr`,
        sha256: "a".repeat(64),
        capabilities: [],
      };
    }

    /** The catalog answers each fetch with the next document, or is offline. */
    function catalogServes(...documents: Array<{ entries: unknown[] } | "offline">) {
      const queue = [...documents];
      const fetchImpl = vi.fn(async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected catalog fetch");
        if (next === "offline") throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
        return new Response(JSON.stringify(next), {
          headers: { "content-type": "application/json" },
        });
      });
      catalogRef.current = new PluginCatalogService({ cachePath: null, fetchImpl });
      return fetchImpl;
    }

    /**
     * The catalog half of the installer's check: it reads the catalog the pass
     * hands it, or the shared one when it is handed none. Returns what each
     * install's last check answered.
     */
    function checksAgainstCatalog(installedVersionOf: (id: string) => string = () => "1.0.0") {
      const answers = new Map<string, unknown>();
      pluginServiceMock.checkForUpdate.mockImplementation(async (id: string, options?: unknown) => {
        const handed = (options as { catalog?: PluginCatalogUpdateSource } | undefined)?.catalog;
        const source = handed ?? (catalogRef.current as PluginCatalogService);
        const installedVersion = installedVersionOf(id);
        const lookup = await source.lookupUpdate(id, installedVersion);
        let answer: Record<string, unknown>;
        switch (lookup.status) {
          case "stale":
          case "unavailable":
            answer = {
              status: "catalog-unavailable",
              catalog: lookup.status,
              failure: lookup.failure,
            };
            break;
          case "current":
            answer = { status: "up-to-date" };
            break;
          case "delisted":
            answer = { status: "delisted", scope: lookup.scope, version: installedVersion };
            break;
          case "update":
            answer = available(id, lookup.entry.version);
            break;
        }
        answers.set(id, answer);
        return answer;
      });
      return answers;
    }

    it("fetches the catalog once for ten up-to-date catalog installs", async () => {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue(TEN.map(catalogPlugin));
      const fetchImpl = catalogServes({ entries: TEN.map((id) => release(id, "1.0.0")) });
      const answers = checksAgainstCatalog();

      const svc = new PluginUpdateCheckService();
      await svc._checkNowForTest();

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(10);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(catalogRef.accessed).toBe(1);
      expect([...answers.keys()].sort()).toEqual(TEN);
      expect([...answers.values()]).toEqual(TEN.map(() => ({ status: "up-to-date" })));
      expect(storeState.value.lastCheckedAt).not.toBeNull();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("answers each install from the one catalog by its own id and version", async () => {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue(TEN.map(catalogPlugin));
      // pub.pN is installed at 1.N.0 and listed at it, except: pub.p3 also has
      // 1.4.0, pub.p5 is listed only at an older 1.4.0, and pub.p7 is gone.
      const installedVersionOf = (id: string) => `1.${id.slice("pub.p".length)}.0`;
      const entries = TEN.filter((id) => id !== "pub.p5" && id !== "pub.p7").map((id) =>
        release(id, installedVersionOf(id))
      );
      entries.push(release("pub.p3", "1.4.0"), release("pub.p5", "1.4.0"));
      const fetchImpl = catalogServes({ entries });
      const answers = checksAgainstCatalog(installedVersionOf);

      const svc = new PluginUpdateCheckService();
      await svc._checkNowForTest();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(Object.fromEntries(answers)).toEqual(
        Object.fromEntries(
          TEN.map((id) => [
            id,
            id === "pub.p3"
              ? available("pub.p3", "1.4.0")
              : id === "pub.p5"
                ? { status: "delisted", scope: "release", version: "1.5.0" }
                : id === "pub.p7"
                  ? { status: "delisted", scope: "plugin", version: "1.7.0" }
                  : { status: "up-to-date" },
          ])
        )
      );
      expect(svc.getLatest()).toMatchObject({ signature: "pub.p3@1.4.0" });
    });

    it("fetches afresh on every pass, so a release listed since the last one is offered", async () => {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue(TEN.map(catalogPlugin));
      const current = TEN.map((id) => release(id, "1.0.0"));
      const fetchImpl = catalogServes(
        { entries: current },
        { entries: [...current, release("pub.p2", "1.1.0")] }
      );
      checksAgainstCatalog();
      const svc = new PluginUpdateCheckService();

      await svc._checkNowForTest();
      expect(svc.getLatest()).toBeNull();

      await svc._checkNowForTest();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(catalogRef.accessed).toBe(2);
      expect(svc.getLatest()).toMatchObject({ signature: "pub.p2@1.1.0" });
    });

    it("fetches afresh on the next due pass after a failed one, and that pass counts", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue(TEN.map(catalogPlugin));
      const fetchImpl = catalogServes("offline", {
        entries: TEN.map((id) => release(id, "1.0.0")),
      });
      checksAgainstCatalog();
      const svc = new PluginUpdateCheckService();

      await svc.maybeRunDue("Periodic");
      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(10);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Nothing was learned, so the day's check is still owed.
      expect(storeState.value.lastCheckedAt).toBeNull();

      // Inside the backoff window nothing runs; past it the next pass fetches
      // its own catalog rather than reusing the failed one.
      await svc.maybeRunDue("Periodic");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      await svc.maybeRunDue("Periodic");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(20);
      expect(storeState.value.lastCheckedAt).toBe(Date.now());
      expect(svc.getLatest()).toBeNull();
    });

    it("never fetches the catalog for a pass with only URL installs", async () => {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a"), urlPlugin("pub.b")]);
      const fetchImpl = catalogServes();

      const svc = new PluginUpdateCheckService();
      await svc._checkNowForTest();

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(2);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(catalogRef.accessed).toBe(0);
    });
  });

  describe("a fresh update from another plugin (#17444)", () => {
    type Install = typeof urlPlugin;
    const netFailed = async () => ({ status: "fetch-failed", message: "net" });
    const catalogDown = async () => ({
      status: "catalog-unavailable",
      catalog: "unavailable",
      failure: "unreachable",
    });
    const threw = async (): Promise<never> => {
      throw new Error("boom");
    };

    // Caches a 2.0.0 offer for each id, as the first pass of a day.
    async function cacheOffers(installs: Record<string, Install>) {
      storeState.value = { enabled: true, lastCheckedAt: null };
      pluginServiceMock.listPlugins.mockReturnValue(
        Object.entries(installs).map(([id, install]) => install(id))
      );
      pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) =>
        available(id, "2.0.0")
      );
      const svc = new PluginUpdateCheckService();
      await svc._checkNowForTest();
      expect(svc.getLatest()?.updates).toHaveLength(Object.keys(installs).length);
      return svc;
    }

    function answerPass(answers: Record<string, () => Promise<unknown>>) {
      pluginServiceMock.checkForUpdate.mockImplementation(async (id: string) => answers[id]());
    }

    it.each([
      ["fetch-failed", urlPlugin, netFailed],
      ["catalog-unavailable", catalogPlugin, catalogDown],
      ["a thrown check", urlPlugin, threw],
    ])(
      "keeps the offer for a plugin whose check failed (%s) beside the new one",
      async (_label, install, failure) => {
        const svc = await cacheOffers({ "pub.a": install, "pub.c": urlPlugin });
        pluginServiceMock.listPlugins.mockReturnValue([
          install("pub.a"),
          urlPlugin("pub.b"),
          urlPlugin("pub.c"),
        ]);
        answerPass({
          "pub.a": failure,
          "pub.b": async () => available("pub.b", "3.0.0"),
          // checked and current: its old offer must not ride along
          "pub.c": async () => ({ status: "up-to-date" }),
        });
        await svc._checkNowForTest();

        const latest = svc.getLatest();
        expect(latest?.updates.map((u) => u.pluginId).sort()).toEqual(["pub.a", "pub.b"]);
        expect(latest?.updates.find((u) => u.pluginId === "pub.a")?.version).toBe("2.0.0");
        expect(latest?.signature).toBe("pub.a@2.0.0,pub.b@3.0.0");
        // A renderer already open gets the same set a newly mounted one hydrates.
        expect(broadcastMock).toHaveBeenCalledTimes(2);
        expect(broadcastMock.mock.calls[1][1].payload).toEqual(latest);
      }
    );

    it.each([
      ["current", { status: "up-to-date" }],
      ["delisted", { status: "delisted", scope: "plugin", version: "1.0.0" }],
    ])("drops the old offer once the plugin is checked and is %s", async (_label, answer) => {
      const svc = await cacheOffers({ "pub.a": catalogPlugin, "pub.c": catalogPlugin });
      pluginServiceMock.listPlugins.mockReturnValue([
        catalogPlugin("pub.a"),
        urlPlugin("pub.b"),
        catalogPlugin("pub.c"),
      ]);
      answerPass({
        "pub.a": catalogDown,
        "pub.b": async () => available("pub.b", "3.0.0"),
        "pub.c": catalogDown,
      });
      await svc._checkNowForTest();
      expect(svc.getLatest()?.signature).toBe("pub.a@2.0.0,pub.b@3.0.0,pub.c@2.0.0");

      // pub.c is still unreachable, so its offer stands while pub.a's goes.
      answerPass({
        "pub.a": async () => answer,
        "pub.b": async () => available("pub.b", "3.0.0"),
        "pub.c": catalogDown,
      });
      await svc._checkNowForTest();

      const latest = svc.getLatest();
      expect(latest?.signature).toBe("pub.b@3.0.0,pub.c@2.0.0");
      expect(broadcastMock.mock.calls[2][1].payload).toEqual(latest);
    });

    it("replaces a cached offer with the fresh version while another plugin stays unchecked", async () => {
      const svc = await cacheOffers({ "pub.a": urlPlugin, "pub.b": urlPlugin });
      answerPass({
        "pub.a": async () => available("pub.a", "2.1.0"),
        "pub.b": netFailed,
      });
      await svc._checkNowForTest();

      expect(svc.getLatest()?.signature).toBe("pub.a@2.1.0,pub.b@2.0.0");
      expect(svc.getLatest()?.updates).toHaveLength(2);
    });

    it("checks a plugin once when the registry lists it twice", async () => {
      const svc = await cacheOffers({ "pub.a": urlPlugin });
      pluginServiceMock.checkForUpdate.mockClear();
      // A re-enable in flight holds the plugin in both the running and disabled rows.
      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a"), urlPlugin("pub.a")]);
      const answers = [async () => available("pub.a", "3.0.0"), netFailed];
      pluginServiceMock.checkForUpdate.mockImplementation(async () => answers.shift()!());
      await svc._checkNowForTest();

      expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledTimes(1);
      expect(svc.getLatest()?.signature).toBe("pub.a@3.0.0");
    });

    it("does not resurrect an offer for a plugin that is no longer installed", async () => {
      const svc = await cacheOffers({ "pub.a": urlPlugin, "pub.c": urlPlugin });
      // pub.a is gone, so it is no longer a target and is never reported as
      // unchecked; pub.c stays unreachable and keeps its offer.
      pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.b"), urlPlugin("pub.c")]);
      answerPass({
        "pub.b": async () => available("pub.b", "3.0.0"),
        "pub.c": netFailed,
      });
      await svc._checkNowForTest();

      expect(svc.getLatest()?.signature).toBe("pub.b@3.0.0,pub.c@2.0.0");
    });
  });

  it("does not broadcast or cache when disabled mid-pass", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
    let resolveCheck: ((v: unknown) => void) | undefined;
    pluginServiceMock.checkForUpdate.mockImplementation(
      () =>
        new Promise((res) => {
          resolveCheck = res;
        })
    );
    const svc = new PluginUpdateCheckService();
    const pass = svc._checkNowForTest();
    await Promise.resolve();
    // User flips the toggle off while the network check is in flight.
    storeState.value = { enabled: false, lastCheckedAt: storeState.value.lastCheckedAt };
    resolveCheck?.(available("pub.a", "2.0.0"));
    await pass;

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(svc.getLatest()).toBeNull();
  });

  it("start() is idempotent and registers the wake listener only once", () => {
    storeState.value = { enabled: true, lastCheckedAt: Date.now() };
    const svc = new PluginUpdateCheckService();
    svc.start();
    svc.start();
    expect(systemSleepMock.onWake).toHaveBeenCalledTimes(1);
  });
});
