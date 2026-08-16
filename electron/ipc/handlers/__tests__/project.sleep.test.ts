import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

type StoredProject = { id: string; name: string; path: string; status?: string };

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(),
  getProjectById: vi.fn<(projectId: string) => StoredProject | null>(),
  clearCurrentProject: vi.fn<() => void>(),
  clearProjectState: vi.fn<(projectId: string) => Promise<void>>(),
  updateProjectStatus:
    vi.fn<(projectId: string, status: "active" | "background" | "closed") => unknown>(),
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const teardownMock = vi.hoisted(() => ({
  gracefulTeardownAndJournalProject: vi.fn<
    (...args: unknown[]) => Promise<{
      confirmed: boolean;
      terminalsKilled: number;
      sessions: Array<{ id: string; agentSessionId: string | null }>;
    }>
  >(),
}));
vi.mock("../../../services/pty/projectSessionJournal.js", () => teardownMock);

const hibernationMock = vi.hoisted(() => ({
  evictProjectRenderer: vi.fn<(projectId: string) => number>(),
}));
vi.mock("../../../services/HibernationService.js", () => ({
  getHibernationService: () => hibernationMock,
}));

const persistenceMock = vi.hoisted(() => ({
  writeHibernatedMarker: vi.fn<(terminalId: string) => void>(),
}));
vi.mock("../../../services/pty/terminalSessionPersistence.js", () => persistenceMock);

const broadcastMock = vi.hoisted(() => vi.fn());
// Partial: `typedHandle` — which `defineIpcNamespace` registers through — lives
// in this same module, so replacing it wholesale strands the registrar.
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  broadcastToRenderer: broadcastMock,
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerProjectSleepHandlers } from "../projectSleep.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { HandlerDependencies } from "../../types.js";
import type { ProjectSleepResult } from "../../../../shared/types/ipc/project.js";

const PROJECT: StoredProject = {
  id: "proj-1",
  name: "One",
  path: "/repo/one",
  status: "background",
};

function setup(
  overrides: {
    evictProject?: () => boolean;
    /** Project id each window currently has on screen. */
    windowProjects?: Array<string | null>;
  } = {}
) {
  const evictProject = vi.fn(overrides.evictProject ?? (() => true));
  // Guarded release: only drops the reference while the window is still mapped
  // to the path passed in. Modelled here so a test can prove the guard is used.
  const releaseWindowForProject = vi.fn(
    (_windowId: number, projectPath: string) => projectPath === PROJECT.path
  );
  const windows = (overrides.windowProjects ?? []).map((activeProjectId, index) => ({
    services: {
      projectViewManager: {
        getActiveProjectId: () => activeProjectId,
        win: { id: index + 1, isDestroyed: () => false },
      },
    },
  }));
  const deps = {
    ptyClient: {},
    worktreeService: { evictProject, releaseWindowForProject },
    windowRegistry: { all: () => windows },
  } as unknown as HandlerDependencies;

  const dispose = registerProjectSleepHandlers(deps);

  const handleMock = vi.mocked(ipcMain.handle);
  const entry = handleMock.mock.calls.find(([channel]) => channel === CHANNELS.PROJECT_SLEEP);
  if (!entry) throw new Error("project:sleep was never registered");
  const handler = entry[1] as (event: unknown, projectId: unknown) => Promise<ProjectSleepResult>;

  return {
    dispose,
    evictProject,
    releaseWindowForProject,
    invoke: (projectId: unknown) => handler({}, projectId),
  };
}

