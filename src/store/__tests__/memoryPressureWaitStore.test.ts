import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isMemoryPressureCriticalMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("@/clients/systemClient", () => ({
  systemClient: { isMemoryPressureCritical: isMemoryPressureCriticalMock },
}));

vi.mock("@/utils/logger", () => ({ logInfo: vi.fn() }));

import {
  cancelMemoryPressureHold,
  holdForMemoryPressure,
  isMemoryPressureCritical,
  launchDespiteMemoryPressure,
  MEMORY_PRESSURE_POLL_MS,
  panelHoldKey,
  resetMemoryPressureHoldsForTesting,
  useMemoryPressureWaitStore,
} from "../memoryPressureWaitStore";

const heldPanels = () => Object.keys(useMemoryPressureWaitStore.getState().heldPanelIds);

beforeEach(() => {
  vi.useFakeTimers();
  isMemoryPressureCriticalMock.mockReset();
  isMemoryPressureCriticalMock.mockResolvedValue(true);
});

afterEach(() => {
  resetMemoryPressureHoldsForTesting();
  vi.useRealTimers();
});

describe("isMemoryPressureCritical", () => {
  it("reads a failed check as below critical", async () => {
    isMemoryPressureCriticalMock.mockRejectedValue(new Error("no handler"));
    await expect(isMemoryPressureCritical()).resolves.toBe(false);
  });
});

describe("memory pressure holds (#13530)", () => {
  it("marks a held pane for its chrome until the hold ends", () => {
    holdForMemoryPressure(panelHoldKey("p1"), { panelId: "p1", resume: vi.fn() });
    expect(heldPanels()).toEqual(["p1"]);

    cancelMemoryPressureHold(panelHoldKey("p1"));
    expect(heldPanels()).toEqual([]);
  });

  it("keeps holding while each poll still reads critical", async () => {
    const resume = vi.fn();
    holdForMemoryPressure("k", { resume });

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS * 3);

    expect(isMemoryPressureCriticalMock).toHaveBeenCalledTimes(3);
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes every hold, in the order they were held, once a poll reads below critical", async () => {
    const order: string[] = [];
    holdForMemoryPressure(panelHoldKey("a"), {
      panelId: "a",
      resume: (anyway) => order.push(`a:${anyway}`),
    });
    holdForMemoryPressure(panelHoldKey("b"), {
      panelId: "b",
      resume: (anyway) => order.push(`b:${anyway}`),
    });
    isMemoryPressureCriticalMock.mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(order).toEqual(["a:false", "b:false"]);
    expect(heldPanels()).toEqual([]);
  });

  it("stops polling once nothing is held", async () => {
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    holdForMemoryPressure("k", { resume: vi.fn() });
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    isMemoryPressureCriticalMock.mockClear();

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS * 4);

    expect(isMemoryPressureCriticalMock).not.toHaveBeenCalled();
  });

  it("launches one hold anyway without touching the others", () => {
    const first = vi.fn();
    const second = vi.fn();
    holdForMemoryPressure("first", { resume: first });
    holdForMemoryPressure("second", { resume: second });

    launchDespiteMemoryPressure("first");

    expect(first).toHaveBeenCalledWith(true);
    expect(second).not.toHaveBeenCalled();
  });

  it("drops a stale hold without resuming it, and never asks main for it", async () => {
    const resume = vi.fn();
    holdForMemoryPressure(panelHoldKey("gone"), {
      panelId: "gone",
      resume,
      isStale: () => true,
    });
    isMemoryPressureCriticalMock.mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(resume).not.toHaveBeenCalled();
    expect(isMemoryPressureCriticalMock).not.toHaveBeenCalled();
    expect(heldPanels()).toEqual([]);
  });

  it("cancels the hold a second one under the same key replaces", () => {
    const onCancel = vi.fn();
    const replaced = vi.fn();
    const replacement = vi.fn();
    holdForMemoryPressure("project-open", { resume: replaced, onCancel });
    holdForMemoryPressure("project-open", { resume: replacement });

    launchDespiteMemoryPressure("project-open");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(replaced).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(true);
  });

  it("ends a hold only once, however it is ended", () => {
    const resume = vi.fn();
    const onCancel = vi.fn();
    holdForMemoryPressure("k", { resume, onCancel });

    launchDespiteMemoryPressure("k");
    cancelMemoryPressureHold("k");
    launchDespiteMemoryPressure("k");

    expect(resume).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
