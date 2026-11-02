// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";

// No jest-dom in this repo — plain DOM reads only.

const client = vi.hoisted(() => ({
  list: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  setEnabled: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listRuns: vi.fn(async () => []),
  listScheduleRuns: vi.fn(async () => []),
  onRunsChanged: vi.fn(() => () => {}),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
const reveal = vi.hoisted(() => vi.fn());
vi.mock("@/services/scheduledRunLanding", () => ({ revealRunTerminal: reveal }));
vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));
vi.mock("@/hooks/useResumeAgentSession", () => ({ useResumeAgentSession: () => vi.fn() }));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("@/components/Schedules/useScheduleLaunchOptions", () => ({
  useScheduleLaunchOptions: () => ({ presets: [], preset: undefined, stopsAtPrompts: false }),
}));
vi.mock("@/components/Schedules/useScheduleOsJob", () => ({
  useScheduleOsJob: () => ({ status: null, repairing: false, error: null, repair: vi.fn() }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ProjectSchedulesTab } from "../ProjectSchedulesTab";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";

const NOW = Date.UTC(2027, 0, 4, 8);

function schedule(id: string, name: string): Schedule {
  return createSchedule(
    {
      id,
      projectId: "p1",
      name,
      launch: { agentId: "claude", prompt: "Look at the dependencies." },
      cron: "0 2 * * *",
      timeZone: "Europe/London",
    },
    NOW - 1000
  );
}

function snapshot(schedules: Schedule[], revision = 1): SchedulesSnapshot {
  return { projectId: "p1", revision, schedules } as SchedulesSnapshot;
}

const NIGHTLY = schedule("s1", "Nightly audit");
const WEEKLY = schedule("s2", "Weekly triage");

function renderTab(props: Partial<React.ComponentProps<typeof ProjectSchedulesTab>> = {}) {
  return render(<ProjectSchedulesTab projectId="p1" isOpen isActive {...props} />);
}

const editor = () => screen.queryByTestId("schedule-editor-dialog");

beforeEach(() => {
  useSchedulesViewStore.setState({
    request: { scheduleId: null, seq: 0 },
    landedSeq: 0,
    showing: false,
  });
  client.list.mockResolvedValue(snapshot([NIGHTLY, WEEKLY]));
  client.remove.mockReset();
  dispatch.mockReset();
  reveal.mockReset();
});

afterEach(() => cleanup());

describe("ProjectSchedulesTab — the list", () => {
  it("lists each schedule with its actions, and Add schedule in the section header", async () => {
    renderTab();
    await screen.findByText("Nightly audit");
    expect(screen.getByText("Weekly triage")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add schedule" })).toHaveLength(1);
    for (const name of [
      "Run Nightly audit now",
      "Run history of Nightly audit",
      "Edit schedule Nightly audit",
      "Delete schedule Nightly audit",
    ]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(screen.getByRole("switch", { name: "Enable Nightly audit" })).toBeTruthy();
  });

  it("offers Add schedule in the empty row when there are none", async () => {
    client.list.mockResolvedValue(snapshot([]));
    renderTab();
    await screen.findByText(/Add a schedule to run an agent/);
    expect(screen.getAllByRole("button", { name: "Add schedule" })).toHaveLength(1);
  });

  it("asks before deleting a schedule, naming it, and removes it on confirm", async () => {
    client.remove.mockResolvedValue({ snapshot: snapshot([WEEKLY], 2) });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule Nightly audit" }));
    expect(await screen.findByText("Delete 'Nightly audit'?")).toBeTruthy();
    expect(client.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(client.remove).toHaveBeenCalledExactlyOnceWith("s1"));
    await waitFor(() => expect(screen.queryByText("Nightly audit")).toBeNull());
    expect(screen.getByText("Weekly triage")).toBeTruthy();
  });

  it("runs a schedule now through the action, so its overlap policy asks first", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      result: { status: "started", runId: "r1", terminalId: "t1" },
    });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run Nightly audit now" }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        "schedules.runNow",
        { scheduleId: "s1" },
        { source: "user" }
      )
    );
    expect(await screen.findByText("Started a run of Nightly audit")).toBeTruthy();
  });

  it("says a Run now failure the history couldn't record, with Retry", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      result: { status: "failed", runId: null, message: "The project isn't open" },
    });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run Nightly audit now" }));
    expect(await screen.findByText("Nightly audit: The project isn't open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  });
});

describe("ProjectSchedulesTab — landing on a request", () => {
  it("opens the schedule a request names on its history, once", async () => {
    useSchedulesViewStore.getState().open("s2");
    const { unmount } = renderTab();
    expect(await screen.findByRole("button", { name: "All schedules" })).toBeTruthy();
    expect(await screen.findByText("Weekly triage")).toBeTruthy();
    expect(useSchedulesViewStore.getState().landedSeq).toBe(1);

    // Leaving project scope unmounts the tab; coming back doesn't land again.
    unmount();
    renderTab();
    expect(await screen.findByRole("button", { name: "Add schedule" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All schedules" })).toBeNull();
  });

  it("lands only once it is in front", async () => {
    const { rerender } = renderTab({ isActive: false });
    act(() => useSchedulesViewStore.getState().open("s1"));
    expect(screen.queryByRole("button", { name: "All schedules" })).toBeNull();
    rerender(<ProjectSchedulesTab projectId="p1" isOpen isActive />);
    expect(await screen.findByRole("button", { name: "All schedules" })).toBeTruthy();
  });

  it("holds an opening that arrives mid-edit until the editor has closed", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    const name = await screen.findByDisplayValue("Nightly audit");
    fireEvent.change(name, { target: { value: "Nightly audit, edited" } });

    act(() => useSchedulesViewStore.getState().open("s2"));
    expect(editor()).toBeTruthy();
    expect(screen.getByDisplayValue("Nightly audit, edited")).toBeTruthy();
    expect(useSchedulesViewStore.getState().landedSeq).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(await screen.findByRole("button", { name: "All schedules" })).toBeTruthy();
    expect(useSchedulesViewStore.getState().landedSeq).toBe(1);
  });

  it("tells a run's notification it is in front while it shows or an edit is open", async () => {
    const { rerender, unmount } = renderTab();
    await screen.findByText("Nightly audit");
    expect(useSchedulesViewStore.getState().showing).toBe(true);
    rerender(<ProjectSchedulesTab projectId="p1" isOpen isActive={false} />);
    expect(useSchedulesViewStore.getState().showing).toBe(false);
    rerender(<ProjectSchedulesTab projectId="p1" isOpen isActive />);
    unmount();
    expect(useSchedulesViewStore.getState().showing).toBe(false);
  });
});

describe("ProjectSchedulesTab — the editor", () => {
  it("asks before discarding unsaved edits, and keeps them on Keep editing", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    fireEvent.change(await screen.findByDisplayValue("Nightly audit"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard changes to 'Nightly audit'?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByText("Discard changes to 'Nightly audit'?")).toBeNull()
    );
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();
  });

  it("closes a clean editor without asking", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Add schedule" }));
    expect(await screen.findByText("New schedule")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(screen.queryByText("Discard this new schedule?")).toBeNull();
  });
});
