// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { selectFleetMemberCount, useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { resolveFleetBroadcastTargetIds } from "../fleetBroadcast";
import {
  buildFleetTargetPreviews,
  executeFleetBroadcast,
  filterEligibleIds,
} from "../fleetExecution";
import {
  _resetCrossHostFleetForTesting,
  armCrossHostTarget,
  confirmCrossHostResend,
  crossHostSafeRetryDeadline,
  crossHostTargetKey,
  needsCrossHostResendConfirmation,
  getArmedCrossHostTargets,
  retainCrossHostTargetsFor,
  submitCrossHostTarget,
} from "../crossHostFleet";
import { sendDraftToFleet, tryFleetBroadcastFromEditor } from "../fleetEnterBroadcast";
import { FLEET_SAFE_RETRY_MS } from "@shared/config/fleetSubmitRetention";

const localSubmit = vi.hoisted(() => vi.fn<(id: string, text: string) => Promise<void>>());
const notifyUserInput = vi.hoisted(() => vi.fn());
const notifyEnterPressed = vi.hoisted(() => vi.fn());
const clearDirectingState = vi.hoisted(() => vi.fn());

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => localSubmit(id, text),
    },
  };
});

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { notifyUserInput, notifyEnterPressed, clearDirectingState },
}));

const submitFleet =
  vi.fn<
    (payload: { hostId: string; terminalId: string; text: string; opId?: string }) => Promise<void>
  >();

function agent(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
  } as PtyPanelData;
}

beforeEach(() => {
  _resetCrossHostFleetForTesting();
  localSubmit.mockReset().mockResolvedValue(undefined);
  submitFleet.mockReset().mockResolvedValue(undefined);
  notifyUserInput.mockReset();
  notifyEnterPressed.mockReset();
  clearDirectingState.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { hostMetrics: { submitFleet } },
  });
  const local = agent("local-1");
  usePanelStore.setState({
    panelsById: { "local-1": local as PanelInstance },
    panelIds: ["local-1"],
  });
  useFleetArmingStore.setState({
    armedIds: new Set(["local-1"]),
    armOrder: ["local-1"],
    armOrderById: { "local-1": 0 },
    lastArmedId: "local-1",
  });
  armCrossHostTarget({
    hostId: "studio-01",
    hostName: "studio-01",
    terminalId: "t1",
    title: "Claude",
  });
  armCrossHostTarget({
    hostId: "studio-02",
    hostName: "studio-02",
    terminalId: "t1",
    title: "Codex",
  });
});

