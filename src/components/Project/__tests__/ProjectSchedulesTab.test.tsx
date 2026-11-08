// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { ProjectScheduleSwitches, Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { ScheduleOsJobStatus, SchedulesSnapshot } from "@shared/types/ipc/schedules";

// No jest-dom in this repo — plain DOM reads only.

const client = vi.hoisted(() => ({
  list: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  setEnabled: vi.fn(),
  setSwitches: vi.fn(),
  // Unanswered unless a test answers it: the real hook reads the job's status.
  osJobStatus: vi.fn(() => new Promise(() => {})),
  repairOsJob: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listRuns: vi.fn(async () => []),
  listScheduleRuns: vi.fn(async (): Promise<ScheduledRun[]> => []),
  onRunsChanged: vi.fn(() => () => {}),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
const reveal = vi.hoisted(() => vi.fn());
vi.mock("@/services/scheduledRunLanding", () => ({ revealRunTerminal: reveal }));
const worktreeList = vi.hoisted(() => ({
  current: [] as Array<{ id: string; path: string; name: string; isMainWorktree: boolean }>,
}));
vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: worktreeList.current }),
}));
const resumeSession = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useResumeAgentSession", () => ({ useResumeAgentSession: () => resumeSession }));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("@/components/Schedules/useScheduleLaunchOptions", () => ({
  useScheduleLaunchOptions: () => ({ presets: [], preset: undefined, stopsAtPrompts: false }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ProjectSchedulesTab } from "../ProjectSchedulesTab";
import { ScheduleEditorHost } from "@/components/Schedules/ScheduleEditorHost";
import { isSchedulesViewHeld, useSchedulesViewStore } from "@/store/schedulesViewStore";

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

const SCHEDULES_ON: ProjectScheduleSwitches = {
  schedulesOn: true,
  startWhenClosed: false,
  schedulesOnSince: 1,
};
const SCHEDULES_OFF: ProjectScheduleSwitches = { ...SCHEDULES_ON, schedulesOn: false };

function snapshot(
  schedules: Schedule[],
  revision = 1,
  switches: ProjectScheduleSwitches = SCHEDULES_ON
): SchedulesSnapshot {
  return { projectId: "p1", revision, switches, schedules };
}

const NIGHTLY = schedule("s1", "Nightly audit");
const WEEKLY = schedule("s2", "Weekly triage");

interface HarnessProps {
  isActive?: boolean;
  /** False once Settings leaves project scope (or closes), which unmounts the tab. */
  mounted?: boolean;
  onClose?: React.ComponentProps<typeof ProjectSchedulesTab>["onClose"];
}

/** The tab where Project settings mounts it, and the editor where the project's dialogs host it. */
function Harness({ isActive = true, mounted = true, onClose }: HarnessProps) {
  return (
    <>
      {mounted && <ProjectSchedulesTab isOpen isActive={isActive} onClose={onClose} />}
      <ScheduleEditorHost />
    </>
  );
}

function renderTab(props: HarnessProps = {}) {
  const view = render(<Harness {...props} />);
  return { ...view, update: (next: HarnessProps) => view.rerender(<Harness {...next} />) };
}

const editor = () => screen.queryByTestId("schedule-editor-dialog");

