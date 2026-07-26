import { describe, expect, it, vi, beforeEach } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
  currentProject: { id: "current" } as { id: string } | null,
  projects: [] as Array<{ id: string; status?: string }>,
  switchProject: vi.fn().mockResolvedValue(undefined),
  reopenProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notify", () => ({ notify: notifyMock }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));

import { switchToLastProject } from "../projectHistoryNav";

const peekMock = vi.fn();

beforeEach(() => {
  notifyMock.mockClear();
  peekMock.mockReset();
  projectState.currentProject = { id: "current" };
  projectState.projects = [
    { id: "current", status: "active" },
    { id: "target", status: "closed" },
    { id: "parked", status: "background" },
  ];
  projectState.switchProject.mockClear().mockResolvedValue(undefined);
  projectState.reopenProject.mockClear().mockResolvedValue(undefined);
  (globalThis as unknown as { window: unknown }).window = {
    electron: { projectHistory: { peek: peekMock } },
  };
});

describe("switchToLastProject", () => {
  it("switches to the project main resolved", async () => {
    peekMock.mockResolvedValue({
      projectId: "target",
      name: "Target",
      emoji: "🌲",
    });

    await switchToLastProject();

    // Main resolves the destination from the window it was asked through, so
    // the renderer must send nothing that could narrow or contradict it — a
    // leftover direction argument would be silently ignored on the wire.
    expect(peekMock).toHaveBeenCalledWith();
    expect(projectState.switchProject).toHaveBeenCalledWith("target");
  });

  it("keeps firing on rapid repeated presses", async () => {
    peekMock.mockResolvedValue({ projectId: "target" });

    for (let press = 0; press < 4; press++) await switchToLastProject();

    // Ping-ponging is the point of the key, and it is faster than a view swap.
    // An in-flight guard here rides in an LRU-cached view rather than dying
    // with it, so it survives in the view the user toggles back into and eats
    // the next press. Rate limiting belongs to the project store, which already
    // supersedes transitions by request id.
    expect(projectState.switchProject).toHaveBeenCalledTimes(4);
  });

  it("reopens rather than switches when the destination is backgrounded", async () => {
    peekMock.mockResolvedValue({
      projectId: "parked",
      name: "Parked",
      emoji: "🌿",
    });

    await switchToLastProject();

    // Backgrounded projects still hold live processes; reopen reconnects them
    // instead of treating the project as cold.
    expect(projectState.reopenProject).toHaveBeenCalledWith("parked");
    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("does nothing when the window has only seen one project", async () => {
    peekMock.mockResolvedValue(null);

    await switchToLastProject();

    expect(projectState.switchProject).not.toHaveBeenCalled();
    // Having nowhere to go is not a failure worth interrupting for.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("ignores a target that resolves to the project already showing", async () => {
    peekMock.mockResolvedValue({
      projectId: "current",
      name: "Current",
      emoji: "🌲",
    });

    await switchToLastProject();

    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("surfaces a failed lookup with a retry that actually retries", async () => {
    peekMock.mockRejectedValueOnce(new Error("bridge gone"));

    await switchToLastProject();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]![0] as {
      type: string;
      actions: Array<{ onClick: () => void }>;
    };
    expect(call.type).toBe("error");

    // Assert the action works rather than that its label matches the source.
    peekMock.mockResolvedValue({ projectId: "target" });
    call.actions[0]!.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(peekMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed switch with a retry", async () => {
    peekMock.mockResolvedValue({
      projectId: "target",
      name: "Target",
      emoji: "🌲",
    });
    projectState.switchProject.mockRejectedValue(new Error("view crashed"));

    await switchToLastProject();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
