import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { describePluginWorkStopped, notifyPluginWorkStopped } from "../pluginWorkStoppedNotice";

describe("plugin work stopped notice (#14093)", () => {
  beforeEach(() => notifyMock.mockClear());

  it("names a single stopped task and its plugin", () => {
    expect(
      describePluginWorkStopped("Web", {
        tasks: [{ pluginName: "Sync", title: "Uploading assets" }],
        processes: 0,
        calls: 0,
      })
    ).toBe(
      `Sync's "Uploading assets" stopped when Web went to sleep. Run it again once the project is open.`
    );
  });

  it("counts several tasks and the processes stopped alongside them", () => {
    const message = describePluginWorkStopped("Web", {
      tasks: [
        { pluginName: "Sync", title: "Uploading" },
        { pluginName: "Lint", title: "Linting" },
      ],
      processes: 1,
      calls: 0,
    });
    expect(message).toContain("2 plugin tasks stopped when Web went to sleep");
    expect(message).toContain("along with 1 plugin process.");
  });

  it("counts calls cut off in flight when no task was running", () => {
    expect(describePluginWorkStopped("Web", { tasks: [], processes: 0, calls: 2 })).toBe(
      "2 plugin calls stopped when Web went to sleep. Run it again once the project is open."
    );
  });

  it("mentions calls cut off alongside a stopped task", () => {
    expect(
      describePluginWorkStopped("Web", {
        tasks: [{ pluginName: "Sync", title: "Uploading" }],
        processes: 2,
        calls: 1,
      })
    ).toContain("along with 1 plugin call and 2 plugin processes.");
  });

  it("leaves no record when only processes stopped", () => {
    notifyPluginWorkStopped("Web", { tasks: [], processes: 3, calls: 0 });
    notifyPluginWorkStopped("Web", undefined);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("files the record in the inbox rather than interrupting", () => {
    notifyPluginWorkStopped("Web", {
      tasks: [{ pluginName: "Sync", title: "Uploading" }],
      processes: 0,
      calls: 0,
    });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", priority: "low" })
    );
  });
});
