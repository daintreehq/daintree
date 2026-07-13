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
  getAllProjects: vi.fn<() => Array<{ id: string; name: string; path: string }>>(() => []),
}));

const ptyManagerMock = vi.hoisted(() => ({
  getAllTerminalsAsync: vi.fn<() => Promise<unknown[]>>(async () => []),
  gracefulKillByProject: vi.fn(
    async () => [] as Array<{ id: string; agentSessionId: string | null }>
  ),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock("../../window/serviceRefs.js", () => ({ getPtyClient: () => ptyManagerMock }));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn());
const hibernateProjectOnDemandMock = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _projectName: string) => 0)
);

vi.mock("../../utils/logger.js", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

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

vi.mock("../HibernationService.js", () => ({
  getHibernationService: () => ({
    hibernateProjectOnDemand: hibernateProjectOnDemandMock,
  }),
}));

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
    hibernateProjectOnDemandMock.mockImplementation(async () => 0);
    for (const k of Object.keys(storeBacking)) delete storeBacking[k];
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

      ptyManagerMock.getAllTerminalsAsync.mockClear();
      await runCheck(service);

      expect(ptyManagerMock.getAllTerminalsAsync).toHaveBeenCalled();
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
          lastInputTime: Date.now() - 5 * 60 * 1000, // recent
          lastOutputTime: Date.now() - 5 * 60 * 1000,
        }),
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
          lastInputTime: Date.now(),
          lastOutputTime: Date.now(),
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

    it("records a notified timestamp when it broadcasts", async () => {
      setup();
      const service = makeService();
      await runCheck(service);

      const persisted = storeBacking.idleTerminalNotifiedAt as Record<string, number>;
      expect(persisted["proj-1"]).toBeGreaterThan(0);
    });

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
          lastInputTime: Date.now() - 60 * 1000,
          lastOutputTime: Date.now() - 60 * 1000,
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
          lastInputTime: Date.now() - 60 * 1000,
          lastOutputTime: Date.now() - 60 * 1000,
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
    it("delegates to HibernationService so DevPreview callbacks run", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1", "Old")]);
      hibernateProjectOnDemandMock.mockResolvedValueOnce(2);

      const service = makeService();
      const killed = await service.closeProject("proj-1");

      expect(killed).toBe(2);
      expect(hibernateProjectOnDemandMock).toHaveBeenCalledWith("proj-1", "Old", "user-initiated");
      const dismissals = storeBacking.idleTerminalDismissals as Record<string, number>;
      expect(dismissals["proj-1"]).toBeGreaterThan(0);
    });

    it("falls back to projectId when the project is not in the store", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([]);
      hibernateProjectOnDemandMock.mockResolvedValueOnce(1);

      const service = makeService();
      await service.closeProject("ghost-proj");

      expect(hibernateProjectOnDemandMock).toHaveBeenCalledWith(
        "ghost-proj",
        "ghost-proj",
        "user-initiated"
      );
    });

    it("does NOT set a dismissal cooldown when 0 terminals were killed", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      hibernateProjectOnDemandMock.mockResolvedValueOnce(0);

      const service = makeService();
      await service.closeProject("proj-1");

      expect(storeBacking.idleTerminalDismissals).toBeUndefined();
    });

    it("re-throws errors from hibernateProjectOnDemand", async () => {
      projectStoreMock.getAllProjects.mockReturnValue([makeProject("proj-1")]);
      hibernateProjectOnDemandMock.mockRejectedValueOnce(new Error("boom"));

      const service = makeService();
      await expect(service.closeProject("proj-1")).rejects.toThrow("boom");
    });

    it("rejects empty projectId without delegating", async () => {
      const service = makeService();
      const killed = await service.closeProject("");
      expect(killed).toBe(0);
      expect(hibernateProjectOnDemandMock).not.toHaveBeenCalled();
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
    it("persists a dismissal timestamp", () => {
      const service = makeService();
      service.dismissProject("proj-1");
      const persisted = storeBacking.idleTerminalDismissals as Record<string, number>;
      expect(persisted["proj-1"]).toBeGreaterThan(0);
    });

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

    it("still nudges when no provider is wired, using the DB pointer alone", async () => {
      seedTwoIdleProjects();
      const service = makeService(); // provider never injected

      await runCheck(service);

      // Neither project is the DB pointer's, so both are fair game.
      expect(notifiedProjectIds().sort()).toEqual(["background-proj", "second-window-proj"]);
    });
  });
});
