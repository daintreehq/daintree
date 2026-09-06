import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceEmulationRequest } from "../../../../shared/types/ipc/webviewEmulation.js";

interface MockGuest {
  isDestroyed: () => boolean;
  getUserAgent: ReturnType<typeof vi.fn>;
  setUserAgent: ReturnType<typeof vi.fn>;
  enableDeviceEmulation: ReturnType<typeof vi.fn>;
  disableDeviceEmulation: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  debugger: {
    isAttached: () => boolean;
    attach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
}

const guestRegistry = vi.hoisted(() => new Map<number, MockGuest>());
const dialogService = vi.hoisted(() => ({
  getPanelId: vi.fn<(webContentsId: number) => string | undefined>(),
}));

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn((webContentsId: number) => guestRegistry.get(webContentsId)),
  },
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => dialogService,
}));

function makeGuest(overrides: Partial<MockGuest> = {}): MockGuest {
  return {
    isDestroyed: () => false,
    getUserAgent: vi.fn(() => "Daintree/1.0 Electron desktop UA"),
    setUserAgent: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    once: vi.fn(),
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve()),
    },
    ...overrides,
  };
}

const IPHONE_PARAMS = {
  screenPosition: "mobile" as const,
  screenSize: { width: 393, height: 852 },
  viewPosition: { x: 0, y: 0 },
  deviceScaleFactor: 3,
  viewSize: { width: 393, height: 852 },
  scale: 1,
};

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_4 like Mac OS X) Mobile/15E148";

function applyRequest(overrides: Partial<DeviceEmulationRequest> = {}): DeviceEmulationRequest {
  return {
    webContentsId: 7,
    panelId: "panel-a",
    emulation: { params: IPHONE_PARAMS, userAgent: MOBILE_UA, touch: true },
    ...overrides,
  };
}

async function getHandler() {
  const { webviewEmulationNamespace } = await import("../webviewEmulation.js");
  return webviewEmulationNamespace.ops.setDeviceEmulation.handler as (
    payload: DeviceEmulationRequest
  ) => Promise<{ applied: boolean }>;
}

function cdpCalls(guest: MockGuest) {
  return guest.debugger.sendCommand.mock.calls as Array<[string, Record<string, unknown>]>;
}

