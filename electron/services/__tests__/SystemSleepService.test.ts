import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const powerMonitorMock = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("electron", () => ({
  powerMonitor: powerMonitorMock,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => loggerMock,
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

  it("preserves accumulated sleep metrics after dispose for post-mortem inspection", () => {
    const service = new SystemSleepService();
    service.initialize();

    const suspendHandler = getLatestRegisteredHandler("suspend");
    suspendHandler();

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    const resumeHandler = getLatestRegisteredHandler("resume");
    resumeHandler();

    service.dispose();

    expect(service.getMetrics().sleepPeriods).toHaveLength(1);
    expect(service.getTotalSleepTime()).toBe(5000);
    expect(service.isSleeping()).toBe(false);
  });

  it("clears accumulated sleep periods and totals after dispose and reinitialize", () => {
    const service = new SystemSleepService();
    service.initialize();

    const suspendHandler = getLatestRegisteredHandler("suspend");
    suspendHandler();

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    const resumeHandler = getLatestRegisteredHandler("resume");
    resumeHandler();

    expect(service.getMetrics().sleepPeriods).toHaveLength(1);
    expect(service.getTotalSleepTime()).toBe(5000);

    service.dispose();
    service.initialize();

    expect(service.getMetrics().sleepPeriods).toEqual([]);
    expect(service.getTotalSleepTime()).toBe(0);
  });

  it("does not erase live metrics when initialize is called again without dispose", () => {
    const service = new SystemSleepService();
    service.initialize();

    const suspendHandler = getLatestRegisteredHandler("suspend");
    suspendHandler();

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    const resumeHandler = getLatestRegisteredHandler("resume");
    resumeHandler();

    expect(service.getMetrics().sleepPeriods).toHaveLength(1);
    expect(service.getTotalSleepTime()).toBe(5000);

    service.initialize();

    expect(service.getMetrics().sleepPeriods).toHaveLength(1);
    expect(service.getTotalSleepTime()).toBe(5000);
  });

  it("logs suspend and wake with the sleep duration", () => {
    const service = new SystemSleepService();
    service.initialize();

    getLatestRegisteredHandler("suspend")();
    expect(loggerMock.info).toHaveBeenCalledWith("System suspending", {
      sleepStart: Date.now(),
    });

    vi.advanceTimersByTime(30_000);
    getLatestRegisteredHandler("resume")();
    expect(loggerMock.info).toHaveBeenCalledWith(
      "System resumed",
      expect.objectContaining({ sleepDurationMs: 30_000, totalSleepMs: 30_000 })
    );

    service.dispose();
  });

  it("logs a resume that follows no suspend", () => {
    const service = new SystemSleepService();
    service.initialize();

    getLatestRegisteredHandler("resume")();
    expect(loggerMock.info).toHaveBeenCalledWith("System resumed with no suspend recorded");

    service.dispose();
  });
});
