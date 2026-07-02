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
  waitForInit: vi.fn(async () => {}),
  listPlugins: vi.fn(() => [] as unknown[]),
  checkForUpdate: vi.fn(async (_id: string) => ({ status: "up-to-date" }) as unknown),
}));

vi.mock("electron", () => ({ powerMonitor: powerMonitorMock }));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../../ipc/channels.js", () => ({ CHANNELS: { EVENTS_PUSH: "events:push" } }));
vi.mock("../SystemSleepService.js", () => ({ getSystemSleepService: () => systemSleepMock }));
vi.mock("../PluginService.js", () => ({ pluginService: pluginServiceMock }));
vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { PluginUpdateCheckService } from "../PluginUpdateCheckService.js";

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
  };
}

describe("PluginUpdateCheckService", () => {
  beforeEach(() => {
    storeState.value = { enabled: false, lastCheckedAt: null };
    powerMonitorMock.getSystemIdleTime.mockReturnValue(120);
    pluginServiceMock.waitForInit.mockResolvedValue(undefined);
    pluginServiceMock.listPlugins.mockReturnValue([]);
    pluginServiceMock.checkForUpdate.mockResolvedValue({ status: "up-to-date" });
    broadcastMock.mockClear();
    storeMock.set.mockClear();
    pluginServiceMock.checkForUpdate.mockClear();
  });

  afterEach(() => {
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

  it("records lastCheckedAt even when every check fails (no retry storm)", async () => {
    storeState.value = { enabled: true, lastCheckedAt: null };
    pluginServiceMock.listPlugins.mockReturnValue([urlPlugin("pub.a")]);
    pluginServiceMock.checkForUpdate.mockRejectedValue(new Error("network"));

    const svc = new PluginUpdateCheckService();
    await svc._checkNowForTest();

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(storeState.value.lastCheckedAt).not.toBeNull();
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

    expect(pluginServiceMock.checkForUpdate).toHaveBeenCalledWith("pub.a");
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
});
