// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFleetBroadcastResult, broadcastFleetRawInput } from "../fleetRawInputBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { PtyPanelData } from "@shared/types/panel";

const broadcastMock = vi.hoisted(() => vi.fn<(ids: string[], data: string) => void>());
const notifyUserInputMock = vi.hoisted(() => vi.fn<(id: string, data?: string) => void>());
const notifyEnterPressedMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const clearDirectingStateMock = vi.hoisted(() => vi.fn<(id: string) => void>());

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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    notifyUserInput: notifyUserInputMock,
    notifyEnterPressed: notifyEnterPressedMock,
    clearDirectingState: clearDirectingStateMock,
  },
}));

function makeTerminal(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

function seedPanels(terminals: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  const panelIds: string[] = [];
  for (const terminal of terminals) {
    panelsById[terminal.id] = terminal;
    panelIds.push(terminal.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function resetStores(): void {
  broadcastMock.mockReset();
  notifyUserInputMock.mockReset();
  notifyEnterPressedMock.mockReset();
  clearDirectingStateMock.mockReset();
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
  useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: false });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });
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

  it("silently drops dock terminals while broadcasting to live grid targets", () => {
    seedPanels([
      makeTerminal("grid-a"),
      makeTerminal("grid-b"),
      makeTerminal("docked", { location: "dock" }),
    ]);
    useFleetArmingStore.getState().armIds(["grid-a", "grid-b", "docked"]);

    expect(broadcastFleetRawInput("grid-a", "ls\r")).toBe(true);

    expect(broadcastMock).toHaveBeenCalledWith(["grid-a", "grid-b"], "ls\r");
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

  it("fires notifyUserInput on every non-origin target so directing shows fleet-wide (#7799)", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);

    expect(broadcastFleetRawInput("t1", "abc")).toBe(true);

    // Origin (t1) already gets directing from its own xterm onData listener,
    // so it must NOT be notified here or it would double-fire.
    const calls = notifyUserInputMock.mock.calls;
    const notifiedIds = calls.map(([id]) => id);
    expect(notifiedIds).not.toContain("t1");
    expect(notifiedIds.sort()).toEqual(["t2", "t3"]);
    // Raw payload is passed through (not "") so Phase 2 escalation still
    // engages for large pastes — see #3565.
    expect(calls.every(([, data]) => data === "abc")).toBe(true);
  });

  it("does not call notifyUserInput when the broadcast is rejected", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t2"]);

    expect(broadcastFleetRawInput("t1", "rejected")).toBe(false);
    expect(notifyUserInputMock).not.toHaveBeenCalled();
  });

  it("calls notifyEnterPressed on every target for a plain Enter submit (#8255)", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);

    expect(broadcastFleetRawInput("t1", "\r")).toBe(true);

    // Every target — origin included — gets notifyEnterPressed so the
    // synthetic `directing` state closes optimistically. The custom xterm
    // key handler bypasses the origin's own onEnterPressed listener path,
    // so the origin needs it explicitly here.
    const notifiedIds = notifyEnterPressedMock.mock.calls.map(([id]) => id).sort();
    expect(notifiedIds).toEqual(["t1", "t2", "t3"]);
  });

  it("does not call notifyEnterPressed for non-submit payloads", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    // Codex soft-newline (LF) — not a submit.
    broadcastFleetRawInput("t1", "\n");
    // Legacy ESC+CR — not a submit (alt-Enter soft newline).
    broadcastFleetRawInput("t1", "\x1b\r");
    // Multi-byte payload containing CR — not a single Enter keystroke.
    broadcastFleetRawInput("t1", "abc\r");
    // Plain text — not a submit.
    broadcastFleetRawInput("t1", "abc");

    expect(notifyEnterPressedMock).not.toHaveBeenCalled();
  });

  it("does not enter fleet scope on broadcast even when targets span worktrees (#8797)", () => {
    // Raw input broadcast must never rearrange the layout. Set up the exact
    // conditions that used to auto-enter fleet scope — cross-worktree targets,
    // scoped mode, hydrated — and assert the broadcast still goes out while
    // fleet scope stays inactive. The real worktree store is observed (not a
    // mock) so this guard catches scope entry via any path, not just a
    // verbatim revert. Fleet scope is now strictly opt-in via the
    // `fleet.scope.enter` action.
    seedPanels([
      makeTerminal("t1", { worktreeId: "wt-1" }),
      makeTerminal("t2", { worktreeId: "wt-2" }),
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: true });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });

    expect(broadcastFleetRawInput("t1", "ls\r")).toBe(true);

    // The write still goes out to every target...
    expect(broadcastMock).toHaveBeenCalledWith(["t1", "t2"], "ls\r");
    // ...but the layout is left untouched.
    expect(useWorktreeSelectionStore.getState().isFleetScopeActive).toBe(false);
  });

  it("performs the raw broadcast alongside notifyEnterPressed for plain Enter", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);

    expect(broadcastFleetRawInput("t1", "\r")).toBe(true);

    // The actual write still goes out — adding the notifyEnterPressed call
    // must not gate or short-circuit the broadcast.
    expect(broadcastMock).toHaveBeenCalledWith(["t1", "t2", "t3"], "\r");
    expect(notifyEnterPressedMock.mock.calls.map(([id]) => id).sort()).toEqual(["t1", "t2", "t3"]);
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

    // The synthetic directing state set by notifyUserInput needs to be
    // cleared for permanently-failed targets so the blue indicator doesn't
    // linger for the full 1.5s debounce window on a dead pipe.
    expect(clearDirectingStateMock).toHaveBeenCalledWith("t2");
  });

  it("records non-permanent failures without disarming the target", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    broadcastFleetRawInput("t1", "ls\r");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "EAGAIN", message: "would block" } },
      ],
    });

    const failure = useFleetFailureStore.getState();
    expect(Array.from(failure.failedIds)).toEqual(["t2"]);
    // Payload is intentionally null for raw-input failures — single
    // keystrokes aren't meaningful to retry, and `fleet.retryFailures`
    // guards on `payload == null` to skip the IPC write. An empty string
    // would slip past the loose-equality guard (#8705).
    expect(failure.payload).toBeNull();

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(true);

    expect(clearDirectingStateMock).not.toHaveBeenCalled();
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

  it.each(["ENOTCONN", "ENXIO", "EINVAL"])(
    "disarms the target on %s without recording a chip",
    (code) => {
      seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      broadcastFleetRawInput("t1", "x");

      applyFleetBroadcastResult({
        results: [
          { id: "t1", ok: true },
          { id: "t2", ok: false, error: { code, message: `write failure: ${code}` } },
        ],
      });

      const arming = useFleetArmingStore.getState();
      expect(arming.armedIds.has("t2")).toBe(false);
      expect(arming.armedIds.has("t1")).toBe(true);
      expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
      expect(clearDirectingStateMock).toHaveBeenCalledWith("t2");
    }
  );

  it("handles a mixed batch — disarm permanent, record non-permanent", () => {
    seedPanels([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3"), makeTerminal("t4")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3", "t4"]);
    broadcastFleetRawInput("t1", "x");

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "EPIPE", message: "broken pipe" } },
        { id: "t3", ok: false, error: { code: "EAGAIN", message: "would block" } },
        { id: "t4", ok: true },
      ],
    });

    const arming = useFleetArmingStore.getState();
    expect(arming.armedIds.has("t2")).toBe(false);
    expect(arming.armedIds.has("t3")).toBe(true);

    expect(Array.from(useFleetFailureStore.getState().failedIds)).toEqual(["t3"]);

    expect(clearDirectingStateMock).toHaveBeenCalledWith("t2");
    expect(clearDirectingStateMock).not.toHaveBeenCalledWith("t3");
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

  it("dismisses a prior failure when the next write to that target succeeds", () => {
    // Mirrors fleetEnterBroadcast's dismiss-on-success — a stale red dot
    // shouldn't linger after the user has visibly recovered the pane.
    seedPanels([makeTerminal("t1"), makeTerminal("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: false, error: { code: "ENOSPC", message: "no space" } },
      ],
    });
    expect(Array.from(useFleetFailureStore.getState().failedIds)).toEqual(["t2"]);

    applyFleetBroadcastResult({
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: true },
      ],
    });
    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
  });
});