beforeEach(() => {
  useSchedulesViewStore.setState({
    request: { scheduleId: null, seq: 0 },
    landedSeq: 0,
    showing: false,
    editor: null,
    editorAnswer: null,
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

  it("offers starters in the empty tab, and one opens the editor filled in without saving", async () => {
    client.list.mockResolvedValue(snapshot([]));
    renderTab();
    await screen.findByText(/Add a schedule to run an agent/);
    expect(document.querySelectorAll("[data-schedule-starter]").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Use starter: Nightly bug hunt" }));

    await waitFor(() => expect(editor()).not.toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Nightly bug hunt");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toContain(
      "say so in one line"
    );
    expect(document.body.textContent).toContain("Every day at 2:00");
    expect(client.create).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
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

    // The failure, and its focused Retry, stay up while the retry is pending.
    let answer: (value: unknown) => void = () => {};
    dispatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Nightly audit: The project isn't open")).toBeTruthy();
    expect(document.activeElement).toBe(retry);

    // Once it gets through, the failure goes and focus moves to the row's Run now.
    await act(async () =>
      answer({ ok: true, result: { status: "started", runId: "r2", terminalId: "t2" } })
    );
    await waitFor(() =>
      expect(screen.queryByText("Nightly audit: The project isn't open")).toBeNull()
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Run Nightly audit now" })
      )
    );
  });
});

describe("ProjectSchedulesTab — the project's switches (#16168)", () => {
  const nextRuns = () => screen.queryAllByText(/^Next run/);
  const STARTS: ProjectScheduleSwitches = { ...SCHEDULES_ON, startWhenClosed: true };
  const OPTED_IN = createSchedule(
    {
      id: "s3",
      projectId: "p1",
      name: "Overnight build",
      launch: { agentId: "claude", prompt: "Build it." },
      cron: "0 2 * * *",
      timeZone: "Europe/London",
      policies: { runWhenClosed: true },
    },
    NOW - 1000
  );
  function jobStatus(state: ScheduleOsJobStatus["state"]): ScheduleOsJobStatus {
    return {
      context: { kind: "launch-agent", systemTimeZone: "Europe/London", unavailable: null },
      unavailable: null,
      state,
      error: null,
      excluded: [],
    };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }
  const startSwitch = () =>
    screen.getByRole("switch", { name: "Start Daintree for due schedules" });
  const installed = () => screen.queryByText(/Installed and loaded/);

  it("heads the list with the switches, listing every schedule while they're off", async () => {
    client.list.mockResolvedValue(snapshot([NIGHTLY, WEEKLY], 1, SCHEDULES_OFF));
    renderTab();
    await screen.findByText("Nightly audit");

    const schedulesOn = screen.getByRole("switch", { name: "Schedules on" });
    expect(schedulesOn.getAttribute("aria-checked")).toBe("false");
    const firstRow = screen.getByRole("switch", { name: "Enable Nightly audit" });
    expect(
      schedulesOn.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByText("Weekly triage")).toBeTruthy();
    // No time is promised for a schedule the project holds.
    expect(screen.getAllByText("Schedules off")).toHaveLength(2);
    expect(nextRuns()).toHaveLength(0);
  });

  it("keeps a switched-off schedule Paused while the project's are off", async () => {
    client.list.mockResolvedValue(
      snapshot([NIGHTLY, { ...WEEKLY, enabled: false }], 1, SCHEDULES_OFF)
    );
    renderTab();
    await screen.findByText("Weekly triage");
    expect(screen.getAllByText("Schedules off")).toHaveLength(1);
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("shows the job once main has written it, and until main has removed it", async () => {
    client.list.mockResolvedValue(snapshot([OPTED_IN], 1));
    const firstRead = deferred<ScheduleOsJobStatus>();
    const written = deferred<ScheduleOsJobStatus>();
    const removed = deferred<ScheduleOsJobStatus>();
    client.osJobStatus
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(written.promise)
      .mockReturnValueOnce(removed.promise);
    renderTab();
    await screen.findByText("Overnight build");
    await act(async () => firstRead.resolve(jobStatus("none")));

    client.setSwitches.mockResolvedValueOnce({
      status: "saved",
      snapshot: snapshot([OPTED_IN], 2, STARTS),
    });
    await act(async () => fireEvent.click(startSwitch()));
    expect(startSwitch().getAttribute("aria-checked")).toBe("true");
    expect(installed()).toBeNull();
    await act(async () => written.resolve(jobStatus("current")));
    expect(installed()).toBeTruthy();

    client.setSwitches.mockResolvedValueOnce({
      status: "saved",
      snapshot: snapshot([OPTED_IN], 3, SCHEDULES_ON),
    });
    await act(async () => fireEvent.click(startSwitch()));
    expect(startSwitch().getAttribute("aria-checked")).toBe("false");
    expect(installed()).toBeTruthy();
    await act(async () => removed.resolve(jobStatus("none")));
    expect(installed()).toBeNull();
  });

  it("reads the switches afresh for each opening of the editor", async () => {
    client.list.mockResolvedValue(snapshot([OPTED_IN], 1, STARTS));
    renderTab();
    await screen.findByText("Overnight build");
    const option = () =>
      screen.queryByRole("checkbox", { name: "Run when Daintree isn't running" });

    act(() => useSchedulesViewStore.getState().openEditor(OPTED_IN));
    await waitFor(() => expect(option()?.getAttribute("aria-checked")).toBe("true"));
    act(() => {
      useSchedulesViewStore.getState().closeEditor();
      useSchedulesViewStore.getState().clearEditor();
    });

    // Turned off elsewhere while no editor was watching; this opening's read hasn't answered.
    client.list.mockReturnValue(new Promise(() => {}));
    act(() => useSchedulesViewStore.getState().openEditor(OPTED_IN));
    await waitFor(() => expect(option()).not.toBeNull());
    expect(option()?.getAttribute("aria-checked")).toBe("false");
    act(() => {
      useSchedulesViewStore.getState().closeEditor();
      useSchedulesViewStore.getState().clearEditor();
    });

    // A read that fails keeps the old snapshot, which still never counts.
    client.list.mockRejectedValue(new Error("main went away"));
    act(() => useSchedulesViewStore.getState().openEditor(OPTED_IN));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "main went away, so this option keeps its saved setting"
      )
    );
    expect(option()?.getAttribute("aria-checked")).toBe("false");
  });

  it("turns the project's schedules on, and their next runs come back with main's answer", async () => {
    client.list.mockResolvedValue(snapshot([NIGHTLY], 1, SCHEDULES_OFF));
    client.setSwitches.mockResolvedValue({ status: "saved", snapshot: snapshot([NIGHTLY], 2) });
    renderTab();

    fireEvent.click(await screen.findByRole("switch", { name: "Schedules on" }));

    expect(client.setSwitches).toHaveBeenCalledWith({ schedulesOn: true });
    await waitFor(() => expect(nextRuns()).toHaveLength(1));
    expect(screen.queryByText("Schedules off")).toBeNull();
  });

  it("says a schedule's history waits on the project's switch", async () => {
    client.list.mockResolvedValue(snapshot([NIGHTLY], 1, SCHEDULES_OFF));
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run history of Nightly audit" }));

    expect(await screen.findByText("Schedules off")).toBeTruthy();
    expect(await screen.findByText(/Schedules are off for this project/)).toBeTruthy();
  });
});

describe("ProjectSchedulesTab — a run in its own new worktree (#16369)", () => {
  const RUN_WORKTREE = "/repo-worktrees/schedule-nightly-a";
  const runAt = (worktreeId: string, overrides: Partial<ScheduledRun> = {}): ScheduledRun => ({
    id: "run-1",
    scheduleId: "s1",
    projectId: "p1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: NOW - 500,
    terminalId: "terminal-1",
    terminalSpawnedAt: NOW - 400,
    settlement: {
      state: "settled",
      settledAt: NOW - 100,
      outcome: "done",
      evidence: { kind: "handback", report: "done", summary: null, truncated: false },
    },
    process: {
      agent: { state: "not-started" },
      pty: {
        state: "exited",
        startedAt: NOW - 400,
        exitedAt: NOW - 100,
        exitCode: 0,
        signal: null,
      },
    },
    pane: { state: "none" },
    resume: {
      agentId: "claude",
      agentSessionId: "0b6e3f9c-0d3e-4a55-8a0e-4b6ad8d6e9a1",
      cwd: worktreeId,
      worktreeId,
      agentLaunchFlags: [],
      agentModelId: null,
      agentPresetId: null,
    },
    newWorktree: { branch: "schedule-nightly-a", baseBranch: "main", worktreeId },
    ...overrides,
  });

  afterEach(() => {
    worktreeList.current = [];
    resumeSession.mockReset();
    client.listScheduleRuns.mockReset();
    client.listScheduleRuns.mockImplementation(async () => []);
  });

  it("names the base on the schedule's page and the branch on the run's row", async () => {
    client.list.mockResolvedValue(
      snapshot([
        {
          ...NIGHTLY,
          launch: {
            ...NIGHTLY.launch,
            newWorktree: { baseBranch: "origin/develop", fromRemote: true },
          },
        },
      ])
    );
    client.listScheduleRuns.mockResolvedValue([runAt(RUN_WORKTREE)]);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run history of Nightly audit" }));

    expect(await screen.findByText(/New worktree from origin\/develop/)).toBeTruthy();
    expect(await screen.findByText("schedule-nightly-a")).toBeTruthy();
    expect(screen.queryByText(/Main checkout/)).toBeNull();
  });

  it("names no branch on a run whose worktree was never made", async () => {
    client.list.mockResolvedValue(snapshot([NIGHTLY]));
    client.listScheduleRuns.mockResolvedValue([
      runAt(RUN_WORKTREE, {
        terminalId: null,
        terminalSpawnedAt: null,
        resume: null,
        process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
        settlement: {
          state: "settled",
          settledAt: NOW - 100,
          outcome: "failed",
          evidence: { kind: "launch-error", message: "The new worktree couldn't be created" },
        },
        newWorktree: { branch: "schedule-nightly-a", baseBranch: "main", worktreeId: null },
      }),
    ]);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run history of Nightly audit" }));

    expect(await screen.findByText("The new worktree couldn't be created")).toBeTruthy();
    expect(screen.queryByText("schedule-nightly-a")).toBeNull();
  });

  it("resumes in the run's own worktree, whatever the schedule says now", async () => {
    worktreeList.current = [
      { id: RUN_WORKTREE, path: RUN_WORKTREE, name: "run", isMainWorktree: false },
    ];
    client.list.mockResolvedValue(
      snapshot([{ ...NIGHTLY, launch: { ...NIGHTLY.launch, worktreeId: "/edited/since" } }])
    );
    client.listScheduleRuns.mockResolvedValue([runAt(RUN_WORKTREE)]);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run history of Nightly audit" }));

    fireEvent.click(await screen.findByRole("button", { name: /Resume run from/ }));

    expect(resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: RUN_WORKTREE, cwd: RUN_WORKTREE })
    );
  });
});

