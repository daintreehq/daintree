import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ResourceProfile,
  ResourceProfilePayload,
  ResourceProfileSnapshot,
} from "../../../../shared/types/resourceProfile.js";
import { resolveResourceProfileConfig } from "../../../utils/resourceProfileConfig.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

// define.js wires ops through typedHandle/typedHandleValidated; record
// (channel, handler) so each op's body can be invoked directly.
const utilsMock = vi.hoisted(() => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (
    channel: string,
    schema: { parse: (input: unknown) => unknown },
    handler: unknown
  ) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) =>
      (handler as (payload: unknown) => unknown)(schema.parse(args[0]))
    );
    return () => ipcMainMock.removeHandler(channel);
  },
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

describe("registerResourceProfileHandlers — getResourceProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the live profile's config through the shared resolver (pull == push)", async () => {
    serviceRefsMock.getResourceProfileService.mockReturnValue({
      getProfile: (): ResourceProfile => "performance",
    });

    registerResourceProfileHandlers({} as never);
    const result = (await getHandler("system:get-resource-profile")()) as ResourceProfilePayload;

    expect(result.profile).toBe("performance");
    // The pulled config must match the resolver exactly — the same helper the
    // broadcast path uses — so a late-created renderer gets identical WebGL flip
    // thresholds. Comparing against the resolver (not literal numbers) keeps this
    // deterministic on any host RAM.
    expect(result.config).toEqual(resolveResourceProfileConfig("performance"));
    // The resolved config must actually carry the WebGL flip thresholds (they
    // were removed from the static table) with a valid hysteresis band.
    expect(result.config.webglLowerThreshold).toBeLessThanOrEqual(
      result.config.webglUpperThreshold
    );
  });

  it("falls back to the balanced profile's resolved config when the service is unavailable", async () => {
    serviceRefsMock.getResourceProfileService.mockReturnValue(null);

    registerResourceProfileHandlers({} as never);
    const result = (await getHandler("system:get-resource-profile")()) as ResourceProfilePayload;

    expect(result.profile).toBe("balanced");
    expect(result.config).toEqual(resolveResourceProfileConfig("balanced"));
  });
});

describe("registerResourceProfileHandlers — requestInteractiveOverride", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a validated duration to the live service", async () => {
    const requestInteractiveOverride = vi.fn();
    serviceRefsMock.getResourceProfileService.mockReturnValue({
      requestInteractiveOverride,
    });

    registerResourceProfileHandlers({} as never);
    await getHandler("system:request-interactive-override")(1500);

    expect(requestInteractiveOverride).toHaveBeenCalledWith(1500);
  });

  it("no-ops when the service is unavailable", async () => {
    serviceRefsMock.getResourceProfileService.mockReturnValue(null);

    registerResourceProfileHandlers({} as never);
    await expect(getHandler("system:request-interactive-override")(1500)).resolves.toBeUndefined();
  });

  it("rejects malformed durations at the IPC boundary", async () => {
    const requestInteractiveOverride = vi.fn();
    serviceRefsMock.getResourceProfileService.mockReturnValue({
      requestInteractiveOverride,
    });

    registerResourceProfileHandlers({} as never);
    await expect(getHandler("system:request-interactive-override")(Number.NaN)).rejects.toThrow();
    await expect(getHandler("system:request-interactive-override")(Infinity)).rejects.toThrow();
    await expect(getHandler("system:request-interactive-override")(-1)).rejects.toThrow();
    await expect(getHandler("system:request-interactive-override")(5001)).rejects.toThrow();

    expect(requestInteractiveOverride).not.toHaveBeenCalled();
  });
});
