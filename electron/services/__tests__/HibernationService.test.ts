import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn(() => null),
  getAllProjects: vi.fn(() => []),
  clearProjectState: vi.fn(async () => {}),
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

import { HibernationService } from "../HibernationService.js";

describe("HibernationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes malformed persisted config in getConfig", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: "yes",
      inactiveThresholdHours: Number.NaN,
    });

    const service = new HibernationService();

    expect(service.getConfig()).toEqual({
      enabled: false,
      inactiveThresholdHours: 24,
    });
  });

  it("clamps persisted threshold into valid range", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 500,
    });

    const service = new HibernationService();

    expect(service.getConfig()).toEqual({
      enabled: true,
      inactiveThresholdHours: 168,
    });
  });

  it("ignores invalid update payload values", () => {
    (storeMock.get as Mock).mockReturnValue(undefined);
    const service = new HibernationService();

    service.updateConfig({
      enabled: "true" as unknown as boolean,
      inactiveThresholdHours: Number.NaN,
    });

    expect(storeMock.set).toHaveBeenCalledWith("hibernation", {
      enabled: false,
      inactiveThresholdHours: 24,
    });
  });

  it("preserves current threshold when invalid threshold update is provided", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 72,
    });
    const service = new HibernationService();

    service.updateConfig({
      inactiveThresholdHours: Number.NaN,
    });

    expect(storeMock.set).toHaveBeenCalledWith("hibernation", {
      enabled: true,
      inactiveThresholdHours: 72,
    });
  });

  it("clears pending initial check when stopped before timeout", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 24,
    });
    const service = new HibernationService();
    const checkSpy = vi.spyOn(service as never, "checkAndHibernate" as never);

    service.start();
    service.stop();

    vi.advanceTimersByTime(6000);

    expect(checkSpy).not.toHaveBeenCalled();
  });
});
