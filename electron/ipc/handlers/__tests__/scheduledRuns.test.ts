import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const recorderMock = vi.hoisted(() => ({
  listByProject: vi.fn<(projectId: string) => unknown[]>(() => []),
  listBySchedule: vi.fn<(scheduleId: string) => unknown[]>(() => []),
}));

const getRecorder = vi.hoisted(() => vi.fn<() => Promise<typeof recorderMock | null>>());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../../services/scheduledRuns/index.js", () => ({
  getScheduledRunRecorder: getRecorder,
}));

import { CHANNELS } from "../../channels.js";
import { registerScheduledRunsHandlers } from "../scheduledRuns.js";

function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

/** Unwrap the `{ ok: true, data }` envelope the IPC security layer may add. */
async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const result = (await handlerFor(channel)({ sender: { id: 1 } }, payload)) as {
    ok?: boolean;
    data?: unknown;
  };
  return result?.ok ? result.data : result;
}

describe("scheduledRuns handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRecorder.mockResolvedValue(recorderMock);
    registerScheduledRunsHandlers();
  });

  it("exposes only reads: no view can register or change a run", () => {
    const channels = (ipcMainMock.handle as Mock).mock.calls.map(([name]) => name as string);
    expect(channels.sort()).toEqual(
      [CHANNELS.SCHEDULED_RUNS_LIST_BY_PROJECT, CHANNELS.SCHEDULED_RUNS_LIST_BY_SCHEDULE].sort()
    );
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
