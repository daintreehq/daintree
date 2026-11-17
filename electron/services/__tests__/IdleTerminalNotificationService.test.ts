import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const storeBacking: Record<string, unknown> = {};
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => (key in storeBacking ? storeBacking[key] : undefined)),
  set: vi.fn((key: string, value: unknown) => {
    storeBacking[key] = value;
  }),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getAllProjects: vi.fn<
    () => Array<{ id: string; name: string; path: string; neverAutoSleep?: boolean }>
  >(() => []),
}));

/** How the terminal read went: a shard that timed out leaves the snapshot degraded. */
const snapshotHealth = vi.hoisted(() => ({ degraded: false }));

// `assistantBackends` maps a project to the terminal its help session bound;
// `liveTerminalIds` backs PtyClient's spawn registry. A binding whose terminal
// is not live models an Assistant that already exited.
const assistantBackends = vi.hoisted(() => new Map<string, string>());
const liveTerminalIds = vi.hoisted(() => new Set<string>());
vi.mock("../helpSessionRuntime.js", () => ({
  loadedHelpSessionService: () => ({
    getAssistantBackends: (projectId: string) => {
      const terminalId = assistantBackends.get(projectId);
      return terminalId ? [{ terminalId, webContentsId: 42, slot: 0 }] : [];
    },
  }),
}));

const ptyManagerMock = vi.hoisted(() => ({
  hasTerminal: vi.fn((id: string) => liveTerminalIds.has(id)),
  getAllTerminalsAsync: vi.fn<() => Promise<unknown[]>>(async () => []),
  // Reads the same fixture the tests set on `getAllTerminalsAsync`, as the real
  // client's two reads share one source.
  getAllTerminalsWithCompletenessAsync: vi.fn(async () => {
    const degraded = snapshotHealth.degraded;
    return {
      terminals: await ptyManagerMock.getAllTerminalsAsync(),
      degraded,
      shardsFailed: degraded ? 1 : 0,
      shardsTotal: 2,
    };
  }),
  gracefulKillByProject: vi.fn(
    async () => [] as Array<{ id: string; agentSessionId: string | null }>
  ),
  on: vi.fn(),
  off: vi.fn(),
}));

const workspaceClientMock = vi.hoisted(() => ({ evictProject: vi.fn() }));
vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ptyManagerMock,
  getWorkspaceClientRef: () => workspaceClientMock,
}));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn());
type SleepOutcome =
  | {
      status: "slept";
      terminalsKilled: number;
      rendererViewsEvicted: number;
      workspaceEvicted: boolean;
      pluginWorkStopped?: { tasks: unknown[]; processes: number; calls: number };
    }
  | { status: "already-closed" };
const sleepProjectMock = vi.hoisted(() =>
  vi.fn<(projectId: string, options: unknown, deps: unknown) => Promise<SleepOutcome>>()
);

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    IDLE_TERMINAL_NOTIFY: "idle-terminal:notify",
  },
}));

vi.mock("../pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: writeHibernatedMarkerMock,
}));

vi.mock("../projectSleep.js", () => ({ sleepProject: sleepProjectMock }));

/**
 * Machine-sleep time to subtract from every awake reading, whether it is asleep
 * now, and whether the reading fails outright.
 */
const sleptMs = vi.hoisted(() => ({ value: 0, sleeping: false, throws: false }));
const suspendListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => ({
    onSuspend: vi.fn((callback: () => void) => {
      suspendListeners.add(callback);
      return () => suspendListeners.delete(callback);
    }),
    onWake: vi.fn(() => vi.fn()),
    isSleeping: () => sleptMs.sleeping,
    getAwakeTimeSince: (timestamp: number) => {
      if (sleptMs.throws) throw new Error("sleep tracking unavailable");
      return Math.max(0, Date.now() - timestamp - sleptMs.value);
    },
  }),
}));

