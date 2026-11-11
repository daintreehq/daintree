import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopySnapshot } from "../../../../shared/types/ipc/canopy.js";

const state = vi.hoisted(() => ({
  mode: "on" as string,
  observers: new Set<(snapshot: CanopySnapshot) => void>(),
}));
const windowMock = vi.hoisted(() => ({
  openCanopyWindow: vi.fn(),
  focusCanopyWindow: vi.fn(() => false),
  focusLastProjectWindow: vi.fn(() => false),
  hasCanopyWindowOpenedThisSession: vi.fn(() => false),
  isCanopyWindowView: vi.fn((id: number) => id === CANOPY_VIEW_ID),
}));
const goToCanopyRun = vi.hoisted(() => vi.fn(async () => {}));
const openCanopyAssistantLane = vi.hoisted(() => vi.fn(async () => {}));
const showCanopyGlobalAssistant = vi.hoisted(() => vi.fn());
const assistants = vi.hoisted(() => ({
  resolveAssistantDestination: vi.fn(async (_subject: unknown): Promise<unknown> => null),
  isAssistantLaneAttached: vi.fn(async (_projectId: string, _lane: number) => true),
}));
const CANOPY_VIEW_ID = vi.hoisted(() => 7);
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel),
  },
  BrowserWindow: class {},
}));
vi.mock("../../../services/canopy/canopyMode.js", () => ({ readCanopyMode: () => state.mode }));
vi.mock("../../../window/canopyWindow.js", () => windowMock);
vi.mock("../../../window/canopyGoToRun.js", () => ({
  goToCanopyRun,
  openCanopyAssistantLane,
  showCanopyGlobalAssistant,
}));
vi.mock("../canopy.js", () => ({
  ...assistants,
  observeCanopySnapshots: (observer: (snapshot: CanopySnapshot) => void) => {
    state.observers.add(observer);
    return () => state.observers.delete(observer);
  },
}));

import { AppError } from "../../../utils/errorTypes.js";
import { registerCanopyWindowHandlers, restoreCanopyWindow } from "../canopyWindow.js";
import { CANOPY_WINDOW_METHOD_CHANNELS } from "../canopyWindow.preload.js";

registerCanopyWindowHandlers();

function invoke(channel: string, ...args: unknown[]) {
  return ipcHandlers.get(channel)!({ sender: { id: 1 } }, ...args);
}

function invokeFrom(senderId: number, channel: string, ...args: unknown[]) {
  return ipcHandlers.get(channel)!({ sender: { id: senderId } }, ...args);
}

/** Handlers answer `{ ok, data }` or `{ ok: false, error }` envelopes. */
async function refused(promise: unknown): Promise<boolean> {
  try {
    const result = (await promise) as { ok?: boolean };
    return result?.ok === false;
  } catch {
    return true;
  }
}

beforeEach(() => {
  state.mode = "on";
  state.observers.clear();
  windowMock.openCanopyWindow.mockReset();
  windowMock.focusCanopyWindow.mockReset();
  windowMock.hasCanopyWindowOpenedThisSession.mockReset();
  windowMock.hasCanopyWindowOpenedThisSession.mockReturnValue(false);
  goToCanopyRun.mockReset();
  goToCanopyRun.mockResolvedValue(undefined);
});

describe("the Canopy window's IPC", () => {
  it("opens the window while Canopy is on", async () => {
    await invoke(CANOPY_WINDOW_METHOD_CHANNELS.open);
    expect(windowMock.openCanopyWindow).toHaveBeenCalledTimes(1);
  });

  it.each(["unset", "hidden"])("refuses to open it with Canopy %s", async (mode) => {
    state.mode = mode;
    expect(await refused(invoke(CANOPY_WINDOW_METHOD_CHANNELS.open))).toBe(true);
    expect(windowMock.openCanopyWindow).not.toHaveBeenCalled();
  });

  it("closes the window once a snapshot says Canopy stopped being on, and not before", async () => {
    await invoke(CANOPY_WINDOW_METHOD_CHANNELS.open);
    const watchMode = windowMock.openCanopyWindow.mock.calls[0]![0] as (
      close: () => void
    ) => () => void;
    const close = vi.fn();
    const stop = watchMode(close);

    const publish = (mode: string) => {
      for (const observer of state.observers) observer({ mode } as CanopySnapshot);
    };
    publish("on");
    expect(close).not.toHaveBeenCalled();
    publish("hidden");
    expect(close).toHaveBeenCalledTimes(1);

    stop();
    expect(state.observers.size).toBe(0);
  });

  it("says whether there was a window to bring forward", async () => {
    windowMock.focusCanopyWindow.mockReturnValue(true);
    const answer = (await invoke(CANOPY_WINDOW_METHOD_CHANNELS.focus)) as { data?: boolean };
    expect(answer?.data ?? answer).toBe(true);
  });
});

