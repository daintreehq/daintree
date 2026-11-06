// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { ProjectScheduleSwitches, Schedule } from "@shared/types/scheduledRuns";
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
  context: { kind: "launch-agent", systemTimeZone: "Europe/London", unavailable: null },
  unavailable: null,
  state: "current",
  error: null,
  excluded: [],
};

/** A project that lets the job start Daintree for its schedules (#16166). */
const STARTS: ProjectScheduleSwitches = {
  schedulesOn: true,
  startWhenClosed: true,
  schedulesOnSince: 1,
};

interface ShowOptions {
  error?: string | null;
  repairing?: boolean;
  /** The switches the status was read against; null before any answer. */
  switches?: ProjectScheduleSwitches | null;
  /** The switches now, when they've changed since that read. */
  switchesNow?: ProjectScheduleSwitches | null;
  checking?: boolean;
}

function element(status: Status | null, schedules: Schedule[], options: ShowOptions) {
  const switches = options.switches === undefined ? STARTS : options.switches;
  return (
    <ScheduleOsJobStatus
      status={status}
      basis={switches ? { switches, schedules } : null}
      switches={options.switchesNow === undefined ? switches : options.switchesNow}
      checking={options.checking ?? false}
      repairing={options.repairing ?? false}
      error={options.error ?? null}
      onRepair={onRepair}
    />
  );
}

const onRepair = vi.fn();

