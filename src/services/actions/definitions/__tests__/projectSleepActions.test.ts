// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sleepProjectMock = vi.hoisted(() => vi.fn());
const sleepIdleMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; path: string }>,
  currentProject: null as { id: string } | null,
  sleepProject: (...args: unknown[]): Promise<unknown> => sleepProjectMock(...args),
}));

const getAllTerminalsMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({ projectClient: {} }));
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { getAll: (...args: unknown[]) => getAllTerminalsMock(...args) },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => storeState },
}));
vi.mock("@/hooks/useSleepIdleProjects", () => ({
  sleepIdleProjectsWithConfirm: (...args: unknown[]) => sleepIdleMock(...args),
}));
vi.mock("@shared/utils/projectMru", () => ({ getMruProjects: () => [] }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import type { ProjectStatusEntry } from "@shared/types/ipc/project";
import type { ActionRegistry } from "../../actionTypes";
import { registerProjectActions } from "../projectActions";

const ctx = {} as never;

function action(id: "project.sleep" | "project.sleepIdle") {
  const actions: ActionRegistry = new Map();
  registerProjectActions(actions, {} as never);
  const factory = actions.get(id);
  if (!factory) throw new Error(`${id} is not registered`);
  return factory();
}

function stats(overrides: Partial<ProjectStatusEntry> = {}): ProjectStatusEntry {
  return {
    activeAgentCount: 0,
    waitingAgentCount: 0,
    processCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    ...overrides,
  };
}

const pending = () => useProjectSleepConfirmStore.getState().pendingConfirm;

beforeEach(() => {
  vi.clearAllMocks();
  sleepProjectMock.mockResolvedValue({});
  getAllTerminalsMock.mockResolvedValue([]);
  storeState.projects = [
    { id: "cur", name: "Current", path: "/repos/cur" },
    { id: "bg", name: "Background", path: "/repos/bg" },
  ];
  storeState.currentProject = { id: "cur" };
  useProjectStatsStore.setState({ stats: { cur: stats(), bg: stats() } });
});

afterEach(() => {
  useProjectSleepConfirmStore.getState().resolveConfirmation(false);
  useProjectStatsStore.setState({ stats: {} });
});

describe("project.sleep", () => {
  it("is a confirm-tier command that takes an optional project", () => {
    const a = action("project.sleep");
    expect(a.danger).toBe("confirm");
    expect(a.dangerRationale).toBeTruthy();
    expect(a.nonRepeatable).toBe(true);
    expect(() => a.argsSchema!.parse({})).not.toThrow();
    expect(() => a.argsSchema!.parse({ projectId: "bg" })).not.toThrow();
    expect(() => a.argsSchema!.parse({ projectId: 3 })).toThrow();
  });

  it("sleeps a quiet background project at once, with no dialog", async () => {
    const result = await action("project.sleep").run({ projectId: "bg" }, ctx);
    expect(sleepProjectMock).toHaveBeenCalledWith("bg");
    expect(pending()).toBeNull();
    expect(result).toEqual({ slept: true });
  });

  it("asks first when live processes would stop, and sleeps only on confirm", async () => {
    useProjectStatsStore.setState({
      stats: { cur: stats(), bg: stats({ processCount: 3, waitingAgentCount: 1 }) },
    });
    const run = action("project.sleep").run({ projectId: "bg" }, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.request.kind).toBe("project");
    expect(pending()!.request.projects).toEqual([
      expect.objectContaining({
        id: "bg",
        terminalCount: 3,
        waitingAgentCount: 1,
        isActive: false,
      }),
    ]);
    expect(sleepProjectMock).not.toHaveBeenCalled();

    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    expect(await run).toEqual({ slept: true });
    expect(sleepProjectMock).toHaveBeenCalledWith("bg");
  });

  it("defaults to the project on screen, which always asks", async () => {
    const run = action("project.sleep").run({}, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.request.projects[0]).toMatchObject({ id: "cur", isActive: true });

    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    await run;
    expect(sleepProjectMock).toHaveBeenCalledWith("cur");
  });

  it("asks when the project has no stats entry", async () => {
    useProjectStatsStore.setState({ stats: { cur: stats() } });
    const run = action("project.sleep").run({ projectId: "bg" }, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    expect(await run).toEqual({ slept: false });
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("asks when the host lists a terminal the pushed counts leave out, such as a hidden assistant", async () => {
    getAllTerminalsMock.mockResolvedValue([
      { id: "t1", projectId: "bg", cwd: "/", spawnedAt: 0 },
      { id: "t2", projectId: "other", cwd: "/", spawnedAt: 0 },
      { id: "t3", projectId: "bg", cwd: "/", spawnedAt: 0, isTrashed: true },
    ]);
    const run = action("project.sleep").run({ projectId: "bg" }, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.request.projects[0]).toMatchObject({ id: "bg", terminalCount: 1 });
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    await run;
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("asks when the host's terminal list can't be read", async () => {
    getAllTerminalsMock.mockRejectedValue(new Error("host stalled"));
    const run = action("project.sleep").run({ projectId: "bg" }, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    await run;
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("does not open a second dialog for a dispatch the MCP bridge already cleared", async () => {
    useProjectStatsStore.setState({ stats: { cur: stats(), bg: stats({ processCount: 3 }) } });
    const result = await action("project.sleep").run({ projectId: "bg" }, {
      dispatchSource: "agent",
    } as never);
    expect(pending()).toBeNull();
    expect(sleepProjectMock).toHaveBeenCalledWith("bg");
    expect(result).toEqual({ slept: true });
  });

  it("sleeps nothing when the user cancels", async () => {
    const run = action("project.sleep").run({}, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    expect(await run).toEqual({ slept: false });
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown project, and a missing one when none is open", async () => {
    await expect(action("project.sleep").run({ projectId: "nope" }, ctx)).rejects.toThrow(
      "Project not found: nope"
    );
    storeState.currentProject = null;
    await expect(action("project.sleep").run({}, ctx)).rejects.toThrow(
      "No project given and no project is open"
    );
    expect(sleepProjectMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed teardown to the caller", async () => {
    sleepProjectMock.mockRejectedValue(new Error("host did not acknowledge"));
    await expect(action("project.sleep").run({ projectId: "bg" }, ctx)).rejects.toThrow(
      "host did not acknowledge"
    );
  });
});

describe("project.sleepIdle", () => {
  it("is a confirm-tier command with no arguments, and defers to the shared idle flow", async () => {
    const a = action("project.sleepIdle");
    expect(a.danger).toBe("confirm");
    expect(a.dangerRationale).toBeTruthy();
    expect(a.nonRepeatable).toBe(true);
    sleepIdleMock.mockResolvedValue(2);
    expect(await a.run(undefined, ctx)).toEqual({ slept: true, count: 2 });
    expect(sleepIdleMock).toHaveBeenCalledWith({ alreadyApproved: false });
  });

  it("reports nothing slept when no project actually went down", async () => {
    sleepIdleMock.mockResolvedValue(0);
    expect(await action("project.sleepIdle").run(undefined, ctx)).toEqual({
      slept: false,
      count: 0,
    });
  });

  it("skips its own dialog for an agent dispatch the MCP bridge already cleared", async () => {
    sleepIdleMock.mockResolvedValue(1);
    await action("project.sleepIdle").run(undefined, { dispatchSource: "agent" } as never);
    expect(sleepIdleMock).toHaveBeenCalledWith({ alreadyApproved: true });
  });
});
