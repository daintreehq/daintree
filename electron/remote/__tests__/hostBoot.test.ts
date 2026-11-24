import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const service = {
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    refreshStartAtLogin: vi.fn(async () => {}),
    getAttachedClients: vi.fn(() => []),
    getStatus: vi.fn(async () => ({ listening: true })),
    setEnabled: vi.fn(async () => ({})),
    enableFromSetup: vi.fn(async () => ({})),
    runKeychainPreflight: vi.fn(async () => ({})),
    dispose: vi.fn(async () => {}),
  };
  return {
    service,
    /** Set when the Host mode module (and the Host server under it) is evaluated. */
    defaultsLoaded: false,
    createHostModeService: vi.fn((_options: unknown) => service),
    reapOrphanedAdvert: vi.fn(),
    followAppImageMoves: vi.fn(),
    settings: { enabled: false, startAtLogin: false, advertise: true },
    location: vi.fn(() => ({
      dir: "/run/daintree",
      socketPath: "/run/daintree/host.sock",
      discoveryPath: "/run/daintree/host.json",
    })),
    argv: [] as string[],
  };
});

vi.mock("../host/advertRecord.js", () => ({ reapOrphanedAdvert: m.reapOrphanedAdvert }));
vi.mock("../host/appImageRelocation.js", () => ({ followAppImageMoves: m.followAppImageMoves }));
vi.mock("../host/hostModeSettings.js", () => ({ readHostModeSettings: () => m.settings }));
vi.mock("../host/hostLocation.js", () => ({ hostLocation: m.location }));
vi.mock("../../boot/hostModeLaunch.js", () => ({
  isHostModeRequested: (argv: string[]) => argv.includes("--host-mode"),
}));

type HostBoot = typeof import("../hostBoot.js");
type Runtime = typeof import("../runtime.js");

let startHostRole: HostBoot["startHostRole"];
let getRemoteService: Runtime["getRemoteService"];
let _resetRemoteServicesForTest: Runtime["_resetRemoteServicesForTest"];
let teardowns: Array<() => void | Promise<void>> = [];
const addTeardown = (teardown: () => void | Promise<void>) => void teardowns.push(teardown);
const originalArgv = process.argv;

beforeEach(async () => {
  vi.clearAllMocks();
  m.settings = { enabled: false, startAtLogin: false, advertise: true };
  process.argv = [...originalArgv];
  // Each case starts from a cold module registry, so whether Host mode's module
  // was evaluated is this case's doing, whatever ran before it.
  vi.resetModules();
  m.defaultsLoaded = false;
  vi.doMock("../host/hostModeDefaults.js", () => {
    m.defaultsLoaded = true;
    return { createHostModeService: m.createHostModeService };
  });
  ({ startHostRole } = await import("../hostBoot.js"));
  ({ getRemoteService, _resetRemoteServicesForTest } = await import("../runtime.js"));
});

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown();
  teardowns = [];
  _resetRemoteServicesForTest();
  process.argv = originalArgv;
});

describe("startHostRole", () => {
  it("leaves Host mode and the Host server unloaded while Host mode is off", async () => {
    await expect(startHostRole({ hostMode: false }, addTeardown)).resolves.toBeNull();

    const hostMode = getRemoteService("hostMode")!;
    await expect(hostMode.getStatus()).resolves.toMatchObject({
      supported: true,
      enabled: false,
      listening: false,
      socketPath: "/run/daintree/host.sock",
      attachedClients: [],
    });
    expect(hostMode.getAttachedClients()).toEqual([]);
    expect(m.defaultsLoaded).toBe(false);
    expect(m.createHostModeService).not.toHaveBeenCalled();
    // Boot's own upkeep runs whatever the setting.
    expect(m.reapOrphanedAdvert).toHaveBeenCalledWith("/run/daintree");
    expect(m.followAppImageMoves).toHaveBeenCalledTimes(1);

    // The switch loads it and starts listening.
    await hostMode.setEnabled({ enabled: true });
    expect(m.defaultsLoaded).toBe(true);
    expect(m.service.setEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it("loads and listens at once when Host mode is on for the launch", async () => {
    await expect(startHostRole({ hostMode: true }, addTeardown)).resolves.toBeNull();
    expect(m.defaultsLoaded).toBe(true);
    expect(m.createHostModeService).toHaveBeenCalledTimes(1);
    expect(m.service.startListening).toHaveBeenCalledTimes(1);
    expect(m.service.refreshStartAtLogin).not.toHaveBeenCalled();
    await expect(getRemoteService("hostMode")!.getStatus()).resolves.toEqual({ listening: true });
  });

  it("refreshes start at login for a launch its login item made", async () => {
    process.argv = [...originalArgv, "--host-mode"];
    await startHostRole({ hostMode: true }, addTeardown);
    await vi.waitFor(() => expect(m.service.refreshStartAtLogin).toHaveBeenCalledTimes(1));
  });

  it("resolves with why listening failed, leaving the service registered", async () => {
    const error = new Error("EADDRINUSE");
    m.service.startListening.mockRejectedValueOnce(error);
    await expect(startHostRole({ hostMode: true }, addTeardown)).resolves.toEqual({ error });
    expect(getRemoteService("hostMode")).toBeDefined();
  });

  it("uses the location it is given, and reaps nothing when none resolves", async () => {
    const given = {
      dir: "/tmp/h",
      socketPath: "/tmp/h/host.sock",
      discoveryPath: "/tmp/h/host.json",
    };
    await startHostRole({ hostMode: true, hostLocation: given }, addTeardown);
    expect(m.reapOrphanedAdvert).toHaveBeenCalledWith("/tmp/h");
    expect(m.createHostModeService).toHaveBeenCalledWith({ location: given });
    expect(m.location).not.toHaveBeenCalled();

    vi.clearAllMocks();
    _resetRemoteServicesForTest();
    m.location.mockImplementationOnce(() => {
      throw new Error("no runtime dir");
    });
    await startHostRole({ hostMode: false }, addTeardown);
    expect(m.reapOrphanedAdvert).not.toHaveBeenCalled();
    await expect(getRemoteService("hostMode")!.getStatus()).resolves.toMatchObject({
      socketPath: null,
    });
  });

  it("disposes the service it built, and unregisters it, on teardown", async () => {
    await startHostRole({ hostMode: true }, addTeardown);
    for (const teardown of teardowns.splice(0).reverse()) await teardown();
    expect(m.service.dispose).toHaveBeenCalledTimes(1);
    expect(getRemoteService("hostMode")).toBeUndefined();
  });
});