function show(status: Status | null, schedules: Schedule[], options: ShowOptions = {}) {
  onRepair.mockReset();
  const view = render(element(status, schedules, options));
  return {
    onRepair,
    text: () => document.body.textContent ?? "",
    update: (next: ShowOptions) => view.rerender(element(status, schedules, next)),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ScheduleOsJobStatus (#15990)", () => {
  it.each([
    ["current for another project", CURRENT],
    ["not installed", { ...CURRENT, state: "none" as const }],
  ])(
    "says no schedule here asks for the job while the switch is on and none has the option: %s (#16168)",
    (_label, status) => {
      const { text } = show(status, [
        schedule("a", { runWhenClosed: false }),
        schedule("b", { enabled: false }),
      ]);
      expect(text()).toContain(
        "No schedule that's on here is set to run when Daintree isn't running"
      );
      expect(text()).not.toContain("Installed and loaded");
      expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
    }
  );

  it("offers to repair a stale job even while the project's switches leave it out (#16168)", () => {
    // A job switching off couldn't remove still starts Daintree, for nothing.
    const { text } = show(
      { ...CURRENT, state: "stale", error: "Couldn't remove the macOS job" },
      [schedule("a")],
      { switches: { ...STARTS, startWhenClosed: false } }
    );
    expect(text()).toContain("Couldn't remove the macOS job");
    expect(screen.getByRole("button", { name: "Repair" })).not.toBeNull();
  });

  it.each([
    ["schedules are off", { ...STARTS, schedulesOn: false }],
    ["starting Daintree is off", { ...STARTS, startWhenClosed: false }],
    ["they haven't been read", null],
  ])(
    "claims no schedule here while the project's switches leave the job out: %s (#16166)",
    (_label, switches) => {
      // The job is current for another project's schedules.
      show(CURRENT, [schedule("a")], { switches });
      expect(screen.queryByTestId("schedule-os-job-status")).toBeNull();
    }
  );

  it("says a current job is installed and loaded, counting the schedules it starts", () => {
    const { text } = show(CURRENT, [
      schedule("a"),
      schedule("b"),
      schedule("c", { enabled: false }),
    ]);
    expect(text()).toContain("Installed and loaded");
    expect(text()).toContain("for 2 schedules here");
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("names what starts Daintree as each platform does", () => {
    const mac = show(CURRENT, [schedule("a")]);
    expect(mac.text()).toContain("macOS starts Daintree without a window for 1 schedule here");
    cleanup();

    const linux: Status = {
      ...CURRENT,
      context: { kind: "systemd-timer", systemTimeZone: "UTC", unavailable: null },
    };
    expect(show(linux, [schedule("a")]).text()).toContain(
      "systemd starts Daintree without a window for 1 schedule here"
    );
    cleanup();

    const { text } = show(
      { ...linux, state: "none", unavailable: "This computer doesn't run systemd" },
      [schedule("a")]
    );
    expect(text()).toContain("systemd can't start Daintree for these schedules");
    expect(text()).toContain("This computer doesn't run systemd");
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
    const { onRepair } = show({ ...CURRENT, state: "stale" }, [schedule("a")], {
      repairing: true,
    });
    const button = screen.getByRole("button", { name: "Repair" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it("names each schedule the job can't start, with why", () => {
    const { text } = show(
      {
        ...CURRENT,
        excluded: [
          { scheduleId: "b", reason: "Runs on Asia/Tokyo time" },
          { scheduleId: "c", reason: "Needs 600 start times" },
          { scheduleId: "gone", reason: "Not in this list" },
          { scheduleId: "paused", reason: "Switched off since" },
          { scheduleId: "plain", reason: "Not opted in since" },
        ],
      },
      [
        schedule("a"),
        schedule("b"),
        schedule("c"),
        schedule("paused", { enabled: false }),
        schedule("plain", { runWhenClosed: false }),
      ]
    );
    expect(text()).toContain("2 schedules can't start Daintree when it isn't running");
    expect(text()).toContain("Schedule b: Runs on Asia/Tokyo time");
    expect(text()).toContain("Schedule c: Needs 600 start times");
    expect(text()).not.toContain("Not in this list");
    expect(text()).not.toContain("Switched off since");
    expect(text()).not.toContain("Not opted in since");
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

describe("ScheduleOsJobStatus after a change (#16168)", () => {
  it("keeps the answer for the switches it was read against until the next read answers", () => {
    // Switched off: the job is still installed until main has removed it.
    const { text } = show(CURRENT, [schedule("a")], {
      switchesNow: { ...STARTS, startWhenClosed: false },
      checking: true,
    });
    expect(text()).toContain("Installed and loaded");
  });

  it("says nothing of a job a switch just asked for until it has been read", () => {
    show({ ...CURRENT, state: "none" }, [schedule("a")], {
      switches: { ...STARTS, startWhenClosed: false },
      switchesNow: STARTS,
      checking: true,
    });
    expect(screen.queryByTestId("schedule-os-job-status")).toBeNull();
  });

  it("says it's checking once a read outlasts the gate, while the project asks for the job", () => {
    vi.useFakeTimers();
    const view = show(CURRENT, [schedule("a")], {
      switches: { ...STARTS, startWhenClosed: false },
      switchesNow: STARTS,
      checking: true,
    });
    expect(view.text()).not.toContain("Checking");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(view.text()).toContain("Checking the job that starts Daintree");

    view.update({ checking: false });
    expect(view.text()).not.toContain("Checking");
    expect(view.text()).toContain("Installed and loaded");
  });

  it("says a read failed with Repair after switching off, since the removal wasn't confirmed", () => {
    const { text } = show(CURRENT, [schedule("a")], {
      switches: { ...STARTS, startWhenClosed: false },
      error: "Couldn't check the job",
    });
    expect(text()).toContain("Couldn't check the job");
    expect(text()).not.toContain("Installed and loaded");
    expect(screen.getByRole("button", { name: "Repair" })).not.toBeNull();
  });

  it("never says it's checking for a project that doesn't ask for the job", () => {
    vi.useFakeTimers();
    const off = { ...STARTS, schedulesOn: false };
    const { text } = show(CURRENT, [schedule("a")], {
      switches: off,
      switchesNow: off,
      checking: true,
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(text()).not.toContain("Checking");
  });
});

describe("ScheduleOsJobStatus on Windows (#15993)", () => {
  const WINDOWS: Status = {
    ...CURRENT,
    context: { kind: "task-scheduler", systemTimeZone: "Europe/London", unavailable: null },
  };

  it("names Windows as what starts Daintree", () => {
    const { text } = show(WINDOWS, [schedule("a"), schedule("b")]);
    expect(text()).toContain("Windows starts Daintree without a window for 2 schedules here");
    expect(text()).not.toContain("macOS");
  });

  it("names Windows when this build can't register the task, with the reason", () => {
    const { text } = show(
      { ...WINDOWS, state: "none", unavailable: "The Store build can't register tasks" },
      [schedule("a")]
    );
    expect(text()).toContain("Windows can't start Daintree for these schedules");
    expect(text()).toContain("The Store build can't register tasks");
  });
});