/** Hold the next terminal read open until the test releases it with what it read. */
function holdNextRead(): (terminals: unknown[]) => void {
  let release!: (terminals: unknown[]) => void;
  ptyManagerMock.getAllTerminalsWithCompletenessAsync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = (terminals) =>
          resolve({ terminals, degraded: false, shardsFailed: 0, shardsTotal: 1 });
      })
  );
  return (terminals) => release(terminals);
}

const pluginWorkReader = vi.hoisted(() => vi.fn<(projectId: string) => unknown[]>(() => []));
vi.mock("../plugin/projectPluginWork.js", () => ({
  loadProjectPluginWorkReader: async () => pluginWorkReader,
}));

function slept(terminalsKilled: number): SleepOutcome {
  return { status: "slept", terminalsKilled, rendererViewsEvicted: 1, workspaceEvicted: true };
}

import { IdleTerminalNotificationService } from "../IdleTerminalNotificationService.js";
import type { PtyClient } from "../PtyClient.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

/** Construct a service with the PtyClient-shaped mock injected (#10054). */
function makeService(): IdleTerminalNotificationService {
  const service = new IdleTerminalNotificationService();
  service.setPtyClient(ptyManagerMock as unknown as PtyClient);
  return service;
}

const SIXTY_MIN_MS = 60 * 60 * 1000;

function makeProject(id: string, name = id) {
  return { id, name, path: `/projects/${id}`, lastOpened: Date.now() };
}

function makeTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    projectId: "proj-1",
    agentState: "idle",
    lastInputTime: Date.now() - 2 * SIXTY_MIN_MS,
    lastOutputTime: Date.now() - 2 * SIXTY_MIN_MS,
    lastTypedInputAt: Date.now() - 2 * SIXTY_MIN_MS,
    lastOutputChangeAt: Date.now() - 2 * SIXTY_MIN_MS,
    hasPty: true,
    ...overrides,
  };
}

async function runCheck(service: IdleTerminalNotificationService): Promise<void> {
  await (service as unknown as { checkAndNotify(): Promise<void> }).checkAndNotify();
}