describe("webviewEmulation handler", () => {
  beforeEach(() => {
    vi.resetModules();
    guestRegistry.clear();
    dialogService.getPanelId.mockReset();
    dialogService.getPanelId.mockReturnValue("panel-a");
  });

  it("applies viewport metrics and the spoofed user agent to the registered guest", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);

    const handler = await getHandler();
    await handler(applyRequest());

    expect(guest.setUserAgent).toHaveBeenCalledWith(MOBILE_UA);
    expect(guest.enableDeviceEmulation).toHaveBeenCalledWith(IPHONE_PARAMS);
  });

  it("emulates touch and the coarse pointer/no-hover media features", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);

    const handler = await getHandler();
    await handler(applyRequest());

    const calls = cdpCalls(guest);
    expect(calls).toContainEqual([
      "Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 5 },
    ]);
    expect(calls).toContainEqual([
      "Emulation.setEmitTouchEventsForMouse",
      { enabled: true, configuration: "mobile" },
    ]);
    const media = calls.find(([cmd]) => cmd === "Emulation.setEmulatedMedia");
    expect(media?.[1]).toEqual({
      features: [
        { name: "pointer", value: "coarse" },
        { name: "any-pointer", value: "coarse" },
        { name: "hover", value: "none" },
        { name: "any-hover", value: "none" },
      ],
    });
  });

  it("restores the guest's own user agent and native metrics on a null payload", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    await handler(applyRequest());
    await handler(applyRequest({ emulation: null }));

    expect(guest.disableDeviceEmulation).toHaveBeenCalledTimes(1);
    expect(guest.setUserAgent).toHaveBeenLastCalledWith("Daintree/1.0 Electron desktop UA");
    expect(cdpCalls(guest)).toContainEqual([
      "Emulation.setTouchEmulationEnabled",
      { enabled: false, maxTouchPoints: 1 },
    ]);
    expect(
      cdpCalls(guest).filter(([cmd, params]) => {
        return cmd === "Emulation.setEmulatedMedia" && (params as { features: [] }).features;
      })
    ).toContainEqual(["Emulation.setEmulatedMedia", { features: [] }]);
  });

  it("captures the original user agent only once across repeated applies", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    await handler(applyRequest());
    await handler(
      applyRequest({ emulation: { params: IPHONE_PARAMS, userAgent: "other", touch: true } })
    );
    await handler(applyRequest({ emulation: null }));

    expect(guest.getUserAgent).toHaveBeenCalledTimes(1);
    expect(guest.setUserAgent).toHaveBeenLastCalledWith("Daintree/1.0 Electron desktop UA");
  });

  it("does not re-issue touch commands when the state is known and unchanged", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    await handler(applyRequest());
    await handler(applyRequest());

    const touchCalls = cdpCalls(guest).filter(
      ([cmd]) => cmd === "Emulation.setTouchEmulationEnabled"
    );
    expect(touchCalls).toHaveLength(1);
  });

  it("still applies viewport metrics when the touch CDP commands fail", async () => {
    const guest = makeGuest();
    guest.debugger.sendCommand.mockRejectedValue(new Error("Target closed"));
    guestRegistry.set(7, guest);

    const handler = await getHandler();
    await handler(applyRequest());

    expect(guest.enableDeviceEmulation).toHaveBeenCalledWith(IPHONE_PARAMS);
  });

  it("survives a guest that never had emulation enabled", async () => {
    const guest = makeGuest({
      disableDeviceEmulation: vi.fn(() => {
        throw new Error("Device emulation is not enabled");
      }),
    });
    guestRegistry.set(7, guest);

    const handler = await getHandler();
    await expect(handler(applyRequest({ emulation: null }))).resolves.toEqual({ applied: true });
  });

  it("ignores a guest registered to a different panel", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    dialogService.getPanelId.mockReturnValue("panel-b");

    const handler = await getHandler();
    const result = await handler(applyRequest());

    expect(result).toEqual({ applied: false });
    expect(guest.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(guest.setUserAgent).not.toHaveBeenCalled();
  });

  it("reports applied:false rather than letting the caller cache a lie", async () => {
    const handler = await getHandler();
    await expect(handler(applyRequest())).resolves.toEqual({ applied: false });

    guestRegistry.set(7, makeGuest());
    await expect(handler(applyRequest())).resolves.toEqual({ applied: true });
  });

  it("does not let a clear finish underneath a newer preset", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    // Settle the first preset, so touch is *known* to be on. Without that, a
    // clear racing a still-unsettled apply would find the cache already false
    // and skip its touch teardown, hiding the ordering problem.
    await handler(applyRequest());
    expect(
      cdpCalls(guest).filter(([cmd]) => cmd === "Emulation.setTouchEmulationEnabled")
    ).toHaveLength(1);

    // Now hold the clear's CDP commands open and select another preset behind
    // it. Serialized, the clear finishes first and the preset's touch setup
    // lands last; interleaved, the clear's teardown lands on top of it.
    const pending: Array<() => void> = [];
    guest.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        })
    );
    const cleared = handler(applyRequest({ emulation: null }));
    const reapplied = handler(applyRequest());

    for (let i = 0; i < 200; i++) {
      while (pending.length > 0) pending.shift()!();
      await Promise.resolve();
    }
    await Promise.all([cleared, reapplied]);

    const touchCalls = cdpCalls(guest)
      .filter(([cmd]) => cmd === "Emulation.setTouchEmulationEnabled")
      .map(([, params]) => (params as { enabled: boolean }).enabled);
    expect(touchCalls).toEqual([true, false, true]);
  });

  it("cleans up touch after a partial failure instead of trusting the cache", async () => {
    const guest = makeGuest();
    // The first command lands, the second does not — the guest now has touch
    // emulation partly on, in a state a boolean cache cannot describe.
    let call = 0;
    guest.debugger.sendCommand.mockImplementation(() => {
      call += 1;
      return call === 2 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    guestRegistry.set(7, guest);
    const handler = await getHandler();
    await handler(applyRequest());

    guest.debugger.sendCommand.mockClear();
    guest.debugger.sendCommand.mockImplementation(() => Promise.resolve());
    await handler(applyRequest({ emulation: null }));

    // A cache that recorded the failed apply as "touch off" would skip this
    // teardown and leave the guest reporting a coarse pointer on desktop.
    expect(cdpCalls(guest)).toContainEqual([
      "Emulation.setTouchEmulationEnabled",
      { enabled: false, maxTouchPoints: 1 },
    ]);
  });

  it("reports applied:false for a queued request whose guest went away", async () => {
    const guest = makeGuest();
    const pending: Array<() => void> = [];
    guest.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        })
    );
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    const first = handler(applyRequest());
    const queued = handler(applyRequest({ emulation: null }));

    // The guest dies while the second request is still waiting its turn.
    guest.isDestroyed = () => true;
    for (let i = 0; i < 200; i++) {
      while (pending.length > 0) pending.shift()!();
      await Promise.resolve();
    }

    await first;
    await expect(queued).resolves.toEqual({ applied: false });
  });

  it("ignores a guest registered to a different panel", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    dialogService.getPanelId.mockReturnValue("panel-b");

    const handler = await getHandler();
    const result = await handler(applyRequest());

    expect(result).toEqual({ applied: false });
    expect(guest.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(guest.setUserAgent).not.toHaveBeenCalled();
  });

  it("reports applied:false rather than letting the caller cache a lie", async () => {
    const handler = await getHandler();
    await expect(handler(applyRequest())).resolves.toEqual({ applied: false });

    guestRegistry.set(7, makeGuest());
    await expect(handler(applyRequest())).resolves.toEqual({ applied: true });
  });

  it("does not let a clear finish underneath a newer preset", async () => {
    const guest = makeGuest();
    const pending: Array<() => void> = [];
    guest.debugger.sendCommand.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        })
    );
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    // Apply a preset, then clear, then apply again — all while every CDP
    // command is still outstanding.
    const first = handler(applyRequest());
    const cleared = handler(applyRequest({ emulation: null }));
    const second = handler(applyRequest());

    // Requests are serialized, so the next batch of CDP commands is only
    // issued once the previous request finishes — keep draining past the
    // moments when nothing is outstanding.
    for (let i = 0; i < 200; i++) {
      while (pending.length > 0) pending.shift()!();
      await Promise.resolve();
    }
    await Promise.all([first, cleared, second]);

    // Serialized, so the last request wins: the guest ends up emulated, not
    // left with the clear's touch teardown applied on top of it.
    const touchCalls = cdpCalls(guest)
      .filter(([cmd]) => cmd === "Emulation.setTouchEmulationEnabled")
      .map(([, params]) => (params as { enabled: boolean }).enabled);
    expect(touchCalls[touchCalls.length - 1]).toBe(true);
  });

  it("re-issues touch commands after a partial failure instead of trusting the cache", async () => {
    const guest = makeGuest();
    // The first command lands, the second does not — the guest is now in a
    // state the cache cannot describe.
    let call = 0;
    guest.debugger.sendCommand.mockImplementation(() => {
      call += 1;
      return call === 2 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    guestRegistry.set(7, guest);
    const handler = await getHandler();

    await handler(applyRequest());
    guest.debugger.sendCommand.mockClear();
    guest.debugger.sendCommand.mockImplementation(() => Promise.resolve());
    await handler(applyRequest());

    expect(cdpCalls(guest)).toContainEqual([
      "Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 5 },
    ]);
  });

  it("ignores an unregistered guest", async () => {
    const guest = makeGuest();
    guestRegistry.set(7, guest);
    dialogService.getPanelId.mockReturnValue(undefined);

    const handler = await getHandler();
    await handler(applyRequest());

    expect(guest.enableDeviceEmulation).not.toHaveBeenCalled();
  });

  it("does nothing when the guest is gone", async () => {
    const handler = await getHandler();
    await expect(handler(applyRequest())).resolves.toEqual({ applied: false });
  });
});
