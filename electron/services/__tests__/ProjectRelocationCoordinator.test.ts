import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so vi.mock factories can reference them) ---------------

const fsState = vi.hoisted(() => ({
  existing: new Set<string>(),
  devByPath: new Map<string, number>(),
  renameReject: null as Error | null,
  renameCalls: [] as Array<{ from: string; to: string }>,
}));

vi.mock("fs", () => ({
  existsSync: (p: string) => fsState.existing.has(p),
  statSync: (p: string) => {
    if (!fsState.existing.has(p)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return { dev: fsState.devByPath.get(p) ?? 1, isDirectory: () => true };
  },
}));

vi.mock("fs/promises", () => ({
  rename: async (from: string, to: string) => {
    fsState.renameCalls.push({ from, to });
    if (fsState.renameReject) throw fsState.renameReject;
    fsState.existing.delete(from);
    fsState.existing.add(to);
  },
}));

const mockProjectStore = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getCurrentProjectId: vi.fn(() => null as string | null),
  finalizeRelocatedPath: vi.fn(),
  relocateProject: vi.fn(),
  beginRelocationRewrite: vi.fn(),
  endRelocationRewrite: vi.fn(),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: mockProjectStore,
  normalizeProjectPath: (p: string) => p.normalize("NFC"),
}));

const mockBroadcast = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: mockBroadcast }));

const mockAssistant = vi.hoisted(() => ({
  getAssistantBackend: vi.fn(() => null as { terminalId: string; webContentsId: number } | null),
}));
vi.mock("../HelpSessionService.js", () => ({ helpSessionService: mockAssistant }));

const mockWriteHibernatedMarker = vi.hoisted(() => vi.fn());
vi.mock("../pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: mockWriteHibernatedMarker,
}));

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { CHANNELS } from "../../ipc/channels.js";
import {
  ProjectRelocationCoordinator,
  ProjectRelocationError,
} from "../ProjectRelocationCoordinator.js";

// --- Fixtures --------------------------------------------------------------

const PROJECT_ID = "abc123";
const OLD_ROOT = "/vol/projects/proj";
const NEW_ROOT = "/vol/projects/proj-renamed";

function makeProject(overrides: Record<string, unknown> = {}) {
  return { id: PROJECT_ID, path: OLD_ROOT, name: "Proj", status: "active", ...overrides };
}

interface FakeView {
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

function makePvm(activeProjectId: string | null) {
  const view: FakeView = { webContents: { isDestroyed: () => false, send: vi.fn() } };
  return {
    getActiveProjectId: () => activeProjectId,
    getOutgoingBridgeProjectId: () => null,
    rebindProjectPath: vi.fn(async () => view.webContents),
    views: new Map([[PROJECT_ID, { view }]]),
    _view: view,
  };
}

function makeDeps(pvm: ReturnType<typeof makePvm> | null) {
  const windowRegistry = {
    all: () => (pvm ? [{ windowId: 1, services: { projectViewManager: pvm } }] : []),
  };
  const ptyClient = {
    gracefulKillByProject: vi.fn(async () => [{ id: "t1", agentSessionId: "sess-1" }]),
    onProjectSwitch: vi.fn(),
  };
  const worktreeService = {
    evictProjectForRelocation: vi.fn(),
    loadProject: vi.fn(async () => {}),
    getHostForProject: vi.fn(() => ({}) as unknown),
    attachDirectPort: vi.fn(),
  };
  const worktreePortBroker = { brokerPort: vi.fn(() => true) };
  return { ptyClient, worktreeService, windowRegistry, worktreePortBroker };
}

// deps use runtime-shaped fakes; the coordinator only touches the methods above.
/* eslint-disable @typescript-eslint/no-explicit-any */
function configure(coordinator: ProjectRelocationCoordinator, deps: ReturnType<typeof makeDeps>) {
  coordinator.configure(deps as any);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  vi.clearAllMocks();
  fsState.existing = new Set([OLD_ROOT, "/vol/projects"]);
  fsState.devByPath = new Map([
    [OLD_ROOT, 10],
    ["/vol/projects", 10],
  ]);
  fsState.renameReject = null;
  fsState.renameCalls = [];
  mockProjectStore.getProjectById.mockReturnValue(makeProject());
  mockProjectStore.getCurrentProjectId.mockReturnValue(null);
  mockProjectStore.finalizeRelocatedPath.mockResolvedValue(
    makeProject({ path: NEW_ROOT })
  );
  mockProjectStore.relocateProject.mockResolvedValue(makeProject({ path: NEW_ROOT }));
  mockAssistant.getAssistantBackend.mockReturnValue(null);
});