describe("back to a project window from the Canopy window (#16578)", () => {
  beforeEach(() => windowMock.focusLastProjectWindow.mockReset());

  it.each([true, false])(
    "brings the last project window forward when the Canopy window asks, answering %s",
    async (found) => {
      windowMock.focusLastProjectWindow.mockReturnValue(found);

      const answer = (await invokeFrom(
        CANOPY_VIEW_ID,
        CANOPY_WINDOW_METHOD_CHANNELS.focusLastProjectWindow
      )) as { data?: boolean };

      expect(windowMock.focusLastProjectWindow).toHaveBeenCalledTimes(1);
      expect(answer?.data ?? answer).toBe(found);
    }
  );

  it("refuses a project view, which is already in a project window", async () => {
    expect(await refused(invokeFrom(3, CANOPY_WINDOW_METHOD_CHANNELS.focusLastProjectWindow))).toBe(
      true
    );
    expect(windowMock.focusLastProjectWindow).not.toHaveBeenCalled();
  });
});

describe("Go to pane from the Canopy window (#16337)", () => {
  const target = { workspaceId: "a".repeat(64), runId: "agent-1" };

  it("goes to the run when the Canopy window asks", async () => {
    expect(
      await refused(invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.goToRun, target))
    ).toBe(false);
    expect(goToCanopyRun).toHaveBeenCalledWith(target);
  });

  it("refuses any other view, which moves itself to a run instead", async () => {
    expect(await refused(invokeFrom(3, CANOPY_WINDOW_METHOD_CHANNELS.goToRun, target))).toBe(true);
    expect(goToCanopyRun).not.toHaveBeenCalled();
  });

  it.each([
    ["no run", { workspaceId: "w" }],
    ["an empty workspace", { workspaceId: "", runId: "r" }],
    ["nothing", undefined],
  ])("refuses a request with %s", async (_label, payload) => {
    expect(
      await refused(invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.goToRun, payload))
    ).toBe(true);
    expect(goToCanopyRun).not.toHaveBeenCalled();
  });

  it("passes on why a run couldn't be reached, in the words its toast shows", async () => {
    goToCanopyRun.mockRejectedValue(
      new AppError({
        code: "NOT_FOUND",
        message: "The run's workspace no longer exists",
        userMessage: "Its project or scratch has been removed.",
      })
    );
    const answer = invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.goToRun, target);

    await expect(answer).rejects.toMatchObject({
      code: "NOT_FOUND",
      userMessage: "Its project or scratch has been removed.",
    });
  });
});

