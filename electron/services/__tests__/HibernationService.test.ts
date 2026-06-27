import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getAllProjects: vi.fn<
    () => Array<{ id: string; name: string; path: string; lastOpened: number }>
  >(() => []),
  clearProjectState: vi.fn(async () => {}),
}));

const fsMock = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const ptyManagerMock = vi.hoisted(() => ({
  getAllTerminalsAsync: vi.fn<() => Promise<unknown[]>>(async () => []),
  getProjectStats: vi.fn(() => ({ terminalCount: 0 })),
  gracefulKillByProject: vi.fn(
    async () => [] as Array<{ id: string; agentSessionId: string | null }>
  ),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ptyManagerMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());

const writeHibernatedMarkerMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readdir: fsMock.readdir,
  stat: fsMock.stat,
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: {
    HIBERNATION_PROJECT_HIBERNATED: "hibernation:project-hibernated",
  },
}));

vi.mock("../pty/terminalSessionPersistence.js", () => ({
  writeHibernatedMarker: writeHibernatedMarkerMock,
}));

import { logInfo, logError } from "../../utils/logger.js";
import { HibernationService } from "../HibernationService.js";
import type { PtyClient } from "../PtyClient.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

/** Construct a service with the PtyClient-shaped mock injected (#10054). */
function makeService(): HibernationService {
  const service = new HibernationService();
  service.setPtyClient(ptyManagerMock as unknown as PtyClient);
  return service;
}

const HIBERNATED_CHANNEL = "hibernation:project-hibernated";

/**
 * Project IDs for which the `hibernation:project-hibernated` event was
 * broadcast, in call order. EXPERIMENT (hibernation removal, step 4): the PTY-
 * kill is guarded off, so `gracefulKillByProject` is never called — the
 * broadcast event is the observable for which projects the sweep actually
 * selected (each selected project still emits one event, now reporting zero
 * kills).
 */
function hibernatedProjectIds(): string[] {
  return broadcastToRendererMock.mock.calls
    .filter((call) => call[0] === HIBERNATED_CHANNEL)
    .map((call) => (call[1] as { projectId: string }).projectId);
}