describe("project:sleep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.getProjectById.mockReturnValue(PROJECT);
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
      confirmed: true,
      terminalsKilled: 2,
      sessions: [
        { id: "t1", agentSessionId: "s1" },
        { id: "t2", agentSessionId: null },
      ],
    });
    hibernationMock.evictProjectRenderer.mockReturnValue(1);
  });

  describe("validation", () => {
    it.each([
      ["an empty id", ""],
      ["a missing id", undefined],
      ["a non-string id", 42],
    ])("rejects %s without touching the project", async (_label, badId) => {
      const { invoke } = setup();

      await expect(invoke(badId)).rejects.toThrow(/Invalid project ID/);
      // A silent fallback to "the current project" here would tear down the
      // wrong one — the invalid arg must reach validation as invalid (#7880).
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("rejects an unknown project", async () => {
      projectStoreMock.getProjectById.mockReturnValue(null);
      const { invoke } = setup();

      await expect(invoke("ghost")).rejects.toThrow(/Project not found/);
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
    });

    it("no-ops on an already-sleeping project instead of re-journaling it", async () => {
      projectStoreMock.getProjectById.mockReturnValue({ ...PROJECT, status: "closed" });
      const { invoke } = setup();

      await expect(invoke("proj-1")).resolves.toEqual({
        terminalsKilled: 0,
        rendererViewsEvicted: 0,
        workspaceEvicted: false,
      });
      expect(teardownMock.gracefulTeardownAndJournalProject).not.toHaveBeenCalled();
      expect(persistenceMock.writeHibernatedMarker).not.toHaveBeenCalled();
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("preserves sessions and writes captured ids back, the way a quit does", async () => {
      const { invoke } = setup();

      await invoke("proj-1");

      const [scopeId, , , options] = teardownMock.gracefulTeardownAndJournalProject.mock.calls[0]!;
      expect(scopeId).toBe("proj-1");
      expect(options).toEqual({ preserveSession: true, writeBackSessionIds: true });
    });

    it("marks every killed terminal hibernated, agent or not", async () => {
      const { invoke } = setup();

      await invoke("proj-1");

      expect(persistenceMock.writeHibernatedMarker.mock.calls.map(([id]) => id)).toEqual([
        "t1",
        "t2",
      ]);
    });

    it("keeps the layout — sleeping must never clear project state", async () => {
      const { invoke } = setup();

      await invoke("proj-1");

      expect(projectStoreMock.clearProjectState).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed");
    });

    it("reclaims the cached views and the workspace host", async () => {
      const { invoke, evictProject } = setup();

      const result = await invoke("proj-1");

      expect(hibernationMock.evictProjectRenderer).toHaveBeenCalledWith("proj-1");
      expect(evictProject).toHaveBeenCalledWith("/repo/one");
      expect(result).toEqual({
        terminalsKilled: 2,
        rendererViewsEvicted: 1,
        workspaceEvicted: true,
      });
    });

    it("reports the workspace host retained when it genuinely can't be dropped", async () => {
      const { invoke } = setup({ evictProject: () => false });

      const result = await invoke("proj-1");

      expect(result.workspaceEvicted).toBe(false);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed");
    });

    it("releases the on-screen window's workspace reference so the host can go", async () => {
      // evictProject refuses a host any window still holds, and a window with
      // the project on screen holds one. Sleep leaves that window's VIEW alive
      // on purpose, so nothing else releases the reference — without this the
      // host survives sleeping the only project using it.
      const { invoke, releaseWindowForProject, evictProject } = setup({
        windowProjects: ["proj-1", "other"],
      });

      await invoke("proj-1");

      expect(releaseWindowForProject).toHaveBeenCalledTimes(1);
      // Path-guarded, not a bare windowId release: during a cold switch the
      // pool can still map this window to the OUTGOING project, and dropping
      // that reference would sever a different project's worktree feed.
      expect(releaseWindowForProject).toHaveBeenCalledWith(1, PROJECT.path);
      // Released before the eviction is attempted, or the refCount still blocks.
      expect(releaseWindowForProject.mock.invocationCallOrder[0]!).toBeLessThan(
        evictProject.mock.invocationCallOrder[0]!
      );
    });

    it("leaves other projects' windows registered", async () => {
      // Releasing a window bound to a different project would sever a worktree
      // feed that is still in use.
      const { invoke, releaseWindowForProject } = setup({ windowProjects: ["other", null] });

      await invoke("proj-1");

      expect(releaseWindowForProject).not.toHaveBeenCalled();
    });

    it("still closes the project when reclamation throws", async () => {
      // Past the confirmed kill the terminals are gone, so the operation is
      // committed: a failing eviction must not strand the row as open with dead
      // terminals behind it.
      const { invoke } = setup({
        evictProject: () => {
          throw new Error("host wedged");
        },
      });
      hibernationMock.evictProjectRenderer.mockImplementation(() => {
        throw new Error("view wedged");
      });

      const result = await invoke("proj-1");

      expect(result.terminalsKilled).toBe(2);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed");
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });
  });

  describe("fail-closed", () => {
    it("leaves the project open when the host can't confirm the kills", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
        confirmed: false,
        terminalsKilled: 0,
        sessions: [],
      });
      const { invoke } = setup();

      await expect(invoke("proj-1")).rejects.toBeInstanceOf(AppError);

      // Nothing downstream may run: marking it closed would hide still-running
      // agents behind a "reopen to resume" that has nothing to resume.
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(persistenceMock.writeHibernatedMarker).not.toHaveBeenCalled();
      expect(hibernationMock.evictProjectRenderer).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("surfaces a teardown rejection without marking the project closed", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockRejectedValue(new Error("host gone"));
      const { invoke } = setup();

      await expect(invoke("proj-1")).rejects.toBeInstanceOf(AppError);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });
  });

  describe("pointer and broadcast", () => {
    it("clears the current-project pointer only when it still names this project", async () => {
      projectStoreMock.getCurrentProjectId.mockReturnValue("someone-else");
      const { invoke } = setup();

      await invoke("proj-1");

      expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
    });

    it("clears the pointer when it does", async () => {
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      const { invoke } = setup();

      await invoke("proj-1");

      expect(projectStoreMock.clearCurrentProject).toHaveBeenCalled();
    });

    it("reads the pointer after the teardown, not before it", async () => {
      // Another window can switch projects while the kill is in flight; a stale
      // read would wipe a different project's pointer.
      const { invoke } = setup();

      await invoke("proj-1");

      const teardownOrder =
        teardownMock.gracefulTeardownAndJournalProject.mock.invocationCallOrder[0]!;
      const pointerReadOrder = projectStoreMock.getCurrentProjectId.mock.invocationCallOrder[0]!;
      expect(pointerReadOrder).toBeGreaterThan(teardownOrder);
    });

    it("broadcasts the updated row so other windows can react", async () => {
      const updated = { ...PROJECT, status: "closed" };
      projectStoreMock.getProjectById.mockReturnValueOnce(PROJECT).mockReturnValue(updated);
      const { invoke } = setup();

      await invoke("proj-1");

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, updated);
    });

    it("announces the sleep on its own event, not just the status change", async () => {
      // A window showing this project drops to no-project off THIS event.
      // Inferring it from a `closed` status would also fire for relocation,
      // project adoption and the idle sweep, blanking windows that shouldn't be.
      const { invoke } = setup();

      await invoke("proj-1");

      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_SLEPT, "proj-1");
    });

    it("stays silent on both channels when the teardown was not confirmed", async () => {
      teardownMock.gracefulTeardownAndJournalProject.mockResolvedValue({
        confirmed: false,
        terminalsKilled: 0,
        sessions: [],
      });
      const { invoke } = setup();

      await expect(invoke("proj-1")).rejects.toBeInstanceOf(AppError);

      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });
});
