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
const panel = vi.hoisted(() => ({
  ensureSlot: vi.fn(),
  setActiveSlot: vi.fn(),
  setOpen: vi.fn(),
  requestFocus: vi.fn(),
}));
const switchProject = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => view.workspaceId }));
vi.mock("@/store/helpPanelStore", () => ({ useHelpPanelStore: { getState: () => panel } }));
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
    view.workspaceId = "p1";
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

  it("activates the exact lane in place when its project is this view's", async () => {
    view.workspaceId = "p2";
    canopy.resolveAssistant.mockResolvedValue(destination);
    expect(await openInAssistant(subject)).toEqual({ ok: true });
    expect(switchProject).not.toHaveBeenCalled();
    expect(panel.ensureSlot).toHaveBeenCalledWith(2);
    expect(panel.setActiveSlot).toHaveBeenCalledWith(2);
    expect(panel.setOpen).toHaveBeenCalledWith(true);
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
