// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import { machineTimeZone } from "@shared/utils/cron";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobContext } from "@shared/utils/scheduleOsJob";

// No jest-dom in this repo — plain DOM reads only.

const clientMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: clientMock }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("../useScheduleLaunchOptions", () => ({
  useScheduleLaunchOptions: () => ({ presets: [], preset: undefined, stopsAtPrompts: false }),
}));
const platformMock = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
  isLinux: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));
vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<object>()),
  ...platformMock,
}));

import { ScheduleEditor, type EditorLeaveState } from "../ScheduleEditor";

const LABEL = "Run when Daintree isn't running";
const NOW = Date.UTC(2027, 0, 4, 8);

const LONDON: ScheduleOsJobContext = {
  kind: "launch-agent",
  systemTimeZone: "Europe/London",
  unavailable: null,
};
const LINUX: ScheduleOsJobContext = {
  kind: "systemd-timer",
  systemTimeZone: "Europe/London",
  unavailable: null,
};
/** No preset writes a day-of-month range, so it opens as a custom expression. */
const CUSTOM_CRON = "0 9 1-7 * *";
/** Days that must be both odd dates and Mondays: launchd can't AND them. */
const BOTH_DAYS_CRON = "0 0 */2 * MON";

function existing(
  policies: Partial<Schedule["policies"]>,
  timeZone = "Europe/London",
  cron = "0 9 * * *"
): Schedule {
  return createSchedule(
    {
      id: "s1",
      projectId: "p1",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Go." },
      cron,
      timeZone,
      policies,
    },
    NOW - 1000
  );
}

function renderEditor(schedule: Schedule | null, osJobContext: ScheduleOsJobContext | null) {
  const onSaved = vi.fn();
  render(
    <ScheduleEditor
      schedule={schedule}
      defaultAgentId="claude"
      worktrees={[{ id: null, label: "Main checkout" }]}
      now={NOW}
      osJobContext={osJobContext}
      leaveStateRef={createRef<EditorLeaveState | null>()}
      onSaved={onSaved}
      onDeleted={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  return { onSaved };
}

function option(): HTMLElement | null {
  return screen.queryByRole("checkbox", { name: LABEL });
}

function optionRow(): HTMLElement {
  const row = option()?.closest<HTMLElement>("[data-settings-reset-scope]");
  if (!row) throw new Error("no option");
  return row;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function typeCron(cron: string): void {
  fireEvent.change(screen.getByLabelText("Expression"), { target: { value: cron } });
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.isMac.mockReturnValue(true);
  platformMock.isLinux.mockReturnValue(false);
  platformMock.isWindows.mockReturnValue(false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScheduleEditor: Run when Daintree isn't running (#15990)", () => {
  it("starts off, and creates the schedule with it on in the zone it was checked against", async () => {
    const zone = machineTimeZone();
    clientMock.create.mockResolvedValue({
      status: "saved",
      schedule: existing({ runWhenClosed: true }, zone),
      snapshot: { projectId: "p1", schedules: [], revision: 1 },
    });
    renderEditor(null, { kind: "launch-agent", systemTimeZone: zone, unavailable: null });

    expect(option()?.getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nightly" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go." } });
    fireEvent.click(option()!);
    expect(option()?.getAttribute("aria-checked")).toBe("true");

    await act(async () => fireEvent.click(button("Create schedule")));

    expect(clientMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        timeZone: zone,
        policies: expect.objectContaining({ runWhenClosed: true }),
      })
    );
  });

  it("can't be turned on for days launchd can't require both of, in the Mac's own zone", () => {
    renderEditor(existing({ runWhenClosed: false }, "Europe/London", BOTH_DAYS_CRON), LONDON);

    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toMatch(/both the day of the month and the weekday/);
  });

  it("follows the cadence as it's edited between ones the job can and can't hold", () => {
    renderEditor(existing({ runWhenClosed: false }, "Europe/London", CUSTOM_CRON), LONDON);
    expect(option()?.hasAttribute("disabled")).toBe(false);

    typeCron(BOTH_DAYS_CRON);
    expect(option()?.hasAttribute("disabled")).toBe(true);

    typeCron(CUSTOM_CRON);
    expect(option()?.hasAttribute("disabled")).toBe(false);
    fireEvent.click(option()!);
    typeCron(BOTH_DAYS_CRON);
    // Turned on and no longer holdable: it stays on, says why, and can be turned off.
    expect(option()?.getAttribute("aria-checked")).toBe("true");
    expect(option()?.hasAttribute("disabled")).toBe(false);
    expect(optionRow().textContent).toMatch(/both the day of the month and the weekday/);
  });

  it("can't be turned on for a cadence the Mac's job can't hold, and says why", () => {
    renderEditor(existing({ runWhenClosed: false }, "Asia/Tokyo"), {
      kind: "launch-agent",
      systemTimeZone: "Europe/London",
      unavailable: null,
    });

    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toContain(
      "macOS can only start Daintree on this Mac's time (Europe/London), and this schedule runs on Asia/Tokyo time"
    );
  });

  it("keeps a stored opt-in the job can no longer hold from saving, until it's turned off", async () => {
    const schedule = existing({ runWhenClosed: true }, "Asia/Tokyo");
    clientMock.update.mockResolvedValue({
      status: "saved",
      schedule,
      snapshot: { projectId: "p1", schedules: [], revision: 2 },
    });
    renderEditor(schedule, {
      kind: "launch-agent",
      systemTimeZone: "Europe/London",
      unavailable: null,
    });

    expect(option()?.hasAttribute("disabled")).toBe(false);
    expect(optionRow().textContent).toMatch(/runs on Asia\/Tokyo time/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    await act(async () => fireEvent.click(button("Save changes")));
    expect(clientMock.update).not.toHaveBeenCalled();

    fireEvent.click(option()!);
    await act(async () => fireEvent.click(button("Save changes")));
    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      schedule.updatedAt,
      expect.objectContaining({ policies: expect.objectContaining({ runWhenClosed: false }) })
    );
  });

  it("shows main's refusal under the option, focuses it, and drops it once the cadence changes", async () => {
    clientMock.update.mockResolvedValue({
      status: "invalid",
      issues: [{ path: "policies.runWhenClosed", cronField: null, message: "Not on this Mac" }],
    });
    renderEditor(existing({ runWhenClosed: false }, "Europe/London", CUSTOM_CRON), null);

    fireEvent.click(option()!);
    await act(async () => fireEvent.click(button("Save changes")));

    expect(optionRow().textContent).toContain("Not on this Mac");
    await waitFor(() => expect(document.activeElement).toBe(option()));

    typeCron("0 10 1-7 * *");
    expect(optionRow().textContent).not.toContain("Not on this Mac");
  });

  it("is offered on a Mac, on Linux or on a Windows PC before main has answered, and nowhere else", () => {
    renderEditor(existing({ runWhenClosed: false }), null);
    expect(optionRow().textContent).toMatch(/^.*macOS starts Daintree/);
    cleanup();

    platformMock.isMac.mockReturnValue(false);
    platformMock.isLinux.mockReturnValue(true);
    renderEditor(existing({ runWhenClosed: false }), null);
    expect(optionRow().textContent).toMatch(/systemd starts Daintree/);
    cleanup();

    platformMock.isLinux.mockReturnValue(false);
    platformMock.isWindows.mockReturnValue(true);
    renderEditor(existing({ runWhenClosed: false }), null);
    expect(optionRow().textContent).toContain("Windows starts Daintree");
    cleanup();

    platformMock.isWindows.mockReturnValue(false);
    renderEditor(existing({ runWhenClosed: false }), null);
    expect(option()).toBeNull();
  });

  it("judges a Linux cadence by what a systemd timer can hold, in main's words", () => {
    // Days launchd can't require both of are one OnCalendar line.
    renderEditor(existing({ runWhenClosed: false }, "Europe/London", BOTH_DAYS_CRON), LINUX);
    expect(option()?.hasAttribute("disabled")).toBe(false);
    expect(optionRow().textContent).toMatch(/systemd starts Daintree without a window/);
    expect(optionRow().textContent).toMatch(/wakes or you next log in/);
    cleanup();

    renderEditor(existing({ runWhenClosed: false }, "Asia/Tokyo"), LINUX);
    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toContain(
      "systemd can only start Daintree on this computer's time (Europe/London), and this schedule runs on Asia/Tokyo time"
    );
  });

  it("isn't offered where there's no OS job, unless a schedule already has it on", () => {
    renderEditor(existing({ runWhenClosed: false }), {
      kind: null,
      systemTimeZone: null,
      unavailable: null,
    });
    expect(option()).toBeNull();
    cleanup();

    renderEditor(existing({ runWhenClosed: true }), {
      kind: null,
      systemTimeZone: null,
      unavailable: null,
    });
    expect(option()?.getAttribute("aria-checked")).toBe("true");
    expect(optionRow().textContent).toMatch(/isn't available on this platform/);
  });
});

