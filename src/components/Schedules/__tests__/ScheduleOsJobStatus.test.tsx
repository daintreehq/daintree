// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobStatus as Status } from "@shared/types/ipc/schedules";
import { ScheduleOsJobStatus } from "../ScheduleOsJobStatus";

// No jest-dom in this repo — plain DOM reads only.

function schedule(id: string, options: { enabled?: boolean; runWhenClosed?: boolean } = {}) {
  return createSchedule(
    {
      id,
      projectId: "p1",
      name: `Schedule ${id}`,
      launch: { agentId: "claude", prompt: "Go." },
      timeZone: "Europe/London",
      enabled: options.enabled ?? true,
      policies: { runWhenClosed: options.runWhenClosed ?? true },
    },
    1
  );
}

const CURRENT: Status = {
  context: { kind: "launch-agent", systemTimeZone: "Europe/London" },
  unavailable: null,
  state: "current",
  error: null,
  excluded: [],
};

function show(
  status: Status | null,
  schedules: Schedule[],
  options: { error?: string | null; repairing?: boolean } = {}
) {
  const onRepair = vi.fn();
  render(
    <ScheduleOsJobStatus
      status={status}
      schedules={schedules}
      repairing={options.repairing ?? false}
      error={options.error ?? null}
      onRepair={onRepair}
    />
  );
  return { onRepair, text: () => document.body.textContent ?? "" };
}

afterEach(cleanup);

describe("ScheduleOsJobStatus (#15990)", () => {
  it("says nothing while no switched-on schedule here asks for the job", () => {
    show({ ...CURRENT, state: "stale" }, [
      schedule("a", { runWhenClosed: false }),
      schedule("b", { enabled: false }),
    ]);
    expect(screen.queryByTestId("schedule-os-job-status")).toBeNull();
  });

  it("counts the schedules a current job starts", () => {
    const { text } = show(CURRENT, [
      schedule("a"),
      schedule("b"),
      schedule("c", { enabled: false }),
    ]);
    expect(text()).toContain("for 2 schedules here");
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("offers to repair a stale job, with what went wrong", () => {
    const { onRepair, text } = show(
      { ...CURRENT, state: "stale", error: "Couldn't load the macOS job (launchctl exited 5)" },
      [schedule("a")]
    );
    expect(text()).toContain("out of date");
    expect(text()).toContain("launchctl exited 5");
    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(onRepair).toHaveBeenCalledOnce();
  });

  it("offers a repair when the job couldn't be checked at all", () => {
    const { text } = show(null, [schedule("a")], { error: "Couldn't check the job" });
    expect(text()).toContain("Couldn't check the job");
    expect(screen.getByRole("button", { name: "Repair" })).not.toBeNull();
  });

  it("says a repair failed even beside a status that last read current", () => {
    const { text } = show(CURRENT, [schedule("a")], { error: "Couldn't repair the job" });
    expect(text()).toContain("Couldn't repair the job");
    expect(text()).not.toContain("schedule here when");
  });

  it("holds the repair while one is under way", () => {
    show({ ...CURRENT, state: "stale" }, [schedule("a")], { repairing: true });
    const button = screen.getByRole("button", { name: "Repairing…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("names each schedule the job can't start, with why", () => {
    const { text } = show(
      {
        ...CURRENT,
        excluded: [
          { scheduleId: "b", reason: "Runs on Asia/Tokyo time" },
          { scheduleId: "c", reason: "Needs 600 start times" },
          { scheduleId: "gone", reason: "Not in this list" },
        ],
      },
      [schedule("a"), schedule("b"), schedule("c")]
    );
    expect(text()).toContain("2 schedules can't start Daintree when it isn't running");
    expect(text()).toContain("Schedule b: Runs on Asia/Tokyo time");
    expect(text()).toContain("Schedule c: Needs 600 start times");
    expect(text()).not.toContain("Not in this list");
    expect(text()).toContain("for 1 schedule here");
  });

  it("says why this copy of Daintree can't install the job, offering no repair", () => {
    const { text } = show({ ...CURRENT, state: "none", unavailable: "Temporary copy" }, [
      schedule("a"),
    ]);
    expect(text()).toContain("Temporary copy");
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });
});
