import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakePanel {
  kind?: string;
  location: string;
  worktreeId: string | null;
  scheduledRun?: { scheduleId: string; runId: string };
}

const fake = vi.hoisted(() => ({
  panels: {} as Record<string, FakePanel>,
  activeWorktreeId: "wt-main" as string | null,
  schedulesOpen: false,
  schedules: null as { schedules: Array<{ id: string }> } | null,
  listError: null as Error | null,
  list: null as (() => Promise<{ schedules: Array<{ id: string }> } | null>) | null,
  selectWorktree: vi.fn(),
  calls: [] as string[],
}));

const dispatch = vi.hoisted(() =>
  vi.fn(
    async (
      actionId: string,
      args?: { panelId?: string; scheduleId?: string },
      _options?: unknown
    ): Promise<{ ok: boolean; error?: unknown }> => {
      const panelId = args?.panelId;
      const where =
        actionId === "panel.focus" && panelId
          ? `:${panelId}@${fake.panels[panelId]?.location}`
          : "";
      fake.calls.push(`${actionId}${where}`);
      return { ok: true };
    }
  )
);

function moveTo(id: string, location: string): void {
  const panel = fake.panels[id];
  if (panel) panel.location = location;
}

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: fake.panels,
      restoreTerminal: (id: string) => {
        fake.calls.push(`restore:${id}`);
        moveTo(id, "grid");
      },
      restoreBackgroundTerminal: (id: string) => {
        fake.calls.push(`unbackground:${id}`);
        moveTo(id, "grid");
      },
      activateTerminal: (id: string) => fake.calls.push(`activate:${id}`),
    }),
  },
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: fake.activeWorktreeId,
      selectWorktree: fake.selectWorktree,
    }),
  },
}));
vi.mock("@/store/schedulesViewStore", () => ({
  useSchedulesViewStore: { getState: () => ({ isOpen: fake.schedulesOpen }) },
}));
vi.mock("@/clients/schedulesClient", () => ({
  schedulesClient: {
    list: async () => {
      if (fake.list) return fake.list();
      if (fake.listError) throw fake.listError;
      return fake.schedules;
    },
  },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { landOnScheduledRun } from "../scheduledRunLanding";

const runRef = { scheduleId: "schedule-1", runId: "run-1" };
const target = { runId: "run-1", scheduleId: "schedule-1", panelId: "terminal-1" };
const notSuperseded = () => false;
const opened = (args: unknown) => ["schedules.open", args, { source: "user" }];

beforeEach(() => {
  fake.panels = {};
  fake.activeWorktreeId = "wt-main";
  fake.schedulesOpen = false;
  fake.schedules = { schedules: [{ id: "schedule-1" }] };
  fake.listError = null;
  fake.list = null;
  dispatch.mockClear();
  fake.selectWorktree.mockClear();
  fake.calls = [];
});

describe("landOnScheduledRun", () => {
  it("brings the run's pane forward in its worktree and focuses it", async () => {
    fake.panels["terminal-1"] = {
      location: "grid",
      worktreeId: "wt-feature",
      scheduledRun: runRef,
    };
    await landOnScheduledRun(target, notSuperseded);

    expect(fake.selectWorktree).toHaveBeenCalledWith("wt-feature", { source: "user" });
    expect(fake.calls).toEqual(["activate:terminal-1", "panel.focus:terminal-1@grid"]);
  });

  it("restores a trashed or backgrounded pane before focusing it", async () => {
    fake.panels["terminal-1"] = { location: "trash", worktreeId: null, scheduledRun: runRef };
    await landOnScheduledRun(target, notSuperseded);
    fake.panels["terminal-2"] = {
      location: "background",
      worktreeId: null,
      scheduledRun: { scheduleId: "schedule-1", runId: "run-2" },
    };
    await landOnScheduledRun({ ...target, runId: "run-2", panelId: "terminal-2" }, notSuperseded);

    expect(fake.calls).toEqual([
      "restore:terminal-1",
      "activate:terminal-1",
      "panel.focus:terminal-1@grid",
      "unbackground:terminal-2",
      "activate:terminal-2",
      "panel.focus:terminal-2@grid",
    ]);
  });

  it.each<[string, Record<string, FakePanel>]>([
    ["the pane is gone", {}],
    [
      "the pane carries another run",
      {
        "terminal-1": {
          location: "grid",
          worktreeId: null,
          scheduledRun: { ...runRef, runId: "run-9" },
        },
      },
    ],
    ["the pane carries no run", { "terminal-1": { location: "grid", worktreeId: null } }],
    [
      "the pane is in a dialog",
      { "terminal-1": { location: "dialog", worktreeId: null, scheduledRun: runRef } },
    ],
    [
      "the id names a panel that isn't a terminal",
      {
        "terminal-1": { kind: "browser", location: "grid", worktreeId: null, scheduledRun: runRef },
      },
    ],
  ])("opens the schedule's history when %s", async (_name, panels) => {
    fake.panels = panels;
    await landOnScheduledRun(target, notSuperseded);
    expect(dispatch.mock.calls).toEqual([opened({ scheduleId: "schedule-1" })]);
    expect(fake.calls).toEqual(["schedules.open"]);
  });

  it("opens the history for a run with no terminal, whatever panes there are", async () => {
    fake.panels["terminal-1"] = { location: "grid", worktreeId: null, scheduledRun: runRef };
    await landOnScheduledRun({ ...target, panelId: null }, notSuperseded);
    expect(dispatch.mock.calls).toEqual([opened({ scheduleId: "schedule-1" })]);
  });

  it.each([
    ["the run's pane is here", "terminal-1"],
    ["the run has no pane", null],
  ])(
    "leaves a Schedules view already open as it is when %s, so an edit in it is never lost",
    async (_name, panelId) => {
      fake.panels["terminal-1"] = { location: "grid", worktreeId: null, scheduledRun: runRef };
      fake.schedulesOpen = true;
      await landOnScheduledRun({ ...target, panelId }, notSuperseded);
      expect(dispatch).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    }
  );

  it("opens the list for a schedule deleted since, and the schedule when they can't be read", async () => {
    fake.schedules = { schedules: [{ id: "schedule-2" }] };
    await landOnScheduledRun(target, notSuperseded);
    expect(dispatch).toHaveBeenLastCalledWith(...opened(undefined));

    fake.listError = new Error("no project bound");
    await landOnScheduledRun(target, notSuperseded);
    expect(dispatch).toHaveBeenLastCalledWith(...opened({ scheduleId: "schedule-1" }));
  });

  it("opens nothing once a newer landing took over while the schedules were read", async () => {
    let answer: () => void = () => {};
    fake.list = () =>
      new Promise((resolve) => {
        answer = () => resolve(fake.schedules);
      });
    let superseded = false;
    const landing = landOnScheduledRun(target, () => superseded);
    superseded = true;
    answer();
    await landing;
    expect(dispatch).not.toHaveBeenCalled();
  });
});
