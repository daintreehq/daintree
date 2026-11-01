import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const storeBacking: Record<string, unknown> = {};
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => (key in storeBacking ? storeBacking[key] : undefined)),
  set: vi.fn((key: string, value: unknown) => {
    storeBacking[key] = value;
  }),
}));

// getProjectById is consulted on every eligibility re-check in a close (before
// and after the revoke, after the post-revoke snapshot, after the kill — all must
// see a still-eligible background project) and once more for the post-close
// PROJECT_UPDATED broadcast. Default it to a background project idle well past
// the threshold.
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
  // The process census the idle-shell gate reads (#13849).
  getProcessInventory: vi.fn<
    () => Promise<{ inventories: unknown[]; shardsTotal: number; shardsFailed: number }>
  >(async () => ({ inventories: [], shardsTotal: 1, shardsFailed: 0 })),
}));

const snapshotDegraded = vi.hoisted(() => ({ value: false }));

const workspaceClientMock = vi.hoisted(() => ({
  evictProject: vi.fn<(p: string) => boolean>(() => true),
  getAllStatesWithGitBackedForProjectAsync: vi.fn<
    (path: string, id: string) => Promise<{ states: unknown[]; gitBacked: boolean | null }>
  >(async (path) => ({ states: [{ path }], gitBacked: true })),
}));

const gitSafetyMock = vi.hoisted(() => ({
  probeRepositorySleepSafety: vi.fn<
    (
      paths: readonly string[],
      options?: { missingRepoIsClear?: boolean }
    ) => Promise<{ state: string; marker?: string }>
  >(async () => ({ state: "clear" })),
}));
vi.mock("../../utils/gitSleepSafety.js", () => gitSafetyMock);

const resourceProbeMock = vi.hoisted(() => ({
  probeResourceConfig: vi.fn<(root: string, paths: readonly string[]) => Promise<string>>(
    async () => "none"
  ),
}));
vi.mock("../../utils/resourceConfigProbe.js", () => resourceProbeMock);

/** Remote Shell views attached to a project, as the endpoint registry lists them. */
const remoteViewProjects = vi.hoisted(() => new Set<string>());
vi.mock("../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({
    getRemote: () => [...remoteViewProjects].map((projectId) => ({ projectId })),
  }),
}));

/** The resource profile the pressure threshold is read from; `null` before it boots. */
const resourceProfile = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ptyClientMock,
  getWorkspaceClientRef: () => workspaceClientMock,
  getResourceProfileService: () =>
    resourceProfile.value === null ? null : { getProfile: () => resourceProfile.value },
}));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn());
const evictProjectRendererMock = vi.hoisted(() =>
  vi.fn<(id: string, options?: { protectMcpDispatch?: boolean }) => number>(() => 1)
);

const logInfoMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ logInfo: logInfoMock, logError: vi.fn() }));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    IDLE_BACKGROUND_CLOSED: "idle-background:closed",
    PROJECT_UPDATED: "project:updated",
    PROJECT_SLEPT: "project:slept",
  },
}));

/** Whether the host acknowledges the fake kill below — false models a timeout. */
const killConfirmed = vi.hoisted(() => ({ value: true }));

// Sleep's kill runs through the journal helper, whose real module boots the
// agent journal and lifecycle ledger. Faked over the PtyClient mock instead, so
// every kill assertion below still reads `gracefulKillByProject` — and faithful
// to the parts of its contract a policy leans on: a `beforeKill` guard sees the
// scope's terminals from a completeness-aware snapshot (a failed read counts as
// degraded) and can refuse, and the kill reports whether the host confirmed it.
vi.mock("../pty/projectSessionJournal.js", () => ({
  gracefulTeardownAndJournalProject: vi.fn(
    async (
      scopeId: string,
      client: {
        getAllTerminalsWithCompletenessAsync: () => Promise<{
          terminals: unknown[];
          degraded: boolean;
        }>;
        gracefulKillByProject: (
          id: string,
          opts?: { preserveSession?: boolean }
        ) => Promise<Array<{ id: string }>>;
      },
      _workspaceClient: unknown,
      options: {
        preserveSession?: boolean;
        beforeKill?: (snapshot: { terminals: unknown[]; degraded: boolean }) => boolean;
      } = {}
    ) => {
      if (options.beforeKill) {
        let snapshot: { terminals: unknown[]; degraded: boolean };
        try {
          snapshot = await client.getAllTerminalsWithCompletenessAsync();
        } catch {
          snapshot = { terminals: [], degraded: true };
        }
        const terminals = snapshot.terminals.filter(
          (t) => (t as { projectId?: string }).projectId === scopeId
        );
        if (!options.beforeKill({ terminals, degraded: snapshot.degraded })) {
          return { confirmed: false, aborted: true, terminalsKilled: 0, sessions: [] };
        }
      }
      const sessions = await client.gracefulKillByProject(scopeId, {
        preserveSession: options.preserveSession,
      });
      return {
        confirmed: killConfirmed.value,
        aborted: false,
        terminalsKilled: sessions.length,
        sessions,
      };
    }
  ),
}));

vi.mock("../pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: writeHibernatedMarkerMock,
}));

vi.mock("../HibernationService.js", () => ({
  getHibernationService: () => ({
    evictProjectRenderer: evictProjectRendererMock,
  }),
}));

/** Machine-sleep time to subtract from every awake reading. */
const sleptMs = vi.hoisted(() => ({ value: 0 }));
vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn(() => vi.fn()),
    onWake: vi.fn(() => vi.fn()),
    isSleeping: () => false,
    getAwakeTimeSince: (timestamp: number) => Math.max(0, Date.now() - timestamp - sleptMs.value),
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
  getAssistantBackends: vi.fn((projectId: string) => {
    const terminalId = assistantBackends.get(projectId);
    return terminalId ? [{ terminalId, webContentsId: 42, slot: 0 }] : [];
  }),
}));

vi.mock("../HelpSessionService.js", () => ({ helpSessionService: helpSessionServiceMock }));

// Mocked rather than exercised: the real seam dynamically imports the whole
// PluginService module graph, which this sweep test has no business loading.
const pluginLifecycleMock = vi.hoisted(() => ({
  notifyProjectPluginsClosed: vi.fn<(projectId: string) => void>(),
}));
vi.mock("../../window/projectPluginLifecycle.js", () => pluginLifecycleMock);
vi.mock("../panelRecoveryQuery.js", () => ({ readPanelRecoveryHold: async () => null }));

/** Every agent resumes its conversation unless a test says otherwise (#13854). */
const allResume = vi.hoisted(
  () => async (terminals: ReadonlyArray<{ id: string }>) =>
    terminals.map((terminal) => ({
      terminalId: terminal.id,
      verdict: { resumesExactly: true } as
        { resumesExactly: true } | { resumesExactly: false; reason: string },
    }))
);
const exactResumeMock = vi.hoisted(() => ({
  observeExactAgentResumes: vi.fn(allResume),
}));
vi.mock("../pty/exactAgentResume.js", () => exactResumeMock);

