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

import { switchProjectByHistory } from "../projectHistoryNav";

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

describe("switchProjectByHistory", () => {
  it("switches to the project main resolved", async () => {
    peekMock.mockResolvedValue({
      projectId: "target",
      name: "Target",
      emoji: "🌲",
    });

    await switchProjectByHistory("back");

    expect(peekMock).toHaveBeenCalledWith("back");
    expect(projectState.switchProject).toHaveBeenCalledWith("target");
  });

  it("reopens rather than switches when the destination is backgrounded", async () => {
    peekMock.mockResolvedValue({
      projectId: "parked",
      name: "Parked",
      emoji: "🌿",
    });

    await switchProjectByHistory("forward");

    // Backgrounded projects still hold live processes; reopen reconnects them
    // instead of treating the project as cold.
    expect(projectState.reopenProject).toHaveBeenCalledWith("parked");
    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("does nothing at either end of the stack", async () => {
    peekMock.mockResolvedValue(null);

    await switchProjectByHistory("back");

    expect(projectState.switchProject).not.toHaveBeenCalled();
    // Running out of history is not a failure worth interrupting for.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("ignores a step that resolves to the project already showing", async () => {
    peekMock.mockResolvedValue({
      projectId: "current",
      name: "Current",
      emoji: "🌲",
    });

    await switchProjectByHistory("back");

    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("surfaces a failed lookup with a retry that actually retries", async () => {
    peekMock.mockRejectedValueOnce(new Error("bridge gone"));

    await switchProjectByHistory("back");

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
    expect(peekMock).toHaveBeenLastCalledWith("back");
  });

  it("surfaces a failed switch with a retry", async () => {
    peekMock.mockResolvedValue({
      projectId: "target",
      name: "Target",
      emoji: "🌲",
    });
    projectState.switchProject.mockRejectedValue(new Error("view crashed"));

    await switchProjectByHistory("back");

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