describe("ProjectRelocationCoordinator — managed move of an open project", () => {
  it("quiesces, renames once, finalizes with preserved status, rebinds and reopens", async () => {
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    const result = await coordinator.relocate({
      projectId: PROJECT_ID,
      mode: "move",
      newPath: NEW_ROOT,
    });

    // Quiesce: graceful, session-preserving PTY kill + hibernation marker + host evict.
    expect(deps.ptyClient.gracefulKillByProject).toHaveBeenCalledWith(PROJECT_ID, {
      preserveSession: true,
    });
    expect(mockWriteHibernatedMarker).toHaveBeenCalledWith("t1");
    expect(deps.worktreeService.evictProjectForRelocation).toHaveBeenCalledWith(OLD_ROOT);

    // Exactly one rename, forward-only.
    expect(fsState.renameCalls).toEqual([{ from: OLD_ROOT, to: NEW_ROOT }]);

    // Finalize preserves the OPEN project's status (not forced "closed").
    expect(mockProjectStore.finalizeRelocatedPath).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedOldPath: OLD_ROOT,
      newPath: NEW_ROOT,
      status: "active",
    });

    // Rebind + live-repoint + reopen at the NEW path.
    expect(pvm.rebindProjectPath).toHaveBeenCalledWith(PROJECT_ID, NEW_ROOT);
    expect(mockBroadcast).toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, makeProject({ path: NEW_ROOT }));
    expect(deps.worktreeService.loadProject).toHaveBeenCalledWith(NEW_ROOT, 1);
    expect(deps.ptyClient.onProjectSwitch).toHaveBeenCalledWith(1, PROJECT_ID, NEW_ROOT);

    // The renderer view is never evicted (kept alive) — a clean worktree-load status is sent.
    expect(pvm._view.webContents.send).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: PROJECT_ID,
      worktreeLoadError: null,
    });
    expect(result.path).toBe(NEW_ROOT);
    // Reservation released.
    expect(coordinator.isRelocating(PROJECT_ID)).toBe(false);
    expect(mockProjectStore.endRelocationRewrite).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("refuses a cross-volume move up front — nothing is stopped or renamed", async () => {
    // Destination parent on a different device.
    fsState.existing.add("/other");
    fsState.devByPath.set("/other", 99);
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await expect(
      coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: "/other/proj" })
    ).rejects.toMatchObject({ reason: "cross-volume" });

    expect(deps.ptyClient.gracefulKillByProject).not.toHaveBeenCalled();
    expect(deps.worktreeService.evictProjectForRelocation).not.toHaveBeenCalled();
    expect(fsState.renameCalls).toHaveLength(0);
    expect(mockProjectStore.finalizeRelocatedPath).not.toHaveBeenCalled();
  });
});

describe("ProjectRelocationCoordinator — guard fork", () => {
  it("delegates a closed reattach to ProjectStore.relocateProject (no quiesce)", async () => {
    fsState.existing.add(NEW_ROOT);
    const pvm = makePvm(null); // not the active project in any window
    const deps = makeDeps(pvm);
    mockProjectStore.getCurrentProjectId.mockReturnValue(null);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await coordinator.relocate({ projectId: PROJECT_ID, mode: "reattach", newPath: NEW_ROOT });

    expect(mockProjectStore.relocateProject).toHaveBeenCalledWith(PROJECT_ID, NEW_ROOT);
    expect(deps.ptyClient.gracefulKillByProject).not.toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, makeProject({ path: NEW_ROOT }));
  });

  it("routes an open reattach through the coordinator pipeline", async () => {
    fsState.existing.add(NEW_ROOT);
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await coordinator.relocate({ projectId: PROJECT_ID, mode: "reattach", newPath: NEW_ROOT });

    // Reattach: folder already at newPath, so no rename, but full quiesce/rebind.
    expect(fsState.renameCalls).toHaveLength(0);
    expect(deps.ptyClient.gracefulKillByProject).toHaveBeenCalled();
    expect(mockProjectStore.finalizeRelocatedPath).toHaveBeenCalled();
    expect(mockProjectStore.relocateProject).not.toHaveBeenCalled();
  });

  it("treats a second-window (unfocused) project as open via the id union", async () => {
    // getCurrentProjectId (last-focused window) does NOT name this project, but a
    // PVM does — the union must still route it through the coordinator.
    mockProjectStore.getCurrentProjectId.mockReturnValue("some-other-project");
    fsState.existing.add(NEW_ROOT);
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await coordinator.relocate({ projectId: PROJECT_ID, mode: "reattach", newPath: NEW_ROOT });

    expect(deps.ptyClient.gracefulKillByProject).toHaveBeenCalled();
    expect(mockProjectStore.relocateProject).not.toHaveBeenCalled();
  });
});

