// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const canopy = vi.hoisted(() => ({
  resolveAssistant: vi.fn(),
  watchAssistantTerminal: vi.fn(async () => ({ watchId: 9, snapshot: null })),
  watchTerminal: vi.fn(),
  unwatchTerminal: vi.fn(),
  terminalInput: vi.fn(),
  terminalResize: vi.fn(),
  terminalSubmit: vi.fn(),
  terminalSendKey: vi.fn(),
  onTerminalData: vi.fn(() => () => {}),
}));
const view = vi.hoisted(() => ({ workspaceId: "p1" as string | null }));
const panel = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>();
  const store = {
    sessions: {} as Record<number, { terminalId: string | null }>,
    ensureSlot: vi.fn(),
    setActiveSlot: vi.fn(),
    selectGlobal: vi.fn(),
    setOpen: vi.fn(),
    requestFocus: vi.fn(),
    listeners,
    /** The view takes a lane over, as its own adoption does. */
    bind(lane: number, terminalId: string) {
      store.sessions = { ...store.sessions, [lane]: { terminalId } };
      for (const listener of [...listeners]) listener(store);
    },
  };
  return store;
});
const switchProject = vi.hoisted(() => vi.fn(async () => {}));
const viewHost = vi.hoisted(() => ({ id: null as string | null }));
const hostEvents = vi.hoisted(() => new Set<(event: unknown) => void>());
const canopyHost = vi.hoisted(() => ({
  watchAssistant: vi.fn(async (_consumer: string, _subject: unknown) => ({
    watchId: 4,
    snapshot: null,
  })),
  resolveAssistant: vi.fn(),
  assistantInvoke: vi.fn(async () => undefined),
  releaseAssistant: vi.fn(async () => {}),
  onEvent: vi.fn((callback: (event: unknown) => void) => {
    hostEvents.add(callback);
    return () => hostEvents.delete(callback);
  }),
}));
const remoteHosts = vi.hoisted(() => ({
  switchWindowHost: vi.fn(
    async (
      _payload: unknown
    ): Promise<{ outcome: string; hostId: string; projectId?: string }> => ({
      outcome: "switched",
      hostId: "studio",
      projectId: "p2",
    })
  ),
}));

vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => viewHost.id }));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => view.workspaceId }));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => panel,
    subscribe: (listener: (state: unknown) => void) => {
      panel.listeners.add(listener);
      return () => panel.listeners.delete(listener);
    },
  },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ switchProject }) },
}));

import { activateAssistantLane, assistantTerminalApi, openInAssistant } from "../assistantSubject";

const subject = {
  hostId: "local",
  scope: { kind: "project" as const, projectId: "p2" },
  terminalId: "t1",
  incarnation: 3,
  lane: 2,
};
const destination = {
  scope: "project" as const,
  hostId: "local",
  projectId: "p2",
  lane: 2,
  terminalId: "t1",
  incarnation: 3,
};

const globalSubject = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "g1",
  incarnation: 2,
};

