// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFleetBroadcastResult, broadcastFleetRawInput } from "../fleetRawInputBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalInstance } from "@shared/types";

const broadcastMock = vi.hoisted(() => vi.fn<(ids: string[], data: string) => void>());

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      broadcast: broadcastMock,
    },
  };
});

function makeTerminal(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const terminal of terminals) {
    panelsById[terminal.id] = terminal;
    panelIds.push(terminal.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function resetStores(): void {
  broadcastMock.mockReset();
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    broadcastSignal: 0,
    previewArmedIds: new Set<string>(),
  });
  useFleetFailureStore.getState().clear();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

describe("broadcastFleetRawInput", () => {
  beforeEach(() => {
    resetStores();
  });

  it("broadcasts direct raw input to every armed live terminal", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
    useFleetArmingStore.getState().armIds(["t2", "t1", "t3"]);

    expect(broadcastFleetRawInput("t1", "npm test\r")).toBe(true);

    expect(broadcastMock).toHaveBeenCalledWith(["t2", "t1", "t3"], "npm test\r");
  });

  it("works for normal terminals without agent identity", () => {
    seedPanels([makeTerminal("shell-a"), makeTerminal("shell-b")]);
    useFleetArmingStore.getState().armIds(["shell-a", "shell-b"]);

    expect(broadcastFleetRawInput("shell-a", "\u0003")).toBe(true);

    expect(broadcastMock).toHaveBeenCalledWith(["shell-a", "shell-b"], "\u0003");
  });

  it("returns false when the origin is not armed", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t2"]);

    expect(broadcastFleetRawInput("t1", "local-only")).toBe(false);

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("returns false when live eligibility leaves fewer than two targets", () => {
    seedPanels([
      makeTerminal("t1"),
      makeTerminal("trashed", { location: "trash" }),
      makeTerminal("no-pty", { hasPty: false }),
      makeTerminal("docked", { location: "dock" }),
    ]);
    useFleetArmingStore.getState().armIds(["t1", "trashed", "no-pty", "docked"]);

    expect(broadcastFleetRawInput("t1", "still-local")).toBe(false);

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("returns false for empty raw input", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    expect(broadcastFleetRawInput("t1", "")).toBe(false);

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("increments broadcastSignal once per accepted broadcast", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    expect(useFleetArmingStore.getState().broadcastSignal).toBe(0);
    broadcastFleetRawInput("t1", "a");
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(1);
    broadcastFleetRawInput("t1", "b");
    broadcastFleetRawInput("t1", "c");
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(3);
  });

  it("does not increment broadcastSignal when origin is not armed", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t2"]);

    broadcastFleetRawInput("t1", "rejected");
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(0);
  });

  it("does not increment broadcastSignal on empty input", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    broadcastFleetRawInput("t1", "");
    expect(useFleetArmingStore.getState().broadcastSignal).toBe(0);
  });
});

describe("applyFleetBroadcastResult", () => {
  beforeEach(() => {
    resetStores();
  });

  it("disarms the target on a dead-pipe error and leaves peers armed", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);
    broadcastFleetRawInput("t1", "echo hi\r");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "EIO", message: "dead pty" } },
        { id: "t3", ok: true },
      ],
    });

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(false);
    expect(arming.armedIds.has("t1")).toBe(true);
    expect(arming.armedIds.has("t3")).toBe(true);

    // The fleetFailureStore subscription auto-clears records for unarmed
    // targets, so a dead-pipe target should not surface a chip.
    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
  });

  it("records non-permanent failures without disarming the target", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    broadcastFleetRawInput("t1", "ls\r");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "ENOSPC", message: "no space" } },
      ],
    });

    const failure = useFleetFailureStore.getState();
    expect(Array.from(failure.failedIds)).toEqual(["t2"]);
    // Payload is intentionally empty for raw-input failures — single
    // keystrokes aren't meaningful to retry, and the `Retry failed` action
    // checks for a non-null payload before firing.
    expect(failure.payload).toBe("");

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(true);
  });

  it("treats failures with no errno code as permanent (defensive default)", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    broadcastFleetRawInput("t1", "x");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { message: "unknown write error" } },
      ],
    });

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(false);
    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
  });

  it("handles a mixed batch — disarm permanent, record non-permanent", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3"), makeTerminal("t4")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3", "t4"]);
    broadcastFleetRawInput("t1", "x");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "EPIPE", message: "broken pipe" } },
        { id: "t3", ok: false, error: { code: "ENOSPC", message: "no space" } },
        { id: "t4", ok: true },
      ],
    });

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(false);
    expect(arming.armedIds.has("t3")).toBe(true);

    expect(Array.from(useFleetFailureStore.getState().failedIds)).toEqual(["t3"]);
  });

  it("does nothing when every target succeeded", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: true },
      ],
    });

    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
  });
});