describe("ProjectRelocationCoordinator — rollback vs forward-fail boundary", () => {
  it("rolls back before the rename: a rename failure reopens at the ORIGINAL path and never renames backward", async () => {
    fsState.renameReject = new Error("EPERM");
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await expect(
      coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: NEW_ROOT })
    ).rejects.toBeInstanceOf(ProjectRelocationError);

    // Durable state untouched, reopened at the old path.
    expect(mockProjectStore.finalizeRelocatedPath).not.toHaveBeenCalled();
    expect(deps.worktreeService.loadProject).toHaveBeenCalledWith(OLD_ROOT, 1);
    // Only the forward rename was attempted — never a reverse rename.
    expect(fsState.renameCalls).toEqual([{ from: OLD_ROOT, to: NEW_ROOT }]);
    expect(coordinator.isRelocating(PROJECT_ID)).toBe(false);
  });

  it("forward-fails after the rename: a reopen failure surfaces the Tier-3 banner and does NOT revert", async () => {
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    deps.worktreeService.loadProject.mockRejectedValue(new Error("host spawn failed"));
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    const result = await coordinator.relocate({
      projectId: PROJECT_ID,
      mode: "move",
      newPath: NEW_ROOT,
    });

    // The move committed and is NOT reverted.
    expect(fsState.renameCalls).toEqual([{ from: OLD_ROOT, to: NEW_ROOT }]);
    expect(result.path).toBe(NEW_ROOT);
    // The failure surfaces as a worktree-load error banner (Retry recovers).
    expect(pvm._view.webContents.send).toHaveBeenCalledWith(
      CHANNELS.PROJECT_WORKTREE_LOAD_STATUS,
      expect.objectContaining({ projectId: PROJECT_ID, worktreeLoadError: expect.any(String) })
    );
  });
});

describe("ProjectRelocationCoordinator — guards", () => {
  it("refuses to relocate while the Daintree Assistant is active", async () => {
    mockAssistant.getAssistantBackend.mockReturnValue({ terminalId: "help-1", webContentsId: 5 });
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    await expect(
      coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: NEW_ROOT })
    ).rejects.toMatchObject({ reason: "assistant-active" });

    expect(deps.ptyClient.gracefulKillByProject).not.toHaveBeenCalled();
    expect(fsState.renameCalls).toHaveLength(0);
  });

  it("rejects a concurrent relocation for the same project", async () => {
    const pvm = makePvm(PROJECT_ID);
    const deps = makeDeps(pvm);
    // Hold the first relocation open inside the reopen step.
    let releaseLoad: () => void = () => {};
    deps.worktreeService.loadProject.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseLoad = resolve;
      })
    );
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, deps);

    const first = coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: NEW_ROOT });
    // Let the first reach its awaiting reopen.
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: NEW_ROOT })
    ).rejects.toMatchObject({ reason: "in-progress" });

    releaseLoad();
    await first;
  });

  it("rejects an unknown project", async () => {
    mockProjectStore.getProjectById.mockReturnValue(null);
    const coordinator = new ProjectRelocationCoordinator();
    configure(coordinator, makeDeps(makePvm(PROJECT_ID)));

    await expect(
      coordinator.relocate({ projectId: PROJECT_ID, mode: "move", newPath: NEW_ROOT })
    ).rejects.toMatchObject({ reason: "not-found" });
  });
});
