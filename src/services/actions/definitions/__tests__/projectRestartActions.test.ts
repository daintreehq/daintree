// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const restartProjectMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; path: string }>,
  currentProject: null as { id: string; name: string; path: string } | null,
}));

vi.mock("@/clients", () => ({ projectClient: {} }));
vi.mock("@/clients/terminalClient", () => ({ terminalClient: { getAll: vi.fn() } }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => storeState },
}));
vi.mock("@/services/projectRestart", () => ({
  restartProject: (...args: unknown[]) => restartProjectMock(...args),
}));
vi.mock("@/hooks/useSleepIdleProjects", () => ({ sleepIdleProjectsWithConfirm: vi.fn() }));
vi.mock("@shared/utils/projectMru", () => ({ getMruProjects: () => [] }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import { registerProjectActions } from "../projectActions";
// The run bodies load on first dispatch (#14269). Evaluate them here, as they
// always were, so the first test's waitFor isn't spent on a cold module load.
import "../projectActions.impl";

const ctx: ActionContext = {};

function restartAction() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = Object.create(null);
  registerProjectActions(actions, callbacks);
  const factory = actions.get("project.restart");
  if (!factory) throw new Error("project.restart is not registered");
  return factory();
}

const pending = () => useProjectSleepConfirmStore.getState().pendingConfirm;

beforeEach(() => {
  vi.clearAllMocks();
  restartProjectMock.mockResolvedValue("restarted");
  const cur = { id: "cur", name: "Current", path: "/repos/cur" };
  storeState.projects = [cur, { id: "bg", name: "Background", path: "/repos/bg" }];
  storeState.currentProject = cur;
  useProjectStatsStore.setState({ stats: {} });
});

afterEach(() => {
  useProjectSleepConfirmStore.getState().resolveConfirmation(false);
});

describe("project.restart", () => {
  it("is a confirm action kept out of repeat-last", () => {
    const a = restartAction();
    expect(a.danger).toBe("confirm");
    expect(a.nonRepeatable).toBe(true);
    expect(a.scope).toBe("renderer");
  });

  it("asks to confirm even when nothing is known to be running", async () => {
    const run = restartAction().run({}, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.request).toEqual({
      kind: "restart",
      projects: [
        {
          id: "cur",
          name: "Current",
          path: "/repos/cur",
          terminalCount: 0,
          activeAgentCount: 0,
          waitingAgentCount: 0,
          isActive: true,
        },
      ],
    });
    expect(restartProjectMock).not.toHaveBeenCalled();
    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    await expect(run).resolves.toEqual({ restarted: true, outcome: "restarted" });
    expect(restartProjectMock).toHaveBeenCalledWith("cur");
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const run = restartAction().run({ projectId: "cur" }, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(false);
    await expect(run).resolves.toEqual({ restarted: false });
    expect(restartProjectMock).not.toHaveBeenCalled();
  });

  it("drops the restart when the window moved on while the dialog was open", async () => {
    const run = restartAction().run({}, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    storeState.currentProject = { id: "bg", name: "Background", path: "/repos/bg" };
    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    await expect(run).resolves.toEqual({ restarted: false });
    expect(restartProjectMock).not.toHaveBeenCalled();
  });

  it("reports a failed stage as not restarted", async () => {
    restartProjectMock.mockResolvedValue("reopen-failed");
    const run = restartAction().run({}, ctx);
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    useProjectSleepConfirmStore.getState().resolveConfirmation(true);
    await expect(run).resolves.toEqual({ restarted: false, outcome: "reopen-failed" });
  });

  it("refuses a project that isn't the one in this window", async () => {
    await expect(restartAction().run({ projectId: "bg" }, ctx)).rejects.toThrow(
      "Only the project open in this window can be restarted"
    );
    expect(pending()).toBeNull();
  });

  it("refuses when no project is open", async () => {
    storeState.currentProject = null;
    await expect(restartAction().run({}, ctx)).rejects.toThrow("No project is open in this window");
  });

  it("refuses an agent dispatch without opening the dialog", async () => {
    await expect(restartAction().run({}, { dispatchSource: "agent" })).rejects.toThrow(
      "only available to the user"
    );
    expect(pending()).toBeNull();
    expect(restartProjectMock).not.toHaveBeenCalled();
  });
});
