import { describe, expect, it } from "vitest";
import {
  pluginWorkHold,
  summarizePluginWorkStopped,
  type ProjectPluginWork,
} from "../projectPluginWork.js";

function work(overrides: Partial<ProjectPluginWork> & { pluginId: string }): ProjectPluginWork {
  return { liveTasks: [], pendingCalls: 0, runningProcesses: 0, ...overrides };
}

const TASK = { id: "t1", pluginName: "Sync", title: "Uploading" };

describe("pluginWorkHold (#14093)", () => {
  it("names the instance holding a live task ahead of one with a call in flight", () => {
    expect(
      pluginWorkHold([
        work({ pluginId: "project__p__a.calls", pendingCalls: 2 }),
        work({ pluginId: "project__p__a.tasks", liveTasks: [TASK] }),
      ])
    ).toBe("plugin-task:project__p__a.tasks");
  });

  it("holds for a call still in flight", () => {
    expect(pluginWorkHold([work({ pluginId: "project__p__a.calls", pendingCalls: 1 })])).toBe(
      "plugin-operation:project__p__a.calls"
    );
  });

  it("never holds for a managed process alone, however many are running", () => {
    expect(
      pluginWorkHold([
        work({ pluginId: "project__p__a.lsp", runningProcesses: 3 }),
        work({ pluginId: "project__p__a.watch", runningProcesses: 1 }),
      ])
    ).toBeNull();
  });

  it("holds nothing for a project with no plugin work", () => {
    expect(pluginWorkHold([])).toBeNull();
  });
});

describe("summarizePluginWorkStopped (#14093)", () => {
  it("lists every instance's tasks and totals its processes", () => {
    expect(
      summarizePluginWorkStopped([
        work({ pluginId: "project__p__a.sync", liveTasks: [TASK], runningProcesses: 1 }),
        work({
          pluginId: "project__p__a.lint",
          liveTasks: [{ id: "t2", pluginName: "Lint", title: "Linting" }],
          runningProcesses: 2,
        }),
      ])
    ).toEqual({
      tasks: [
        { pluginName: "Sync", title: "Uploading" },
        { pluginName: "Lint", title: "Linting" },
      ],
      processes: 3,
    });
  });

  it("reports nothing when only calls were in flight", () => {
    expect(
      summarizePluginWorkStopped([work({ pluginId: "project__p__a.calls", pendingCalls: 4 })])
    ).toBeNull();
  });
});
