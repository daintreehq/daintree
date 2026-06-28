import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const storeBacking: Record<string, unknown> = {};
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => (key in storeBacking ? storeBacking[key] : undefined)),
  set: vi.fn((key: string, value: unknown) => {
    storeBacking[key] = value;
  }),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getAllProjects: vi.fn<() => Array<Record<string, unknown>>>(() => []),
  getProjectById: vi.fn<(id: string) => Record<string, unknown> | null>((id) => ({
    id,
    name: id,
    path: `/projects/${id}`,
    status: "closed",
  })),
  updateProjectStatus: vi.fn(),
}));

const ptyClientMock = vi.hoisted(() => ({
  getAllTerminalsAsync: vi.fn<() => Promise<unknown[]>>(async () => []),
  gracefulKillByProject: vi.fn(async () => [] as Array<{ id: string }>),
}));

const workspaceClientMock = vi.hoisted(() => ({
  evictProject: vi.fn<(p: string) => boolean>(() => true),
}));

vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ptyClientMock,
  getWorkspaceClientRef: () => workspaceClientMock,
}));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn());
const evictProjectRendererMock = vi.hoisted(() => vi.fn<(id: string) => number>(() => 1));

vi.mock("../../utils/logger.js", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    IDLE_BACKGROUND_CLOSED: "idle-background:closed",
    PROJECT_UPDATED: "project:updated",
  },
}));

vi.mock("../pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: writeHibernatedMarkerMock,
}));

vi.mock("../HibernationService.js", () => ({
  getHibernationService: () => ({
    evictProjectRenderer: evictProjectRendererMock,
  }),
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn(() => vi.fn()),
    onWake: vi.fn(() => vi.fn()),
  }),
}));

import { IdleBackgroundAutoCloseService } from "../IdleBackgroundAutoCloseService.js";
import type { PtyClient } from "../PtyClient.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

const THIRTY_MIN_MS = 30 * 60 * 1000;

function makeService(): IdleBackgroundAutoCloseService {
  const service = new IdleBackgroundAutoCloseService();
  service.setPtyClient(ptyClientMock as unknown as PtyClient);
  return service;
}

function enable(thresholdMinutes = 15): void {
  storeBacking.idleBackgroundAutoClose = { enabled: true, thresholdMinutes };
}

/** A background project idle past the default 15-min threshold. */
function makeIdleProject(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    path: `/projects/${id}`,
    status: "background",
    lastOpened: Date.now() - THIRTY_MIN_MS,
    ...overrides,
  };
}

function makeTerminal(projectId: string, overrides: Record<string, unknown> = {}) {
  return { id: `t-${projectId}`, projectId, hasPty: true, ...overrides };
}

/** A ProjectViewManager mock whose active project is `activeId`. */
function makePvm(activeId: string | null, outgoingId: string | null = null): ProjectViewManager {
  return {
    getActiveProjectId: () => activeId,
    getOutgoingBridgeProjectId: () => outgoingId,
  } as unknown as ProjectViewManager;
}

async function runCheck(service: IdleBackgroundAutoCloseService): Promise<void> {
  await (service as unknown as { checkAndClose(): Promise<void> }).checkAndClose();
}

