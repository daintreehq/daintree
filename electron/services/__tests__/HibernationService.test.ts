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
import { HibernationService, initializeHibernationService } from "../HibernationService.js";
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
 * broadcast, in call order — one per project a sweep selected.
 */
function hibernatedProjectIds(): string[] {
  return broadcastToRendererMock.mock.calls
    .filter((call) => call[0] === HIBERNATED_CHANNEL)
    .map((call) => (call[1] as { projectId: string }).projectId);
}

// `readonly` is compile-time only, so the experiment static is writable
// through a cast. Restored after every test by the outer afterEach.
type ExperimentSeam = { EXPERIMENT_HIBERNATION_DISABLED: boolean };
const experimentSeam = HibernationService as unknown as ExperimentSeam;
const experimentDefault = experimentSeam.EXPERIMENT_HIBERNATION_DISABLED;

/**
 * Turn the hibernation-removal experiment off for the current test. With it on,
 * `hibernateUnderMemoryPressure` returns before selecting anything (#12517), so
 * the sweep's selection and guards are only observable with it off.
 */
function disableHibernationExperiment(): void {
  experimentSeam.EXPERIMENT_HIBERNATION_DISABLED = false;
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
    experimentSeam.EXPERIMENT_HIBERNATION_DISABLED = experimentDefault;
  });

  describe("hibernateUnderMemoryPressure", () => {
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
    const TWENTY_MINUTES = 20 * 60 * 1000;

    it("does no work at all while the hibernation-removal experiment is on (#12517)", async () => {
      // Every candidate would be selected — idle, old, off-screen — and the
      // kill could never follow, so none of the sweep may run: no terminal
      // enumeration, no git probe, no dev-preview stop, and no "0 terminals
      // suspended" toast for a project that was never hibernated.
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);
      const callback = vi.fn();

      const service = makeService();
      service.onProjectHibernated(callback);
      const killed = await service.hibernateUnderMemoryPressure();

      expect(killed).toBe(0);
      expect(ptyManagerMock.getAllTerminalsAsync).not.toHaveBeenCalled();
      expect(fsMock.readdir).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).not.toHaveBeenCalled();
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();

      // The user-initiated close is the one path the experiment never covered.
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);
      expect(await service.hibernateProjectOnDemand("proj-1", "Old")).toBe(1);
    });

    it("never kills for a background reason while the experiment is on, even when routed on demand", async () => {
      // hibernateUnderMemoryPressure returns before reaching this guard, so the
      // on-demand entry point is the only way to prove the kill-site guard holds.
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = makeService();
      const killed = await service.hibernateProjectOnDemand(
        "proj-1",
        "Proj One",
        "memory-pressure"
      );

      expect(killed).toBe(0);
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(writeHibernatedMarkerMock).not.toHaveBeenCalled();
    });

    describe("with the hibernation-removal experiment off", () => {
      beforeEach(() => disableHibernationExperiment());

      function makeTerminal(overrides: Record<string, unknown> = {}) {
        return {
          id: "t1",
          projectId: "proj-1",
          agentState: undefined,
          ...overrides,
        };
      }

      it("selects an eligible project and reports what it killed", async () => {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          makeTerminal({ agentState: "idle" }),
        ]);

        projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
        projectStoreMock.getAllProjects.mockReturnValue([
          {
            id: "proj-1",
            name: "Old",
            path: "/projects/proj-1",
            lastOpened: Date.now() - THIRTY_ONE_MINUTES,
          },
        ]);

        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
        ]);

        const service = makeService();
        const killed = await service.hibernateUnderMemoryPressure();

        expect(killed).toBe(1);
        expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
          preserveSession: true,
        });
        expect(broadcastToRendererMock).toHaveBeenCalledWith(
          HIBERNATED_CHANNEL,
          expect.objectContaining({ projectId: "proj-1", reason: "memory-pressure" })
        );
      });

      it("skips the current active project", async () => {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          makeTerminal({ projectId: "active-proj" }),
        ]);

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

        expect(hibernatedProjectIds()).toEqual([]);
        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      });

      it("skips projects inactive less than 30 minutes", async () => {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([makeTerminal()]);

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

      it("reports a sweep that failed outright as a failure, not as one with nothing to do", async () => {
        // The tier-2 ladder backs off a lever that did nothing (#12517); a kill
        // that threw for every candidate must not read as that.
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          makeTerminal({ agentState: "idle" }),
        ]);
        ptyManagerMock.gracefulKillByProject.mockRejectedValueOnce(new Error("pty-host gone"));
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
        await expect(service.hibernateUnderMemoryPressure()).rejects.toThrow(/1 project/);
        expect(logError).toHaveBeenCalledWith(
          "memory-pressure-hibernate-failed",
          expect.any(Error),
          expect.objectContaining({ projectId: "proj-1" })
        );
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

          // The falsy-lastOpened project is filtered out; only the two valid
          // projects are selected and have their PTYs killed.
          expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledTimes(2);
          expect(ptyManagerMock.gracefulKillByProject).toHaveBeenNthCalledWith(
            1,
            "proj-valid-1",
            expect.anything()
          );
          expect(ptyManagerMock.gracefulKillByProject).toHaveBeenNthCalledWith(
            2,
            "proj-valid-2",
            expect.anything()
          );
          expect(hibernatedProjectIds()).toEqual(["proj-valid-1", "proj-valid-2"]);
        }
      );

      it("skips projects with no terminals", async () => {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([]);

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
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          makeTerminal({ agentState: "idle" }),
        ]);
        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
        ]);

        fsMock.readdir.mockImplementation(async (dirPath: string) => {
          if (String(dirPath).endsWith(".git")) return ["MERGE_HEAD", "HEAD", "config"];
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });

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

      /** One project idle past the default 30-minute window, one idle for two hours. */
      function seedThresholdProjects() {
        ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
          makeTerminal({ id: "t1", projectId: "half-hour", agentState: "idle" }),
          makeTerminal({ id: "t2", projectId: "two-hours", agentState: "idle" }),
        ]);
        projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
        projectStoreMock.getAllProjects.mockReturnValue([
          {
            id: "half-hour",
            name: "Half hour",
            path: "/projects/half-hour",
            lastOpened: Date.now() - THIRTY_ONE_MINUTES,
          },
          {
            id: "two-hours",
            name: "Two hours",
            path: "/projects/two-hours",
            lastOpened: Date.now() - 2 * 60 * 60 * 1000,
          },
        ]);
      }

      it("selects by the threshold the resource profile sets", async () => {
        seedThresholdProjects();

        const service = makeService();
        service.setMemoryPressureThresholdMs(60 * 60 * 1000);
        await service.hibernateUnderMemoryPressure();

        expect(hibernatedProjectIds()).toEqual(["two-hours"]);
      });

      it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
        "rejects a non-finite/negative threshold (%s), keeping the last valid one",
        async (bad) => {
          seedThresholdProjects();

          const service = makeService();
          service.setMemoryPressureThresholdMs(60 * 60 * 1000);
          service.setMemoryPressureThresholdMs(bad);
          await service.hibernateUnderMemoryPressure();

          // NaN or -1 would select both projects, Infinity neither.
          expect(hibernatedProjectIds()).toEqual(["two-hours"]);
        }
      );
    });
  });

  describe("live assistant guard (#11477)", () => {
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

    /** An idle project eligible for the memory-pressure sweep. */
    function seedEligibleProject() {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Old",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);
    }

    it("suppresses the background PTY kill for a project with a live assistant backend", async () => {
      // The FSM guard above this can't catch it: the assistant reports "idle"
      // while a sub-agent or background shell it dispatched runs on, which is
      // exactly the work #11157 established gets lost. Binding + PTY liveness
      // is the correct pair, injected the same way ProjectViewManager gets it.
      seedEligibleProject();
      disableHibernationExperiment();

      const service = makeService();
      service.setHasLiveAssistantBackend((projectId) => projectId === "proj-1");
      await service.hibernateUnderMemoryPressure();

      expect(logInfo).toHaveBeenCalledWith("hibernate-skip-live-assistant", {
        project: "Old",
        projectId: "proj-1",
        reason: "memory-pressure",
      });
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("does not suppress when no assistant is bound to the project", async () => {
      seedEligibleProject();
      disableHibernationExperiment();

      const service = makeService();
      service.setHasLiveAssistantBackend(() => false);
      await service.hibernateUnderMemoryPressure();

      expect(logInfo).not.toHaveBeenCalledWith("hibernate-skip-live-assistant", expect.anything());
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("leaves the user-initiated close alone — the user asked for exactly this", async () => {
      // The guard is scoped to the background reasons. A live assistant must
      // not make "Close Them" silently do nothing.
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = makeService();
      service.setHasLiveAssistantBackend(() => true);
      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(killed).toBe(1);
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
      expect(logInfo).not.toHaveBeenCalledWith("hibernate-skip-live-assistant", expect.anything());
    });

    describe("with the hibernation-removal experiment off", () => {
      // Every background kill is currently suppressed by
      // EXPERIMENT_HIBERNATION_DISABLED, so with it on, "no kill happened"
      // proves nothing about the assistant guard — deleting the guard would
      // leave those assertions passing. Neutralize the flag so the guard is the
      // only thing that can decide, then assert both directions.
      beforeEach(() => disableHibernationExperiment());

      it("a live assistant backend is what stops the background kill", async () => {
        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
        ]);

        const service = makeService();
        service.setHasLiveAssistantBackend(() => true);
        const killed = await service.hibernateProjectOnDemand(
          "proj-1",
          "Proj One",
          "memory-pressure"
        );

        expect(killed).toBe(0);
        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      });

      it("kills as usual when no assistant is bound", async () => {
        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
        ]);

        const service = makeService();
        service.setHasLiveAssistantBackend(() => false);
        const killed = await service.hibernateProjectOnDemand(
          "proj-1",
          "Proj One",
          "memory-pressure"
        );

        expect(killed).toBe(1);
        expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
          preserveSession: true,
        });
      });

      it("kills as usual when no predicate is wired at all", async () => {
        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
        ]);

        const service = makeService();
        const killed = await service.hibernateProjectOnDemand(
          "proj-1",
          "Proj One",
          "memory-pressure"
        );

        expect(killed).toBe(1);
      });
    });
  });

  describe("git sentinel guards", () => {
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

    // The probe only runs on the memory-pressure sweep, which the experiment
    // skips whole — so it's only observable with the experiment off.
    beforeEach(() => disableHibernationExperiment());

    function setupMemoryPressureProject() {
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

    it("proceeds when .git directory is missing", async () => {
      setupMemoryPressureProject();
      // Default ENOENT for all readdir calls (set in beforeEach)

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("proceeds when gitdir is unreadable (EACCES)", async () => {
      setupMemoryPressureProject();
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
      await service.hibernateUnderMemoryPressure();

      // fail-closed: readdir error on .git means we skip that gitdir and check next
      // Since all gitdirs failed without finding sentinels, we proceed with hibernation
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });

    it("continues to next project after skipping one with git operation", async () => {
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "proj-1",
          name: "Merging",
          path: "/projects/proj-1",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
        {
          id: "proj-2",
          name: "Idle",
          path: "/projects/proj-2",
          lastOpened: Date.now() - THIRTY_ONE_MINUTES,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
        { id: "t2", projectId: "proj-2", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t2", agentSessionId: null }]);

      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        const dir = String(dirPath).replace(/\\/g, "/");
        if (dir === "/projects/proj-1/.git") return ["MERGE_HEAD", "HEAD"];
        if (dir === "/projects/proj-2/.git") return ["HEAD", "config"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      // proj-1 is skipped (active git op); the sweep continues to proj-2.
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledExactlyOnceWith("proj-2", {
        preserveSession: true,
      });
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

    it("memory pressure skips a project whose index.lock is fresh", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // Written a minute ago — a git command is still holding it.
      fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - 60 * 1000 });

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual([]);
    });

    it("handles index.lock disappearing between readdir and stat", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // stat throws ENOENT — lock was deleted between readdir and stat
      fsMock.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const service = makeService();
      await service.hibernateUnderMemoryPressure();

      // Lock disappeared, so no active git operation — proceed
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
    });
  });

  describe("no background sweep (#13840)", () => {
    it("never stops a stale background project's dev servers or reports it hibernated, even with the old setting stored on", async () => {
      // A user who flipped the retired "Hibernate inactive projects" switch.
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 1 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "stale",
          name: "Stale",
          path: "/projects/stale",
          lastOpened: Date.now() - 7 * 24 * 60 * 60 * 1000,
        },
      ]);
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "stale", agentState: "idle" },
      ]);

      const service = initializeHibernationService();
      const devPreviewStop = vi.fn();
      const unsubscribe = service.onProjectHibernated(devPreviewStop);

      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      unsubscribe();

      expect(devPreviewStop).not.toHaveBeenCalled();
      expect(hibernatedProjectIds()).toEqual([]);
      expect(ptyManagerMock.getAllTerminalsAsync).not.toHaveBeenCalled();
    });
  });

  describe("hibernation notifications and cleanup", () => {
    function setupHibernation() {
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([
        { id: "t1", agentSessionId: null },
        { id: "t2", agentSessionId: "session-123" },
      ]);
    }

    it("emits event to renderer with correct payload", async () => {
      setupHibernation();

      const service = makeService();
      await service.hibernateProjectOnDemand("proj-1", "Old Project");

      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({
          projectId: "proj-1",
          projectName: "Old Project",
          reason: "user-initiated",
          terminalsKilled: 2,
        })
      );
    });

    it("invokes registered callbacks during hibernation", async () => {
      setupHibernation();
      const callback = vi.fn();

      const service = makeService();
      service.onProjectHibernated(callback);
      await service.hibernateProjectOnDemand("proj-1", "Old Project");

      expect(callback).toHaveBeenCalledWith("proj-1");
    });

    it("unsubscribe removes callback", async () => {
      setupHibernation();
      const callback = vi.fn();

      const service = makeService();
      const unsub = service.onProjectHibernated(callback);
      unsub();
      await service.hibernateProjectOnDemand("proj-1", "Old Project");

      expect(callback).not.toHaveBeenCalled();
    });

    it("continues even if a callback throws", async () => {
      setupHibernation();
      const failingCallback = vi.fn().mockRejectedValue(new Error("boom"));
      const successCallback = vi.fn();

      const service = makeService();
      service.onProjectHibernated(failingCallback);
      service.onProjectHibernated(successCallback);
      await service.hibernateProjectOnDemand("proj-1", "Old Project");

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
      destroyView: Mock<
        (projectId: string, options?: { protectMcpDispatch?: boolean }) => boolean
      >;
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

    it("hands an automatic sleep's MCP-dispatch guard to every window (#13845)", () => {
      const background = makeManager("other-proj");
      const alsoBackground = makeManager(null);
      background.destroyView.mockReturnValue(false);
      const service = makeServiceWithManagers([background, alsoBackground]);

      const evicted = service.evictProjectRenderer("proj-1", { protectMcpDispatch: true });

      // A window that kept its view because a dispatch is waiting on it doesn't count.
      expect(evicted).toBe(1);
      expect(background.destroyView).toHaveBeenCalledWith("proj-1", { protectMcpDispatch: true });
      expect(alsoBackground.destroyView).toHaveBeenCalledWith("proj-1", {
        protectMcpDispatch: true,
      });
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

    it("does not evict renderers for memory-pressure hibernation", async () => {
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
      disableHibernationExperiment();
      const manager = makeManager(null);
      const service = makeServiceWithManagers([manager]);

      await service.hibernateUnderMemoryPressure();

      // Selected (it did hibernate) but not evicted — the eviction is the
      // user-initiated path's alone.
      expect(hibernatedProjectIds()).toEqual(["proj-1"]);
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

      // The user-initiated path kills despite the experiment flag (#10831); the
      // beforeEach stub returns one terminal. The throwing eviction provider is
      // swallowed and the project-hibernated event still fires.
      expect(killed).toBe(1);
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

    it("returns the killed-terminal count and does not throw when no provider is wired", async () => {
      const service = makeService();

      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      // No provider wired (no eviction), but the user-initiated kill still runs
      // (#10831) — the beforeEach stub returns one terminal.
      expect(killed).toBe(1);
      expect(broadcastToRendererMock).toHaveBeenCalled();
    });

    it("writes a hibernation marker for every terminal killed on user-initiated (#10831)", async () => {
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([
        { id: "t1", agentSessionId: null },
        { id: "t2", agentSessionId: null },
      ]);
      const service = makeServiceWithManagers([makeManager(null)]);

      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(killed).toBe(2);
      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t1");
      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t2");
    });

    it("still broadcasts the hibernated event when user-initiated kills nothing (#10831)", async () => {
      // gracefulKillByProject is invoked (the experiment guard is bypassed) but
      // resolves empty — no terminals matched. Count is 0, no markers, but the
      // project-hibernated event must still fire so the renderer eviction and
      // dismissal gate see a consistent signal.
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([]);
      const service = makeServiceWithManagers([makeManager(null)]);

      const killed = await service.hibernateProjectOnDemand("proj-1", "Proj One", "user-initiated");

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
      expect(killed).toBe(0);
      expect(writeHibernatedMarkerMock).not.toHaveBeenCalled();
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({ reason: "user-initiated", terminalsKilled: 0 })
      );
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

  describe("multi-window visibility guard (#11102)", () => {
    const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

    beforeEach(() => disableHibernationExperiment());

    type PvmMock = {
      getActiveProjectId: Mock<() => string | null>;
      getOutgoingBridgeProjectId: Mock<() => string | null>;
      destroyView: Mock<
        (projectId: string, options?: { protectMcpDispatch?: boolean }) => boolean
      >;
    };

    function makePvm(
      activeProjectId: string | null = null,
      outgoingBridgeProjectId: string | null = null
    ): PvmMock {
      return {
        getActiveProjectId: vi.fn(() => activeProjectId),
        getOutgoingBridgeProjectId: vi.fn(() => outgoingBridgeProjectId),
        destroyView: vi.fn(() => true),
      };
    }

    function serviceWith(managers: PvmMock[]): HibernationService {
      const service = makeService();
      service.setProjectViewManagersProvider(() => managers as unknown as ProjectViewManager[]);
      return service;
    }

    /**
     * Two long-idle projects with live terminals. `focused` is the DB pointer's
     * project; `second` is the one on-screen in the OTHER, unfocused window.
     * Both are old enough to be eligible, so any that survives the sweep did so
     * because of the visibility guard, not the inactivity threshold.
     */
    function seedTwoIdleProjects(inactiveFor: number): void {
      ptyManagerMock.getAllTerminalsAsync.mockResolvedValue([
        { id: "t1", projectId: "focused-proj", agentState: "idle" },
        { id: "t2", projectId: "second-window-proj", agentState: "idle" },
        { id: "t3", projectId: "truly-background-proj", agentState: "idle" },
      ]);
      projectStoreMock.getAllProjects.mockReturnValue([
        {
          id: "focused-proj",
          name: "Focused",
          path: "/projects/focused",
          lastOpened: Date.now() - inactiveFor,
        },
        {
          id: "second-window-proj",
          name: "Second Window",
          path: "/projects/second",
          lastOpened: Date.now() - inactiveFor,
        },
        {
          id: "truly-background-proj",
          name: "Background",
          path: "/projects/background",
          lastOpened: Date.now() - inactiveFor,
        },
      ]);
      projectStoreMock.getCurrentProjectId.mockReturnValue("focused-proj");
    }

    it("does not hibernate a project visible in a second, unfocused window", async () => {
      seedTwoIdleProjects(THIRTY_ONE_MINUTES);
      const service = serviceWith([makePvm("focused-proj"), makePvm("second-window-proj")]);

      await service.hibernateUnderMemoryPressure();

      // Only the project no window is showing gets selected.
      expect(hibernatedProjectIds()).toEqual(["truly-background-proj"]);
    });

    it("does not hibernate the outgoing paint-gate bridge project", async () => {
      seedTwoIdleProjects(THIRTY_ONE_MINUTES);
      // Second window is mid cold-switch: it already points at a third project,
      // but second-window-proj is still painted behind the anti-flash bridge.
      const service = serviceWith([
        makePvm("focused-proj"),
        makePvm("truly-background-proj", "second-window-proj"),
      ]);

      await service.hibernateUnderMemoryPressure();

      expect(hibernatedProjectIds()).toEqual([]);
    });

    it("re-reads visibility after the git probe, sparing a project brought on-screen mid-sweep", async () => {
      seedTwoIdleProjects(THIRTY_ONE_MINUTES);

      // The window shows nothing when the sweep starts, then switches to
      // truly-background-proj while the (awaited) git probe is in flight.
      const late = makePvm("focused-proj");
      let collectCount = 0;
      late.getActiveProjectId.mockImplementation(() => {
        collectCount++;
        // First collection (pre-loop) sees the old state; later ones see the switch.
        return collectCount <= 1 ? "focused-proj" : "truly-background-proj";
      });

      const service = serviceWith([late]);
      await service.hibernateUnderMemoryPressure();

      // Without the late recheck this would have hibernated a now-visible project.
      expect(hibernatedProjectIds()).not.toContain("truly-background-proj");
    });

    it("still hibernates a background project when one window's manager throws (#8607)", async () => {
      seedTwoIdleProjects(THIRTY_ONE_MINUTES);

      const disposing = makePvm();
      disposing.getActiveProjectId.mockImplementation(() => {
        throw new Error("manager disposed");
      });
      const healthy = makePvm("second-window-proj");
      const service = serviceWith([disposing, healthy]);

      await service.hibernateUnderMemoryPressure();

      // The throwing window doesn't abort collection: the healthy window's
      // project is still protected, and the sweep still does its job.
      expect(hibernatedProjectIds()).toEqual(["truly-background-proj"]);
    });

    it("falls back to the DB pointer when no provider is wired (early startup)", async () => {
      seedTwoIdleProjects(THIRTY_ONE_MINUTES);

      const service = makeService(); // provider never injected

      await service.hibernateUnderMemoryPressure();

      // The pointer still protects the focused project; the rest are fair game.
      expect(hibernatedProjectIds()).not.toContain("focused-proj");
      expect(hibernatedProjectIds()).toContain("truly-background-proj");
    });
  });
});
