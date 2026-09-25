// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
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
  crossHostTargetKey,
  getArmedCrossHostTargets,
  retainCrossHostTargetsFor,
} from "../crossHostFleet";

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
  vi.fn<(payload: { hostId: string; terminalId: string; text: string }) => Promise<void>>();

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
    });
    expect(submitFleet).toHaveBeenCalledWith({
      hostId: "studio-02",
      terminalId: "t1",
      text: "ship it",
    });
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
    });
  });
});
