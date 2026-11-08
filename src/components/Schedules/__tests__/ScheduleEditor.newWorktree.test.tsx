// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSchedule } from "@shared/utils/scheduledRuns";
import type { Schedule } from "@shared/types/scheduledRuns";

// No jest-dom in this repo — plain DOM reads only.

const clientMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const listBranches = vi.hoisted(() => vi.fn());
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: clientMock }));
vi.mock("@/clients/worktreeClient", () => ({ worktreeClient: { listBranches } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { path: string } }) => unknown) =>
    selector({ currentProject: { path: "/repo" } }),
}));
vi.mock("@/components/Worktree/hooks/useFirstAgentOptions", () => ({
  useFirstAgentOptions: () => [{ id: "claude", name: "Claude", iconId: "claude" }],
}));
vi.mock("../useScheduleLaunchOptions", () => ({
  useScheduleLaunchOptions: () => ({ presets: [], preset: undefined, stopsAtPrompts: false }),
}));

import { ScheduleEditor, type EditorLeaveState } from "../ScheduleEditor";
import { scheduleWorktreeLabel } from "../scheduleWords";

const NOW = Date.UTC(2027, 0, 4, 8);
const BRANCHES = [
  { name: "main", current: true, commit: "a" },
  { name: "origin/develop", current: false, commit: "b", remote: "origin" },
];

function existing(launch: Partial<Schedule["launch"]> = {}): Schedule {
  const schedule = createSchedule(
    {
      id: "s1",
      projectId: "p1",
      name: "Nightly",
      launch: { agentId: "claude", prompt: "Go." },
      timeZone: "Europe/London",
    },
    NOW - 1000
  );
  return { ...schedule, launch: { ...schedule.launch, ...launch } };
}

function renderEditor(schedule: Schedule) {
  render(
    <ScheduleEditor
      schedule={schedule}
      defaultAgentId="claude"
      worktrees={[
        { id: null, label: "Main checkout" },
        { id: "/wt", label: "feature" },
      ]}
      now={NOW}
      osJobContext={null}
      leaveStateRef={createRef<EditorLeaveState | null>()}
      onSaved={vi.fn()}
      onDeleted={vi.fn()}
      onCancel={vi.fn()}
      onOpenAgentSettings={vi.fn()}
      projectSwitches={null}
    />
  );
}

async function chooseWorktree(name: string) {
  const trigger = screen.getByRole("combobox", { name: "Worktree" });
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  const option = await screen.findByRole("option", { name });
  await act(async () => fireEvent.keyDown(option, { key: "Enter" }));
}

const save = () =>
  act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));

