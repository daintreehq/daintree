// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const platformMock = vi.hoisted(() => ({ isMac: vi.fn(() => true) }));
vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<object>()),
  ...platformMock,
}));

import { ScheduleEditor, type EditorLeaveState } from "../ScheduleEditor";

const LABEL = "Run when Daintree isn't running";
const NOW = Date.UTC(2027, 0, 4, 8);

function existing(policies: Partial<Schedule["policies"]>, timeZone = "Europe/London"): Schedule {
  return createSchedule(
    {
      id: "s1",
      projectId: "p1",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Go." },
      cron: "0 9 * * *",
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
  const box = option();
  if (!box) throw new Error("no option");
  return box.closest("[data-settings-reset-scope]") as HTMLElement;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.isMac.mockReturnValue(true);
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
    renderEditor(null, { kind: "launch-agent", systemTimeZone: zone });

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

  it("can't be turned on for a cadence the Mac's job can't hold, and says why", () => {
    renderEditor(existing({ runWhenClosed: false }, "Asia/Tokyo"), {
      kind: "launch-agent",
      systemTimeZone: "Europe/London",
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
    renderEditor(schedule, { kind: "launch-agent", systemTimeZone: "Europe/London" });

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

  it("shows main's refusal under the option", async () => {
    clientMock.update.mockResolvedValue({
      status: "invalid",
      issues: [{ path: "policies.runWhenClosed", cronField: null, message: "Not on this Mac" }],
    });
    renderEditor(existing({ runWhenClosed: false }), null);

    fireEvent.click(option()!);
    await act(async () => fireEvent.click(button("Save changes")));

    expect(optionRow().textContent).toContain("Not on this Mac");
  });

  it("isn't offered where there's no OS job, unless a schedule already has it on", () => {
    renderEditor(existing({ runWhenClosed: false }), { kind: null, systemTimeZone: null });
    expect(option()).toBeNull();
    cleanup();

    renderEditor(existing({ runWhenClosed: true }), { kind: null, systemTimeZone: null });
    expect(option()?.getAttribute("aria-checked")).toBe("true");
    expect(optionRow().textContent).toMatch(/isn't available on this platform/);
  });
});