describe("IdleBackgroundAutoCloseService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(storeBacking)) delete storeBacking[k];
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    projectStoreMock.getAllProjects.mockReturnValue([]);
    projectStoreMock.getProjectById.mockImplementation((id) => ({
      id,
      name: id,
      path: `/projects/${id}`,
      status: "closed",
    }));
    ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
    ptyClientMock.gracefulKillByProject.mockResolvedValue([]);
    evictProjectRendererMock.mockReturnValue(1);
    workspaceClientMock.evictProject.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config", () => {
    it("defaults to disabled with a 15-minute threshold", () => {
      const service = makeService();
      expect(service.getConfig()).toEqual({ enabled: false, thresholdMinutes: 15 });
    });

    it("returns defaults for malformed persisted config", () => {
      storeBacking.idleBackgroundAutoClose = { enabled: "yes", thresholdMinutes: Number.NaN };
      const service = makeService();
      expect(service.getConfig()).toEqual({ enabled: false, thresholdMinutes: 15 });
    });

    it("clamps threshold to [15, 1440]", () => {
      storeBacking.idleBackgroundAutoClose = { enabled: true, thresholdMinutes: 5 };
      let service = makeService();
      expect(service.getConfig().thresholdMinutes).toBe(15);

      storeBacking.idleBackgroundAutoClose = { enabled: true, thresholdMinutes: 9999 };
      service = makeService();
      expect(service.getConfig().thresholdMinutes).toBe(1440);
    });

    it("persists normalized config on updateConfig", () => {
      const service = makeService();
      service.updateConfig({ enabled: true, thresholdMinutes: 30 });
      expect(storeMock.set).toHaveBeenCalledWith("idleBackgroundAutoClose", {
        enabled: true,
        thresholdMinutes: 30,
      });
      service.stop();
    });
  });

  describe("checkAndClose gating", () => {
    it("does nothing when disabled", async () => {
      storeBacking.idleBackgroundAutoClose = { enabled: false, thresholdMinutes: 15 };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("closes an idle, zero-terminal background project past the threshold", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
      expect(evictProjectRendererMock).toHaveBeenCalledWith("proj-1");
      expect(workspaceClientMock.evictProject).toHaveBeenCalledWith("/projects/proj-1");
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: expect.any(Number),
      });
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "idle-background:closed",
        expect.objectContaining({
          projects: [{ projectId: "proj-1", projectName: "proj-1" }],
        })
      );
    });

    it("skips a project that still has a terminal", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal("proj-1")]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("ignores ghost (hasPty===false) panels when gating on terminals", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal("proj-1", { hasPty: false }),
      ]);
      const service = makeService();
      await runCheck(service);
      // hasPty===false is not a real terminal — project is still eligible.
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "proj-1",
        "closed",
        expect.anything()
      );
    });

    it("skips a project still within the idle threshold", async () => {
      enable(60);
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1", { lastOpened: Date.now() - THIRTY_MIN_MS }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("skips already-closed and missing projects", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("closed-1", { status: "closed" }),
        makeIdleProject("missing-1", { status: "missing" }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("skips projects that were never opened", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1", { lastOpened: 0 }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });
  });

  describe("multi-window active guard", () => {
    it("never closes the project active in a window", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm("proj-1")]);
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("never closes a project active in a SECOND (non-focused) window", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      const service = makeService();
      // Window A foreground proj-1, window B foreground proj-2 — both protected.
      service.setProjectViewManagersProvider(() => [makePvm("proj-1"), makePvm("proj-2")]);
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("protects a project mid-bridge (outgoing) in a window", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm(null, "proj-1")]);
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("falls back to the SQLite current-project pointer when no provider is wired", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("closes a background project while protecting the active one", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("active-1"),
        makeIdleProject("bg-1"),
      ]);
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm("active-1")]);
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledTimes(1);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "bg-1",
        "closed",
        expect.anything()
      );
    });
  });

  describe("resilience", () => {
    it("isolates a per-project teardown failure and continues the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("bad-1"),
        makeIdleProject("good-1"),
      ]);
      ptyClientMock.gracefulKillByProject.mockImplementation(async (id: string) => {
        if (id === "bad-1") throw new Error("kill failed");
        return [];
      });
      const service = makeService();
      await runCheck(service);
      // good-1 still closed despite bad-1 throwing.
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "good-1",
        "closed",
        expect.anything()
      );
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalledWith(
        "bad-1",
        "closed",
        expect.anything()
      );
      // Only the successful project is in the broadcast payload.
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "idle-background:closed",
        expect.objectContaining({
          projects: [{ projectId: "good-1", projectName: "good-1" }],
        })
      );
    });

    it("writes hibernation markers for each killed terminal", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.gracefulKillByProject.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
      const service = makeService();
      await runCheck(service);
      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t1");
      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t2");
    });

    it("does not broadcast when nothing qualifies", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });
  });
});