beforeEach(() => {
  vi.clearAllMocks();
  listBranches.mockResolvedValue(BRANCHES);
  clientMock.update.mockResolvedValue({
    status: "saved",
    schedule: existing(),
    snapshot: { projectId: "p1", schedules: [], revision: 1 },
  });
  Element.prototype.scrollIntoView ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.releasePointerCapture ??= () => {};
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

describe("ScheduleEditor: a new worktree each run (#16369)", () => {
  it("reads no branches and sends no base for a schedule that doesn't use it", async () => {
    renderEditor(existing());

    expect(screen.queryByText("Base branch")).toBeNull();
    expect(listBranches).not.toHaveBeenCalled();

    await chooseWorktree("feature");
    await save();

    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({
        launch: expect.objectContaining({ worktreeId: "/wt", newWorktree: null }),
      })
    );
  });

  it("won't save the mode without a base branch, and says which field", async () => {
    renderEditor(existing());
    await chooseWorktree("New worktree each run");
    await save();

    expect(clientMock.update).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a base branch")).toBeTruthy();
  });

  it("saves the chosen remote base, clearing any fixed worktree", async () => {
    renderEditor(existing({ worktreeId: "/wt" }));
    await chooseWorktree("New worktree each run");
    await waitFor(() => expect(listBranches).toHaveBeenCalledWith("/repo"));

    await act(async () => fireEvent.click(screen.getByRole("combobox", { name: "Base branch" })));
    const remote = await screen.findByRole("option", { name: /origin\/develop/ });
    await act(async () => fireEvent.click(remote));
    await save();

    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({
        launch: expect.objectContaining({
          worktreeId: null,
          newWorktree: { baseBranch: "origin/develop", fromRemote: true },
        }),
      })
    );
  });

  it("counts a change of base alone as a change, the kind of base included", async () => {
    renderEditor(existing({ newWorktree: { baseBranch: "main", fromRemote: false } }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Base branch" })).toBeTruthy());
    expect(screen.queryByText("No changes to save")).not.toBeNull();

    await act(async () => fireEvent.click(screen.getByRole("combobox", { name: "Base branch" })));
    await act(async () =>
      fireEvent.click(await screen.findByRole("option", { name: /origin\/develop/ }))
    );

    expect(screen.queryByText("No changes to save")).toBeNull();
    await save();
    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({
        launch: expect.objectContaining({
          newWorktree: { baseBranch: "origin/develop", fromRemote: true },
        }),
      })
    );
  });

  it("keeps the base when the choice moves away and back", async () => {
    renderEditor(existing({ newWorktree: { baseBranch: "main", fromRemote: false } }));

    await chooseWorktree("feature");
    expect(screen.queryByText("Base branch")).toBeNull();
    await chooseWorktree("New worktree each run");
    await save();

    expect(clientMock.update).not.toHaveBeenCalled();
    expect(screen.queryByText("No changes to save")).not.toBeNull();
    expect(screen.getByText("Base branch")).toBeTruthy();
  });

  it("takes keyboard focus to the base when saving without one", async () => {
    renderEditor(existing());
    await chooseWorktree("New worktree each run");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Base branch" })).toBeTruthy());

    await save();

    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Base branch" }));
  });

  it("shows main's refusal on the base field", async () => {
    clientMock.update.mockResolvedValue({
      status: "invalid",
      issues: [
        {
          path: "launch.newWorktree.baseBranch",
          message: "Choose a base branch",
        },
      ],
    });
    renderEditor(existing({ newWorktree: { baseBranch: "main", fromRemote: false } }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Base branch" })).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("combobox", { name: "Base branch" })));
    await act(async () =>
      fireEvent.click(await screen.findByRole("option", { name: /origin\/develop/ }))
    );

    await save();

    expect(screen.getByText("Choose a base branch")).toBeTruthy();
  });

  it("says a stored base the project no longer has is missing, and saves it unchanged", async () => {
    renderEditor(existing({ newWorktree: { baseBranch: "gone", fromRemote: true } }));
    await waitFor(() => expect(screen.getByText("gone (missing)")).toBeTruthy());

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed" },
    });
    await save();

    expect(clientMock.update).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({
        name: "Renamed",
        launch: expect.objectContaining({
          newWorktree: { baseBranch: "gone", fromRemote: true },
        }),
      })
    );
  });

  it("says where the check runs, since no worktree exists yet", async () => {
    renderEditor(
      createSchedule(
        {
          id: "s1",
          projectId: "p1",
          name: "Nightly",
          launch: {
            agentId: "claude",
            prompt: "Go.",
            newWorktree: { baseBranch: "main", fromRemote: false },
          },
          policies: { precondition: { command: "true" } },
        },
        NOW - 1000
      )
    );

    await waitFor(() => expect(screen.getByText(/before a worktree is made/)).toBeTruthy());
  });
});

describe("scheduleWorktreeLabel", () => {
  const labels = new Map([["/wt", "feature"]]);

  it("names the base of a new-worktree schedule, never its main checkout", () => {
    expect(
      scheduleWorktreeLabel(
        { worktreeId: null, newWorktree: { baseBranch: "origin/develop", fromRemote: true } },
        labels
      )
    ).toBe("New worktree from origin/develop");
  });

  it("reads fixed targets as before", () => {
    expect(scheduleWorktreeLabel({ worktreeId: null, newWorktree: null }, labels)).toBeNull();
    expect(scheduleWorktreeLabel({ worktreeId: "/wt", newWorktree: null }, labels)).toBe("feature");
    expect(scheduleWorktreeLabel({ worktreeId: "/gone", newWorktree: null }, labels)).toBe(
      "Missing worktree"
    );
  });
});
