import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const storeBacking: Record<string, unknown> = {};
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => (key in storeBacking ? storeBacking[key] : undefined)),
  set: vi.fn((key: string, value: unknown) => {
    storeBacking[key] = value;
  }),
}));

// getProjectById is consulted THREE times per close: the pre-revoke re-check,
// the post-revoke re-check (both must see a still-eligible background project),
// and the post-close PROJECT_UPDATED broadcast. Default it to a background
// project idle well past the threshold.
const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getAllProjects: vi.fn<() => Array<Record<string, unknown>>>(() => []),
  getProjectById: vi.fn<(id: string) => Record<string, unknown> | null>((id) => ({
    id,
    name: id,
    path: `/projects/${id}`,
    status: "background",
    lastOpened: Date.now() - 30 * 60 * 1000,
  })),
  updateProjectStatus: vi.fn(),
}));

const ptyClientMock = vi.hoisted(() => ({
  getAllTerminalsAsync: vi.fn<() => Promise<unknown[]>>(async () => []),
  gracefulKillByProject: vi.fn<
    (projectId: string, opts?: { preserveSession?: boolean }) => Promise<Array<{ id: string }>>
  >(async () => []),
  // PtyClient's main-local spawn registry — the liveness half of the assistant
  // floor, independent of the (truncatable) pty-host terminal snapshot.
  hasTerminal: vi.fn<(id: string) => boolean>((id: string) => liveTerminalIds.has(id)),
  // The service reads completeness so a silent shard can't read as "no
  // terminals". Delegates to getAllTerminalsAsync so every fixture below still
  // drives the snapshot through the one mock; flip `snapshotDegraded` to model
  // a shard that failed to answer.
  getAllTerminalsWithCompletenessAsync: vi.fn(async () => ({
    terminals: await ptyClientMock.getAllTerminalsAsync(),
    degraded: snapshotDegraded.value,
    shardsTotal: 2,
    shardsFailed: snapshotDegraded.value ? 1 : 0,
  })),
}));

const snapshotDegraded = vi.hoisted(() => ({ value: false }));

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

const logInfoMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ logInfo: logInfoMock, logError: vi.fn() }));

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

// A live Daintree Assistant floors the reclaim (#11807). `assistantBackends`
// maps a project to the terminal its help session bound; `liveTerminalIds` backs
// PtyClient's spawn registry. A binding whose terminal is NOT in the live set
// models an assistant that exited under its own steam — nothing drops the
// binding, so only the liveness half distinguishes it from a running one.
const assistantBackends = vi.hoisted(() => new Map<string, string>());
const liveTerminalIds = vi.hoisted(() => new Set<string>());

const helpSessionServiceMock = vi.hoisted(() => ({
  revokeByProjectId: vi.fn(async (_projectId: string) => {}),
  getAssistantBackend: vi.fn((projectId: string) => {
    const terminalId = assistantBackends.get(projectId);
    return terminalId ? { terminalId, webContentsId: 42 } : null;
  }),
}));

vi.mock("../HelpSessionService.js", () => ({ helpSessionService: helpSessionServiceMock }));

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

/** A bound assistant whose PTY is still running — floors the reclaim. */
function liveAssistant(projectId: string, terminalId = `t-help-${projectId}`): string {
  assistantBackends.set(projectId, terminalId);
  liveTerminalIds.add(terminalId);
  return terminalId;
}

/**
 * A session binding whose PTY already exited. Nothing drops the binding on a
 * self-exit, so this is the shape a quit assistant leaves behind — it must not
 * block, and `closeProject` capture-revokes it on the way out.
 */