describe("Open in Assistant from the Canopy window (#16758)", () => {
  const subject = {
    hostId: "local",
    scope: { kind: "project" as const, projectId: "project-a" },
    terminalId: "assistant-1",
    incarnation: 2,
    lane: 1,
  };
  const lane = {
    scope: "project",
    hostId: "local",
    projectId: "project-a",
    lane: 1,
    terminalId: "assistant-1",
    incarnation: 2,
  };
  const open = (payload: unknown, sender = CANOPY_VIEW_ID) =>
    invokeFrom(sender, CANOPY_WINDOW_METHOD_CHANNELS.openAssistant, payload);

  beforeEach(() => {
    openCanopyAssistantLane.mockReset();
    openCanopyAssistantLane.mockResolvedValue(undefined);
    showCanopyGlobalAssistant.mockReset();
    assistants.resolveAssistantDestination.mockReset();
    assistants.resolveAssistantDestination.mockResolvedValue(lane);
    assistants.isAssistantLaneAttached.mockReset();
    assistants.isAssistantLaneAttached.mockResolvedValue(true);
  });

  const answer = (payload: unknown) => open(payload);

  it("lands a running, held lane in the project main found it in", async () => {
    expect(await answer(subject)).toBeNull();
    expect(assistants.isAssistantLaneAttached).toHaveBeenCalledWith("project-a", 1);
    expect(openCanopyAssistantLane).toHaveBeenCalledWith("project-a", subject);
  });

  it("goes by the project main resolved, not the one the subject names", async () => {
    assistants.resolveAssistantDestination.mockResolvedValue({ ...lane, projectId: "project-b" });
    await answer(subject);
    expect(openCanopyAssistantLane).toHaveBeenCalledWith("project-b", subject);
  });

  it("moves nothing for a session that ended", async () => {
    assistants.resolveAssistantDestination.mockResolvedValue(null);
    expect(await answer(subject)).toBe("ended");
    expect(openCanopyAssistantLane).not.toHaveBeenCalled();
    expect(showCanopyGlobalAssistant).not.toHaveBeenCalled();
  });

  it("moves nothing for a lane no view holds", async () => {
    assistants.isAssistantLaneAttached.mockResolvedValue(false);
    expect(await answer(subject)).toBe("not-attached");
    expect(openCanopyAssistantLane).not.toHaveBeenCalled();
  });

  it("shows the global session in a window on this machine", async () => {
    const global = { hostId: "local", scope: { kind: "global" }, terminalId: "g", incarnation: 1 };
    assistants.resolveAssistantDestination.mockResolvedValue({
      scope: "global",
      hostId: "local",
      terminalId: "g",
      incarnation: 1,
    });
    expect(await answer(global)).toBeNull();
    expect(showCanopyGlobalAssistant).toHaveBeenCalledWith(global);
    expect(assistants.isAssistantLaneAttached).not.toHaveBeenCalled();
    expect(openCanopyAssistantLane).not.toHaveBeenCalled();
  });

  it("passes on why its window didn't come forward", async () => {
    openCanopyAssistantLane.mockRejectedValue(
      new AppError({
        code: "PROJECT_OPEN_FAILED",
        message: "No window opened",
        userMessage: "A window for its project didn't open.",
      })
    );
    await expect(open(subject)).rejects.toMatchObject({
      code: "PROJECT_OPEN_FAILED",
      userMessage: "A window for its project didn't open.",
    });
  });

  it("refuses any view but the Canopy window's", async () => {
    expect(await refused(open(subject, 3))).toBe(true);
    expect(assistants.resolveAssistantDestination).not.toHaveBeenCalled();
  });

  it.each([
    ["another host's assistant", { ...subject, hostId: "studio" }],
    ["a malformed subject", { ...subject, terminalId: "" }],
    ["nothing", undefined],
  ])("refuses %s without resolving it", async (_label, payload) => {
    expect(await refused(open(payload))).toBe(true);
    expect(assistants.resolveAssistantDestination).not.toHaveBeenCalled();
    expect(openCanopyAssistantLane).not.toHaveBeenCalled();
  });
});

describe("restoring the Canopy window at launch (#16336)", () => {
  it("opens it behind the focused window while Canopy is on", () => {
    expect(restoreCanopyWindow()).toBe(true);
    expect(windowMock.openCanopyWindow).toHaveBeenCalledTimes(1);
    expect(windowMock.openCanopyWindow.mock.calls[0]?.[1]).toEqual({ revealMode: "showInactive" });
  });

  it("closes what it restored once Canopy stops being on", () => {
    restoreCanopyWindow();
    const watch = windowMock.openCanopyWindow.mock.calls[0]?.[0] as (
      close: () => void
    ) => () => void;
    const close = vi.fn();
    const stop = watch(close);

    for (const observer of state.observers) observer({ mode: "on" } as CanopySnapshot);
    expect(close).not.toHaveBeenCalled();
    for (const observer of state.observers) observer({ mode: "hidden" } as CanopySnapshot);
    expect(close).toHaveBeenCalledTimes(1);

    stop();
    expect(state.observers.size).toBe(0);
  });

  it.each(["unset", "hidden"])("opens nothing with Canopy %s", (mode) => {
    state.mode = mode;
    expect(restoreCanopyWindow()).toBe(false);
    expect(windowMock.openCanopyWindow).not.toHaveBeenCalled();
  });

  it("opens nothing once a Canopy window has stood this session", () => {
    windowMock.hasCanopyWindowOpenedThisSession.mockReturnValue(true);
    expect(restoreCanopyWindow()).toBe(false);
    expect(windowMock.openCanopyWindow).not.toHaveBeenCalled();
  });
});
