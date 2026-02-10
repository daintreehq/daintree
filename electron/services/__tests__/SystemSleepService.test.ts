import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const powerMonitorMock = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock("electron", () => ({
  powerMonitor: powerMonitorMock,
}));

import { SystemSleepService } from "../SystemSleepService.js";

function getLatestRegisteredHandler(eventName: "suspend" | "resume"): () => void {
  const matchingCall = [...(powerMonitorMock.on as Mock).mock.calls]
    .reverse()
    .find(([name]) => name === eventName);

  if (!matchingCall) {
    throw new Error(`No handler registered for event: ${eventName}`);
  }

  return matchingCall[1] as () => void;
}

describe("SystemSleepService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears in-progress sleep state when disposed", () => {
    const service = new SystemSleepService();
    service.initialize();

    const suspendHandler = getLatestRegisteredHandler("suspend");
    suspendHandler();

    expect(service.isSleeping()).toBe(true);

    service.dispose();

    expect(service.isSleeping()).toBe(false);
    expect(service.getMetrics().currentSleepStart).toBeNull();
  });

  it("does not attribute stale pre-dispose suspend to post-reinitialize resume", () => {
    const service = new SystemSleepService();
    service.initialize();

    const initialSuspendHandler = getLatestRegisteredHandler("suspend");
    initialSuspendHandler();

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    service.dispose();

    service.initialize();
    const postReinitResumeHandler = getLatestRegisteredHandler("resume");

    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    postReinitResumeHandler();

    expect(service.getTotalSleepTime()).toBe(0);
    expect(service.getMetrics().sleepPeriods).toEqual([]);
  });
});