function staleAssistant(projectId: string, terminalId = `t-help-${projectId}`): string {
  assistantBackends.set(projectId, terminalId);
  return terminalId;
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
      status: "background",
      lastOpened: Date.now() - THIRTY_MIN_MS,
    }));
    ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
    ptyClientMock.gracefulKillByProject.mockResolvedValue([]);
    evictProjectRendererMock.mockReturnValue(1);
    workspaceClientMock.evictProject.mockReturnValue(true);
    assistantBackends.clear();
    liveTerminalIds.clear();
    snapshotDegraded.value = false;
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
      // PROJECT_UPDATED drives the switcher row → "Suspended to free memory".
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "project:updated",
        expect.objectContaining({ id: "proj-1" })
      );
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

    it("a live assistant blocks the reclaim, and is never capture-revoked (#11807)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const helpId = liveAssistant("proj-1");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        { id: helpId, projectId: "proj-1", hasPty: true },
      ]);
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(workspaceClientMock.evictProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("blocks on an idle assistant — pending wakeups read as idle, so state is not consulted", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const helpId = liveAssistant("proj-1");
      // An assistant that scheduled a wakeup an hour out sits at "idle" with no
      // output. That is precisely the state #11807 must not reclaim.
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        { id: helpId, projectId: "proj-1", hasPty: true, agentState: "idle" },
      ]);
      const service = makeService();
      await runCheck(service);

      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
    });

    it("floors on the session binding even when the terminal snapshot omits the help PTY", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      liveAssistant("proj-1");
      // A truncated/stale pty-host snapshot never lists the assistant. The
      // main-local spawn registry still knows it is alive.
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      const service = makeService();
      await runCheck(service);

      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
    });

    it("logs the projects held back by a live assistant, once per sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      const helpId = liveAssistant("proj-1");
      liveAssistant("proj-2");
      // proj-1's help PTY is listed in the snapshot the ordinary way, proj-2's
      // is not — both must be attributed to the assistant, not to "a terminal".
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        { id: helpId, projectId: "proj-1", hasPty: true },
      ]);
      const service = makeService();
      await runCheck(service);

      const skipLogs = logInfoMock.mock.calls.filter(
        ([event]) => event === "idle-background-auto-close-skip-live-assistant"
      );
      expect(skipLogs).toHaveLength(1);
      const logged = (skipLogs[0]?.[1] as { projectIds: string[] }).projectIds;
      expect([...logged].sort()).toEqual(["proj-1", "proj-2"]);
    });

    it("a live assistant in one project does not hold back another project's reclaim", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      liveAssistant("proj-1");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      const service = makeService();
      await runCheck(service);

      // proj-1 is floored, proj-2 closes — the floor is per-project, not global.
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledTimes(1);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "proj-2",
        "closed",
        expect.anything()
      );
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalledWith("proj-1");

      const skipLogs = logInfoMock.mock.calls.filter(
        ([event]) => event === "idle-background-auto-close-skip-live-assistant"
      );
      expect(skipLogs[0]?.[1]).toEqual({ projectIds: ["proj-1"] });

      const closedBroadcast = broadcastToRendererMock.mock.calls.find(
        ([channel]) => channel === "idle-background:closed"
      );
      expect(closedBroadcast?.[1].projects).toEqual([
        { projectId: "proj-2", projectName: "proj-2" },
      ]);
    });

    it("a stale binding whose PTY already exited does not block, and is capture-revoked (#10989)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // Binding survives a self-exited assistant; `hasTerminal` is the half that
      // knows it is gone.
      staleAssistant("proj-1");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      const service = makeService();
      await runCheck(service);

      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: expect.any(Number),
      });
      // The leftover session is capture-revoked (conversation preserved via the
      // pending-hibernation entry) BEFORE the project-wide kill.
      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      const revokeOrder =
        helpSessionServiceMock.revokeByProjectId.mock.invocationCallOrder[0] ?? -1;
      const killOrder = ptyClientMock.gracefulKillByProject.mock.invocationCallOrder[0] ?? -1;
      expect(revokeOrder).toBeGreaterThanOrEqual(0);
      expect(killOrder).toBeGreaterThan(revokeOrder);
    });

    it("still skips when a real terminal coexists with the assistant help PTY", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const helpId = liveAssistant("proj-1");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal("proj-1"),
        { id: helpId, projectId: "proj-1", hasPty: true },
      ]);
      const service = makeService();
      await runCheck(service);

      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
    });

    it("bails before the capture-revoke when an assistant appeared during the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      liveTerminalIds.add("t-help-late");
      // The sweep gate saw no binding; the panel opened before the pre-revoke
      // re-check ran, so the second look finds one. Queued per-call rather than
      // via a persistent mockImplementation, which `clearAllMocks` would not
      // undo and would poison later tests.
      helpSessionServiceMock.getAssistantBackend
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ terminalId: "t-help-late", webContentsId: 42 });
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("bails after the capture-revoke when a real terminal appeared during the await", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      staleAssistant("proj-1");
      // Sweep snapshot + pre-revoke recheck are clean; the post-revoke recheck
      // sees a real terminal spawned mid-await.
      ptyClientMock.getAllTerminalsAsync
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeTerminal("proj-1")]);
      const service = makeService();
      await runCheck(service);

      // The revoke already ran (conversation captured), but the reclaim must
      // not proceed under the new terminal.
      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("bails after the capture-revoke when a FRESH assistant binding appeared during the await", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      staleAssistant("proj-1", "t-help-old");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      // The revoke settles the dead record and the user reopens the panel during
      // the multi-second await, which binds a DIFFERENT terminal. The post-revoke
      // gate has to re-resolve the project's backend — an implementation that
      // reused the terminal id it saw before the await would sail past this.
      helpSessionServiceMock.revokeByProjectId.mockImplementationOnce(async () => {
        assistantBackends.delete("proj-1");
        liveAssistant("proj-1", "t-help-new");
      });
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("a failed capture-revoke of a dead session degrades gracefully and never blocks the reclaim", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      staleAssistant("proj-1");
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      helpSessionServiceMock.revokeByProjectId.mockRejectedValueOnce(new Error("host gone"));
      const service = makeService();
      await runCheck(service);

      // The reclaim proceeds; only the resume entry is lost.
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: expect.any(Number),
      });
    });

    it("never reclaims on a degraded terminal snapshot — a silent shard is not 'no terminals'", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // A shard failed to answer, so the empty list proves nothing. Killing here
      // is the one wrong answer: the project may be full of live agents.
      snapshotDegraded.value = true;
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([]);
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("bails when the snapshot degrades between the sweep and the pre-revoke re-check", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsWithCompletenessAsync
        .mockResolvedValueOnce({ terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 })
        .mockResolvedValueOnce({ terminals: [], degraded: true, shardsTotal: 2, shardsFailed: 1 });
      const service = makeService();
      await runCheck(service);

      // The revoke sits behind this gate, so nothing was touched at all.
      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("halts an in-flight close when the feature is toggled off during the snapshot await", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsWithCompletenessAsync
        .mockResolvedValueOnce({ terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 })
        .mockImplementationOnce(async () => {
          storeBacking.idleBackgroundAutoClose = { enabled: false, thresholdMinutes: 15 };
          return { terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 };
        });
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("bails when the snapshot degrades at the POST-revoke re-check", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const clean = { terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 };
      ptyClientMock.getAllTerminalsWithCompletenessAsync
        .mockResolvedValueOnce(clean)
        .mockResolvedValueOnce(clean)
        .mockResolvedValueOnce({ terminals: [], degraded: true, shardsTotal: 2, shardsFailed: 1 });
      const service = makeService();
      await runCheck(service);

      // The revoke already ran, but the irreversible teardown must not.
      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("halts an in-flight close when stop() clears the client mid-await", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const clean = { terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 };
      const service = makeService();
      // Shutdown nulls the client without touching `enabled`, so the config
      // re-checks cannot catch it — only the client-identity check can.
      ptyClientMock.getAllTerminalsWithCompletenessAsync
        .mockResolvedValueOnce(clean)
        .mockImplementationOnce(async () => {
          service.stop();
          return clean;
        });
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
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

    it("never closes a project the store still calls 'active' (defensive status guard)", async () => {
      enable();
      // PVM provider and DB pointer both miss it, but its persisted status is
      // "active" — the status guard is the last line of defense.
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1", { status: "active" }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("isolates a throwing ProjectViewManager and still consults the others", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("bg-1")]);
      const throwing = {
        getActiveProjectId: () => {
          throw new Error("PVM disposing");
        },
        getOutgoingBridgeProjectId: () => null,
      } as unknown as ProjectViewManager;
      const service = makeService();
      // A healthy PVM marks active-1 as foreground; the throwing one must not
      // drop it from the active set. bg-1 is unaffected and still closes.
      service.setProjectViewManagersProvider(() => [throwing, makePvm("active-1")]);
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "bg-1",
        "closed",
        expect.anything()
      );
    });

    it("falls back to the DB pointer when the whole provider throws", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      const service = makeService();
      service.setProjectViewManagersProvider(() => {
        throw new Error("registry tearing down");
      });
      await runCheck(service);
      // Provider threw, but the DB current-project fallback still protects proj-1.
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });
  });

  describe("teardown re-check (TOCTOU)", () => {
    it("does not close a project that became active during the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // Loop snapshot sees no active project; by teardown the user has focused it.
      let call = 0;
      const service = makeService();
      service.setProjectViewManagersProvider(() => {
        call += 1;
        return call === 1 ? [] : [makePvm("proj-1")];
      });
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("does not close a project that gained a terminal during the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // First registry read (loop) is empty; the teardown re-query sees a terminal.
      ptyClientMock.getAllTerminalsAsync
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeTerminal("proj-1")]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("does not close a project whose lastOpened was freshly bumped (re-fetch)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // The fresh row read at teardown shows a just-switched-away project: still
      // "background" with zero terminals, but lastOpened bumped to ~now.
      projectStoreMock.getProjectById.mockReturnValue({
        id: "proj-1",
        name: "proj-1",
        path: "/projects/proj-1",
        status: "background",
        lastOpened: Date.now(),
      });
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("does not close once the fresh row shows the project already closed", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      projectStoreMock.getProjectById.mockReturnValue({
        id: "proj-1",
        name: "proj-1",
        path: "/projects/proj-1",
        status: "closed",
        lastOpened: Date.now() - THIRTY_MIN_MS,
      });
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
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

    it("isolates a failure at the renderer-eviction step and continues the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("bad-1"),
        makeIdleProject("good-1"),
      ]);
      evictProjectRendererMock.mockImplementation((id: string) => {
        if (id === "bad-1") throw new Error("evict failed");
        return 1;
      });
      const service = makeService();
      await runCheck(service);
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

  describe("lifecycle guards", () => {
    it("suppresses sweeps during the startup quiet period after start()", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      // start() seeds quietUntil = now + 2min, so an immediate sweep is a no-op.
      service.start();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();

      // With the quiet window elapsed, the same project now closes. (stop() is
      // deferred to the end — it nulls the injected ptyClient.)
      (service as unknown as { quietUntil: number | null }).quietUntil = null;
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "proj-1",
        "closed",
        expect.anything()
      );
      service.stop();
    });

    it("skips an overlapping sweep while a prior one is still running", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      // Hold the first sweep open inside getAllTerminalsAsync.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      ptyClientMock.getAllTerminalsAsync.mockImplementationOnce(async () => {
        await gate;
        return [];
      });
      const service = makeService();
      const first = runCheck(service);
      // Second sweep fires before the first resolves — must early-return.
      await runCheck(service);
      expect(ptyClientMock.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });
});