describe("cross-host fleet targets", () => {
  it("rides beside this view's armed agents under host-qualified ids", () => {
    const ids = resolveFleetBroadcastTargetIds();
    expect(ids).toEqual([
      "local-1",
      crossHostTargetKey("studio-01", "t1"),
      crossHostTargetKey("studio-02", "t1"),
    ]);
    // The same terminal id on two hosts is two targets.
    expect(new Set(ids).size).toBe(3);
    expect(filterEligibleIds(ids)).toEqual(ids);
    const previews = buildFleetTargetPreviews("ship it");
    expect(previews.map((p) => p.title)).toEqual([
      "local-1",
      "Claude · studio-01",
      "Codex · studio-02",
    ]);
  });

  it("dispatches each target over its own host's link and local ones locally", async () => {
    const ids = resolveFleetBroadcastTargetIds();
    const result = await executeFleetBroadcast("ship it", ids);
    expect(result.successCount).toBe(3);
    expect(localSubmit).toHaveBeenCalledWith("local-1", "ship it");
    expect(submitFleet).toHaveBeenCalledWith({
      hostId: "studio-01",
      terminalId: "t1",
      text: "ship it",
      opId: expect.any(String),
    });
    expect(submitFleet).toHaveBeenCalledWith({
      hostId: "studio-02",
      terminalId: "t1",
      text: "ship it",
      opId: expect.any(String),
    });
    // Each target submit carries its own opId.
    const opIds = submitFleet.mock.calls.map(([p]) => p.opId);
    expect(new Set(opIds).size).toBe(2);
    // Directing state is this view's terminals' business only.
    expect(notifyUserInput.mock.calls.map(([id]) => id)).toEqual(["local-1"]);
    expect(notifyEnterPressed.mock.calls.map(([id]) => id)).toEqual(["local-1"]);
  });

  it("classifies a host's dead-PTY refusal as permanent and a dropped link as transient", async () => {
    submitFleet.mockImplementation(async ({ hostId }) => {
      if (hostId === "studio-01") throw new Error("EBADF: terminal t1 not found");
      throw new Error("Host studio-02 is not connected");
    });
    const result = await executeFleetBroadcast("go", resolveFleetBroadcastTargetIds());
    expect(result.permanentlyFailedIds).toEqual([crossHostTargetKey("studio-01", "t1")]);
    expect(result.transientlyFailedIds).toEqual([crossHostTargetKey("studio-02", "t1")]);
    expect(clearDirectingState).not.toHaveBeenCalled();
    expect(getArmedCrossHostTargets()).toHaveLength(2);
  });

  it("drops a forgotten host's agents from the fleet", () => {
    retainCrossHostTargetsFor(new Set(["studio-02"]));
    expect(getArmedCrossHostTargets().map((t) => t.hostId)).toEqual(["studio-02"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual([
      "local-1",
      crossHostTargetKey("studio-02", "t1"),
    ]);
  });

  it("sends another host's agent the draft as typed, as its preview shows", async () => {
    await executeFleetBroadcast("on {{branch_name}}", resolveFleetBroadcastTargetIds());
    expect(submitFleet).toHaveBeenCalledWith({
      hostId: "studio-01",
      terminalId: "t1",
      text: "on {{branch_name}}",
      opId: expect.any(String),
    });
  });

  it("leaves with the rest of the fleet on exit, so re-arming one pane can't reach it", () => {
    useFleetArmingStore.getState().clear();
    expect(getArmedCrossHostTargets()).toEqual([]);
    useFleetArmingStore.getState().armId("local-1");
    expect(resolveFleetBroadcastTargetIds()).toEqual(["local-1"]);
    // One pane alone is no fleet: Enter sends only there.
    expect(tryFleetBroadcastFromEditor("local-1", "go", () => {})).toBe(false);
    expect(submitFleet).not.toHaveBeenCalled();
  });

  it("is dropped when the selection is replaced, and leaves by the same disarm as a pane", () => {
    useFleetArmingStore.getState().armIds(["local-1"]);
    expect(getArmedCrossHostTargets()).toEqual([]);
    armCrossHostTarget({
      hostId: "studio-01",
      hostName: "studio-01",
      terminalId: "t1",
      title: "C",
    });
    useFleetArmingStore.getState().disarmId(crossHostTargetKey("studio-01", "t1"));
    expect(getArmedCrossHostTargets()).toEqual([]);
  });

  it("counts agents on other hosts as fleet members", () => {
    expect(selectFleetMemberCount(useFleetArmingStore.getState())).toBe(3);
    useFleetArmingStore.getState().disarmId("local-1");
    // Two agents on other hosts are a fleet of two with no pane here.
    expect(selectFleetMemberCount(useFleetArmingStore.getState())).toBe(2);
    expect(resolveFleetBroadcastTargetIds()).toEqual([
      crossHostTargetKey("studio-01", "t1"),
      crossHostTargetKey("studio-02", "t1"),
    ]);
  });

  it("sends a fleet made only of other hosts' agents from the fleet's own field", async () => {
    useFleetArmingStore.getState().disarmId("local-1");
    expect(await sendDraftToFleet("ship it")).toBe(true);
    expect(submitFleet.mock.calls.map(([p]) => p.hostId)).toEqual(["studio-01", "studio-02"]);
    expect(localSubmit).not.toHaveBeenCalled();
  });

  it("retries a submit whose outcome was never confirmed under the same opId", async () => {
    const key = crossHostTargetKey("studio-01", "t1");
    submitFleet.mockRejectedValueOnce(
      new Error("[AppError|OUTCOME_UNKNOWN] Couldn't confirm fleet submit")
    );
    await expect(submitCrossHostTarget(key, "go")).rejects.toBeTruthy();
    const first = submitFleet.mock.calls[0]![0].opId;
    await submitCrossHostTarget(key, "go", { retry: true });
    expect(submitFleet.mock.calls[1]![0].opId).toBe(first);
    // A fresh broadcast of the same words is a new submit, not a retry.
    await submitCrossHostTarget(key, "go");
    expect(submitFleet.mock.calls[2]![0].opId).not.toBe(first);
    // Confirmed once, the old opId is not reused.
    await submitCrossHostTarget(key, "go", { retry: true });
    expect(submitFleet.mock.calls[3]![0].opId).not.toBe(first);
  });

  it("does not reuse an opId after a refusal the host answered", async () => {
    const key = crossHostTargetKey("studio-01", "t1");
    submitFleet.mockRejectedValueOnce(new Error("[AppError|DRIVEN_ELSEWHERE] driven"));
    await expect(submitCrossHostTarget(key, "go")).rejects.toBeTruthy();
    await submitCrossHostTarget(key, "go", { retry: true });
    expect(submitFleet.mock.calls[1]![0].opId).not.toBe(submitFleet.mock.calls[0]![0].opId);
  });

  it("reuses the opId only while the host still holds the record, timed from the first send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const key = crossHostTargetKey("studio-01", "t1");
      const lost = () =>
        submitFleet.mockRejectedValueOnce(
          new Error("[AppError|OUTCOME_UNKNOWN] Couldn't confirm fleet submit")
        );
      lost();
      await expect(submitCrossHostTarget(key, "go")).rejects.toBeTruthy();
      const first = submitFleet.mock.calls[0]![0].opId;
      expect(crossHostSafeRetryDeadline(key, "go")).toBe(1_000_000 + FLEET_SAFE_RETRY_MS);

      // Inside the window: same opId, and a second lost answer keeps the first send's clock.
      vi.setSystemTime(1_000_000 + FLEET_SAFE_RETRY_MS - 1);
      lost();
      await expect(submitCrossHostTarget(key, "go", { retry: true })).rejects.toBeTruthy();
      expect(submitFleet.mock.calls[1]![0].opId).toBe(first);
      expect(crossHostSafeRetryDeadline(key, "go")).toBe(1_000_000 + FLEET_SAFE_RETRY_MS);

      // Past it: the outcome is unknown and a retry sends nothing on its own.
      vi.setSystemTime(1_000_000 + FLEET_SAFE_RETRY_MS);
      expect(needsCrossHostResendConfirmation(key, "go")).toBe(true);
      await expect(submitCrossHostTarget(key, "go", { retry: true })).rejects.toThrow(
        /needs confirmation/
      );
      expect(submitFleet).toHaveBeenCalledTimes(2);

      // Once the person confirms, it is a fresh send under a new opId.
      confirmCrossHostResend([key]);
      expect(needsCrossHostResendConfirmation(key, "go")).toBe(false);
      await submitCrossHostTarget(key, "go", { retry: true });
      expect(submitFleet).toHaveBeenCalledTimes(3);
      expect(submitFleet.mock.calls[2]![0].opId).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer unconfirmed submit's record when an older submit to the same target settles late", async () => {
    const key = crossHostTargetKey("studio-01", "t1");
    let releaseOld!: () => void;
    submitFleet.mockImplementationOnce(() => new Promise<void>((r) => (releaseOld = r)));
    const old = submitCrossHostTarget(key, "go");
    submitFleet.mockRejectedValueOnce(
      new Error("[AppError|OUTCOME_UNKNOWN] Couldn't confirm fleet submit")
    );
    await expect(submitCrossHostTarget(key, "go")).rejects.toBeTruthy();
    const newer = submitFleet.mock.calls[1]![0].opId;
    releaseOld();
    await old;
    await submitCrossHostTarget(key, "go", { retry: true });
    expect(submitFleet.mock.calls[2]![0].opId).toBe(newer);
  });
});