import { IdleBackgroundAutoCloseService } from "../IdleBackgroundAutoCloseService.js";
import { ProjectVisibilityClock, trackProjectVisibility } from "../projectVisibilityClock.js";
import { collectActiveProjectIds } from "../../window/activeProjectIds.js";
import { notifyProjectPresenceChanged } from "../../window/projectPresenceChanges.js";
import type { PtyClient } from "../PtyClient.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

const THIRTY_MIN_MS = 30 * 60 * 1000;

/** Pins the visibility clock's "now" while a test back-dates an observation. */
const clockNowOverride = vi.hoisted(() => ({ value: null as number | null }));

/**
 * A visibility clock that has been running for `runningForMs` without seeing
 * any project on screen — so every project starts out that idle.
 */
function makeClock(runningForMs = THIRTY_MIN_MS): ProjectVisibilityClock {
  return new ProjectVisibilityClock(
    () => clockNowOverride.value ?? Date.now(),
    Date.now() - runningForMs
  );
}

/** The project was on screen until `agoMs` ago. */
function leftScreen(clock: ProjectVisibilityClock, projectId: string, agoMs = 0): void {
  clockNowOverride.value = Date.now() - agoMs;
  try {
    clock.observe([projectId]);
    clock.observe([]);
  } finally {
    clockNowOverride.value = null;
  }
}