describe("HibernationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: no git sentinel files found (readdir rejects with ENOENT)
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    fsMock.readdir.mockRejectedValue(enoent);
    fsMock.stat.mockRejectedValue(enoent);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes malformed persisted config in getConfig", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: "yes",
      inactiveThresholdHours: Number.NaN,
    });

    const service = makeService();

    expect(service.getConfig()).toEqual({
      enabled: false,
      inactiveThresholdHours: 24,
    });
  });

  it("clamps persisted threshold into valid range", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 500,
    });

    const service = makeService();

    expect(service.getConfig()).toEqual({
      enabled: true,
      inactiveThresholdHours: 168,
    });
  });

  describe("getSnapshot (#10500)", () => {
    it("reports isRunning false and surfaces config before start", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 12 });
      const service = makeService();

      const snapshot = service.getSnapshot();

      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.config).toEqual({ enabled: true, inactiveThresholdHours: 12 });
    });

    it("reports isRunning true once the scheduler is armed", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = makeService();

      expect(service.getSnapshot().isRunning).toBe(false);
      service.start();
      expect(service.getSnapshot().isRunning).toBe(true);
      service.stop();
      expect(service.getSnapshot().isRunning).toBe(false);
    });

    it("does not arm the scheduler when hibernation is disabled", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      const service = makeService();

      service.start();

      expect(service.getSnapshot().isRunning).toBe(false);
    });

    it("reflects the memory-pressure threshold override", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      const service = makeService();

      const defaultMs = service.getSnapshot().memoryPressureThresholdMs;
      service.setMemoryPressureThresholdMs(defaultMs + 90_000);

      expect(service.getSnapshot().memoryPressureThresholdMs).toBe(defaultMs + 90_000);
    });

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
      "rejects non-finite/negative threshold (%s), keeping the last valid value",
      (bad) => {
        (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
        const service = makeService();

        const valid = service.getSnapshot().memoryPressureThresholdMs;
        service.setMemoryPressureThresholdMs(bad);

        const after = service.getSnapshot().memoryPressureThresholdMs;
        expect(after).toBe(valid);
        expect(Number.isFinite(after)).toBe(true);
        expect(after).toBeGreaterThanOrEqual(0);
      }
    );
  });

  it("ignores invalid update payload values", () => {
    (storeMock.get as Mock).mockReturnValue(undefined);
    const service = makeService();

    service.updateConfig({
      enabled: "true" as unknown as boolean,
      inactiveThresholdHours: Number.NaN,
    });

    expect(storeMock.set).toHaveBeenCalledWith("hibernation", {
      enabled: false,
      inactiveThresholdHours: 24,
    });
  });

  it("preserves current threshold when invalid threshold update is provided", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 72,
    });
    const service = makeService();

    service.updateConfig({
      inactiveThresholdHours: Number.NaN,
    });

    expect(storeMock.set).toHaveBeenCalledWith("hibernation", {
      enabled: true,
      inactiveThresholdHours: 72,
    });
  });

  it("re-acquires PtyClient after a Settings toggle off→on (#10054)", async () => {
    // stop() clears the injected PtyClient; start() must re-acquire it via
    // getPtyClient() or checkAndHibernate() stays guarded-out forever.
    (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
    ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);
    projectStoreMock.getAllProjects.mockReturnValue([]);

    const service = makeService();
    service.start();
    service.updateConfig({ enabled: false }); // → stop(), clears ptyClient
    service.updateConfig({ enabled: true }); // → start(), must re-acquire

    ptyManagerMock.getAllTerminalsAsync.mockClear();
    await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

    expect(ptyManagerMock.getAllTerminalsAsync).toHaveBeenCalled();
    service.stop();
  });

  it("does not kill PTYs or call clearProjectState during hibernation", async () => {
    ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
      { id: "t1", projectId: "proj-1", agentState: "idle" },
      { id: "t2", projectId: "proj-1", agentState: "idle" },
    ]);

    const inactiveProject = {
      id: "proj-1",
      name: "Old Project",
      path: "/projects/proj-1",
      lastOpened: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    };

    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 24,
    });

    projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
    projectStoreMock.getAllProjects.mockReturnValue([inactiveProject]);

    const service = makeService();
    await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

    // EXPERIMENT: project hibernation no longer tears down the backgrounded
    // project's terminals — the PTY-kill is guarded off, so they stay fully alive.
    expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    expect(projectStoreMock.clearProjectState).not.toHaveBeenCalled();
    // The project-hibernated event still fires, reporting zero kills.
    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      HIBERNATED_CHANNEL,
      expect.objectContaining({ projectId: "proj-1", terminalsKilled: 0 })
    );
  });

  it.each([0, null, undefined, NaN])(
    "skips projects with falsy lastOpened (%s) in checkAndHibernate",
    async (falsyValue) => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-valid-1", agentState: "idle" },
        { id: "t2", projectId: "proj-falsy", agentState: "idle" },
        { id: "t3", projectId: "proj-valid-2", agentState: "idle" },
      ]);

      const validOldProject = {
        id: "proj-valid-1",
        name: "Valid Old 1",
        path: "/projects/proj-valid-1",
        lastOpened: Date.now() - 25 * 60 * 60 * 1000,
      };
      const falsyProject = {
        id: "proj-falsy",
        name: "Falsy Project",
        path: "/projects/proj-falsy",
        lastOpened: falsyValue as unknown as number,
      };
      const validOldProject2 = {
        id: "proj-valid-2",
        name: "Valid Old 2",
        path: "/projects/proj-valid-2",
        lastOpened: Date.now() - 26 * 60 * 60 * 1000,
      };

      (storeMock.get as Mock).mockReturnValue({
        enabled: true,
        inactiveThresholdHours: 24,
      });

      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        validOldProject,
        falsyProject,
        validOldProject2,
      ]);

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // No PTYs are killed under the experiment; the project-hibernated broadcast
      // is the observable for which projects the sweep selected. The falsy-
      // lastOpened project is filtered out; the two valid ones are selected.
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual(["proj-valid-1", "proj-valid-2"]);
    }
  );

  it("clears pending initial check when stopped before timeout", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 24,
    });
    const service = makeService();
    const checkSpy = vi.spyOn(service as never, "checkAndHibernate" as never);

    service.start();
    service.stop();

    vi.advanceTimersByTime(6000);

    expect(checkSpy).not.toHaveBeenCalled();
  });

  describe("hibernateUnderMemoryPressure", () => {
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
    const TWENTY_MINUTES = 20 * 60 * 1000;

    function makeTerminal(overrides: Record<string, unknown> = {}) {
      return {
        id: "t1",
        projectId: "proj-1",
        agentState: undefined,
        ...overrides,
      };
    }

    it("runs even when auto-hibernation is disabled", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal({ agentState: "idle" })]);

      (storeMock.get as Mock).mockReturnValue({
        enabled: false,
        inactiveThresholdHours: 24,
      });

      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      // The sweep still runs and selects the eligible project (the broadcast
      // fires), but never kills its PTYs under the experiment.
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        HIBERNATED_CHANNEL,
        expect.objectContaining({ projectId: "proj-1", reason: "memory-pressure" })
      );
    });

    it("skips the current active project", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        makeTerminal({ projectId: "active-proj" }),
      ]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "active-proj",
          name: "Active",
          path: "/projects/active-proj",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("skips projects inactive less than 30 minutes", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal()]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Recent",
          path: "/projects/proj-1",
          lastOpened: Date.now() - TWENTY_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it.each(["working", "waiting", "directing"] as const)(
      "skips projects with %s agent terminals",
      async (agentState) => {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal({ agentState })]);

        (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
        projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
        projectStoreMock.getAllProjects.mockReturnValue([
          {
            id: "proj-1",
            name: "Busy",
            path: "/projects/proj-1",
            lastOpened: Date.now() - THIRTY_ONE_MINUTES,
          },
        ]);

        const service = makeService();
        await service.hibernateUnderMemoryPressure();

        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      }
    );

    it("selects eligible idle projects without killing their PTYs", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal({ agentState: "idle" })]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it.each([0, null, undefined, NaN])(
      "skips projects with falsy lastOpened (%s)",
      async (falsyValue) => {
        const validTerminal = makeTerminal({
          id: "t1",
          projectId: "proj-valid-1",
          agentState: "idle",
        });
        const falsyTerminal = makeTerminal({
          id: "t2",
          projectId: "proj-falsy",
          agentState: "idle",
        });
        const validTerminal2 = makeTerminal({
          id: "t3",
          projectId: "proj-valid-2",
          agentState: "idle",
        });
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          validTerminal,
          falsyTerminal,
          validTerminal2,
        ]);

        (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
        projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
        projectStoreMock.getAllProjects.mockReturnValue([
          {
            id: "proj-valid-1",
            name: "Valid Old 1",
            path: "/projects/proj-valid-1",
            lastOpened: Date.now() - THIRTY_ONE_MINUTES,
          },
          {
            id: "proj-falsy",
            name: "Falsy Project",
            path: "/projects/proj-falsy",
            lastOpened: falsyValue as unknown as number,
          },
          {
            id: "proj-valid-2",
            name: "Valid Old 2",
            path: "/projects/proj-valid-2",
            lastOpened: Date.now() - THIRTY_ONE_MINUTES,
          },
        ]);

        const service = makeService();
        await service.hibernateUnderMemoryPressure();

        // No PTYs killed; the falsy-lastOpened project is filtered out and only
        // the two valid projects are selected (broadcast).
        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
        expect(hibernatedProjectIds()).toEqual(["proj-valid-1", "proj-valid-2"]);
      }
    );

    it("skips projects with no terminals", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Empty",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("skips projects with active git operations", async () => {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal({ agentState: "idle" })]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["MERGE_HEAD", "HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Merging",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });
  });

  describe("checkAndHibernate agent guard", () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60 * 1000;

    function setupScheduledTest() {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - TWENTY_FIVE_HOURS,
        },
      ]);
    }

    it.each(["working", "waiting", "directing"] as const)(
      "skips projects with %s agent in scheduled hibernation",
      async (agentState) => {
        setupScheduledTest();
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          { id: "t1", projectId: "proj-1", agentState },
        ]);

        const service = makeService();
        await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      }
    );

    it("proceeds with idle agents in scheduled hibernation", async () => {
      setupScheduledTest();
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // Idle agents don't block selection — the project is hibernated (broadcast),
      // though its PTYs are not killed under the experiment.
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });
  });

  describe("git sentinel guards", () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60 * 1000;
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

    function setupScheduledProject() {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - TWENTY_FIVE_HOURS,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);
    }

    function setupMemoryPressureProject() {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);
    }

    it.each([
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ])("scheduled hibernation skips project with %s sentinel", async (sentinel) => {
      setupScheduledProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return [sentinel, "HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("scheduled hibernation skips project with fresh index.lock", async () => {
      setupScheduledProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - 5000 }); // 5 seconds ago

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("scheduled hibernation proceeds when index.lock is stale", async () => {
      setupScheduledProject();
      const thresholdMs = 24 * 60 * 60 * 1000;
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // Lock is older than the 24h threshold
      fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - thresholdMs - 1000 });

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("memory pressure hibernation skips project with REBASE_HEAD", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["REBASE_HEAD", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("detects sentinel in linked worktree", async () => {
      setupScheduledProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        const dir = String(dirPath).replace(/\\/g, "/");
        if (dir.endsWith(".git/worktrees")) {
          return [{ name: "feature-branch", isDirectory: () => true }];
        }
        if (dir.endsWith(".git")) return ["HEAD", "config"];
        if (dir.includes("worktrees/feature-branch")) return ["MERGE_HEAD", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("proceeds when .git directory is missing", async () => {
      setupScheduledProject();
      // Default ENOENT for all readdir calls (set in beforeEach)

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("proceeds when gitdir is unreadable (EACCES)", async () => {
      setupScheduledProject();
      // The main .git readdir should work but with a sentinel
      // Actually, test fail-closed: readdir on .git/worktrees throws ENOENT (fine),
      // but then readdir on .git itself throws EACCES
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        const dir = String(dirPath).replace(/\\/g, "/");
        if (dir.endsWith(".git/worktrees")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        // .git readdir throws EACCES — we can't read it, but no sentinel found
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      });

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // fail-closed: readdir error on .git means we skip that gitdir and check next
      // Since all gitdirs failed without finding sentinels, we proceed with hibernation
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("continues to next project after skipping one with git operation", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Merging",
          path: "/projects/proj-1",
          lastOpened: Date.now() - TWENTY_FIVE_HOURS,
        },
        {
          id: "proj-2",
          name: "Idle",
          path: "/projects/proj-2",
          lastOpened: Date.now() - TWENTY_FIVE_HOURS,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
        { id: "t2", projectId: "proj-2", agentState: "idle" },
      ]);

      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        const dir = String(dirPath).replace(/\\/g, "/");
        if (dir === "/projects/proj-1/.git") return ["MERGE_HEAD", "HEAD"];
        if (dir === "/projects/proj-2/.git") return ["HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // proj-1 is skipped (active git op); the sweep continues to proj-2, which is
      // selected. Neither has its PTYs killed under the experiment.
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual(["proj-2"]);
    });

    it("memory pressure uses 30min threshold for stale index.lock", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // Lock is 31 minutes old — older than MEMORY_PRESSURE_INACTIVE_MS (30 min), so stale
      fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - THIRTY_ONE_MINUTES - 1000 });

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("handles index.lock disappearing between readdir and stat", async () => {
      setupScheduledProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // stat throws ENOENT — lock was deleted between readdir and stat
      fsMock.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // Lock disappeared, so no active git operation — proceed
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });
  });

  describe("structured logging", () => {
    it("logs auto-hibernation-disabled when config is off", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      const service = makeService();
      service.start();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-disabled");
    });

    it("logs auto-hibernation-started when config is on", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = makeService();
      service.start();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-started");
    });

    it("logs auto-hibernation-stopped on stop", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = makeService();
      service.start();
      service.stop();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-stopped");
    });

    it("logs auto-hibernation-check-failed when interval check throws", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = makeService();
      const testError = new Error("boom");
      (
        vi.spyOn(service as never, "checkAndHibernate" as never) as unknown as Mock
      ).mockRejectedValue(testError);

      service.start();
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(logError).toHaveBeenCalledWith("auto-hibernation-check-failed", testError);
    });

    it("logs auto-hibernation-initial-check-failed when initial check throws", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = makeService();
      const testError = new Error("init-boom");
      (
        vi.spyOn(service as never, "checkAndHibernate" as never) as unknown as Mock
      ).mockRejectedValue(testError);

      service.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(logError).toHaveBeenCalledWith("auto-hibernation-initial-check-failed", testError);
    });

    it("logs scheduled-hibernate-project and scheduled-hibernate-complete on successful hibernation", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - 25 * 60 * 60 * 1000,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // The pre-hibernation log still reports the live terminal count (these
      // terminals stay alive — they are not killed).
      expect(logInfo).toHaveBeenCalledWith("scheduled-hibernate-project", {
        project: "Old",
        projectId: "proj-1",
        hoursInactive: 25,
        terminalCount: 1,
      });
      // The completion log reports zero kills under the experiment.
      expect(logInfo).toHaveBeenCalledWith("scheduled-hibernate-complete", {
        project: "Old",
        projectId: "proj-1",
        terminalsKilled: 0,
      });
    });

    it("logs scheduled-hibernate-failed when hibernation throws", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - 25 * 60 * 60 * 1000,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      const service = makeService();
      // The PTY-kill is guarded off under the experiment, so it can no longer be
      // the throw source. Drive the error from hibernateProject itself to verify
      // checkAndHibernate's per-project try/catch still logs the structured error
      // with the project context (the catch is kept, intentional behavior).
      const testError = new Error("hibernate-boom");
      (
        vi.spyOn(service as never, "hibernateProject" as never) as unknown as Mock
      ).mockRejectedValue(testError);

      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(logError).toHaveBeenCalledWith("scheduled-hibernate-failed", testError, {
        project: "Old",
        projectId: "proj-1",
      });
    });

    it("logs hibernation-config-updated on updateConfig", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      // After store.set, getConfig re-reads from store — update the mock to reflect the new value
      storeMock.set.mockImplementation(() => {
        (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 48 });
      });
      const service = makeService();
      service.updateConfig({ inactiveThresholdHours: 48 });

      expect(logInfo).toHaveBeenCalledWith("hibernation-config-updated", {
        enabled: false,
        inactiveThresholdHours: 48,
      });
    });
  });

  describe("hibernation notifications and cleanup", () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60 * 1000;

    function setupHibernation() {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old Project",
          path: "/projects/proj-1",
          lastOpened: Date.now() - TWENTY_FIVE_HOURS,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
        { id: "t2", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([
        { id: "t1", agentSessionId: null },
        { id: "t2", agentSessionId: "session-123" },
      ]);
    }

    it("writes no hibernation markers because no terminals are killed", async () => {
      setupHibernation();

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // Markers are written only for killed terminals; under the experiment none
      // are killed, so no markers are written even though the project is selected.
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(writeHibernatedMarkerMock).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("emits event to renderer with correct payload", async () => {
      setupHibernation();

      const service = makeService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({
          projectId: "proj-1",
          projectName: "Old Project",
          reason: "scheduled",
          // No terminals are killed under the experiment, so the payload reports 0.
          terminalsKilled: 0,
        })
      );
    });

    it("emits memory-pressure reason for memory pressure hibernation", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - 31 * 60 * 1000,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({
          reason: "memory-pressure",
        })
      );
    });

    it("invokes registered callbacks during hibernation", async () => {
      setupHibernation();
      const callback = vi.fn();

      const service = makeService();
      service.onProjectHibernated(callback);
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(callback).toHaveBeenCalledWith("proj-1");
    });

    it("unsubscribe removes callback", async () => {
      setupHibernation();
      const callback = vi.fn();

      const service = makeService();
      const unsub = service.onProjectHibernated(callback);
      unsub();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(callback).not.toHaveBeenCalled();
    });

    it("continues even if a callback throws", async () => {
      setupHibernation();
      const failingCallback = vi.fn().mockRejectedValue(new Error("boom"));
      const successCallback = vi.fn();

      const service = makeService();
      service.onProjectHibernated(failingCallback);
      service.onProjectHibernated(successCallback);
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(failingCallback).toHaveBeenCalled();
      expect(successCallback).toHaveBeenCalled();
      // Event should still be emitted
      expect(broadcastToRendererMock).toHaveBeenCalled();
    });
  });

  describe("user-initiated renderer eviction (#10668)", () => {
    type ProjectViewManagerMock = {
      getActiveProjectId: Mock<() => string | null>;
      getOutgoingBridgeProjectId: Mock<() => string | null>;
      destroyView: Mock<(projectId: string) => boolean>;
    };

    function makeManager(
      activeProjectId: string | null = null,
      outgoingBridgeProjectId: string | null = null
    ): ProjectViewManagerMock {
      return {
        getActiveProjectId: vi.fn(() => activeProjectId),
        getOutgoingBridgeProjectId: vi.fn(() => outgoingBridgeProjectId),
        destroyView: vi.fn(() => true),
      };
    }

    function makeServiceWithManagers(managers: ProjectViewManagerMock[]): HibernationService {
      const service = makeService();
      service.setProjectViewManagersProvider(() => managers as unknown as ProjectViewManager[]);
      return service;
    }

    beforeEach(() => {
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);
    });

    it("evicts the cached renderer on every window where the project is not active", async () => {
      const background = makeManager("other-proj");
      const alsoBackground = makeManager(null);
      const service = makeServiceWithManagers([background, alsoBackground]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(background.destroyView).toHaveBeenCalledWith("proj-1");
      expect(alsoBackground.destroyView).toHaveBeenCalledWith("proj-1");
    });

    it("skips the window where the project is the active/foreground view", async () => {
      const foreground = makeManager("proj-1");
      const background = makeManager("other-proj");
      const service = makeServiceWithManagers([foreground, background]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(foreground.destroyView).not.toHaveBeenCalled();
      expect(background.destroyView).toHaveBeenCalledWith("proj-1");
    });

    it("skips the window where the project is the outgoing paint-gate bridge", async () => {
      // Mid cold-switch: activeProjectId is already the incoming project, but
      // proj-1 is still painted as the anti-flash bridge. Destroying it would
      // expose a blank frame — it must be skipped like the active view.
      const switching = makeManager("incoming-proj", "proj-1");
      const service = makeServiceWithManagers([switching]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(switching.destroyView).not.toHaveBeenCalled();
    });

    it("does not evict renderers for scheduled hibernation", async () => {
      const manager = makeManager(null);
      const service = makeServiceWithManagers([manager]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "scheduled");

      expect(manager.destroyView).not.toHaveBeenCalled();
    });

    it("does not evict renderers for memory-pressure hibernation", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - 31 * 60 * 1000,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      const manager = makeManager(null);
      const service = makeServiceWithManagers([manager]);

      await service.hibernateUnderMemoryPressure();

      expect(manager.destroyView).not.toHaveBeenCalled();
    });

    it("continues evicting other windows when one destroyView throws", async () => {
      const failing = makeManager(null);
      failing.destroyView.mockImplementation(() => {
        throw new Error("boom");
      });
      const healthy = makeManager(null);
      const service = makeServiceWithManagers([failing, healthy]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(failing.destroyView).toHaveBeenCalledWith("proj-1");
      expect(healthy.destroyView).toHaveBeenCalledWith("proj-1");
      expect(logError).toHaveBeenCalledWith(
        "user-initiated-hibernate-evict-failed",
        expect.any(Error),
        { projectId: "proj-1" }
      );
    });

    it("continues to the next window when a guard accessor throws", async () => {
      const failing = makeManager(null);
      failing.getActiveProjectId.mockImplementation(() => {
        throw new Error("registry torn down");
      });
      const healthy = makeManager(null);
      const service = makeServiceWithManagers([failing, healthy]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(failing.destroyView).not.toHaveBeenCalled();
      expect(healthy.destroyView).toHaveBeenCalledWith("proj-1");
    });

    it("does not reject when the eviction provider throws", async () => {
      const service = makeService();
      service.setProjectViewManagersProvider(() => {
        throw new Error("windowRegistry tearing down");
      });

      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      // No PTYs are killed under the experiment (count is 0); the throwing
      // provider is swallowed and the project-hibernated event still fires.
      expect(killed).toBe(0);
      expect(broadcastToRendererMock).toHaveBeenCalled();
    });

    it("counts only windows that actually had a cached view", async () => {
      const withView = makeManager(null);
      withView.destroyView.mockReturnValue(true);
      const withoutView = makeManager(null);
      withoutView.destroyView.mockReturnValue(false);
      const service = makeServiceWithManagers([withView, withoutView]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(logInfo).toHaveBeenCalledWith("user-initiated-hibernate-renderer-evicted", {
        projectId: "proj-1",
        evictedViewCount: 1,
      });
    });

    it("returns a zero killed-terminal count and does not throw when no provider is wired", async () => {
      const service = makeService();

      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      // No provider wired (no eviction) and no PTYs killed under the experiment.
      expect(killed).toBe(0);
      expect(broadcastToRendererMock).toHaveBeenCalled();
    });

    it("defaults to user-initiated when no reason is passed", async () => {
      const manager = makeManager(null);
      const service = makeServiceWithManagers([manager]);

      await service.hibernateProjectOnDemand("proj-1", "Proj One");

      expect(manager.destroyView).toHaveBeenCalledWith("proj-1");
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({ reason: "user-initiated" })
      );
    });
  });
});
