import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakePanel {
  location: string;
  worktreeId: string | null;
  scheduledRun?: { scheduleId: string; runId: string };
}

const fake = vi.hoisted(() => ({
  panels: {} as Record<string, FakePanel>,
  activeWorktreeId: "wt-main" as string | null,
  schedules: null as { schedules: Array<{ id: string }> } | null,
  listError: null as Error | null,
  onList: null as (() => void) | null,
  dispatch: vi.fn(
    async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; error?: unknown }
  ),
  selectWorktree: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: fake.panels,
      restoreTerminal: (id: string) => {
        fake.calls.push(`restore:${id}`);
        fake.panels[id] = { ...fake.panels[id], location: "grid" };
      },
      restoreBackgroundTerminal: (id: string) => {
        fake.calls.push(`unbackground:${id}`);
        fake.panels[id] = { ...fake.panels[id], location: "grid" };
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
vi.mock("@/clients/schedulesClient", () => ({
  schedulesClient: {
    list: async () => {
      fake.onList?.();
      if (fake.listError) throw fake.listError;
      return fake.schedules;
    },
  },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: fake.dispatch } }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { landOnScheduledRun } from "../scheduledRunLanding";

const runRef = { scheduleId: "schedule-1", runId: "run-1" };
const target = { runId: "run-1", scheduleId: "schedule-1", panelId: "terminal-1" };
const notSuperseded = () => false;

beforeEach(() => {
  fake.panels = {};
  fake.activeWorktreeId = "wt-main";
  fake.schedules = { schedules: [{ id: "schedule-1" }] };
  fake.listError = null;
  fake.onList = null;
  fake.dispatch.mockClear();
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
    expect(fake.dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "terminal-1" });
    expect(fake.dispatch).not.toHaveBeenCalledWith(
      "schedules.open",
      expect.anything(),
      expect.anything()
    );
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
      "unbackground:terminal-2",
      "activate:terminal-2",
    ]);
    expect(fake.dispatch.mock.calls.map(([id]) => id)).toEqual(["panel.focus", "panel.focus"]);
  });

  it.each([
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
  ])("opens the schedule's history when %s", async (_name, panels) => {
    fake.panels = panels as Record<string, FakePanel>;
    await landOnScheduledRun(target, notSuperseded);
    expect(fake.dispatch).toHaveBeenCalledWith(
      "schedules.open",
      { scheduleId: "schedule-1" },
      { source: "user" }
    );
    expect(fake.dispatch).not.toHaveBeenCalledWith("panel.focus", expect.anything());
  });

  it("opens the history for a run that never had a terminal", async () => {
    await landOnScheduledRun({ ...target, panelId: null }, notSuperseded);
    expect(fake.dispatch).toHaveBeenCalledWith(
      "schedules.open",
      { scheduleId: "schedule-1" },
      { source: "user" }
    );
  });

  it("opens the list for a schedule deleted since, and the schedule when they can't be read", async () => {
    fake.schedules = { schedules: [{ id: "schedule-2" }] };
    await landOnScheduledRun(target, notSuperseded);
    expect(fake.dispatch).toHaveBeenLastCalledWith("schedules.open", undefined, { source: "user" });

    fake.listError = new Error("no project bound");
    await landOnScheduledRun(target, notSuperseded);
    expect(fake.dispatch).toHaveBeenLastCalledWith(
      "schedules.open",
      { scheduleId: "schedule-1" },
      { source: "user" }
    );
  });

  it("opens nothing once a newer landing took over while the schedules were read", async () => {
    let superseded = false;
    fake.onList = () => {
      superseded = true;
    };
    await landOnScheduledRun(target, () => superseded);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });
});
