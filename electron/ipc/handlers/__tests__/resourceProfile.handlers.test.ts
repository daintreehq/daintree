import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceProfileSnapshot } from "../../../../shared/types/resourceProfile.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

// define.js wires plain ops through typedHandle; record (channel, handler) so
// each op's body can be invoked directly. The other typedHandle* variants are
// unused by this namespace but must exist for the module to import cleanly.
const utilsMock = vi.hoisted(() => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: vi.fn(),
  typedHandleWithContext: vi.fn(),
  typedHandleWithContextValidated: vi.fn(),
}));

vi.mock("../../utils.js", () => utilsMock);

const serviceRefsMock = vi.hoisted(() => ({
  getResourceProfileService: vi.fn(),
}));

vi.mock("../../../window/serviceRefs.js", () => serviceRefsMock);

import { registerResourceProfileHandlers } from "../resourceProfile.js";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const entry = ipcMainMock.handle.mock.calls.find(([ch]) => ch === channel);
  if (!entry) throw new Error(`no handler registered for ${channel}`);
  return (...args: unknown[]) => entry[1](null, ...args);
}

describe("registerResourceProfileHandlers — getResourceProfileSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the live service snapshot when the service is running", async () => {
    const snapshot: ResourceProfileSnapshot = {
      profile: "efficiency",
      thermalState: "serious",
      isOnBattery: true,
      speedLimit: 55,
      lagPressureActive: true,
    };
    serviceRefsMock.getResourceProfileService.mockReturnValue({
      getSnapshot: () => snapshot,
    });

    registerResourceProfileHandlers({} as never);
    const result = await getHandler("system:get-resource-profile-snapshot")();

    expect(result).toEqual(snapshot);
  });

  it("falls back to the balanced/unthrottled baseline when the service is unavailable", async () => {
    serviceRefsMock.getResourceProfileService.mockReturnValue(null);

    registerResourceProfileHandlers({} as never);
    const result = await getHandler("system:get-resource-profile-snapshot")();

    // The fallback defaults are semantically load-bearing: an orchestrator must
    // read "no pressure" (not "missing") before the service boots.
    expect(result).toEqual({
      profile: "balanced",
      thermalState: "unknown",
      isOnBattery: false,
      speedLimit: 100,
      lagPressureActive: false,
    });
  });
});
