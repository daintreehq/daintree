import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopySnapshot } from "../../../../shared/types/ipc/canopy.js";

const state = vi.hoisted(() => ({
  mode: "on" as string,
  observers: new Set<(snapshot: CanopySnapshot) => void>(),
}));
const windowMock = vi.hoisted(() => ({
  openCanopyWindow: vi.fn(),
  focusCanopyWindow: vi.fn(() => false),
  hasCanopyWindowOpenedThisSession: vi.fn(() => false),
  isCanopyWindowView: vi.fn((id: number) => id === CANOPY_VIEW_ID),
  popOutToCanopyWindow: vi.fn(async (_popOut: unknown, _watch: unknown) => {}),
  peekPendingPopOut: vi.fn((): unknown => null),
  acknowledgePopOut: vi.fn((_id: number) => true),
}));
const broadcastToLocalViews = vi.hoisted(() => vi.fn());
const goToCanopyRun = vi.hoisted(() => vi.fn(async () => {}));
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
vi.mock("../../../window/canopyGoToRun.js", () => ({ goToCanopyRun }));
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  typedBroadcastToLocalViews: broadcastToLocalViews,
}));
vi.mock("../canopy.js", () => ({
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
  windowMock.popOutToCanopyWindow.mockReset();
  windowMock.popOutToCanopyWindow.mockResolvedValue(undefined);
  windowMock.peekPendingPopOut.mockReset();
  windowMock.peekPendingPopOut.mockReturnValue(null);
  windowMock.acknowledgePopOut.mockReset();
  windowMock.acknowledgePopOut.mockReturnValue(true);
  broadcastToLocalViews.mockReset();
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

describe("popping a dialog out into the Canopy window (#16338)", () => {
  const PROJECT_VIEW_ID = 3;
  const place = {
    hostId: "local",
    query: "deploy",
    selection: { kind: "assistant", assistantId: "assistant-1" },
    roleFilter: "assistants",
    unreadOnly: false,
    keptUnread: [],
    archivedExpanded: false,
    trashExpanded: true,
    workOf: { assistantId: "assistant-1", name: "Planner" },
  };

  it("hands the place to the window, and only once it has it closes every view's dialog", async () => {
    let taken!: () => void;
    windowMock.popOutToCanopyWindow.mockImplementationOnce(
      () => new Promise<void>((resolve) => (taken = resolve))
    );
    let answered = false;
    const answer = Promise.resolve(
      invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, place)
    ).then((result) => {
      answered = true;
      return result;
    });
    await vi.waitFor(() => expect(windowMock.popOutToCanopyWindow).toHaveBeenCalledTimes(1));

    expect(windowMock.popOutToCanopyWindow).toHaveBeenCalledWith(place, expect.any(Function));
    expect(broadcastToLocalViews).not.toHaveBeenCalled();
    expect(answered).toBe(false);

    taken();
    expect(await refused(answer)).toBe(false);
    // The asking view too: a reload since may have opened a dialog its first page can't close.
    expect(broadcastToLocalViews).toHaveBeenCalledWith("canopy-window:popped-out", undefined);
  });

  it("takes a search as long as a pasted list", async () => {
    const query = Array.from({ length: 2_000 }, (_, i) => `term-${i}`).join(", ");
    expect(
      await refused(
        invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, { ...place, query })
      )
    ).toBe(false);
  });

  it("closes no dialog anywhere when the window didn't take it", async () => {
    windowMock.popOutToCanopyWindow.mockRejectedValue(
      new AppError({ code: "CANCELLED", message: "closed", userMessage: "Its window closed." })
    );

    await expect(
      invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, place)
    ).rejects.toMatchObject({ userMessage: "Its window closed." });
    expect(broadcastToLocalViews).not.toHaveBeenCalled();
  });

  it.each(["unset", "hidden"])("refuses with Canopy %s", async (mode) => {
    state.mode = mode;
    expect(
      await refused(invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, place))
    ).toBe(true);
    expect(windowMock.popOutToCanopyWindow).not.toHaveBeenCalled();
  });

  it("refuses the Canopy window itself, which has no dialog to pop out", async () => {
    expect(
      await refused(invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, place))
    ).toBe(true);
    expect(windowMock.popOutToCanopyWindow).not.toHaveBeenCalled();
  });

  const missing = [
    "query",
    "selection",
    "roleFilter",
    "unreadOnly",
    "keptUnread",
    "archivedExpanded",
    "trashExpanded",
    "workOf",
  ] as const;
  const refusedPlaces: Array<[string, unknown]> = [
    ["no host", { ...place, hostId: "" }],
    ["an unknown role", { ...place, roleFilter: "everyone" }],
    ["an unknown selection", { ...place, selection: { kind: "pane", runId: "r" } }],
    ...missing.map((key): [string, unknown] => {
      const { [key]: _dropped, ...rest } = place;
      return [`no ${key}`, rest];
    }),
  ];

  it.each(refusedPlaces)("refuses a place with %s", async (_label, payload) => {
    expect(
      await refused(invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.popOut, payload))
    ).toBe(true);
    expect(windowMock.popOutToCanopyWindow).not.toHaveBeenCalled();
  });

  it("shows the waiting place to the Canopy window alone", async () => {
    const pending = { id: 4, popOut: place };
    windowMock.peekPendingPopOut.mockReturnValue(pending);

    const answer = (await invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.peekPopOut)) as {
      data?: unknown;
    };
    expect(answer?.data ?? answer).toEqual(pending);
    expect(
      await refused(invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.peekPopOut))
    ).toBe(true);
  });

  it("takes the window's word that it has the place, and no other view's", async () => {
    for (const taken of [true, false]) {
      windowMock.acknowledgePopOut.mockReturnValueOnce(taken);
      const answer = (await invokeFrom(
        CANOPY_VIEW_ID,
        CANOPY_WINDOW_METHOD_CHANNELS.acknowledgePopOut,
        { id: 4 }
      )) as { data?: unknown };
      expect(answer?.data ?? answer).toBe(taken);
    }
    expect(windowMock.acknowledgePopOut).toHaveBeenCalledWith(4);
    expect(
      await refused(
        invokeFrom(CANOPY_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.acknowledgePopOut, { id: 0 })
      )
    ).toBe(true);

    windowMock.acknowledgePopOut.mockClear();
    expect(
      await refused(
        invokeFrom(PROJECT_VIEW_ID, CANOPY_WINDOW_METHOD_CHANNELS.acknowledgePopOut, { id: 4 })
      )
    ).toBe(true);
    expect(windowMock.acknowledgePopOut).not.toHaveBeenCalled();
  });
});
