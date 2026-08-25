import { describe, expect, it, vi, beforeEach } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
  currentProject: { id: "current" } as { id: string } | null,
  projects: [] as Array<{ id: string; status?: string }>,
  switchProject: vi.fn().mockResolvedValue(undefined),
  reopenProject: vi.fn().mockResolvedValue(undefined),
}));
const scratchState = vi.hoisted(() => ({
  currentScratch: null as { id: string } | null,
  scratches: [] as Array<{ id: string }>,
  switchScratch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notify", () => ({ notify: notifyMock }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => scratchState },
}));

import { switchToLastWorkspace } from "../projectHistoryNav";

const peekMock = vi.fn();

// Real id shapes: routing is decided by the shape, not by store membership.
const CURRENT_PROJECT = "c".repeat(64);
const TARGET_PROJECT = "1".repeat(64);
const PARKED_PROJECT = "2".repeat(64);
const SCRATCH_ONE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  notifyMock.mockClear();
  peekMock.mockReset();
  projectState.currentProject = { id: CURRENT_PROJECT };
  projectState.projects = [
    { id: CURRENT_PROJECT, status: "active" },
    { id: TARGET_PROJECT, status: "closed" },
    { id: PARKED_PROJECT, status: "background" },
  ];
  projectState.switchProject.mockClear().mockResolvedValue(undefined);
  projectState.reopenProject.mockClear().mockResolvedValue(undefined);
  scratchState.currentScratch = null;
  scratchState.scratches = [];
  scratchState.switchScratch.mockClear().mockResolvedValue(undefined);
  (globalThis as unknown as { window: unknown }).window = {
    electron: { projectHistory: { peek: peekMock } },
  };
});

describe("switchToLastWorkspace", () => {
  it("switches to the project main resolved", async () => {
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });

    await switchToLastWorkspace();

    // Main resolves the destination from the window it was asked through, so
    // the renderer must send nothing that could narrow or contradict it — a
    // leftover direction argument would be silently ignored on the wire.
    expect(peekMock).toHaveBeenCalledWith();
    expect(projectState.switchProject).toHaveBeenCalledWith(TARGET_PROJECT);
  });

  it("keeps firing on rapid repeated presses", async () => {
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });

    for (let press = 0; press < 4; press++) await switchToLastWorkspace();

    // Ping-ponging is the point of the key, and it is faster than a view swap.
    // An in-flight guard here rides in an LRU-cached view rather than dying
    // with it, so it survives in the view the user toggles back into and eats
    // the next press. Rate limiting belongs to the project store, which already
    // supersedes transitions by request id.
    expect(projectState.switchProject).toHaveBeenCalledTimes(4);
  });

  it("reopens rather than switches when the destination is backgrounded", async () => {
    peekMock.mockResolvedValue({ workspaceId: PARKED_PROJECT });

    await switchToLastWorkspace();

    // Backgrounded projects still hold live processes; reopen reconnects them
    // instead of treating the project as cold.
    expect(projectState.reopenProject).toHaveBeenCalledWith(PARKED_PROJECT);
    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("switches to a scratch through the scratch store", async () => {
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });

    await switchToLastWorkspace();

    // `switchProject` rejects a scratch id outright, so a scratch destination
    // that fell through to the project path did nothing at all (#11936).
    expect(scratchState.switchScratch).toHaveBeenCalledWith(SCRATCH_ONE);
    expect(projectState.switchProject).not.toHaveBeenCalled();
    expect(projectState.reopenProject).not.toHaveBeenCalled();
  });

  it("routes a scratch on its id shape before the scratch list has loaded", async () => {
    // Both stores hydrate asynchronously. A membership test here answers "has
    // the list arrived yet", which sends a scratch down the project path during
    // exactly the boot window where the shortcut is most likely to be pressed.
    scratchState.scratches = [];
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });

    await switchToLastWorkspace();

    expect(scratchState.switchScratch).toHaveBeenCalledWith(SCRATCH_ONE);
  });

  it("does nothing when the window has only seen one workspace", async () => {
    peekMock.mockResolvedValue(null);

    await switchToLastWorkspace();

    expect(projectState.switchProject).not.toHaveBeenCalled();
    expect(scratchState.switchScratch).not.toHaveBeenCalled();
    // Having nowhere to go is not a failure worth interrupting for.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("ignores a target that resolves to the project already showing", async () => {
    peekMock.mockResolvedValue({ workspaceId: CURRENT_PROJECT });

    await switchToLastWorkspace();

    expect(projectState.switchProject).not.toHaveBeenCalled();
  });

  it("ignores a target that resolves to the scratch already showing", async () => {
    // On a scratch the project pointer is null, so the window's own position
    // can only be read from the scratch pointer.
    projectState.currentProject = null;
    scratchState.currentScratch = { id: SCRATCH_ONE };
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });

    await switchToLastWorkspace();

    expect(scratchState.switchScratch).not.toHaveBeenCalled();
  });

  it("still switches to a project while the window is in a scratch", async () => {
    projectState.currentProject = null;
    scratchState.currentScratch = { id: SCRATCH_ONE };
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });

    await switchToLastWorkspace();

    expect(projectState.switchProject).toHaveBeenCalledWith(TARGET_PROJECT);
  });

  it("surfaces a failed lookup with a retry that actually retries", async () => {
    peekMock.mockRejectedValueOnce(new Error("bridge gone"));

    await switchToLastWorkspace();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]![0] as {
      type: string;
      actions: Array<{ onClick: () => void }>;
    };
    expect(call.type).toBe("error");

    // Assert the action works rather than that its label matches the source.
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });
    call.actions[0]!.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(peekMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed switch with a retry", async () => {
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });
    projectState.switchProject.mockRejectedValue(new Error("view crashed"));

    await switchToLastWorkspace();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed scratch switch with a retry", async () => {
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });
    scratchState.switchScratch.mockRejectedValue(new Error("scratch gone"));

    await switchToLastWorkspace();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