describe("ScheduleEditor: Run when Daintree isn't running on Windows (#15993)", () => {
  const PC: ScheduleOsJobContext = {
    kind: "task-scheduler",
    systemTimeZone: "Europe/London",
    unavailable: null,
  };

  beforeEach(() => {
    platformMock.isMac.mockReturnValue(false);
    platformMock.isWindows.mockReturnValue(true);
  });

  it("says what Windows does, judged by main's context", () => {
    renderEditor(existing({ runWhenClosed: false }), PC);
    expect(option()?.hasAttribute("disabled")).toBe(false);
    expect(optionRow().textContent).toMatch(/Windows starts Daintree.*signed in.*wake timers/);
  });

  it("can't be turned on for a cadence Windows' task can't hold, and says why in its words", () => {
    renderEditor(existing({ runWhenClosed: false }, "Asia/Tokyo"), PC);
    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toContain(
      "Windows can only start Daintree on this PC's time (Europe/London), and this schedule runs on Asia/Tokyo time"
    );
  });

  it("shows the option unavailable on a Store build, with the reason, and lets one already on be turned off", () => {
    const store = { ...PC, unavailable: "The Store build can't register tasks" };
    renderEditor(existing({ runWhenClosed: false }), store);
    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toContain("The Store build can't register tasks");
    cleanup();

    renderEditor(existing({ runWhenClosed: true }), store);
    expect(option()?.hasAttribute("disabled")).toBe(false);
    fireEvent.click(option()!);
    expect(option()?.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps a Store build's reason while the cadence isn't valid yet", () => {
    const store = { ...PC, unavailable: "The Store build can't register tasks" };
    renderEditor(existing({ runWhenClosed: false }, "Europe/London", CUSTOM_CRON), store);
    typeCron("not a cron");
    expect(option()?.hasAttribute("disabled")).toBe(true);
    expect(optionRow().textContent).toContain("The Store build can't register tasks");
  });
});