describe("IdleTerminalNotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sleepProjectMock.mockReset().mockResolvedValue(slept(0));
    for (const k of Object.keys(storeBacking)) delete storeBacking[k];
    sleptMs.value = 0;
    sleptMs.sleeping = false;
    sleptMs.throws = false;
    suspendListeners.clear();
    // Back to the fixture-reading default, so a held read a failed test never
    // consumed can't answer the next test's read instead.
    ptyManagerMock.getAllTerminalsWithCompletenessAsync.mockReset();
    snapshotHealth.degraded = false;
    assistantBackends.clear();
    liveTerminalIds.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeConfig", () => {
    it("returns defaults for malformed persisted config", () => {
      storeBacking.idleTerminalNotify = { enabled: "yes", thresholdMinutes: Number.NaN };
      const service = makeService();
      // Default enabled is true (issue: idle notifications should be on by default)
      expect(service.getConfig()).toEqual({ enabled: true, thresholdMinutes: 60 });
    });

    it("clamps threshold to [15, 1440]", () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 5 };
      let service = makeService();
      expect(service.getConfig().thresholdMinutes).toBe(15);

      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 9999 };
      service = makeService();
      expect(service.getConfig().thresholdMinutes).toBe(1440);
    });
  });

  describe("updateConfig", () => {
    it("ignores invalid values and persists normalized config", () => {
      const service = makeService();
      service.updateConfig({
        enabled: "true" as unknown as boolean,
        thresholdMinutes: Number.NaN,
      });
      expect(storeMock.set).toHaveBeenCalledWith("idleTerminalNotify", {
        enabled: true, // default
        thresholdMinutes: 60,
      });
    });

    it("starts the service when toggled on", () => {
      const service = makeService();
      service.updateConfig({ enabled: true });
      expect((service as unknown as { checkInterval: unknown }).checkInterval).not.toBeNull();
      service.stop();
    });

    it("stops the service when toggled off", () => {
      const service = makeService();
      service.updateConfig({ enabled: true });
      service.updateConfig({ enabled: false });
      expect((service as unknown as { checkInterval: unknown }).checkInterval).toBeNull();
    });

    it("re-acquires PtyClient after a toggle off→on (#10054)", async () => {
      // stop() clears the injected PtyClient; start() must re-acquire it via
      // getPtyClient() or checkAndNotify() stays guarded-out forever.
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);

      const service = makeService();
      service.start();
      service.updateConfig({ enabled: false }); // → stop(), clears ptyClient
      service.updateConfig({ enabled: true }); // → start(), must re-acquire

      // Bypass the startup/wake quiet windows so the check body runs.
      (service as unknown as { quietUntil: number | null }).quietUntil = null;
      (service as unknown as { wakeQuietUntil: number | null }).wakeQuietUntil = null;

      ptyManagerMock.getAllTerminalsWithCompletenessAsync.mockClear();
      await runCheck(service);

      expect(ptyManagerMock.getAllTerminalsWithCompletenessAsync).toHaveBeenCalled();
      service.stop();
    });
  });

  describe("checkAndNotify", () => {
    function setup() {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1", "Old")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal()]);
    }

    it("does nothing when disabled", async () => {
      storeBacking.idleTerminalNotify = { enabled: false, thresholdMinutes: 60 };
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("emits a single aggregate broadcast for one idle background project", async () => {
      setup();
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [channel, payload] = broadcastToRendererMock.mock.calls[0];
      expect(channel).toBe("idle-terminal:notify");
      expect(payload.projects).toHaveLength(1);
      expect(payload.projects[0]).toMatchObject({
        projectId: "proj-1",
        projectName: "Old",
        terminalCount: 1,
      });
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(60);
    });

    it("aggregates multiple idle projects into one payload", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        makeProject("proj-1"),
        makeProject("proj-2"),
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1", projectId: "proj-1" }),
        makeTerminal({ id: "t2", projectId: "proj-2" }),
      ]);

      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects.map((p: { projectId: string }) => p.projectId)).toEqual([
        "proj-1",
        "proj-2",
      ]);
    });

    it("doesn't suggest sleeping a project that opted out of automatic sleep", async () => {
      setup();
      projectStoreMock.getAllProjects.mockReturnValue([
        { ...makeProject("proj-1", "Old"), neverAutoSleep: true },
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("skips the current active project", async () => {
      setup();
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("skips projects with active agent terminals", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ agentState: "working" }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("skips projects when any terminal is below the idle threshold", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1" }),
        makeTerminal({
          id: "t2",
          lastTypedInputAt: Date.now() - 5 * 60 * 1000, // recent
          lastOutputChangeAt: Date.now() - 5 * 60 * 1000,
        }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    // A spinner or a TUI repainting its status line moves the raw output clock
    // on every frame, and xterm's own focus reports move the raw input clock,
    // without anything changing on screen or in the composer (#13845).
    it("counts a terminal that only redraws an unchanged screen as idle", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ lastOutputTime: Date.now(), lastInputTime: Date.now() }),
      ]);
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(119);
    });

    it("treats a recent visible change as activity", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ lastOutputChangeAt: Date.now() - 5 * 60 * 1000 }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("treats recent typing as activity", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ lastTypedInputAt: Date.now() - 5 * 60 * 1000 }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    // Two hours on the wall clock, but the lid was shut for ninety minutes of it.
    it("doesn't count time the machine spent asleep toward the threshold", async () => {
      setup();
      sleptMs.value = 90 * 60 * 1000;
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("reports idle minutes the machine was awake for", async () => {
      setup();
      sleptMs.value = 45 * 60 * 1000;
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(74);
      expect(payload.projects[0].idleMinutes).toBeLessThanOrEqual(75);
    });

    // A shard that timed out may hold this project's busy agent; an empty
    // answer from it says nothing about whether the project is idle.
    it("skips the whole check when a pty-host shard didn't answer", async () => {
      setup();
      snapshotHealth.degraded = true;
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).not.toHaveBeenCalled();
      expect(storeBacking.idleTerminalNotifiedAt).toBeUndefined();
    });

    // A project that read as empty only because its shard was silent hasn't
    // left the idle state, so its throttle must survive; expired entries still go.
    it("keeps unexpired throttle entries on a degraded read and drops expired ones", async () => {
      setup();
      const recent = Date.now() - 10 * 60 * 1000;
      storeBacking.idleTerminalNotifiedAt = {
        "proj-1": recent,
        "proj-gone": Date.now() - 3 * SIXTY_MIN_MS,
      };
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);
      snapshotHealth.degraded = true;
      const service = makeService();
      await runCheck(service);

      expect(storeBacking.idleTerminalNotifiedAt).toEqual({ "proj-1": recent });
    });

    // Off and on again in Settings re-acquires the very same client, so only
    // the stop itself can tell the old check apart.
    it("drops a read that stop() overtook, even once a restart re-acquires the same client", async () => {
      setup();
      const release = holdNextRead();
      const service = makeService();
      try {
        const check = runCheck(service);
        service.updateConfig({ enabled: false });
        service.updateConfig({ enabled: true });
        expect((service as unknown as { ptyClient: unknown }).ptyClient).toBe(ptyManagerMock);
        release([makeTerminal()]);
        await check;

        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      } finally {
        service.stop();
      }
    });

    it("drops a read that a new client overtook", async () => {
      setup();
      const release = holdNextRead();
      const service = makeService();
      const check = runCheck(service);
      service.setPtyClient({ ...ptyManagerMock } as unknown as PtyClient);
      release([makeTerminal()]);
      await check;

      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    // A check that began before the lid closed would otherwise land inside the
    // post-wake quiet window.
    it("drops a read the machine suspended through", async () => {
      setup();
      const service = makeService();
      service.start();
      (service as unknown as { quietUntil: number | null }).quietUntil = null;
      try {
        const release = holdNextRead();
        const check = runCheck(service);
        for (const listener of suspendListeners) listener();
        release([makeTerminal()]);
        await check;

        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      } finally {
        service.stop();
      }
    });

    it("leaves trashed terminals out of the count, the activity check and the idle time", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1" }),
        makeTerminal({
          id: "t-trashed",
          isTrashed: true,
          agentState: "working",
          lastTypedInputAt: Date.now() - 5 * 60 * 1000,
          lastOutputChangeAt: Date.now() - 5 * 60 * 1000,
        }),
      ]);
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].terminalCount).toBe(1);
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(119);
    });

    it("doesn't nudge while the machine reads as asleep", async () => {
      setup();
      sleptMs.sleeping = true;
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("doesn't nudge when the awake clock can't be read", async () => {
      setup();
      sleptMs.throws = true;
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    // Typed into after the check began, then a read that stalled past the
    // threshold: by the time it lands the stamp is old enough on the awake
    // clock, but it is still newer than the check.
    it("treats activity stamped after the check began as recent, however long the read took", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        setup();
        const release = holdNextRead();
        const service = makeService();
        const check = runCheck(service);
        vi.setSystemTime(Date.now() + 1000);
        const typedAt = Date.now();
        vi.setSystemTime(Date.now() + 2 * SIXTY_MIN_MS);
        release([makeTerminal({ lastTypedInputAt: typedAt, lastOutputChangeAt: typedAt })]);
        await check;

        expect(broadcastToRendererMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves an Assistant row out of a project whose Assistant has no live binding", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1" }),
        makeTerminal({
          id: "t-help",
          isAssistantTerminal: true,
          agentState: "working",
          lastTypedInputAt: Date.now() - 5 * 60 * 1000,
          lastOutputChangeAt: Date.now() - 5 * 60 * 1000,
        }),
      ]);
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].terminalCount).toBe(1);
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(119);
    });

    // A live Assistant holds the project back without ending its shells' idle
    // period, so once it exits they aren't reminded about again in the cooldown.
    it("keeps the project's throttle while a live Assistant holds it back", async () => {
      setup();
      const notifiedAt = Date.now() - 10 * 60 * 1000;
      storeBacking.idleTerminalNotifiedAt = { "proj-1": notifiedAt };
      assistantBackends.set("proj-1", "t-help");
      liveTerminalIds.add("t-help");
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).not.toHaveBeenCalled();
      expect(storeBacking.idleTerminalNotifiedAt).toEqual({ "proj-1": notifiedAt });
    });

    // The reminder's Sleep would end the Assistant, and one with a wakeup or
    // sub-agent pending reads idle, so a live one holds the project back.
    it("doesn't nudge a project with a live Assistant beside its idle shells", async () => {
      setup();
      assistantBackends.set("proj-1", "t-help");
      liveTerminalIds.add("t-help");
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1" }),
        makeTerminal({ id: "t-help", isAssistantTerminal: true }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("holds the project on the Assistant's binding even when the snapshot omits its PTY", async () => {
      setup();
      assistantBackends.set("proj-1", "t-help");
      liveTerminalIds.add("t-help");
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("isn't held by an Assistant binding whose PTY already exited", async () => {
      setup();
      assistantBackends.set("proj-1", "t-help");
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    });

    it("lets a live Assistant hold only its own project", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        makeProject("proj-1"),
        makeProject("proj-2"),
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1", projectId: "proj-1" }),
        makeTerminal({ id: "t2", projectId: "proj-2" }),
      ]);
      assistantBackends.set("proj-1", "t-help");
      liveTerminalIds.add("t-help");
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["proj-2"]);
    });

    it("doesn't nudge a project whose only terminal is in the trash", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal({ isTrashed: true })]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("doesn't nudge a project whose only terminal is its Assistant", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ isAssistantTerminal: true }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    // A shell whose prompt landed inside its first resize window never gets a
    // change stamp, and an untouched prompt never changes again.
    it("counts a terminal with no real activity as idle since it spawned", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({
          lastTypedInputAt: undefined,
          lastOutputChangeAt: undefined,
          lastOutputTime: Date.now(),
          spawnedAt: Date.now() - 2 * SIXTY_MIN_MS,
        }),
      ]);
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].idleMinutes).toBeGreaterThanOrEqual(119);
    });

    it("doesn't count a freshly spawned terminal with no activity yet as idle", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({
          lastTypedInputAt: undefined,
          lastOutputChangeAt: undefined,
          spawnedAt: Date.now() - 5 * 60 * 1000,
        }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("never calls a terminal idle when nothing about its activity is known", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ lastTypedInputAt: undefined, lastOutputChangeAt: undefined }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("ignores hasPty:false (orphaned) terminals when evaluating idleness", async () => {
      setup();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1" }), // idle, has pty
        makeTerminal({
          id: "t2",
          hasPty: false,
          lastTypedInputAt: Date.now(),
          lastOutputChangeAt: Date.now(),
        }),
      ]);
      const service = makeService();
      await runCheck(service);
      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects[0].terminalCount).toBe(1);
    });

    it("respects the dismissal cooldown", async () => {
      setup();
      const service = makeService();
      service.dismissProject("proj-1");
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("uses at-least-60min cooldown even for shorter thresholds", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 15 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal()]);

      const service = makeService();
      // Dismissal 30min ago — would be expired under threshold (15) but not under 60min floor.
      storeBacking.idleTerminalDismissals = { "proj-1": Date.now() - 30 * 60 * 1000 };
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("clears stale dismissal entries", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalDismissals = {
        "expired-proj": Date.now() - 24 * SIXTY_MIN_MS,
      };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalDismissals as Record<string, number>;
      expect(persisted["expired-proj"]).toBeUndefined();
    });

    it("does not fire during the startup quiet period", async () => {
      setup();
      const service = makeService();
      // Simulate the service having just started: set quietUntil 30s in the future
      (service as unknown as { quietUntil: number | null }).quietUntil = Date.now() + 30_000;
      await runCheck(service);
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });
  });

  describe("notified throttle", () => {
    function setup() {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1", "Old")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ projectId: "proj-1" }),
      ]);
    }

    it("does not re-broadcast for an ignored project within the cooldown", async () => {
      setup();
      const service = makeService();
      await runCheck(service);
      await runCheck(service);

      // Second cycle is suppressed by the notified throttle even though nothing
      // was dismissed — this is the stacking-toast regression fix.
      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    });

    it("re-broadcasts after the cooldown lapses", async () => {
      setup();
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 2 * SIXTY_MIN_MS };
      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    });

    it("suppresses an already-notified project but still broadcasts a fresh one", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      // proj-1 was notified recently; proj-2 is newly idle.
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 5 * 60 * 1000 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        makeProject("proj-1"),
        makeProject("proj-2"),
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1", projectId: "proj-1" }),
        makeTerminal({ id: "t2", projectId: "proj-2" }),
      ]);

      const service = makeService();
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
      const [, payload] = broadcastToRendererMock.mock.calls[0];
      expect(payload.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["proj-2"]);
    });

    it("keeps the throttle while a project is merely the active project", async () => {
      // Viewing a project (without terminal activity) must not reset the
      // throttle — otherwise a switch-to-then-away round trip re-notifies the
      // same still-idle terminals inside the cooldown.
      const notifiedAt = Date.now() - 5 * 60 * 1000;
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalNotifiedAt = { "proj-1": notifiedAt };
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ projectId: "proj-1" }),
      ]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["proj-1"]).toBe(notifiedAt);
    });

    it("does not re-notify after switching to a still-idle project and back", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ projectId: "proj-1" }),
      ]);
      const service = makeService();

      // Cycle 1: proj-1 idle in the background → notify.
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      await runCheck(service);
      // Cycle 2: user switches to proj-1 (now current) → skipped, throttle kept.
      projectStoreMock.getCurrentProjectId.mockReturnValue("proj-1");
      await runCheck(service);
      // Cycle 3: user switches away; proj-1 still idle, no activity → suppressed.
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      await runCheck(service);

      expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    });

    it("clears the throttle when a project has no terminals", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 5 * 60 * 1000 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["proj-1"]).toBeUndefined();
    });

    it("clears the throttle when an agent becomes active", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 5 * 60 * 1000 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ projectId: "proj-1", agentState: "working" }),
      ]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["proj-1"]).toBeUndefined();
    });

    it("clears the throttle when terminal activity resumes", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 5 * 60 * 1000 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      // Recent activity — the project is no longer fully idle.
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({
          projectId: "proj-1",
          lastTypedInputAt: Date.now() - 60 * 1000,
          lastOutputChangeAt: Date.now() - 60 * 1000,
        }),
      ]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["proj-1"]).toBeUndefined();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("does not clear an explicit dismissal when clearing the notified throttle", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      const dismissedAt = Date.now() - 5 * 60 * 1000;
      storeBacking.idleTerminalDismissals = { "proj-1": dismissedAt };
      storeBacking.idleTerminalNotifiedAt = { "proj-1": Date.now() - 5 * 60 * 1000 };
      // Activity resumes → proj-1 leaves the idle state → throttle cleared, but
      // the explicit dismissal (a separate user mute) is preserved.
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({
          projectId: "proj-1",
          lastTypedInputAt: Date.now() - 60 * 1000,
          lastOutputChangeAt: Date.now() - 60 * 1000,
        }),
      ]);

      const service = makeService();
      await runCheck(service);

      const notified = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      const dismissals = storeBacking.idleTerminalDismissals as Record<string, number>;
      expect(notified["proj-1"]).toBeUndefined();
      expect(dismissals["proj-1"]).toBe(dismissedAt);
    });

    it("clears stale notified entries", async () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      storeBacking.idleTerminalNotifiedAt = {
        "expired-proj": Date.now() - 24 * SIXTY_MIN_MS,
      };
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([]);

      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["expired-proj"]).toBeUndefined();
    });
  });

  describe("closeProject", () => {
    it("puts the project to sleep as the user, the same Sleep the switcher runs", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1", "Old")]);
      sleepProjectMock.mockResolvedValueOnce(slept(2));

      const service = makeService();
      const provider = () => [] as ProjectViewManager[];
      service.setProjectViewManagersProvider(provider);
      const result = await service.closeProject("proj-1");

      expect(result).toEqual({ terminalsKilled: 2, pluginWorkStopped: null });
      // The reminder that offered it was automatic; pressing it is not (#13845).
      expect(sleepProjectMock).toHaveBeenCalledWith(
        "proj-1",
        { initiator: "user" },
        {
          ptyClient: ptyManagerMock,
          workspaceClient: workspaceClientMock,
          projectViewManagers: provider,
          pluginWork: pluginWorkReader,
        }
      );
      const dismissals = storeBacking.idleTerminalDismissals as Record<string, number>;
      expect(dismissals["proj-1"]).toBeGreaterThan(0);
    });

    it("passes on the plugin work the sleep stopped (#14093)", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      const pluginWorkStopped = { tasks: [], processes: 1, calls: 0 };
      sleepProjectMock.mockResolvedValueOnce({
        status: "slept",
        terminalsKilled: 0,
        rendererViewsEvicted: 1,
        workspaceEvicted: true,
        pluginWorkStopped,
      });

      const service = makeService();
      expect(await service.closeProject("proj-1")).toEqual({
        terminalsKilled: 0,
        pluginWorkStopped,
      });
    });

    it("does NOT set a dismissal cooldown when 0 terminals were killed", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      sleepProjectMock.mockResolvedValueOnce(slept(0));

      const service = makeService();
      await service.closeProject("proj-1");

      expect(storeBacking.idleTerminalDismissals).toBeUndefined();
    });

    it("reports nothing killed for a project that was already asleep", async () => {
      sleepProjectMock.mockResolvedValueOnce({ status: "already-closed" });

      const service = makeService();
      expect(await service.closeProject("proj-1")).toEqual({
        terminalsKilled: 0,
        pluginWorkStopped: null,
      });
      expect(storeBacking.idleTerminalDismissals).toBeUndefined();
    });

    it("re-throws a failed sleep", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      sleepProjectMock.mockRejectedValueOnce(new Error("boom"));

      const service = makeService();
      await expect(service.closeProject("proj-1")).rejects.toThrow("boom");
    });

    it("rejects empty projectId without delegating", async () => {
      const service = makeService();
      const result = await service.closeProject("");
      expect(result).toEqual({ terminalsKilled: 0, pluginWorkStopped: null });
      expect(sleepProjectMock).not.toHaveBeenCalled();
    });
  });

  describe("startup quiet period", () => {
    it("is seeded on the first start() and not re-bumped by a subsequent start()", () => {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      const service = makeService();
      service.start();
      const initialQuietUntil = (service as unknown as { quietUntil: number | null }).quietUntil;
      expect(initialQuietUntil).not.toBeNull();

      service.stop();
      // Simulate time passing
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      service.start();
      const secondQuietUntil = (service as unknown as { quietUntil: number | null }).quietUntil;
      expect(secondQuietUntil).toBe(initialQuietUntil);
      service.stop();
      vi.useRealTimers();
    });
  });

  describe("dismissProject", () => {
    it("ignores empty projectId", () => {
      const service = makeService();
      service.dismissProject("");
      expect(storeBacking.idleTerminalDismissals).toBeUndefined();
    });
  });

  describe("multi-window visibility guard (#11102)", () => {
    type PvmMock = {
      getActiveProjectId: Mock<() => string | null>;
      getOutgoingBridgeProjectId: Mock<() => string | null>;
    };

    function makePvm(
      activeProjectId: string | null = null,
      outgoingBridgeProjectId: string | null = null
    ): PvmMock {
      return {
        getActiveProjectId: vi.fn(() => activeProjectId),
        getOutgoingBridgeProjectId: vi.fn(() => outgoingBridgeProjectId),
      };
    }

    function serviceWith(managers: PvmMock[]): IdleTerminalNotificationService {
      const service = makeService();
      service.setProjectViewManagersProvider(() => managers as unknown as ProjectViewManager[]);
      return service;
    }

    /**
     * Two projects whose terminals are equally idle. Only the visibility guard
     * can distinguish them, so whichever survives into the payload did so on
     * visibility grounds alone.
     */
    function seedTwoIdleProjects(): void {
      storeBacking.idleTerminalNotify = { enabled: true, thresholdMinutes: 60 };
      projectStoreMock.getCurrentProjectId.mockReturnValue("focused-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        makeProject("second-window-proj", "Second Window"),
        makeProject("background-proj", "Background"),
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ id: "t1", projectId: "second-window-proj" }),
        makeTerminal({ id: "t2", projectId: "background-proj" }),
      ]);
    }

    function notifiedProjectIds(): string[] {
      const call = broadcastToRendererMock.mock.calls[0];
      if (!call) return [];
      return (call[1] as { projects: Array<{ projectId: string }> }).projects.map(
        (p) => p.projectId
      );
    }

    it("does not nudge about a project visible in a second, unfocused window", async () => {
      seedTwoIdleProjects();
      const service = serviceWith([makePvm("focused-proj"), makePvm("second-window-proj")]);

      await runCheck(service);

      expect(notifiedProjectIds()).toEqual(["background-proj"]);
    });

    it("does not nudge about the outgoing paint-gate bridge project", async () => {
      seedTwoIdleProjects();
      const service = serviceWith([makePvm("background-proj", "second-window-proj")]);

      await runCheck(service);

      // Both projects are on-screen in that window (one active, one still
      // painted behind the bridge) — nothing left to notify about.
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
    });

    it("preserves the notified throttle of a project visible in another window", async () => {
      seedTwoIdleProjects();
      const notifiedAt = Date.now() - 1000;
      storeBacking.idleTerminalNotifiedAt = { "second-window-proj": notifiedAt };

      const service = serviceWith([makePvm("second-window-proj")]);
      await runCheck(service);

      // Merely being on-screen isn't engaging with the terminals, so the
      // throttle must survive — otherwise a switch-away would re-nudge instantly.
      const stored = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(stored["second-window-proj"]).toBe(notifiedAt);
    });

    it("retains the provider across a stop() so a Settings off→on keeps multi-window awareness", async () => {
      seedTwoIdleProjects();
      const service = serviceWith([makePvm("second-window-proj")]);

      service.stop();
      // stop() clears the PtyClient; start() re-acquires it (#10054). Re-inject
      // so this test isolates provider retention rather than tripping that guard.
      service.setPtyClient(ptyManagerMock as unknown as PtyClient);
      await runCheck(service);

      // The provider is a stateless closure over the window registry, so the
      // second window's project is still protected after the toggle (#8637).
      expect(notifiedProjectIds()).toEqual(["background-proj"]);
    });

    it("does not nudge about a project brought on-screen during the pty-host await", async () => {
      seedTwoIdleProjects();

      // Nothing on-screen when the check starts...
      const pvm = makePvm(null);
      const service = serviceWith([pvm]);

      // ...but the user switches to it while the terminal snapshot is in flight.
      ptyManagerMock.getAllTerminalsAsync.mockImplementation(async () => {
        pvm.getActiveProjectId.mockReturnValue("second-window-proj");
        return [
          makeTerminal({ id: "t1", projectId: "second-window-proj" }),
          makeTerminal({ id: "t2", projectId: "background-proj" }),
        ];
      });

      await runCheck(service);

      // Only a post-await collection can see the switch.
      expect(notifiedProjectIds()).toEqual(["background-proj"]);
    });

    it("still nudges when no provider is wired, using the DB pointer alone", async () => {
      seedTwoIdleProjects();
      const service = makeService(); // provider never injected

      await runCheck(service);

      // Neither project is the DB pointer's, so both are fair game.
      expect(notifiedProjectIds().sort()).toEqual(["background-proj", "second-window-proj"]);
    });
  });
});
