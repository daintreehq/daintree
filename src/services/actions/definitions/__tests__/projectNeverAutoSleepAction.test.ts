// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateProjectMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; neverAutoSleep?: boolean }>,
  currentProject: null as { id: string } | null,
  updateProject: (...args: unknown[]): Promise<void> => updateProjectMock(...args),
}));

vi.mock("@/clients", () => ({ projectClient: {} }));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => storeState },
}));

vi.mock("@shared/utils/projectMru", () => ({ getMruProjects: () => [] }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import type { ActionRegistry } from "../../actionTypes";
import { registerProjectActions } from "../projectActions";

const ctx = {} as never;

function action() {
  const actions: ActionRegistry = new Map();
  registerProjectActions(actions, {} as never);
  const factory = actions.get("project.toggleNeverAutoSleep");
  if (!factory) throw new Error("project.toggleNeverAutoSleep is not registered");
  return factory();
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState.projects = [{ id: "p1" }, { id: "p2", neverAutoSleep: true }];
  storeState.currentProject = { id: "p1" };
  updateProjectMock.mockResolvedValue(undefined);
});

describe("project.toggleNeverAutoSleep", () => {
  it("is a safe command with optional arguments", () => {
    const a = action();
    expect(a.danger).toBe("safe");
    expect(a.title).toBe("Never sleep automatically");
    expect(() => a.argsSchema!.parse({})).not.toThrow();
    expect(() => a.argsSchema!.parse({ projectId: "p1", enabled: true })).not.toThrow();
    expect(() => a.argsSchema!.parse({ enabled: "yes" })).toThrow();
  });

  it("flips the current state when enabled is omitted", async () => {
    await action().run({ projectId: "p1" }, ctx);
    expect(updateProjectMock).toHaveBeenCalledWith("p1", { neverAutoSleep: true });

    await action().run({ projectId: "p2" }, ctx);
    expect(updateProjectMock).toHaveBeenCalledWith("p2", { neverAutoSleep: false });
  });

  it("sets the value explicitly when enabled is given", async () => {
    await action().run({ projectId: "p2", enabled: true }, ctx);
    expect(updateProjectMock).toHaveBeenCalledWith("p2", { neverAutoSleep: true });
  });

  it("defaults to the current project", async () => {
    await action().run({}, ctx);
    expect(updateProjectMock).toHaveBeenCalledWith("p1", { neverAutoSleep: true });
  });

  it("refuses when no project resolves", async () => {
    storeState.currentProject = null;
    await expect(action().run({}, ctx)).rejects.toThrow("No project given");
    await expect(action().run({ projectId: "nope" }, ctx)).rejects.toThrow("Project not found");
    expect(updateProjectMock).not.toHaveBeenCalled();
  });
});
