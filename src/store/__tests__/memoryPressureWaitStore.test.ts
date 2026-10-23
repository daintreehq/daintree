import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isMemoryPressureCriticalMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const requestAdmissionMock = vi.hoisted(() => vi.fn());
const observeAdmissionMock = vi.hoisted(() => vi.fn());
vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    isMemoryPressureCritical: isMemoryPressureCriticalMock,
    requestAgentLaunchAdmission: requestAdmissionMock,
    observeAgentLaunchAdmission: observeAdmissionMock,
  },
}));

vi.mock("@/utils/logger", () => ({ logInfo: vi.fn() }));

import {
  cancelMemoryPressureHold,
  clearPanelMemoryPressureMark,
  holdForMemoryPressure,
  isMemoryPressureCritical,
  launchDespiteMemoryPressure,
  MEMORY_PRESSURE_POLL_MS,
  panelHoldKey,
  requestAgentLaunchAdmission,
  resetMemoryPressureHoldsForTesting,
  useMemoryPressureWaitStore,
} from "../memoryPressureWaitStore";
import type { AgentLaunchObservation } from "@shared/types/agentLaunchAdmission";

const heldPanels = () => Object.keys(useMemoryPressureWaitStore.getState().heldPanelIds);

beforeEach(() => {
  vi.useFakeTimers();
  isMemoryPressureCriticalMock.mockReset();
  isMemoryPressureCriticalMock.mockResolvedValue(true);
  // A host from before #14221 by default: the kernel reading is all it has.
  requestAdmissionMock.mockReset();
  requestAdmissionMock.mockRejectedValue(new Error("no handler"));
  observeAdmissionMock.mockReset();
  observeAdmissionMock.mockRejectedValue(new Error("no handler"));
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
    // Still marked: each launch clears its own mark as it starts.
    expect(heldPanels()).toEqual(["a", "b"]);
  });

  it("stops polling once nothing is held", async () => {
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    holdForMemoryPressure("k", { resume: vi.fn() });
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    isMemoryPressureCriticalMock.mockClear();

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS * 4);

    expect(isMemoryPressureCriticalMock).not.toHaveBeenCalled();
  });

  it("keeps a released pane marked until its launch clears the mark itself", () => {
    // The launch is queued, not started: the mark is what keeps a restart off it.
    holdForMemoryPressure(panelHoldKey("p1"), { panelId: "p1", resume: vi.fn() });

    launchDespiteMemoryPressure(panelHoldKey("p1"));
    expect(heldPanels()).toEqual(["p1"]);

    clearPanelMemoryPressureMark("p1");
    expect(heldPanels()).toEqual([]);
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

  it("leaves a deferred hold waiting, and asks main nothing while every hold is deferred", async () => {
    const resume = vi.fn();
    let deferred = true;
    holdForMemoryPressure("k", { resume, isDeferred: () => deferred });
    isMemoryPressureCriticalMock.mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS * 2);
    expect(resume).not.toHaveBeenCalled();
    expect(isMemoryPressureCriticalMock).not.toHaveBeenCalled();

    deferred = false;
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    expect(resume).toHaveBeenCalledWith(false);
  });

  it("resumes the holds that are not deferred, and keeps the rest", async () => {
    const waiting = vi.fn();
    const trashed = vi.fn();
    holdForMemoryPressure("waiting", { resume: waiting });
    holdForMemoryPressure("trashed", { resume: trashed, isDeferred: () => true });
    isMemoryPressureCriticalMock.mockResolvedValue(false);

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(waiting).toHaveBeenCalledTimes(1);
    expect(trashed).not.toHaveBeenCalled();
    launchDespiteMemoryPressure("trashed");
    expect(trashed).toHaveBeenCalledWith(true);
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

const observation = (extra: Partial<AgentLaunchObservation> = {}): AgentLaunchObservation => ({
  kernelCritical: false,
  runningAgents: 8,
  startingAgents: 0,
  agentLaunchLimit: 8,
  memoryTotalBytes: 36 * 1024 ** 3,
  ...extra,
});

describe("requestAgentLaunchAdmission", () => {
  it("passes on the host's answer", async () => {
    const admission = { holdReason: "agent-capacity", observation: observation() };
    requestAdmissionMock.mockResolvedValue(admission);

    await expect(requestAgentLaunchAdmission("p1")).resolves.toEqual(admission);
    expect(requestAdmissionMock).toHaveBeenCalledWith("p1");
  });

  it("falls back to the kernel reading when the host can't count its agents", async () => {
    isMemoryPressureCriticalMock.mockResolvedValue(true);
    await expect(requestAgentLaunchAdmission("p1")).resolves.toMatchObject({
      holdReason: "kernel-critical",
      observation: { runningAgents: null, agentLaunchLimit: null },
    });

    isMemoryPressureCriticalMock.mockResolvedValue(false);
    await expect(requestAgentLaunchAdmission("p1")).resolves.toMatchObject({ holdReason: null });
  });
});

describe("agent launches held at the host's agent limit (#14221)", () => {
  const details = () => useMemoryPressureWaitStore.getState().holdDetails;

  it("records why a pane waits, and forgets it once the hold ends", () => {
    const detail = { reason: "agent-capacity" as const, observation: observation() };
    holdForMemoryPressure(panelHoldKey("p1"), { panelId: "p1", resume: vi.fn(), detail });
    expect(details()).toEqual({ p1: detail });

    cancelMemoryPressureHold(panelHoldKey("p1"));
    expect(details()).toEqual({});
  });

  it("resumes only as many waiting launches as the host has places for, in order", async () => {
    const order: string[] = [];
    for (const id of ["a", "b", "c"]) {
      holdForMemoryPressure(panelHoldKey(id), { panelId: id, resume: () => order.push(id) });
    }
    observeAdmissionMock.mockResolvedValue(observation({ runningAgents: 6, startingAgents: 1 }));

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(order).toEqual(["a"]);
    // What still waits shows the host as it looked on that poll.
    expect(details().b).toEqual({
      reason: "agent-capacity",
      observation: observation({ runningAgents: 6, startingAgents: 1 }),
    });
    expect(details().a).toBeUndefined();
  });

  it("resumes nothing while the host is full, and the rest once agents exit", async () => {
    const resume = vi.fn();
    holdForMemoryPressure(panelHoldKey("a"), { panelId: "a", resume });
    observeAdmissionMock.mockResolvedValue(observation());

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS * 2);
    expect(resume).not.toHaveBeenCalled();

    observeAdmissionMock.mockResolvedValue(observation({ runningAgents: 7 }));
    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);
    expect(resume).toHaveBeenCalledWith(false);
  });

  it("holds every agent launch at critical pressure, whatever room the count leaves", async () => {
    const resume = vi.fn();
    holdForMemoryPressure(panelHoldKey("a"), { panelId: "a", resume });
    observeAdmissionMock.mockResolvedValue(observation({ kernelCritical: true, runningAgents: 0 }));

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(resume).not.toHaveBeenCalled();
    expect(details().a?.reason).toBe("kernel-critical");
  });

  it("opens a project on pressure alone, however many agents the host runs", async () => {
    const resume = vi.fn();
    holdForMemoryPressure("project-open", { resume });
    isMemoryPressureCriticalMock.mockResolvedValue(false);
    observeAdmissionMock.mockResolvedValue(observation());

    await vi.advanceTimersByTimeAsync(MEMORY_PRESSURE_POLL_MS);

    expect(resume).toHaveBeenCalledWith(false);
    expect(observeAdmissionMock).not.toHaveBeenCalled();
  });

  it("launches a pane held at the limit anyway", () => {
    const resume = vi.fn();
    holdForMemoryPressure(panelHoldKey("a"), {
      panelId: "a",
      resume,
      detail: { reason: "agent-capacity", observation: observation() },
    });

    launchDespiteMemoryPressure(panelHoldKey("a"));

    expect(resume).toHaveBeenCalledWith(true);
    expect(details().a).toBeUndefined();
  });
});
