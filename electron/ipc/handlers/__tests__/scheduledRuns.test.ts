import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const recorderMock = vi.hoisted(() => ({
  listByProject: vi.fn<(projectId: string) => unknown[]>(() => []),
  listBySchedule: vi.fn<(scheduleId: string) => unknown[]>(() => []),
  listInboxPending: vi.fn<() => unknown[]>(() => []),
  clearInboxPending: vi.fn<(ids: readonly string[]) => string[]>((ids) => [...ids]),
}));

const getRecorder = vi.hoisted(() => vi.fn<() => Promise<typeof recorderMock | null>>());
const getInboxRecorder = vi.hoisted(() => vi.fn<() => Promise<typeof recorderMock | null>>());
const getSchedule = vi.hoisted(() =>
  vi.fn<(projectId: string, scheduleId: string) => Promise<unknown>>()
);

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  webContents: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
}));

vi.mock("../../../services/scheduledRuns/index.js", () => ({
  getScheduledRunRecorder: getRecorder,
  getScheduledRunRecorderForInbox: getInboxRecorder,
}));

vi.mock(import("../../../window/webContentsRegistry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getShownAppWebContents: () => [{ id: 1 }, { id: 2 }] as unknown as Electron.WebContents[],
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { schedules: { get: getSchedule } },
}));

import { CHANNELS } from "../../channels.js";
import { _resetScheduledRunInboxForTest, registerScheduledRunsHandlers } from "../scheduledRuns.js";

function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

/** Unwrap the `{ ok: true, data }` envelope the IPC security layer may add. */
async function invoke(channel: string, payload?: unknown, senderId = 1): Promise<unknown> {
  const result = (await handlerFor(channel)({ sender: { id: senderId } }, payload)) as {
    ok?: boolean;
    data?: unknown;
  };
  return result?.ok ? result.data : result;
}

describe("scheduledRuns handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRecorder.mockResolvedValue(recorderMock);
    getInboxRecorder.mockResolvedValue(recorderMock);
    _resetScheduledRunInboxForTest();
    registerScheduledRunsHandlers();
  });

  it("exposes reads and the inbox handoff: no view can register a run or change its facts", () => {
    const channels = (ipcMainMock.handle as Mock).mock.calls.map(([name]) => name as string);
    expect(channels.sort()).toEqual(
      [
        CHANNELS.SCHEDULED_RUNS_LIST_BY_PROJECT,
        CHANNELS.SCHEDULED_RUNS_LIST_BY_SCHEDULE,
        CHANNELS.SCHEDULED_RUNS_TAKE_INBOX,
        CHANNELS.SCHEDULED_RUNS_ACK_INBOX,
      ].sort()
    );
  });

  it("hands a view the runs waiting for the inbox with their schedule, then clears what it acks", async () => {
    recorderMock.listInboxPending.mockReturnValue([
      { id: "run-1", projectId: "project-1", scheduleId: "schedule-1" },
    ]);
    getSchedule.mockResolvedValue({ name: "Nightly", cadence: { timeZone: "Europe/London" } });

    await expect(invoke(CHANNELS.SCHEDULED_RUNS_TAKE_INBOX)).resolves.toEqual({
      items: [
        {
          run: { id: "run-1", projectId: "project-1", scheduleId: "schedule-1" },
          schedule: { name: "Nightly", timeZone: "Europe/London" },
        },
      ],
      retryInMs: null,
    });
    expect(getSchedule).toHaveBeenCalledWith("project-1", "schedule-1");
    // Another view asking while the first holds them gets none.
    await expect(invoke(CHANNELS.SCHEDULED_RUNS_TAKE_INBOX, undefined, 2)).resolves.toMatchObject({
      items: [],
    });
    // Nor does a view no window has on screen.
    await expect(invoke(CHANNELS.SCHEDULED_RUNS_TAKE_INBOX, undefined, 3)).resolves.toEqual({
      items: [],
      retryInMs: null,
    });

    await invoke(CHANNELS.SCHEDULED_RUNS_ACK_INBOX, { runIds: ["run-1"] });
    expect(recorderMock.clearInboxPending).toHaveBeenCalledWith(["run-1"]);
  });

  it("refuses an ack that names no runs list", async () => {
    await expect(invoke(CHANNELS.SCHEDULED_RUNS_ACK_INBOX, { runIds: "run-1" })).rejects.toThrow(
      /validation failed/
    );
    expect(recorderMock.clearInboxPending).not.toHaveBeenCalled();
  });

  it("hands nothing over when no run is waiting", async () => {
    getInboxRecorder.mockResolvedValue(null);
    await expect(invoke(CHANNELS.SCHEDULED_RUNS_TAKE_INBOX)).resolves.toEqual({
      items: [],
      retryInMs: null,
    });
  });

  it("lists a project's runs and a schedule's runs", async () => {
    recorderMock.listByProject.mockReturnValue([{ id: "run-1" }]);
    recorderMock.listBySchedule.mockReturnValue([{ id: "run-2" }]);

    await expect(
      invoke(CHANNELS.SCHEDULED_RUNS_LIST_BY_PROJECT, { projectId: "project-1" })
    ).resolves.toEqual([{ id: "run-1" }]);
    await expect(
      invoke(CHANNELS.SCHEDULED_RUNS_LIST_BY_SCHEDULE, { scheduleId: "schedule-1" })
    ).resolves.toEqual([{ id: "run-2" }]);
    expect(recorderMock.listByProject).toHaveBeenCalledWith("project-1");
    expect(recorderMock.listBySchedule).toHaveBeenCalledWith("schedule-1");
  });

  it("refuses a request without an id", async () => {
    await expect(
      invoke(CHANNELS.SCHEDULED_RUNS_LIST_BY_PROJECT, { projectId: "" })
    ).rejects.toThrow(/validation failed/);
    expect(recorderMock.listByProject).not.toHaveBeenCalled();
  });

  it("answers an empty history when the history can't be opened", async () => {
    getRecorder.mockResolvedValue(null);
    await expect(
      invoke(CHANNELS.SCHEDULED_RUNS_LIST_BY_SCHEDULE, { scheduleId: "schedule-1" })
    ).resolves.toEqual([]);
  });
});
