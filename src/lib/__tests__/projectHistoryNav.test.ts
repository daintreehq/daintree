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
// The view's own immutable workspace id, seeded by main at view creation.
const viewWorkspaceId = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => viewWorkspaceId.current,
}));

import { switchToLastWorkspace } from "../projectHistoryNav";

const peekMock = vi.fn();

// Real id shapes: routing is decided by the shape, not by store membership.
const CURRENT_PROJECT = "c".repeat(64);
const TARGET_PROJECT = "1".repeat(64);
const PARKED_PROJECT = "2".repeat(64);
const SCRATCH_ONE = "11111111-1111-4111-8111-111111111111";
const SCRATCH_TWO = "22222222-2222-4222-9222-222222222222";

beforeEach(() => {
  notifyMock.mockClear();
  peekMock.mockReset();
  viewWorkspaceId.current = CURRENT_PROJECT;
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
    scratchState.scratches = [{ id: SCRATCH_ONE }];
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
    // A scratch view is seeded with its own scratch id, which is what says the
    // window is already there — the project pointer is null on a scratch.
    viewWorkspaceId.current = SCRATCH_ONE;
    projectState.currentProject = null;
    scratchState.currentScratch = { id: SCRATCH_ONE };
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });

    await switchToLastWorkspace();

    expect(scratchState.switchScratch).not.toHaveBeenCalled();
  });

  it("still switches when another window entered the scratch this one is toggling into", async () => {
    // This view owns scratch one, so its project pointer is null — and
    // `currentScratch` is broadcast to every renderer, so a sibling window
    // entering scratch two sets it here too. Reading the window's position from
    // that pointer makes this press look like a switch to where we already are
    // and swallows it, in the workspace people toggle into most.
    viewWorkspaceId.current = SCRATCH_ONE;
    projectState.currentProject = null;
    scratchState.currentScratch = { id: SCRATCH_TWO };
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_TWO });

    await switchToLastWorkspace();

    expect(scratchState.switchScratch).toHaveBeenCalledWith(SCRATCH_TWO);
  });

  it("switches back to the project a never-reloaded renderer booted on", async () => {
    // The legacy single-renderer keeps one view for every project, so its
    // seeded id stays pinned to the project it launched with. Trusting that
    // over the live pointer would make the toggle home refuse to go home.
    viewWorkspaceId.current = TARGET_PROJECT;
    projectState.currentProject = { id: CURRENT_PROJECT };
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });

    await switchToLastWorkspace();

    expect(projectState.switchProject).toHaveBeenCalledWith(TARGET_PROJECT);
  });

  it("still switches to a project while the window is in a scratch", async () => {
    viewWorkspaceId.current = SCRATCH_ONE;
    projectState.currentProject = null;
    scratchState.currentScratch = { id: SCRATCH_ONE };
    peekMock.mockResolvedValue({ workspaceId: TARGET_PROJECT });

    await switchToLastWorkspace();

    expect(projectState.switchProject).toHaveBeenCalledWith(TARGET_PROJECT);
  });

  it("dispatches a project target before the project list has hydrated", async () => {
    // The list only picks switch-vs-reopen. Treating an unlisted id as unknown
    // would strand the toggle for the whole boot window.
    projectState.projects = [];
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

  it("surfaces a failed scratch switch with a retry that actually retries", async () => {
    peekMock.mockResolvedValue({ workspaceId: SCRATCH_ONE });
    scratchState.switchScratch.mockRejectedValueOnce(new Error("scratch gone"));

    await switchToLastWorkspace();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]![0] as {
      actions: Array<{ onClick: () => void }>;
    };

    call.actions[0]!.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(scratchState.switchScratch).toHaveBeenCalledTimes(2);
  });
});
