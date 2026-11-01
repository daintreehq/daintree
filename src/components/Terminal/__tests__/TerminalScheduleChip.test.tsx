/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { TooltipProvider } from "@/components/ui/tooltip";
import { _resetScheduleNamesForTests } from "@/store/scheduleNamesStore";
import { TerminalScheduleChip } from "../TerminalScheduleChip";

const { dispatchMock, client, remote, panels } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  client: { list: vi.fn(), onChanged: vi.fn() },
  remote: { value: false },
  panels: { byId: {} as Record<string, unknown> },
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote.value }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: panels.byId }),
}));

let push: ((snapshot: SchedulesSnapshot) => void) | undefined;

function schedules(revision: number, names: Record<string, string>): SchedulesSnapshot {
  return {
    projectId: "proj-a",
    revision,
    schedules: Object.entries(names).map(([id, name]) => ({ id, name })),
  } as unknown as SchedulesSnapshot;
}

function seedPanel(panel: Record<string, unknown>) {
  panels.byId = { "term-1": { id: "term-1", kind: "terminal", ...panel } };
}

async function renderChip() {
  const view = render(
    <TooltipProvider delayDuration={0}>
      <TerminalScheduleChip terminalId="term-1" />
    </TooltipProvider>
  );
  await act(async () => {});
  return view;
}

const SCHEDULED = { spawnedBy: "schedule", scheduledRun: { scheduleId: "s1", runId: "r1" } };

beforeEach(() => {
  _resetScheduleNamesForTests();
  remote.value = false;
  panels.byId = {};
  push = undefined;
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  client.list.mockReset();
  client.onChanged.mockReset();
  client.onChanged.mockImplementation((callback: (snapshot: SchedulesSnapshot) => void) => {
    push = callback;
    return () => {};
  });
  client.list.mockResolvedValue(schedules(1, { s1: "Nightly triage" }));
});

describe("TerminalScheduleChip", () => {
  it.each([
    ["a pane no schedule launched", { spawnedBy: "palette" }],
    ["a schedule source without its run", { spawnedBy: "schedule" }],
    [
      "a run reference on another source",
      { spawnedBy: "agent", scheduledRun: SCHEDULED.scheduledRun },
    ],
    ["a panel that isn't a terminal", { kind: "browser", ...SCHEDULED }],
  ])("draws nothing and reads nothing for %s", async (_name, panel) => {
    seedPanel(panel);
    const { container } = await renderChip();
    expect(container.textContent).toBe("");
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
  });

  it("names the schedule and opens the Schedules view at its runs", async () => {
    seedPanel(SCHEDULED);
    await renderChip();
    const chip = screen.getByTestId("terminal-schedule-chip");
    expect(chip.textContent).toBe("Nightly triage");
    expect(chip.getAttribute("aria-label")).toContain("Nightly triage");

    fireEvent.click(chip);
    expect(dispatchMock).toHaveBeenCalledWith(
      "schedules.open",
      { scheduleId: "s1" },
      { source: "user" }
    );
  });

  it("keeps the click and the press from reaching the pane header", async () => {
    seedPanel(SCHEDULED);
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const onDoubleClick = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <div onClick={onClick} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
          <TerminalScheduleChip terminalId="term-1" />
        </div>
      </TooltipProvider>
    );
    await act(async () => {});
    const chip = screen.getByTestId("terminal-schedule-chip");
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    fireEvent.doubleClick(chip);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
    expect(chip.hasAttribute("data-no-dnd")).toBe(true);
  });

  it("follows a rename, and says so once the schedule is deleted", async () => {
    seedPanel(SCHEDULED);
    await renderChip();
    act(() => push?.(schedules(2, { s1: "Weekly triage" })));
    expect(screen.getByTestId("terminal-schedule-chip").textContent).toBe("Weekly triage");

    act(() => push?.(schedules(3, {})));
    const chip = screen.getByTestId("terminal-schedule-chip");
    expect(chip.textContent).not.toContain("Weekly triage");
    expect(chip.textContent).not.toBe("");
    // Still opens: the view says the schedule is gone.
    fireEvent.click(chip);
    expect(dispatchMock).toHaveBeenCalledWith(
      "schedules.open",
      { scheduleId: "s1" },
      { source: "user" }
    );
  });

  it("still opens the view when the names couldn't be read, and reads them again", async () => {
    client.list.mockRejectedValueOnce(new Error("boom"));
    seedPanel(SCHEDULED);
    await renderChip();
    const chip = screen.getByTestId("terminal-schedule-chip");
    expect(chip.textContent).not.toContain("Nightly triage");

    fireEvent.click(chip);
    await act(async () => {});
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("terminal-schedule-chip").textContent).toBe("Nightly triage");
  });

  it("is a plain label in a window driving a Remote Host", async () => {
    remote.value = true;
    seedPanel(SCHEDULED);
    await renderChip();
    const chip = screen.getByTestId("terminal-schedule-chip");
    expect(chip.textContent).not.toBe("");
    fireEvent.click(chip);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
  });
});