describe("ProjectSchedulesTab — landing on a request", () => {
  it("opens the schedule a request names on its history, once", async () => {
    useSchedulesViewStore.getState().open("s2");
    const { update } = renderTab();
    expect(await screen.findByRole("button", { name: "All schedules" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Weekly triage" })).toBeTruthy();
    expect(useSchedulesViewStore.getState().landedSeq).toBe(1);

    // Leaving project scope unmounts the tab; coming back doesn't land again.
    update({ mounted: false });
    update({ mounted: true });
    expect(await screen.findByRole("button", { name: "Add schedule" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All schedules" })).toBeNull();
  });

  it("lands only once it is in front", async () => {
    const { update } = renderTab({ isActive: false });
    act(() => useSchedulesViewStore.getState().open("s1"));
    expect(screen.queryByRole("button", { name: "All schedules" })).toBeNull();
    update({ isActive: true });
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
    const back = await screen.findByRole("button", { name: "All schedules" });
    expect(screen.getByRole("heading", { name: "Weekly triage" })).toBeTruthy();
    expect(useSchedulesViewStore.getState().landedSeq).toBe(1);
    // The row the editor handed focus back to is gone, so the new page takes it.
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it("tells a run's notification it is in front while it shows or an edit is open", async () => {
    const { update } = renderTab();
    await screen.findByText("Nightly audit");
    expect(isSchedulesViewHeld()).toBe(true);
    update({ isActive: false });
    expect(isSchedulesViewHeld()).toBe(false);

    update({ isActive: true });
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    await screen.findByTestId("schedule-editor-dialog");
    update({ mounted: false });
    expect(useSchedulesViewStore.getState().showing).toBe(false);
    expect(isSchedulesViewHeld()).toBe(true);
  });
});

describe("ProjectSchedulesTab — the editor", () => {
  it("hands focus to Project settings when the page it was opened from is hidden", async () => {
    /** Settings keeps a page it moved away from mounted, hidden. */
    function SettingsShell({ hidden }: { hidden: boolean }) {
      return (
        <>
          <div role="dialog" aria-modal="true">
            <div tabIndex={-1} data-testid="settings-surface">
              <div hidden={hidden}>
                <ProjectSchedulesTab isOpen isActive={!hidden} />
              </div>
            </div>
          </div>
          <ScheduleEditorHost />
        </>
      );
    }
    const { rerender } = render(<SettingsShell hidden={false} />);
    const edit = await screen.findByRole("button", { name: "Edit schedule Nightly audit" });
    edit.focus();
    fireEvent.click(edit);
    await screen.findByDisplayValue("Nightly audit");

    rerender(<SettingsShell hidden />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editor()).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("settings-surface"))
    );
  });

  it("never replaces an open draft with another opening", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    fireEvent.change(await screen.findByDisplayValue("Nightly audit"), {
      target: { value: "Renamed" },
    });
    act(() => useSchedulesViewStore.getState().openEditor(WEEKLY));
    expect(useSchedulesViewStore.getState().editor?.schedule?.id).toBe("s1");
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();
  });

  it("deleting from the editor keeps an opening that arrived mid-edit", async () => {
    client.remove.mockResolvedValue({ snapshot: snapshot([WEEKLY], 2) });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    await screen.findByDisplayValue("Nightly audit");
    act(() => useSchedulesViewStore.getState().open("s2"));

    fireEvent.click(screen.getByRole("button", { name: "Delete schedule…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(client.remove).toHaveBeenCalledExactlyOnceWith("s1"));
    await waitFor(() => expect(editor()).toBeNull());
    expect(await screen.findByRole("heading", { name: "Weekly triage" })).toBeTruthy();
  });

  it("goes back to the list after deleting the schedule whose history it was opened from", async () => {
    client.remove.mockResolvedValue({ snapshot: snapshot([WEEKLY], 2) });
    useSchedulesViewStore.getState().open("s1");
    renderTab();
    await screen.findByRole("heading", { name: "Nightly audit" });
    fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    await screen.findByDisplayValue("Nightly audit");

    fireEvent.click(screen.getByRole("button", { name: "Delete schedule…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(await screen.findByRole("button", { name: "Edit schedule Weekly triage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "All schedules" })).toBeNull();
  });

  it("keeps a draft when Settings unmounts the tab beneath it (Cmd+, to global scope)", async () => {
    const { update } = renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Edit schedule Nightly audit" }));
    fireEvent.change(await screen.findByDisplayValue("Nightly audit"), {
      target: { value: "Renamed" },
    });
    update({ mounted: false });
    expect(screen.queryByTestId("project-schedules-tab")).toBeNull();
    expect(editor()).toBeTruthy();
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard changes to 'Nightly audit'?")).toBeTruthy();
  });

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
