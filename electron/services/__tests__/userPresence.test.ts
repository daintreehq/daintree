import { afterEach, describe, expect, it, vi } from "vitest";

const powerMonitorMock = vi.hoisted(() => ({
  getSystemIdleState: vi.fn<(threshold: number) => string>(() => "active"),
}));

vi.mock("electron", () => ({ powerMonitor: powerMonitorMock }));

import { AWAY_IDLE_THRESHOLD_SECONDS, readUserPresence } from "../userPresence.js";
import { updatePowerObservations } from "../../window/powerPolicy.js";

describe("readUserPresence", () => {
  afterEach(() => {
    updatePowerObservations({ screenLocked: false });
    powerMonitorMock.getSystemIdleState.mockReset();
    powerMonitorMock.getSystemIdleState.mockReturnValue("active");
  });

  it("asks the OS with the 180 second away threshold", () => {
    readUserPresence();
    expect(powerMonitorMock.getSystemIdleState).toHaveBeenCalledWith(180);
    expect(AWAY_IDLE_THRESHOLD_SECONDS).toBe(180);
  });

  it.each([
    ["active", "present"],
    ["idle", "away"],
    ["locked", "away"],
    ["unknown", "unknown"],
  ] as const)("maps idle state %s to %s", (state, presence) => {
    powerMonitorMock.getSystemIdleState.mockReturnValue(state);
    expect(readUserPresence()).toBe(presence);
  });

  it("keeps an unrecognised idle state unknown rather than guessing", () => {
    powerMonitorMock.getSystemIdleState.mockReturnValue("dozing");
    expect(readUserPresence()).toBe("unknown");
  });

  it("reports unknown when the OS query throws", () => {
    powerMonitorMock.getSystemIdleState.mockImplementation(() => {
      throw new Error("no idle source");
    });
    expect(readUserPresence()).toBe("unknown");
  });

  it("treats an observed screen lock as away without waiting for the idle threshold", () => {
    updatePowerObservations({ screenLocked: true });
    expect(readUserPresence()).toBe("away");
    expect(powerMonitorMock.getSystemIdleState).not.toHaveBeenCalled();
  });
});
