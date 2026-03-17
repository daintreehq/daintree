import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getAllProjects: vi.fn<() => Array<{ id: string; name: string; lastOpened: number }>>(() => []),
  clearProjectState: vi.fn(async () => {}),
}));

const ptyManagerMock = vi.hoisted(() => ({
  getAll: vi.fn<() => unknown[]>(() => []),
  getProjectStats: vi.fn(() => ({ terminalCount: 0 })),
  gracefulKillByProject: vi.fn(async () => []),
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../PtyManager.js", () => ({
  getPtyManager: () => ptyManagerMock,
}));

import { HibernationService } from "../HibernationService.js";

describe("HibernationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    ptyManagerMock.getProjectStats.mockReturnValue({ terminalCount: 2 });
    ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1" }]);

    const inactiveProject = {
      id: "proj-1",
      name: "Old Project",
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

    expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1");
    expect(projectStoreMock.clearProjectState).not.toHaveBeenCalled();
  });

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
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1" }]);

      (storeMock.get as Mock).mockReturnValue({
        enabled: false,
        inactiveThresholdHours: 24,
      });

      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "proj-1", name: "Old", lastOpened: Date.now() - THIRTY_ONE_MINUTES },
      ]);

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1");
    });

    it("skips the current active project", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ projectId: "active-proj" })]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("active-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "active-proj", name: "Active", lastOpened: Date.now() - THIRTY_ONE_MINUTES },
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
        { id: "proj-1", name: "Recent", lastOpened: Date.now() - TWENTY_MINUTES },
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
          { id: "proj-1", name: "Busy", lastOpened: Date.now() - THIRTY_ONE_MINUTES },
        ]);

        const service = new HibernationService();
        await service.hibernateUnderMemoryPressure();

        expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
      }
    );

    it("hibernates eligible idle projects", async () => {
      ptyManagerMock.getAll.mockReturnValue([makeTerminal({ agentState: "idle" })]);
      ptyManagerMock.gracefulKillByProject.mockResolvedValue([{ id: "t1" }]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "proj-1", name: "Old", lastOpened: Date.now() - THIRTY_ONE_MINUTES },
      ]);

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).toHaveBeenCalledWith("proj-1");
    });

    it("skips projects with no terminals", async () => {
      ptyManagerMock.getAll.mockReturnValue([]);

      (storeMock.get as Mock).mockReturnValue({ enabled: true, inactiveThresholdHours: 24 });
      projectStoreMock.getCurrentProjectId.mockReturnValue("other-proj");
      projectStoreMock.getAllProjects.mockReturnValue([
        { id: "proj-1", name: "Empty", lastOpened: Date.now() - THIRTY_ONE_MINUTES },
      ]);

      const service = new HibernationService();
      await service.hibernateUnderMemoryPressure();

      expect(ptyManagerMock.gracefulKillByProject).not.toHaveBeenCalled();
    });
  });
});
