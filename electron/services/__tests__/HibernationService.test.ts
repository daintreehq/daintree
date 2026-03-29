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
  getAll: vi.fn<() => unknown[]>(() => []),
  getProjectStats: vi.fn(() => ({ terminalCount: 0 })),
  gracefulKillByProject: vi.fn(
    async () => [] as Array<{ id: string; agentSessionId: string | null }>
  ),
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

vi.mock("../PtyManager.js", () => ({
  getPtyManager: () => ptyManagerMock,
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

    const service = new HibernationService();

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

    const service = new HibernationService();

    expect(service.getConfig()).toEqual({
      enabled: true,
      inactiveThresholdHours: 168,
    });
  });

  it("ignores invalid update payload values", () => {
    (storeMock.get as Mock).mockReturnValue(undefined);
    const service = new HibernationService();

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
    const service = new HibernationService();

    service.updateConfig({
      inactiveThresholdHours: Number.NaN,
    });

    expect(storeMock.set).toHaveBeenCalledWith("hibernation", {
      enabled: true,
      inactiveThresholdHours: 72,
    });
  });

  it("does not call clearProjectState during hibernation", async () => {
    ptyManagerMock.getAll.mockReturnValue([
      { id: "t1", projectId: "proj-1", agentState: "idle" },
      { id: "t2", projectId: "proj-1", agentState: "idle" },
    ]);
    ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

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

    const service = new HibernationService();
    await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

    expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
      preserveSession: true,
    });
    expect(projectStoreMock.clearProjectState).not.toHaveBeenCalled();
  });

  it.each([0, null, undefined, NaN])(
    "skips projects with falsy lastOpened (%s) in checkAndHibernate",
    async (falsyValue) => {
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-valid-1", agentState: "idle" },
        { id: "t2", projectId: "proj-falsy", agentState: "idle" },
        { id: "t3", projectId: "proj-valid-2", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

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

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-valid-1", {
        preserveSession: true,
      });
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-valid-2", {
        preserveSession: true,
      });
      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalledWith("proj-falsy");
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledTimes(2);
    }
  );

  it("clears pending initial check when stopped before timeout", () => {
    (storeMock.get as Mock).mockReturnValue({
      enabled: true,
      inactiveThresholdHours: 24,
    });
    const service = new HibernationService();
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
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ agentState: "idle" })]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

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

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("skips the current active project", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ projectId: "active-proj" })]);

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

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("skips projects inactive less than 30 minutes", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal()]);

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

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it.each(["working", "running", "waiting", "directing"] as const)(
      "skips projects with %s agent terminals",
      async (agentState) => {
        ptyManagerMock.getAll.mockReturnValue([makeTerminal({ agentState })]);

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

        const service = new HibernationService();
        await service.hibernateUnderMemoryPressure();

        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      }
    );

    it("hibernates eligible idle projects", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ agentState: "idle" })]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

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

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
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
        ptyManagerMock.getAll.mockReturnValue([validTerminal, falsyTerminal, validTerminal2]);
        ptyManagerMock.gracefulKillByProject.mockResolvedValue([
          { id: "t1", agentSessionId: null },
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

        const service = new HibernationService();
        await service.hibernateUnderMemoryPressure();

        expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-valid-1", {
          preserveSession: true,
        });
        expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-valid-2", {
          preserveSession: true,
        });
        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalledWith("proj-falsy");
        expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledTimes(2);
      }
    );

    it("skips projects with no terminals", async () => {
      ptyManagerMock.getAll.mockReturnValue([]);

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

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("skips projects with active git operations", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ agentState: "idle" })]);
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

      const service = new HibernationService();
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

    it.each(["working", "running", "waiting", "directing"] as const)(
      "skips projects with %s agent in scheduled hibernation",
      async (agentState) => {
        setupScheduledTest();
        ptyManagerMock.getAll.mockReturnValue([{ id: "t1", projectId: "proj-1", agentState }]);

        const service = new HibernationService();
        await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      }
    );

    it("proceeds with idle agents in scheduled hibernation", async () => {
      setupScheduledTest();
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
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
      ptyManagerMock.getAll.mockReturnValue([
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
      ptyManagerMock.getAll.mockReturnValue([
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

      const service = new HibernationService();
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

      const service = new HibernationService();
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

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("memory pressure hibernation skips project with REBASE_HEAD", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["REBASE_HEAD", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const service = new HibernationService();
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

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });

    it("proceeds when .git directory is missing", async () => {
      setupScheduledProject();
      // Default ENOENT for all readdir calls (set in beforeEach)

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
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

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // fail-closed: readdir error on .git means we skip that gitdir and check next
      // Since all gitdirs failed without finding sentinels, we proceed with hibernation
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
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
      ptyManagerMock.getAll.mockReturnValue([
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

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalledWith("proj-1");
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-2", {
        preserveSession: true,
      });
    });

    it("memory pressure uses 30min threshold for stale index.lock", async () => {
      setupMemoryPressureProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // Lock is 31 minutes old — older than MEMORY_PRESSURE_INACTIVE_MS (30 min), so stale
      fsMock.stat.mockResolvedValue({ mtimeMs: Date.now() - THIRTY_ONE_MINUTES - 1000 });

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });

    it("handles index.lock disappearing between readdir and stat", async () => {
      setupScheduledProject();
      fsMock.readdir.mockImplementation(async (dirPath: string) => {
        if (String(dirPath).endsWith(".git")) return ["index.lock", "HEAD"];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      // stat throws ENOENT — lock was deleted between readdir and stat
      fsMock.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      // Lock disappeared, so no active git operation — proceed
      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1", {
        preserveSession: true,
      });
    });
  });

  describe("structured logging", () => {
    it("logs auto-hibernation-disabled when config is off", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: false, inactiveThresholdHours: 24 });
      const service = new HibernationService();
      service.start();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-disabled");
    });

    it("logs auto-hibernation-started when config is on", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = new HibernationService();
      service.start();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-started");
    });

    it("logs auto-hibernation-stopped on stop", () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = new HibernationService();
      service.start();
      service.stop();
      expect(logInfo).toHaveBeenCalledWith("auto-hibernation-stopped");
    });

    it("logs auto-hibernation-check-failed when interval check throws", async () => {
      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      const service = new HibernationService();
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
      const service = new HibernationService();
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
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(logInfo).toHaveBeenCalledWith("scheduled-hibernate-project", {
        project: "Old",
        projectId: "proj-1",
        hoursInactive: 25,
        terminalCount: 1,
      });
      expect(logInfo).toHaveBeenCalledWith("scheduled-hibernate-complete", {
        project: "Old",
        projectId: "proj-1",
        terminalsKilled: 1,
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
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      const testError = new Error("hibernate-boom");
      ptyManagerMock.gracefulKillByProject.mockRejectedValue(testError);

      const service = new HibernationService();
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
      const service = new HibernationService();
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
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
        { id: "t2", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([
        { id: "t1", agentSessionId: null },
        { id: "t2", agentSessionId: "session-123" },
      ]);
    }

    it("writes hibernation markers for each killed terminal", async () => {
      setupHibernation();

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t1");
      expect(writeHibernatedMarkerMock).toHaveBeenCalledWith("t2");
    });

    it("emits event to renderer with correct payload", async () => {
      setupHibernation();

      const service = new HibernationService();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        "hibernation:project-hibernated",
        expect.objectContaining({
          projectId: "proj-1",
          projectName: "Old Project",
          reason: "scheduled",
          terminalsKilled: 2,
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
      ptyManagerMock.getAll.mockReturnValue([
        { id: "t1", projectId: "proj-1", agentState: "idle" },
      ]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1", agentSessionId: null }]);

      const service = new HibernationService();
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

      const service = new HibernationService();
      service.onProjectHibernated(callback);
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(callback).toHaveBeenCalledWith("proj-1");
    });

    it("unsubscribe removes callback", async () => {
      setupHibernation();
      const callback = vi.fn();

      const service = new HibernationService();
      const unsub = service.onProjectHibernated(callback);
      unsub();
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(callback).not.toHaveBeenCalled();
    });

    it("continues even if a callback throws", async () => {
      setupHibernation();
      const failingCallback = vi.fn().mockRejectedValue(new Error("boom"));
      const successCallback = vi.fn();

      const service = new HibernationService();
      service.onProjectHibernated(failingCallback);
      service.onProjectHibernated(successCallback);
      await (service as unknown as { checkAndHibernate(): Promise<void> }).checkAndHibernate();

      expect(failingCallback).toHaveBeenCalled();
      expect(successCallback).toHaveBeenCalled();
      // Event should still be emitted
      expect(broadcastToRendererMock).toHaveBeenCalled();
    });
  });
});