function makeService(clock: ProjectVisibilityClock = makeClock()): IdleBackgroundAutoCloseService {
  const service = new IdleBackgroundAutoCloseService(clock);
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
function makePvm(
  activeId: string | null,
  outgoingId: string | null = null,
  mcpDispatchFor: ReadonlySet<string> = new Set(),
  dictationFor: ReadonlySet<string> = new Set()
): ProjectViewManager {
  return {
    getActiveProjectId: () => activeId,
    getOutgoingBridgeProjectId: () => outgoingId,
    isMcpDispatchProtected: (projectId: string) => mcpDispatchFor.has(projectId),
    isDictationHeld: (projectId: string) => dictationFor.has(projectId),
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
    killConfirmed.value = true;
    sleptMs.value = 0;
    remoteViewProjects.clear();
    gitSafetyMock.probeRepositorySleepSafety.mockResolvedValue({ state: "clear" });
    resourceProbeMock.probeResourceConfig.mockResolvedValue("none");
    workspaceClientMock.getAllStatesWithGitBackedForProjectAsync.mockImplementation(
      async (path) => ({ states: [{ path }], gitBacked: true })
    );
    ptyClientMock.getProcessInventory.mockResolvedValue({
      inventories: [],
      shardsTotal: 1,
      shardsFailed: 0,
    });
    evictProjectRendererMock.mockReturnValue(1);
    workspaceClientMock.evictProject.mockReturnValue(true);
    assistantBackends.clear();
    liveTerminalIds.clear();
    snapshotDegraded.value = false;
    resourceProfile.value = null;
    exactResumeMock.observeExactAgentResumes.mockImplementation(allResume);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config", () => {
    it("defaults to disabled with a 15-minute threshold", () => {
      const service = makeService();
      expect(service.getConfig()).toEqual({
        enabled: false,
        thresholdMinutes: 15,
        includeIdleShells: false,
        idleShellThresholdMinutes: 60,
      });
    });

    it("returns defaults for malformed persisted config", () => {
      storeBacking.idleBackgroundAutoClose = { enabled: "yes", thresholdMinutes: Number.NaN };
      const service = makeService();
      expect(service.getConfig()).toEqual({
        enabled: false,
        thresholdMinutes: 15,
        includeIdleShells: false,
        idleShellThresholdMinutes: 60,
      });
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
        includeIdleShells: false,
        idleShellThresholdMinutes: 60,
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
      // An automatic sleep never destroys a view an MCP dispatch is waiting on.
      expect(evictProjectRendererMock).toHaveBeenCalledWith("proj-1", { protectMcpDispatch: true });
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

    it("leaves a zero-terminal project awake while it holds pending coordination", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      const service = makeService();
      service.setCoordinationHoldProvider((id) => (id === "proj-1" ? "unseen-hand-back" : null));
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1);
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-2", {
        preserveSession: true,
      });
    });

    it("holds the project when the hold provider throws", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      service.setCoordinationHoldProvider(() => {
        throw new Error("source unreadable");
      });
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("resolves a record's owner from the sweep's terminal snapshot once its terminal exited", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal("proj-1", { id: "t-exited", hasPty: false }),
      ]);
      const service = makeService();
      service.setCoordinationHoldProvider((projectId, ownerOf) =>
        ownerOf("t-exited") === projectId ? "unseen-hand-back" : null
      );
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1);
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-2", {
        preserveSession: true,
      });
    });

    it("sleeps again once the hold clears", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      let hold: string | null = "gated-park";
      service.setCoordinationHoldProvider(() => hold);
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();

      hold = null;
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("stops the teardown when a hold appears after the sweep's own read", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      let reads = 0;
      service.setCoordinationHoldProvider(() => (++reads > 1 ? "pending-reply-wait" : null));
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("leaves a terminal-free project awake while its plugins hold live work (#14093)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      const service = makeService();
      service.setPluginWorkProvider((id) =>
        id === "proj-1" ? "plugin-task:project__proj-1__acme.sync" : null
      );
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1);
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-2", {
        preserveSession: true,
      });
      expect(logInfoMock).toHaveBeenCalledWith("idle-background-auto-close-skip-plugin-work", {
        holds: { "proj-1": "plugin-task:project__proj-1__acme.sync" },
        trigger: "idle",
      });
    });

    it("sleeps once the plugin work finishes or is cancelled (#14093)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      let hold: string | null = "plugin-task:project__proj-1__acme.sync";
      service.setPluginWorkProvider(() => hold);
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();

      hold = null;
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("stops the teardown when plugin work starts during sleep's own awaits (#14093)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      // The work starts while Sleep awaits the assistant revoke, past every
      // read the sweep and the close made before handing over to it.
      let started = false;
      helpSessionServiceMock.revokeByProjectId.mockImplementationOnce(async () => {
        started = true;
      });
      service.setPluginWorkProvider(() =>
        started ? "plugin-operation:project__proj-1__acme.sync" : null
      );
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).toHaveBeenCalledWith("proj-1");
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(logInfoMock).toHaveBeenCalledWith("idle-background-auto-close-plugin-work-hold", {
        projectId: "proj-1",
        hold: "plugin-operation:project__proj-1__acme.sync",
      });
    });

    it("holds the project when the plugin work provider throws (#14093)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      service.setPluginWorkProvider(() => {
        throw new Error("plugin registry unreadable");
      });
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("unloads the reclaimed project's plugins (#12216)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      await runCheck(service);

      // The whole point of the sweep is reclaiming memory; leaving the plugin
      // workers, timers and spawned children resident defeats it. Before
      // #12216 nothing ran the unload cascade on this path.
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledTimes(1);
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledWith("proj-1");

      // Order is load-bearing, not cosmetic: the status write is the commit
      // point, so close intent must not be published before the row carries it.
      expect(projectStoreMock.updateProjectStatus.mock.invocationCallOrder[0]!).toBeLessThan(
        pluginLifecycleMock.notifyProjectPluginsClosed.mock.invocationCallOrder[0]!
      );
    });

    it("notifies once per parked project, not once per sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1"),
        makeIdleProject("proj-2"),
      ]);
      const service = makeService();
      await runCheck(service);

      // A single-close fixture cannot tell "per successful project" apart from
      // "once per sweep" — a regression that hoisted the call out of the loop
      // would pass it. Two closes is the smallest fixture that can.
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledTimes(2);
      expect(pluginLifecycleMock.notifyProjectPluginsClosed.mock.calls.map(([id]) => id)).toEqual([
        "proj-1",
        "proj-2",
      ]);
    });

    it("never closes a project that opted out of automatic sleep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1", { neverAutoSleep: true }),
        makeIdleProject("proj-2"),
      ]);
      const service = makeService();
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalledWith(
        "proj-1",
        expect.anything()
      );
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalledWith(
        "proj-1",
        "closed",
        expect.anything()
      );
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-2", "closed", {
        autoParkedAt: expect.any(Number),
      });
    });

    it("halts an in-flight close when the project opts out during the snapshot await", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsWithCompletenessAsync
        .mockResolvedValueOnce({ terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 })
        .mockImplementationOnce(async () => {
          projectStoreMock.getProjectById.mockImplementation((id) =>
            makeIdleProject(id, { neverAutoSleep: true })
          );
          return { terminals: [], degraded: false, shardsTotal: 2, shardsFailed: 0 };
        });
      const service = makeService();
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("skips a project that still has a terminal", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal("proj-1")]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
      // A project the sweep declined to close keeps its plugins.
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
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

      // Per successfully parked project, not per candidate and not once per
      // sweep: proj-1 never closed, so its plugins must still be running.
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledTimes(1);
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).toHaveBeenCalledWith("proj-2");

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
      helpSessionServiceMock.getAssistantBackends
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ terminalId: "t-help-late", webContentsId: 42, slot: 0 }]);
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
      // Representative LATE bail: the notification hangs off the status write,
      // so a project that bails after the revoke keeps its plugins.
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
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

    it("skips a project last on screen within the idle threshold", async () => {
      enable(60);
      const opened = { lastOpened: Date.now() - 2 * 60 * 60 * 1000 };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1", opened)]);
      projectStoreMock.getProjectById.mockImplementation((id) => makeIdleProject(id, opened));
      const clock = makeClock(2 * 60 * 60 * 1000);
      leftScreen(clock, "proj-1", THIRTY_MIN_MS);
      const service = makeService(clock);
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
        isMcpDispatchProtected: () => false,
        isDictationHeld: () => false,
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

  describe("idle clock (#13844)", () => {
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

    it("does not reclaim a project that was on screen at the previous sweep, however old its lastOpened", async () => {
      enable();
      // Opened hours ago and worked in ever since: lastOpened still holds the
      // open time, because leaving for a scratch never stamps it.
      const stale = { lastOpened: Date.now() - THREE_HOURS_MS };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1", stale)]);
      projectStoreMock.getProjectById.mockImplementation((id) => makeIdleProject(id, stale));
      let onScreen = true;
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm(onScreen ? "proj-1" : "scratch-1")]);

      await runCheck(service);
      onScreen = false;
      await runCheck(service);

      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
    });

    it("counts a visit that started and ended between two sweeps", async () => {
      enable();
      const stale = { lastOpened: Date.now() - THREE_HOURS_MS };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1", stale)]);
      projectStoreMock.getProjectById.mockImplementation((id) => makeIdleProject(id, stale));
      const clock = makeClock(THREE_HOURS_MS);
      let shown = "scratch-1";
      const provider = () => [makePvm(shown)];
      const stopTracking = trackProjectVisibility(
        () => collectActiveProjectIds(provider, null, "test"),
        clock
      );
      const service = makeService(clock);
      service.setProjectViewManagersProvider(provider);

      try {
        // No sweep ever sees proj-1 on screen: it comes and goes in between.
        shown = "proj-1";
        notifyProjectPresenceChanged();
        shown = "scratch-1";
        notifyProjectPresenceChanged();
        await runCheck(service);
      } finally {
        stopTracking();
      }

      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("gives a project nothing has seen since startup a full threshold, whatever its lastOpened", async () => {
      enable();
      const yesterday = { lastOpened: Date.now() - 24 * 60 * 60 * 1000 };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1", yesterday)]);
      projectStoreMock.getProjectById.mockImplementation((id) => makeIdleProject(id, yesterday));
      const service = makeService(makeClock(5 * 60 * 1000));
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("still counts a recent open the clock never saw", async () => {
      enable();
      // The legacy single-view switch moves only the DB pointer, so the clock
      // can miss a visit that its lastOpened stamp still records.
      const recent = { lastOpened: Date.now() - 60 * 1000 };
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1", recent)]);
      projectStoreMock.getProjectById.mockImplementation((id) => makeIdleProject(id, recent));
      const service = makeService(makeClock(THREE_HOURS_MS));
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("keeps a project another window shows on the clock's screen through a read without the provider", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const clock = makeClock(THREE_HOURS_MS);
      // What the tracker saw. The service has no provider yet, so its own read
      // holds only the DB pointer and must not count as the whole screen.
      clock.observe(["proj-1"]);
      const service = makeService(clock);
      await runCheck(service);

      const later = Date.now() + THIRTY_MIN_MS;
      clockNowOverride.value = later;
      try {
        expect(clock.lastVisibleAt("proj-1")).toBe(later);
      } finally {
        clockNowOverride.value = null;
      }
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

    it("does not close a project that came on screen and went during the sweep", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const clock = makeClock();
      // A switch there and straight back while the teardown's terminal snapshot
      // is in flight: the row is still "background" with zero terminals and no
      // window shows it at the re-check. Only the clock saw the visit.
      ptyClientMock.getAllTerminalsAsync
        .mockResolvedValueOnce([])
        .mockImplementationOnce(async () => {
          leftScreen(clock, "proj-1");
          return [];
        });
      const service = makeService(clock);
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

    describe("activation during the final awaits (#13570)", () => {
      let activated = false;

      function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      }

      /** What a window switch does: PVM reports it, the row flips, lastOpened bumps. */
      function activate(): void {
        activated = true;
        projectStoreMock.getProjectById.mockImplementation((id) => ({
          id,
          name: id,
          path: `/projects/${id}`,
          status: "active",
          lastOpened: Date.now(),
        }));
      }

      function makeActivatableService(clock = makeClock()): IdleBackgroundAutoCloseService {
        activated = false;
        const service = makeService(clock);
        service.setProjectViewManagersProvider(() => (activated ? [makePvm("proj-1")] : []));
        return service;
      }

      function expectSurvived(): void {
        expect(evictProjectRendererMock).not.toHaveBeenCalled();
        expect(workspaceClientMock.evictProject).not.toHaveBeenCalled();
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
        expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      }

      it("survives when activated while the post-revoke terminal snapshot is in flight", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const postRevoke = deferred<unknown[]>();
        ptyClientMock.getAllTerminalsAsync
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockReturnValueOnce(postRevoke.promise);
        const service = makeActivatableService();

        const sweep = runCheck(service);
        await vi.waitFor(() => expect(ptyClientMock.getAllTerminalsAsync).toHaveBeenCalledTimes(3));
        activate();
        postRevoke.resolve([]);
        await sweep;

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expectSurvived();
      });

      it("survives when activated while the graceful kill is in flight, keeping the hibernation markers", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const kill = deferred<Array<{ id: string }>>();
        ptyClientMock.gracefulKillByProject.mockReturnValueOnce(kill.promise);
        const service = makeActivatableService();

        const sweep = runCheck(service);
        await vi.waitFor(() =>
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1)
        );
        activate();
        kill.resolve([{ id: "t-killed" }]);
        await sweep;

        // The PTY is already gone, so its marker still lets the reopen restore it.
        expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t-killed");
        expectSurvived();
      });

      it("survives a visit that came and went during the kill, before the row leaves background", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const kill = deferred<Array<{ id: string }>>();
        ptyClientMock.gracefulKillByProject.mockReturnValueOnce(kill.promise);
        const clock = makeClock();
        const service = makeActivatableService(clock);

        const sweep = runCheck(service);
        await vi.waitFor(() =>
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1)
        );
        leftScreen(clock, "proj-1");
        kill.resolve([]);
        await sweep;

        expectSurvived();
      });

      it("survives when only a window reports it active after the kill", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const kill = deferred<Array<{ id: string }>>();
        ptyClientMock.gracefulKillByProject.mockReturnValueOnce(kill.promise);
        const service = makeActivatableService();

        const sweep = runCheck(service);
        await vi.waitFor(() =>
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1)
        );
        activated = true;
        kill.resolve([]);
        await sweep;

        expectSurvived();
      });

      it("stops short of closing when auto-close is disabled during the kill", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const kill = deferred<Array<{ id: string }>>();
        ptyClientMock.gracefulKillByProject.mockReturnValueOnce(kill.promise);
        const service = makeActivatableService();

        const sweep = runCheck(service);
        await vi.waitFor(() =>
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1)
        );
        storeBacking.idleBackgroundAutoClose = { enabled: false, thresholdMinutes: 15 };
        kill.resolve([{ id: "t-killed" }]);
        await sweep;

        expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t-killed");
        expectSurvived();
      });

      it("never starts the capture-revoke when activated during the first teardown snapshot", async () => {
        enable();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const firstRead = deferred<unknown[]>();
        ptyClientMock.getAllTerminalsAsync
          .mockResolvedValueOnce([])
          .mockReturnValueOnce(firstRead.promise);
        const service = makeActivatableService();

        const sweep = runCheck(service);
        await vi.waitFor(() => expect(ptyClientMock.getAllTerminalsAsync).toHaveBeenCalledTimes(2));
        activate();
        firstRead.resolve([]);
        await sweep;

        expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expectSurvived();
      });
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

    it("still closes a project whose renderer eviction fails, and carries on", async () => {
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
      // Sleep's contract (#13845): once the kill is confirmed the sleep is
      // committed, and a failed reclaim step must not strand the row "open"
      // with its terminals gone.
      for (const id of ["bad-1", "good-1"]) {
        expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
          id,
          "closed",
          expect.anything()
        );
      }
    });

    it("leaves a project open when the host can't confirm its kill (#11340)", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      killConfirmed.value = false;
      const service = makeService();
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1);
      expect(writeHibernatedMarkerMock).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalledWith(
        "idle-background:closed",
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
  });

  // An automatic close must never take the view an MCP client is waiting on:
  // that session fails SESSION_BINDING_GONE until the project reopens (#13845).
  describe("MCP dispatch leases", () => {
    it("never starts a sleep while a dispatch is waiting on the project's view", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm("other", null, new Set(["proj-1"]))]);
      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("abandons the close when a dispatch starts during the kill", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const leased = new Set<string>();
      let releaseKill!: (value: Array<{ id: string }>) => void;
      ptyClientMock.gracefulKillByProject.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseKill = resolve;
        })
      );
      const service = makeService();
      service.setProjectViewManagersProvider(() => [makePvm("other", null, leased)]);

      const sweep = runCheck(service);
      await vi.waitFor(() => expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1));
      leased.add("proj-1");
      releaseKill([{ id: "t-killed" }]);
      await sweep;

      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t-killed");
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(pluginLifecycleMock.notifyProjectPluginsClosed).not.toHaveBeenCalled();
    });
  });

  // Destroying the view a dictation started from cancels the session, and its
  // words go to the draft store, never the PTY, so no idle check sees them.
  describe("dictation holds (#15920)", () => {
    it("leaves a project a dictation still needs, and closes it on the sweep after", async () => {
      enable();
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const dictating = new Set(["proj-1"]);
      const service = makeService();
      service.setProjectViewManagersProvider(() => [
        makePvm("other"),
        makePvm("another", null, new Set(), dictating),
      ]);

      await runCheck(service);

      expect(helpSessionServiceMock.revokeByProjectId).not.toHaveBeenCalled();
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(evictProjectRendererMock).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();

      dictating.clear();
      await runCheck(service);

      expect(evictProjectRendererMock).toHaveBeenCalledWith("proj-1", {
        protectMcpDispatch: true,
      });
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith(
        "proj-1",
        "closed",
        expect.anything()
      );
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

  describe("idle shell projects (#13849)", () => {
    const HOUR_MS = 60 * 60 * 1000;

    function enableShells(idleShellThresholdMinutes = 60): void {
      storeBacking.idleBackgroundAutoClose = {
        enabled: true,
        thresholdMinutes: 15,
        includeIdleShells: true,
        idleShellThresholdMinutes,
      };
    }

    function shellTerminal(projectId: string, overrides: Record<string, unknown> = {}) {
      const quietSince = Date.now() - 3 * HOUR_MS;
      return makeTerminal(projectId, {
        kind: "terminal",
        spawnedAt: quietSince,
        lastInputTime: quietSince,
        lastOutputTime: quietSince,
        ...overrides,
      });
    }

    function census(
      projectId: string,
      overrides: {
        comm?: string;
        processCount?: number;
        sampledAt?: number;
        available?: boolean;
        memoryKb?: number;
      } = {}
    ) {
      return {
        inventories: [
          {
            terminals: [
              {
                id: `t-${projectId}`,
                projectId,
                rootPid: 100,
                sample: {
                  cpuPercent: 0,
                  memoryKb: overrides.memoryKb ?? 4096,
                  processCount: overrides.processCount ?? 1,
                  members: [
                    { pid: 100, comm: overrides.comm ?? "zsh", cpuPercent: 0, memoryKb: 4096 },
                  ],
                },
              },
            ],
            pidSamples: {},
            available: overrides.available ?? true,
            sampledAt: overrides.sampledAt ?? Date.now(),
          },
        ],
        shardsTotal: 1,
        shardsFailed: 0,
      };
    }

    /** A background shell project, off screen for three hours, every gate open. */
    function setUpIdleShellProject(projectId = "proj-1") {
      const lastOpened = Date.now() - 3 * HOUR_MS;
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject(projectId, { lastOpened })]);
      projectStoreMock.getProjectById.mockImplementation((id) =>
        makeIdleProject(id, { lastOpened })
      );
      ptyClientMock.getAllTerminalsAsync.mockResolvedValue([shellTerminal(projectId)]);
      ptyClientMock.getProcessInventory.mockResolvedValue(census(projectId));
      return makeService(makeClock(3 * HOUR_MS));
    }

    function skipLog(): Record<string, string[]> | undefined {
      const call = logInfoMock.mock.calls.find(
        ([event]) => event === "idle-background-auto-close-skip-idle-shells"
      );
      return (call?.[1] as { reasons: Record<string, string[]> } | undefined)?.reasons;
    }

    it("skips an idle shell project that holds pending coordination", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      service.setCoordinationHoldProvider(() => "queued-notify");
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ "coordination-hold": ["proj-1"] });
    });

    it("stops an idle shell project's teardown when a hold appears during its probes", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      let reads = 0;
      service.setCoordinationHoldProvider(() => (++reads > 1 ? "queued-notify" : null));
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ "coordination-hold": ["proj-1"] });
    });

    it("skips an idle shell project whose plugins hold live work (#14093)", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      service.setPluginWorkProvider(() => "plugin-task:project__proj-1__acme.sync");
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ "plugin-work": ["proj-1"] });
    });

    it("stops an idle shell project's teardown when plugin work starts during its probes (#14093)", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      let reads = 0;
      service.setPluginWorkProvider(() =>
        ++reads > 1 ? "plugin-task:project__proj-1__acme.sync" : null
      );
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ "plugin-work": ["proj-1"] });
    });

    it("sleeps a project whose only terminal is an idle plain shell", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      await runCheck(service);

      expect(gitSafetyMock.probeRepositorySleepSafety).toHaveBeenCalledWith(
        ["/projects/proj-1", "/projects/proj-1"],
        { missingRepoIsClear: false }
      );
      expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: expect.any(Number),
      });
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "idle-background:closed",
        expect.objectContaining({
          projects: [{ projectId: "proj-1", projectName: "proj-1", estimatedMemoryKb: 4096 }],
          trigger: "idle",
        })
      );
    });

    it("leaves an idle shell project that opted out of automatic sleep awake", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      const lastOpened = Date.now() - 3 * HOUR_MS;
      projectStoreMock.getAllProjects.mockReturnValue([
        makeIdleProject("proj-1", { lastOpened, neverAutoSleep: true }),
      ]);
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("halts an idle shell close when the project opts out mid-sweep", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      const lastOpened = Date.now() - 3 * HOUR_MS;
      ptyClientMock.getProcessInventory.mockImplementation(async () => {
        projectStoreMock.getProjectById.mockImplementation((id) =>
          makeIdleProject(id, { lastOpened, neverAutoSleep: true })
        );
        return census("proj-1");
      });
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
    });

    it("leaves shell projects alone until they are opted in", async () => {
      enable();
      const service = setUpIdleShellProject();
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(ptyClientMock.getProcessInventory).not.toHaveBeenCalled();
    });

    it("waits out the chosen threshold", async () => {
      enableShells(240);
      const service = setUpIdleShellProject();
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("doesn't count time the machine spent asleep", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      sleptMs.value = 2.5 * HOUR_MS;
      await runCheck(service);
      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    /** Every gate an idle shell project is held to, and what each logs. */
    const gateCases: Array<[string, string, () => void]> = [
      [
        "a foreground or background job",
        "terminal-busy",
        () =>
          ptyClientMock.getProcessInventory.mockResolvedValue(
            census("proj-1", { processCount: 2 })
          ),
      ],
      [
        "a terminal launched straight into a REPL",
        "terminal-busy",
        () =>
          ptyClientMock.getProcessInventory.mockResolvedValue(census("proj-1", { comm: "node" })),
      ],
      [
        "a stale census",
        "census-stale",
        () =>
          ptyClientMock.getProcessInventory.mockResolvedValue(
            census("proj-1", { sampledAt: Date.now() - 5 * 60 * 1000 })
          ),
      ],
      [
        "a failing census",
        "census-unavailable",
        () =>
          ptyClientMock.getProcessInventory.mockResolvedValue(
            census("proj-1", { available: false })
          ),
      ],
      [
        "an agent launched but never detected",
        "agent-resume-unproven",
        () =>
          ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
            shellTerminal("proj-1", { launchAgentId: "claude" }),
          ]),
      ],
      [
        "a dev preview",
        "agent-terminal",
        () =>
          ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
            shellTerminal("proj-1", { kind: "dev-preview" }),
          ]),
      ],
      [
        "recent terminal output",
        "terminal-activity",
        () =>
          ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
            shellTerminal("proj-1", { lastOutputTime: Date.now() - 60_000 }),
          ]),
      ],
      [
        "a git operation in progress",
        "git-busy",
        () =>
          gitSafetyMock.probeRepositorySleepSafety.mockResolvedValue({
            state: "busy",
            marker: "rebase-merge",
          }),
      ],
      [
        "an unreadable git directory",
        "git-unknown",
        () => gitSafetyMock.probeRepositorySleepSafety.mockResolvedValue({ state: "unknown" }),
      ],
      [
        "no workspace host answer",
        "workspace-unknown",
        () =>
          workspaceClientMock.getAllStatesWithGitBackedForProjectAsync.mockResolvedValue({
            states: [],
            gitBacked: null,
          }),
      ],
      [
        "a resource environment",
        "resource-configured",
        () =>
          workspaceClientMock.getAllStatesWithGitBackedForProjectAsync.mockResolvedValue({
            states: [{ path: "/projects/proj-1", hasResourceConfig: true }],
            gitBacked: true,
          }),
      ],
      [
        "a running lifecycle script",
        "lifecycle-busy",
        () =>
          workspaceClientMock.getAllStatesWithGitBackedForProjectAsync.mockResolvedValue({
            states: [{ path: "/projects/proj-1", lifecycleStatus: { state: "running" } }],
            gitBacked: true,
          }),
      ],
      [
        "a resource environment declared on disk",
        "resource-configured",
        () => resourceProbeMock.probeResourceConfig.mockResolvedValue("configured"),
      ],
      [
        "an unreadable resource config",
        "resource-unknown",
        () => resourceProbeMock.probeResourceConfig.mockResolvedValue("unknown"),
      ],
      ["a remote Shell's view", "remote-host", () => remoteViewProjects.add("proj-1")],
    ];

    it.each(gateCases)("stays awake for %s and logs why", async (_case, reason, arrange) => {
      enableShells();
      const service = setUpIdleShellProject();
      arrange();
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ [reason]: ["proj-1"] });
    });

    it("won't kill a terminal it never vetted", async () => {
      enableShells();
      const service = setUpIdleShellProject();
      // The sweep and the close both see one shell; the kill's own snapshot
      // finds a second one opened in between.
      ptyClientMock.getAllTerminalsAsync
        .mockResolvedValueOnce([shellTerminal("proj-1")])
        .mockResolvedValueOnce([shellTerminal("proj-1")])
        .mockResolvedValue([shellTerminal("proj-1"), shellTerminal("proj-1", { id: "t-new" })]);
      await runCheck(service);

      expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(skipLog()).toEqual({ ineligible: ["proj-1"] });
    });

    describe("agents (#13854)", () => {
      /** A launched Claude off screen and at rest for three hours, still redrawing its status line. */
      function agentTerminal(projectId: string, overrides: Record<string, unknown> = {}) {
        const quietSince = Date.now() - 3 * HOUR_MS;
        return makeTerminal(projectId, {
          kind: "terminal",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          everDetectedAgent: true,
          agentSessionId: "session-1",
          agentIncarnation: 0,
          agentState: "waiting",
          waitingReason: "prompt",
          lastStateChange: quietSince,
          spawnedAt: quietSince - 1,
          lastInputTime: quietSince - 1,
          lastTypedInputAt: quietSince - 1,
          lastOutputChangeAt: quietSince,
          lastOutputTime: Date.now() - 1_000,
          hasPendingSubmission: false,
          outputObservedSince: quietSince - 1,
          ...overrides,
        });
      }

      function agentCensus(projectId: string, agentTree = "runtime-and-servers") {
        const read = census(projectId, { processCount: 3 });
        Object.assign(read.inventories[0].terminals[0], { agentTree });
        return read;
      }

      function setUpIdleAgentProject(projectId = "proj-1") {
        const service = setUpIdleShellProject(projectId);
        ptyClientMock.getAllTerminalsAsync.mockResolvedValue([agentTerminal(projectId)]);
        ptyClientMock.getProcessInventory.mockResolvedValue(agentCensus(projectId));
        return service;
      }

      it("sleeps a project whose agent rests at its prompt and will resume its conversation", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        await runCheck(service);

        expect(exactResumeMock.observeExactAgentResumes).toHaveBeenCalledWith([
          expect.objectContaining({ id: "t-proj-1", agentSessionId: "session-1" }),
        ]);
        expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
          preserveSession: true,
        });
        expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
          autoParkedAt: expect.any(Number),
        });
      });

      it("leaves agent projects alone until idle terminals are opted in", async () => {
        enable();
        const service = setUpIdleAgentProject();
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(exactResumeMock.observeExactAgentResumes).not.toHaveBeenCalled();
      });

      it("stays awake when an agent won't resume its conversation, and logs what it saw", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        exactResumeMock.observeExactAgentResumes.mockImplementation(async (terminals) =>
          terminals.map((terminal) => ({
            terminalId: terminal.id,
            verdict: { resumesExactly: false as const, reason: "no-transcript" },
          }))
        );
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ "agent-resume-unproven": ["proj-1"] });
        expect(logInfoMock).toHaveBeenCalledWith("idle-background-auto-close-resume-unproven", {
          projectId: "proj-1",
          refused: [{ terminalId: "t-proj-1", reason: "no-transcript" }],
        });
      });

      it("stays awake when any one of its agents won't resume", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        const second = agentTerminal("proj-1", { id: "t-proj-1-b", agentSessionId: "session-2" });
        ptyClientMock.getAllTerminalsAsync.mockResolvedValue([agentTerminal("proj-1"), second]);
        const read = agentCensus("proj-1");
        read.inventories[0].terminals.push({
          ...read.inventories[0].terminals[0],
          id: "t-proj-1-b",
        });
        ptyClientMock.getProcessInventory.mockResolvedValue(read);
        exactResumeMock.observeExactAgentResumes.mockImplementation(async (terminals) =>
          terminals.map((terminal) => ({
            terminalId: terminal.id,
            verdict:
              terminal.id === "t-proj-1-b"
                ? { resumesExactly: false as const, reason: "store-unknown" }
                : { resumesExactly: true as const },
          }))
        );
        await runCheck(service);

        expect(exactResumeMock.observeExactAgentResumes).toHaveBeenCalledWith([
          expect.objectContaining({ id: "t-proj-1" }),
          expect.objectContaining({ id: "t-proj-1-b" }),
        ]);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ "agent-resume-unproven": ["proj-1"] });
      });

      it("stays awake when the transcript read fails", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        exactResumeMock.observeExactAgentResumes.mockRejectedValue(new Error("EIO"));
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ "agent-resume-unproven": ["proj-1"] });
      });

      it.each<[string, string, () => void]>([
        [
          "an approval prompt",
          "agent-not-at-prompt",
          () =>
            ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
              agentTerminal("proj-1", { waitingReason: "approval" }),
            ]),
        ],
        [
          "a queued submission",
          "agent-input-pending",
          () =>
            ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
              agentTerminal("proj-1", { hasPendingSubmission: true }),
            ]),
        ],
        [
          "a visible change inside the threshold",
          "terminal-activity",
          () =>
            ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
              agentTerminal("proj-1", { lastOutputChangeAt: Date.now() - 60_000 }),
            ]),
        ],
        [
          "a background shell under the agent",
          "terminal-busy",
          () => ptyClientMock.getProcessInventory.mockResolvedValue(agentCensus("proj-1", "other")),
        ],
      ])("stays awake for %s without reading the transcript", async (_case, reason, arrange) => {
        enableShells();
        const service = setUpIdleAgentProject();
        arrange();
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(exactResumeMock.observeExactAgentResumes).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ [reason]: ["proj-1"] });
      });

      it("won't kill an agent that took a turn after it was vetted", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        // The sweep and the close see it at rest; the kill's own snapshot sees a turn.
        ptyClientMock.getAllTerminalsAsync
          .mockResolvedValueOnce([agentTerminal("proj-1")])
          .mockResolvedValueOnce([agentTerminal("proj-1")])
          .mockResolvedValue([
            agentTerminal("proj-1", { agentState: "working", lastStateChange: Date.now() }),
          ]);
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ ineligible: ["proj-1"] });
      });

      it("won't kill an agent whose session changed while its transcript was read", async () => {
        enableShells();
        const service = setUpIdleAgentProject();
        exactResumeMock.observeExactAgentResumes.mockImplementation(async (terminals) => {
          ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
            agentTerminal("proj-1", { agentSessionId: "session-2" }),
          ]);
          return allResume(terminals);
        });
        await runCheck(service);

        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      });

      it("sleeps under memory pressure behind the same gates", async () => {
        enableShells(480);
        const service = setUpIdleAgentProject();
        ptyClientMock.gracefulKillByProject.mockResolvedValue([{ id: "t-proj-1" }]);

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(1);
        expect(exactResumeMock.observeExactAgentResumes).toHaveBeenCalledTimes(1);
      });
    });

    it("keeps zero-terminal projects on their own shorter threshold", async () => {
      enableShells(480);
      projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
      const service = makeService();
      await runCheck(service);
      expect(projectStoreMock.updateProjectStatus).toHaveBeenCalledWith("proj-1", "closed", {
        autoParkedAt: expect.any(Number),
      });
    });

    describe("under memory pressure (#13852)", () => {
      const MINUTE_MS = 60 * 1000;

      /** A background shell project off screen, and its shell quiet, for `idleMs`. */
      function setUpShellProjectIdleFor(idleMs: number, projectId = "proj-1") {
        const since = Date.now() - idleMs;
        projectStoreMock.getAllProjects.mockReturnValue([
          makeIdleProject(projectId, { lastOpened: since }),
        ]);
        projectStoreMock.getProjectById.mockImplementation((id) =>
          makeIdleProject(id, { lastOpened: since })
        );
        ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
          shellTerminal(projectId, {
            spawnedAt: since,
            lastInputTime: since,
            lastOutputTime: since,
          }),
        ]);
        ptyClientMock.getProcessInventory.mockResolvedValue(census(projectId));
        return makeService(makeClock(idleMs));
      }

      function pressureBroadcast() {
        return broadcastToRendererMock.mock.calls.find(
          ([channel]) => channel === "idle-background:closed"
        )?.[1] as { projects: unknown[]; trigger?: string } | undefined;
      }

      it("sleeps a shell project the user's threshold hasn't reached yet", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        // Two sessions for one project: the ladder is told terminals, not projects.
        ptyClientMock.gracefulKillByProject.mockResolvedValue([
          { id: "t-proj-1" },
          { id: "t-proj-1-b" },
        ]);

        await runCheck(service);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(2);
        expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
          preserveSession: true,
        });
        expect(pressureBroadcast()).toEqual(
          expect.objectContaining({
            trigger: "memory-pressure",
            projects: [{ projectId: "proj-1", projectName: "proj-1", estimatedMemoryKb: 4096 }],
          })
        );
      });

      it.each([
        ["efficiency", 10 * MINUTE_MS, false],
        ["efficiency", 20 * MINUTE_MS, true],
        ["balanced", 20 * MINUTE_MS, false],
        ["balanced", 45 * MINUTE_MS, true],
        ["performance", 45 * MINUTE_MS, false],
      ])(
        "holds a %s profile's threshold (idle %d ms → sleeps: %s)",
        async (profile, idleMs, sleeps) => {
          enableShells(480);
          resourceProfile.value = profile;
          const service = setUpShellProjectIdleFor(idleMs);
          await service.sleepUnderMemoryPressure();
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(sleeps ? 1 : 0);
        }
      );

      it.each([
        [45, true],
        [20, false],
      ])(
        "shortens how long the shell must be quiet too (quiet %d min → sleeps: %s)",
        async (quietMinutes, sleeps) => {
          enableShells(480);
          const service = setUpIdleShellProject();
          ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
            shellTerminal("proj-1", { lastOutputTime: Date.now() - quietMinutes * MINUTE_MS }),
          ]);
          await service.sleepUnderMemoryPressure();
          expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(sleeps ? 1 : 0);
          expect(skipLog()).toEqual(sleeps ? undefined : { "terminal-activity": ["proj-1"] });
        }
      );

      it.each(gateCases)(
        "still stays awake for %s and logs why",
        async (_case, reason, arrange) => {
          enableShells();
          const service = setUpIdleShellProject();
          arrange();
          await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);

          expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
          expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
          expect(skipLog()).toEqual({ [reason]: ["proj-1"] });
        }
      );

      it("sleeps the projects holding the most first", async () => {
        enableShells();
        const lastOpened = Date.now() - 3 * HOUR_MS;
        projectStoreMock.getAllProjects.mockReturnValue([
          makeIdleProject("small", { lastOpened }),
          makeIdleProject("large", { lastOpened }),
          makeIdleProject("medium", { lastOpened }),
        ]);
        projectStoreMock.getProjectById.mockImplementation((id) =>
          makeIdleProject(id, { lastOpened })
        );
        ptyClientMock.getAllTerminalsAsync.mockResolvedValue([
          shellTerminal("small"),
          shellTerminal("large"),
          shellTerminal("medium"),
        ]);
        const reads = [
          census("small", { memoryKb: 2048 }),
          census("large", { memoryKb: 512_000 }),
          census("medium", { memoryKb: 65_536 }),
        ];
        ptyClientMock.getProcessInventory.mockResolvedValue({
          ...reads[0]!,
          inventories: [
            {
              ...reads[0]!.inventories[0]!,
              terminals: reads.flatMap((read) => read.inventories[0]!.terminals),
            },
          ],
        });
        ptyClientMock.gracefulKillByProject.mockImplementation(async (projectId) => [
          { id: `t-${projectId}` },
        ]);
        const service = makeService(makeClock(3 * HOUR_MS));

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(3);
        expect(ptyClientMock.gracefulKillByProject.mock.calls.map(([id]) => id)).toEqual([
          "large",
          "medium",
          "small",
        ]);
        expect(pressureBroadcast()?.projects).toEqual([
          { projectId: "large", projectName: "large", estimatedMemoryKb: 512_000 },
          { projectId: "medium", projectName: "medium", estimatedMemoryKb: 65_536 },
          { projectId: "small", projectName: "small", estimatedMemoryKb: 2048 },
        ]);
      });

      it("leaves projects with no terminals on their own schedule", async () => {
        enableShells();
        projectStoreMock.getAllProjects.mockReturnValue([makeIdleProject("proj-1")]);
        const service = makeService();
        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      });

      it.each([
        ["auto-close is off", () => {}],
        ["idle shells aren't opted in", () => enable()],
      ])("does nothing while %s", async (_case, arrange) => {
        arrange();
        const service = setUpIdleShellProject();
        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.getAllTerminalsAsync).not.toHaveBeenCalled();
        expect(ptyClientMock.getProcessInventory).not.toHaveBeenCalled();
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
      });

      it("waits out the startup quiet period like the scheduled sweep", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        service.start();
        try {
          await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
          expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        } finally {
          service.stop();
        }
      });

      it("stands aside while a scheduled sweep is still running", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        let release!: (terminals: unknown[]) => void;
        ptyClientMock.getAllTerminalsAsync.mockReturnValueOnce(
          new Promise((resolve) => {
            release = resolve;
          })
        );
        const scheduled = runCheck(service);

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.getAllTerminalsAsync).toHaveBeenCalledTimes(1);

        release([shellTerminal("proj-1")]);
        await scheduled;
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();

        // The guard is released with the sweep, so the next pass goes ahead.
        await service.sleepUnderMemoryPressure();
        expect(ptyClientMock.gracefulKillByProject).toHaveBeenCalledTimes(1);
      });

      /** Three shell projects off screen for three hours, censused at these sizes. */
      function setUpRankedShellProjects(sizes: Record<string, number>) {
        const lastOpened = Date.now() - 3 * HOUR_MS;
        const ids = Object.keys(sizes);
        projectStoreMock.getAllProjects.mockReturnValue(
          ids.map((id) => makeIdleProject(id, { lastOpened }))
        );
        projectStoreMock.getProjectById.mockImplementation((id) =>
          makeIdleProject(id, { lastOpened })
        );
        ptyClientMock.getAllTerminalsAsync.mockResolvedValue(ids.map((id) => shellTerminal(id)));
        // Fresh on every read, so a sweep that outlasts the freshness bound
        // isn't what holds a later project back.
        ptyClientMock.getProcessInventory.mockImplementation(async () => {
          const reads = ids.map((id) => census(id, { memoryKb: sizes[id] }));
          return {
            ...reads[0]!,
            inventories: [
              {
                ...reads[0]!.inventories[0]!,
                terminals: reads.flatMap((read) => read.inventories[0]!.terminals),
              },
            ],
          };
        });
        ptyClientMock.gracefulKillByProject.mockImplementation(async (projectId) => [
          { id: `t-${projectId}` },
        ]);
        return makeService(makeClock(3 * HOUR_MS));
      }

      it("goes on to the next project when one sleep throws", async () => {
        enableShells();
        const service = setUpRankedShellProjects({ small: 2048, large: 512_000 });
        resourceProbeMock.probeResourceConfig.mockRejectedValueOnce(new Error("disk gone"));

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(1);
        expect(ptyClientMock.gracefulKillByProject.mock.calls.map(([id]) => id)).toEqual(["small"]);
        expect(pressureBroadcast()?.projects).toEqual([
          { projectId: "small", projectName: "small", estimatedMemoryKb: 2048 },
        ]);
      });

      it("leaves the smallest projects for the next pass once its time is spent", async () => {
        enableShells();
        const service = setUpRankedShellProjects({ small: 2048, large: 512_000, medium: 65_536 });
        let elapsedMs = 0;
        vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
        ptyClientMock.gracefulKillByProject.mockImplementation(async (projectId) => {
          elapsedMs += 31_000;
          return [{ id: `t-${projectId}` }];
        });

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(1);
        expect(ptyClientMock.gracefulKillByProject.mock.calls.map(([id]) => id)).toEqual(["large"]);
        expect(logInfoMock).toHaveBeenCalledWith(
          "idle-background-auto-close-pressure-budget-spent",
          {
            deferred: ["medium", "small"],
          }
        );
      });

      it("counts the terminals a sleep killed before it was refused", async () => {
        enableShells();
        const service = setUpIdleShellProject();
        // The user opens the project while its shells are going down.
        ptyClientMock.gracefulKillByProject.mockImplementation(async () => {
          projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
          return [{ id: "t-proj-1" }];
        });

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(1);
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
        expect(pressureBroadcast()).toBeUndefined();
      });

      it("leaves a candidate open whose last shell exited after the screen", async () => {
        enableShells();
        const service = setUpIdleShellProject();
        ptyClientMock.getAllTerminalsAsync
          .mockResolvedValueOnce([shellTerminal("proj-1")])
          .mockResolvedValue([]);
        ptyClientMock.getProcessInventory
          .mockResolvedValueOnce(census("proj-1"))
          .mockResolvedValue({ inventories: [], shardsTotal: 1, shardsFailed: 0 });

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      });

      it("stops when idle shells are turned off partway through", async () => {
        enableShells();
        const service = setUpIdleShellProject();
        let releaseWorkspace!: () => void;
        workspaceClientMock.getAllStatesWithGitBackedForProjectAsync.mockImplementationOnce(
          (path) =>
            new Promise((resolve) => {
              releaseWorkspace = () => resolve({ states: [{ path }], gitBacked: true });
            })
        );

        const pressure = service.sleepUnderMemoryPressure();
        await vi.waitFor(() =>
          expect(workspaceClientMock.getAllStatesWithGitBackedForProjectAsync).toHaveBeenCalled()
        );
        storeBacking.idleBackgroundAutoClose = {
          ...(storeBacking.idleBackgroundAutoClose as Record<string, unknown>),
          includeIdleShells: false,
        };
        releaseWorkspace();

        await expect(pressure).resolves.toBe(0);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(pressureBroadcast()).toBeUndefined();
      });

      it("still leaves a project that opted out of automatic sleep awake", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        projectStoreMock.getAllProjects.mockReturnValue([
          makeIdleProject("proj-1", { lastOpened: Date.now() - 3 * HOUR_MS, neverAutoSleep: true }),
        ]);

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.getProcessInventory).not.toHaveBeenCalled();
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      });

      it("still drops a deferred sleep when the project opts out after the screen", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        const lastOpened = Date.now() - 3 * HOUR_MS;
        projectStoreMock.getProjectById.mockImplementation((id) =>
          makeIdleProject(id, { lastOpened, neverAutoSleep: true })
        );

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
      });

      it("still holds a project with pending coordination", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        service.setCoordinationHoldProvider(() => "queued-notify");

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.getProcessInventory).not.toHaveBeenCalled();
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ "coordination-hold": ["proj-1"] });
      });

      it("still drops a deferred sleep when a hold appears after the screen", async () => {
        enableShells(480);
        const service = setUpIdleShellProject();
        let reads = 0;
        service.setCoordinationHoldProvider(() => (++reads > 1 ? "pending-reply-wait" : null));

        await expect(service.sleepUnderMemoryPressure()).resolves.toBe(0);
        expect(ptyClientMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(projectStoreMock.updateProjectStatus).not.toHaveBeenCalled();
        expect(skipLog()).toEqual({ "coordination-hold": ["proj-1"] });
      });
    });
  });
});
