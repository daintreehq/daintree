// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRunNowOutcome } from "@shared/types/ipc/schedules";

const client = vi.hoisted(() => ({
  runNow: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));

import {
  cancelScheduleRunConfirmations,
  resolveScheduleRunConfirmation,
  useScheduleRunConfirmStore,
} from "@/store/scheduleRunConfirmStore";
import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";
import { registerScheduleActions } from "../scheduleActions";

const ctx: ActionContext = { projectId: "project-1" };

function runNow(): Promise<ScheduleRunNowOutcome> {
  const actions: ActionRegistry = new Map();
  registerScheduleActions(actions);
  const definition = actions.get("schedules.runNow")?.();
  if (!definition) throw new Error("schedules.runNow is not registered");
  return definition.run({ scheduleId: "schedule-1" }, ctx) as Promise<ScheduleRunNowOutcome>;
}

const confirmOverlap = (
  openRunIds: string[],
  policy: "skip" | "replace" = "skip"
): ScheduleRunNowOutcome => ({ status: "confirm-overlap", policy, openRunIds });
const started: ScheduleRunNowOutcome = { status: "started", runId: "run-3", terminalId: "t-3" };

const pending = () => useScheduleRunConfirmStore.getState().current;

beforeEach(() => {
  client.runNow.mockReset();
  client.list.mockReset();
  client.list.mockResolvedValue({
    projectId: "project-1",
    revision: 1,
    schedules: [{ id: "schedule-1", name: "Nightly triage" }],
  });
});

afterEach(() => {
  cancelScheduleRunConfirmations();
});

describe("schedules.runNow (#15980)", () => {
  it("runs without asking when nothing is open", async () => {
    client.runNow.mockResolvedValue(started);

    await expect(runNow()).resolves.toEqual(started);
    expect(client.runNow).toHaveBeenCalledExactlyOnceWith("schedule-1");
    expect(pending()).toBeNull();
  });

  it("asks before running alongside open runs, and answers with the runs it named", async () => {
    client.runNow.mockResolvedValueOnce(confirmOverlap(["run-2", "run-1"]));
    client.runNow.mockResolvedValueOnce(started);

    const result = runNow();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()).toMatchObject({
      scheduleName: "Nightly triage",
      policy: "skip",
      openRunCount: 2,
    });
    resolveScheduleRunConfirmation(pending()!.requestId, true);

    await expect(result).resolves.toEqual(started);
    expect(client.runNow).toHaveBeenLastCalledWith("schedule-1", {
      overlap: { policy: "skip", openRunIds: ["run-2", "run-1"] },
    });
  });

  it("runs nothing when the user backs out", async () => {
    const outcome = confirmOverlap(["run-1"], "replace");
    client.runNow.mockResolvedValue(outcome);

    const result = runNow();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()).toMatchObject({ policy: "replace", openRunCount: 1 });
    resolveScheduleRunConfirmation(pending()!.requestId, false);

    await expect(result).resolves.toEqual(outcome);
    expect(client.runNow).toHaveBeenCalledTimes(1);
  });

  it("asks again about a run that opened while it asked", async () => {
    client.runNow
      .mockResolvedValueOnce(confirmOverlap(["run-1"]))
      .mockResolvedValueOnce(confirmOverlap(["run-2", "run-1"]))
      .mockResolvedValueOnce(started);

    const result = runNow();
    await vi.waitFor(() => expect(pending()?.openRunCount).toBe(1));
    resolveScheduleRunConfirmation(pending()!.requestId, true);
    await vi.waitFor(() => expect(pending()?.openRunCount).toBe(2));
    resolveScheduleRunConfirmation(pending()!.requestId, true);

    await expect(result).resolves.toEqual(started);
    expect(client.runNow).toHaveBeenLastCalledWith("schedule-1", {
      overlap: { policy: "skip", openRunIds: ["run-2", "run-1"] },
    });
  });

  it("names the schedule generically when it can't be read", async () => {
    client.list.mockRejectedValue(new Error("gone"));
    client.runNow.mockResolvedValue(confirmOverlap(["run-1"]));

    const result = runNow();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()?.scheduleName).toBe("this schedule");
    cancelScheduleRunConfirmations();
    await expect(result).resolves.toMatchObject({ status: "confirm-overlap" });
  });

  it("is a confirm action, closed to plugins and hidden from MCP", () => {
    const actions: ActionRegistry = new Map();
    registerScheduleActions(actions);
    expect(actions.get("schedules.runNow")?.()).toMatchObject({
      danger: "confirm",
      denyPluginDispatch: true,
      mcpVisibility: "hidden",
    });
  });
});
