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

describe("assistant subject adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    view.workspaceId = "p1";
    panel.sessions = {};
    panel.listeners.clear();
    Object.assign(window, { electron: { canopy } });
  });

  it("watches by the exact subject, never by terminal id", async () => {
    const api = assistantTerminalApi(subject);
    await api.watchTerminal("t1", { spawnedAt: 1 });
    expect(canopy.watchAssistantTerminal).toHaveBeenCalledWith(subject);
    expect(canopy.watchTerminal).not.toHaveBeenCalled();
    await expect(api.answer("t1", { spawnedAt: 1 }, "Yes")).rejects.toThrow();
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
});