describe("assistant subject adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    view.workspaceId = "p1";
    panel.sessions = {};
    panel.listeners.clear();
    viewHost.id = null;
    hostEvents.clear();
    Object.assign(window, { electron: { canopy, canopyHost, remoteHosts } });
  });

  it("watches by the exact subject, never by terminal id", async () => {
    const api = assistantTerminalApi(subject);
    await api.watchTerminal("t1", { spawnedAt: 1 });
    expect(canopy.watchAssistantTerminal).toHaveBeenCalledWith(subject);
    expect(canopy.watchTerminal).not.toHaveBeenCalled();
    await expect(api.answer("t1", { spawnedAt: 1 }, "Yes")).rejects.toThrow();
  });

  it("types to the global session only under the input stamp it was opened with", async () => {
    const stamp = { attachmentId: "a1", inputEpoch: 4 };
    await assistantTerminalApi(globalSubject, stamp).watchTerminal("g1", { spawnedAt: 2 });
    expect(canopy.watchAssistantTerminal).toHaveBeenLastCalledWith(globalSubject, stamp);
    await assistantTerminalApi(globalSubject).watchTerminal("g1", { spawnedAt: 2 });
    expect(canopy.watchAssistantTerminal).toHaveBeenLastCalledWith(globalSubject);
  });

  describe("the global session", () => {
    const globalDestination = {
      scope: "global" as const,
      hostId: "local",
      terminalId: "g1",
      incarnation: 2,
    };

    it("opens in this view's Assistant panel, pinned to the exact run, moving nothing", async () => {
      canopy.resolveAssistant.mockResolvedValue(globalDestination);
      expect(await openInAssistant(globalSubject)).toEqual({ ok: true });
      expect(panel.selectGlobal).toHaveBeenCalledWith(globalSubject);
      expect(panel.setOpen).toHaveBeenCalledWith(true);
      expect(panel.requestFocus).toHaveBeenCalled();
      expect(switchProject).not.toHaveBeenCalled();
      expect(remoteHosts.switchWindowHost).not.toHaveBeenCalled();
      expect(panel.setActiveSlot).not.toHaveBeenCalled();
    });

    it("selects nothing for a run that ended, so its successor is never shown in its place", async () => {
      canopy.resolveAssistant.mockResolvedValue(null);
      expect(await openInAssistant(globalSubject)).toEqual({ ok: false, reason: "ended" });
      expect(panel.selectGlobal).not.toHaveBeenCalled();
      expect(panel.setOpen).not.toHaveBeenCalled();
    });

    it("refuses another machine's global session, which a window here can't hold", async () => {
      canopyHost.resolveAssistant.mockResolvedValue({ ...globalDestination, hostId: "studio" });
      expect(await openInAssistant({ ...globalSubject, hostId: "studio" })).toEqual({
        ok: false,
        reason: "unsupported",
      });
      expect(panel.selectGlobal).not.toHaveBeenCalled();
    });
  });

  it("moves to another project only on Open, carrying the exact subject", async () => {
    canopy.resolveAssistant.mockResolvedValue(destination);
    expect(await openInAssistant(subject)).toEqual({ ok: true });
    expect(switchProject).toHaveBeenCalledWith("p2", {
      focusIntent: { intent: "open-assistant", subject },
    });
    // Nothing is shown here: the incoming view activates the lane.
    expect(panel.setActiveSlot).not.toHaveBeenCalled();
  });

  it("activates the exact lane in place when this view shows its terminal", async () => {
    view.workspaceId = "p2";
    panel.sessions = { 0: { terminalId: "t0" }, 2: { terminalId: "t1" } };
    canopy.resolveAssistant.mockResolvedValue(destination);
    expect(await openInAssistant(subject)).toEqual({ ok: true });
    expect(switchProject).not.toHaveBeenCalled();
    expect(panel.setActiveSlot).toHaveBeenCalledWith(2);
    expect(panel.setOpen).toHaveBeenCalledWith(true);
    expect(panel.ensureSlot).not.toHaveBeenCalled();
  });

  it("waits for the arriving view to take the lane over, then shows it", async () => {
    view.workspaceId = "p2";
    canopy.resolveAssistant.mockResolvedValue(destination);
    const pending = activateAssistantLane(subject);
    await vi.waitFor(() => expect(panel.listeners.size).toBe(1));
    expect(panel.setOpen).not.toHaveBeenCalled();
    panel.bind(2, "t1");
    expect(await pending).toEqual({ ok: true });
    expect(panel.setActiveSlot).toHaveBeenCalledWith(2);
    expect(panel.listeners.size).toBe(0);
  });

  it("never opens an empty lane, where the panel could launch another session", async () => {
    vi.useFakeTimers();
    view.workspaceId = "p2";
    // Another terminal in the lane is a different session, not the one chosen.
    panel.sessions = { 2: { terminalId: "t-successor" } };
    canopy.resolveAssistant.mockResolvedValue(destination);
    const pending = activateAssistantLane(subject);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toEqual({ ok: false, reason: "not-attached" });
    expect(panel.ensureSlot).not.toHaveBeenCalled();
    expect(panel.setActiveSlot).not.toHaveBeenCalled();
    expect(panel.setOpen).not.toHaveBeenCalled();
    expect(panel.listeners.size).toBe(0);
  });

  it("refuses a session that ended while the view was taking the lane over", async () => {
    view.workspaceId = "p2";
    canopy.resolveAssistant.mockResolvedValueOnce(destination).mockResolvedValueOnce(null);
    const pending = activateAssistantLane(subject);
    await vi.waitFor(() => expect(panel.listeners.size).toBe(1));
    panel.bind(2, "t1");
    expect(await pending).toEqual({ ok: false, reason: "ended" });
    expect(panel.setOpen).not.toHaveBeenCalled();
  });

  it("opens nothing for an ended session, before or after the switch", async () => {
    canopy.resolveAssistant.mockResolvedValue(null);
    expect(await openInAssistant(subject)).toEqual({ ok: false, reason: "ended" });
    view.workspaceId = "p2";
    expect(await activateAssistantLane(subject)).toEqual({ ok: false, reason: "ended" });
    expect(switchProject).not.toHaveBeenCalled();
    expect(panel.ensureSlot).not.toHaveBeenCalled();
    expect(panel.setOpen).not.toHaveBeenCalled();
  });

  it("refuses a lane that arrived in a view of another project", async () => {
    view.workspaceId = "p1";
    canopy.resolveAssistant.mockResolvedValue(destination);
    expect(await activateAssistantLane(subject)).toEqual({ ok: false, reason: "ended" });
    expect(panel.setActiveSlot).not.toHaveBeenCalled();
  });

  describe("an assistant on another host (#14163)", () => {
    const remote = { ...subject, hostId: "studio" };

    it("reads it through its own viewer, never sizing it, and lets the viewer go", async () => {
      const api = assistantTerminalApi(remote);
      expect(api.holdsSize).toBe(false);
      await api.watchTerminal("t1", { spawnedAt: 1 });
      const consumer = canopyHost.watchAssistant.mock.calls[0]![0];
      expect(canopyHost.watchAssistant).toHaveBeenCalledWith(consumer, remote);
      await api.terminalSubmit(4, "carry on");
      expect(canopyHost.assistantInvoke).toHaveBeenCalledWith(consumer, "canopy:terminal-submit", [
        4,
        "carry on",
      ]);
      await api.terminalResize(4, 80, 24);
      expect(canopyHost.assistantInvoke).toHaveBeenCalledTimes(1);
      expect(canopy.watchAssistantTerminal).not.toHaveBeenCalled();
      api.dispose();
      expect(canopyHost.releaseAssistant).toHaveBeenCalledWith(consumer);
    });

    it("hears only its own consumer's bytes and resyncs", async () => {
      const api = assistantTerminalApi(remote);
      const other = assistantTerminalApi(remote);
      await api.watchTerminal("t1", { spawnedAt: 1 });
      await other.watchTerminal("t1", { spawnedAt: 1 });
      const [mine, theirs] = canopyHost.watchAssistant.mock.calls.map(([consumer]) => consumer);
      const data = vi.fn();
      const resync = vi.fn();
      api.onTerminalData(data);
      api.onResync(resync);
      const chunk = { kind: "data", watchId: 4 };
      for (const callback of [...hostEvents]) {
        callback({ kind: "assistant-terminal-data", hostId: "studio", consumer: theirs, chunk });
        callback({ kind: "assistant-terminal-data", hostId: "studio", consumer: mine, chunk });
        callback({ kind: "terminal-data", hostId: "studio", chunk });
        callback({ kind: "assistant-resync", hostId: "studio", consumer: mine });
      }
      expect(data.mock.calls).toEqual([[chunk]]);
      expect(resync).toHaveBeenCalledTimes(1);
    });

    it("reads This Mac's assistant through a viewer from a window bound elsewhere", async () => {
      viewHost.id = "studio";
      const api = assistantTerminalApi(subject);
      await api.watchTerminal("t1", { spawnedAt: 1 });
      expect(canopy.watchAssistantTerminal).not.toHaveBeenCalled();
      expect(canopyHost.watchAssistant).toHaveBeenCalled();
    });

    it("opens it by moving this window to its host, carrying the exact subject", async () => {
      canopyHost.resolveAssistant.mockResolvedValue({ ...destination, hostId: "studio" });
      expect(await openInAssistant(remote)).toEqual({ ok: true });
      expect(remoteHosts.switchWindowHost).toHaveBeenCalledWith({
        hostId: "studio",
        newWindow: false,
        projectId: "p2",
        focusIntent: { intent: "open-assistant", subject: remote },
      });
      expect(switchProject).not.toHaveBeenCalled();
      // The lookup's own viewer goes once it has answered.
      expect(canopyHost.releaseAssistant).toHaveBeenCalledTimes(1);
    });

    it("says so when the window didn't move, or the session ended", async () => {
      canopyHost.resolveAssistant.mockResolvedValueOnce({ ...destination, hostId: "studio" });
      remoteHosts.switchWindowHost.mockResolvedValueOnce({
        outcome: "superseded",
        hostId: "studio",
      });
      expect(await openInAssistant(remote)).toEqual({ ok: false, reason: "not-switched" });
      canopyHost.resolveAssistant.mockResolvedValueOnce(null);
      expect(await openInAssistant(remote)).toEqual({ ok: false, reason: "ended" });
    });

    it("shows the lane once this window, now on that host, holds it", async () => {
      viewHost.id = "studio";
      view.workspaceId = "p2";
      panel.sessions = { 2: { terminalId: "t1" } };
      canopyHost.resolveAssistant.mockResolvedValue({ ...destination, hostId: "studio" });
      expect(await activateAssistantLane(remote)).toEqual({ ok: true });
      expect(panel.setActiveSlot).toHaveBeenCalledWith(2);
      expect(canopy.resolveAssistant).not.toHaveBeenCalled();
    });
  });
});
