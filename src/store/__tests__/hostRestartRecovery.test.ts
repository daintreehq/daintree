// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelRestoreContext } from "@/utils/stateHydration/panelRestorePhase";

const { restorePanelsPhase, addPanel, getAllWithStatus, panelsById } = vi.hoisted(() => ({
  restorePanelsPhase: vi.fn(async (_saved: Array<{ id: string }>, _ctx: PanelRestoreContext) => ({
    restoreTasks: [],
    savedIdToRestoredId: new Map(),
    ghostedWorktreeIds: new Set(),
  })),
  addPanel: vi.fn(async (args: { requestedId?: string }) => args.requestedId ?? null),
  getAllWithStatus: vi.fn(async () => ({ worktrees: [], gitBacked: true })),
  panelsById: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/utils/stateHydration/panelRestorePhase", () => ({ restorePanelsPhase }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ addPanel, panelsById }) },
}));
vi.mock("@/store/resourceProfileStore", () => ({
  useResourceProfileStore: { getState: () => ({ profile: "balanced" }) },
}));
vi.mock("@/clients", () => ({ worktreeClient: { getAllWithStatus } }));
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => true }));

import { relaunchTerminalsLostToHostRestart } from "../hostRestartRecovery";

const hydrate = vi.fn();
/** The host's answer for each terminal asked about: gone, unless a test says otherwise. */
const reconnectBulk = vi.fn(async (ids: string[]): Promise<Record<string, unknown>> =>
  Object.fromEntries(ids.map((id) => [id, { exists: false }]))
);
const getForProject = vi.fn(async (_projectId: string): Promise<unknown[]> => []);

function savedState(workspaceId = "proj-1") {
  return {
    workspaceId,
    project: { id: workspaceId, path: "/repo", name: "repo" },
    appState: {
      activeWorktreeId: "wt-main",
      terminals: [
        { id: "t-agent", kind: "terminal", launchAgentId: "claude", agentSessionId: "s-1" },
        { id: "t-other", kind: "terminal" },
        { id: "t-trashed", kind: "terminal", location: "trash" },
      ],
    },
    agentSettings: { agents: {} },
    hostTmpDir: "/tmp",
    terminalSizes: { "t-agent": { cols: 120, rows: 40 } },
    projectPresets: {},
    safeMode: false,
  };
}

const lost = new Map([
  ["t-agent", 2],
  ["t-trashed", 0],
]);

beforeEach(() => {
  vi.clearAllMocks();
  for (const id of Object.keys(panelsById)) delete panelsById[id];
  hydrate.mockResolvedValue(savedState());
  Object.defineProperty(window, "electron", {
    value: { app: { hydrate }, terminal: { reconnectBulk, getForProject } },
    writable: true,
    configurable: true,
  });
});

describe("relaunchTerminalsLostToHostRestart", () => {
  it("restores only what the restart ended, through the cold-launch restore, from the host's save", async () => {
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });

    expect(reconnectBulk).toHaveBeenCalledWith(["t-agent"]);
    expect(restorePanelsPhase).toHaveBeenCalledTimes(1);
    const [saved, ctx] = restorePanelsPhase.mock.calls[0]!;
    expect(saved).toEqual([savedState().appState.terminals[0]]);
    expect(ctx).toMatchObject({
      projectId: "proj-1",
      projectRoot: "/repo",
      prefetchedReconnectResults: { "t-agent": { exists: false } },
      terminalSizes: { "t-agent": { cols: 120, rows: 40 } },
      safeMode: false,
    });
    // Nothing the host runs now is appended as an orphan.
    expect(ctx.backendTerminalMap.size).toBe(0);
  });

  it("replaces each pane in place under the restart key it was lost under, and nothing else", async () => {
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({
        kind: "terminal",
        requestedId: "t-agent",
        cwd: "/repo",
        command: "claude --resume s-1",
      });
      await ctx.addPanel({ kind: "terminal", requestedId: "t-other", cwd: "/repo" });
      await ctx.addPanel({ kind: "terminal", cwd: "/repo" });
      await ctx.addPanel({ kind: "dev-preview", requestedId: "t-trashed", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedId: "t-agent",
        command: "claude --resume s-1",
        replacesLostTerminal: 2,
        bypassLimits: true,
        focusPolicy: "preserve",
      })
    );
  });

  it("starts nothing in a pane the host runs again, or can't say about", async () => {
    reconnectBulk.mockResolvedValueOnce({ "t-agent": { exists: true, hasPty: true } });
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });
    reconnectBulk.mockResolvedValueOnce({ "t-agent": { exists: false, conflict: true } });
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });
    reconnectBulk.mockResolvedValueOnce({});
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });

    expect(restorePanelsPhase).not.toHaveBeenCalled();
  });

  it("keeps where the view shows a pane and the name the user gave it over the host's older save", async () => {
    panelsById["t-agent"] = {
      id: "t-agent",
      location: "dock",
      title: "Auth work",
      titleMode: "user",
    };
    panelsById["t-shell"] = { id: "t-shell", location: "grid", title: "zsh" };
    hydrate.mockResolvedValueOnce({
      ...savedState(),
      appState: {
        activeWorktreeId: "wt-main",
        terminals: [
          { id: "t-agent", kind: "terminal", launchAgentId: "claude" },
          { id: "t-shell", kind: "terminal" },
        ],
      },
    });
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({
        kind: "terminal",
        requestedId: "t-agent",
        cwd: "/repo",
        title: "Claude",
        location: "grid",
      });
      await ctx.addPanel({
        kind: "terminal",
        requestedId: "t-shell",
        cwd: "/repo",
        title: "Terminal",
        location: "dock",
      });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    await relaunchTerminalsLostToHostRestart(
      "proj-1",
      new Map([
        ["t-agent", 0],
        ["t-shell", 0],
      ]),
      { isCurrent: () => true, drives: () => true }
    );

    expect(addPanel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestedId: "t-agent",
        location: "dock",
        title: "Auth work",
        titleMode: "user",
      })
    );
    // A title nobody chose is the restore's to set.
    expect(addPanel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestedId: "t-shell", location: "grid", title: "Terminal" })
    );
  });

  it("lets a saved pane the host runs again claim its conversation, and launches nothing in it", async () => {
    hydrate.mockResolvedValueOnce({
      ...savedState(),
      appState: {
        activeWorktreeId: "wt-main",
        terminals: [
          { id: "t-agent", kind: "terminal", launchAgentId: "claude", agentSessionId: "s-1" },
          { id: "t-live", kind: "terminal", launchAgentId: "claude", agentSessionId: "s-1" },
        ],
      },
    });
    getForProject.mockResolvedValueOnce([
      {
        id: "t-live",
        hasPty: true,
        launchAgentId: "claude",
        agentSessionId: "s-1",
        cwd: "/repo",
        activityTier: "active",
      },
      // Not in the save: nothing for the restore to do with it.
      { id: "t-unsaved", hasPty: true, cwd: "/repo" },
    ]);
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({ kind: "terminal", existingId: "t-live", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    await relaunchTerminalsLostToHostRestart("proj-1", new Map([["t-agent", 0]]), {
      isCurrent: () => true,
      drives: () => true,
    });

    const [saved, ctx] = restorePanelsPhase.mock.calls[0]!;
    expect(saved.map((entry) => entry.id)).toEqual(["t-agent", "t-live"]);
    expect([...ctx.backendTerminalMap.keys()]).toEqual(["t-live"]);
    // The restore sets no tier on a pane it never adds.
    expect(ctx.backendTerminalMap.get("t-live")?.activityTier).toBeUndefined();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("never launches over a pane the host runs, and lets one restarted since its loss claim its conversation", async () => {
    hydrate.mockResolvedValueOnce({
      ...savedState(),
      appState: {
        activeWorktreeId: "wt-main",
        terminals: [
          { id: "t-agent", kind: "terminal", launchAgentId: "claude", agentSessionId: "s-1" },
          { id: "t-back", kind: "terminal", launchAgentId: "claude", agentSessionId: "s-1" },
          { id: "t-listed", kind: "terminal", launchAgentId: "claude" },
        ],
      },
    });
    // t-back was restarted after it was lost; t-listed's own answer says gone, but the list has it.
    reconnectBulk.mockResolvedValueOnce({
      "t-agent": { exists: false },
      "t-back": { exists: true, hasPty: true },
      "t-listed": { exists: false },
    });
    getForProject.mockResolvedValueOnce([
      { id: "t-back", hasPty: true, launchAgentId: "claude", agentSessionId: "s-1", cwd: "/repo" },
      { id: "t-listed", hasPty: true, launchAgentId: "claude", cwd: "/repo" },
    ]);
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({ kind: "terminal", requestedId: "t-listed", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    await relaunchTerminalsLostToHostRestart(
      "proj-1",
      new Map([
        ["t-agent", 0],
        ["t-back", 0],
        ["t-listed", 0],
      ]),
      { isCurrent: () => true, drives: () => true }
    );

    const [saved, ctx] = restorePanelsPhase.mock.calls[0]!;
    expect(saved.map((entry) => entry.id)).toEqual(["t-agent", "t-back", "t-listed"]);
    expect([...ctx.backendTerminalMap.keys()]).toEqual(["t-back", "t-listed"]);
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("hands back what it had to leave once the view stopped driving on the way", async () => {
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({ kind: "terminal", requestedId: "t-agent", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    const outcome = await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => false,
    });

    expect([...outcome.deferred]).toEqual([["t-agent", 2]]);
    expect(outcome).toMatchObject({ relaunched: 0, held: 0 });
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("counts the agents it relaunched apart from those it put back held, and leaves plain shells out", async () => {
    const ids = ["t-a1", "t-a2", "t-held", "t-shell"];
    hydrate.mockResolvedValue({
      ...savedState(),
      appState: {
        activeWorktreeId: "wt-main",
        terminals: ids.map((id) =>
          id === "t-shell"
            ? { id, kind: "terminal" }
            : { id, kind: "terminal", launchAgentId: "claude" }
        ),
      },
    });
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      for (const id of ["t-a1", "t-a2"]) {
        await ctx.addPanel({
          kind: "terminal",
          requestedId: id,
          cwd: "/repo",
          launchAgentId: "claude",
        });
      }
      await ctx.addPanel({
        kind: "terminal",
        requestedId: "t-held",
        cwd: "/repo",
        launchAgentId: "claude",
        restoreRecovery: {
          reason: "host-ended-uncleanly",
          hostEnd: { cause: "watchdog-deadlock", at: 1 },
        },
      });
      await ctx.addPanel({ kind: "terminal", requestedId: "t-shell", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    const outcome = await relaunchTerminalsLostToHostRestart(
      "proj-1",
      new Map(ids.map((id) => [id, 0])),
      { isCurrent: () => true, drives: () => true }
    );

    expect(addPanel).toHaveBeenCalledTimes(4);
    expect(outcome).toMatchObject({ relaunched: 2, held: 1 });
    expect(outcome.deferred.size).toBe(0);
  });

  it("counts nothing the store declined to launch", async () => {
    addPanel.mockResolvedValueOnce(null);
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      await ctx.addPanel({
        kind: "terminal",
        requestedId: "t-agent",
        cwd: "/repo",
        launchAgentId: "claude",
      });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    const outcome = await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ relaunched: 0, held: 0 });
  });

  it("launches nothing once the view no longer drives the project", async () => {
    let driving = true;
    restorePanelsPhase.mockImplementationOnce(async (_saved, ctx) => {
      driving = false;
      await ctx.addPanel({ kind: "terminal", requestedId: "t-agent", cwd: "/repo" });
      return { restoreTasks: [], savedIdToRestoredId: new Map(), ghostedWorktreeIds: new Set() };
    });

    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => driving,
    });

    expect(restorePanelsPhase).toHaveBeenCalledTimes(1);
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("restores nothing from a save that belongs to another workspace, or after the view moved on", async () => {
    hydrate.mockResolvedValueOnce(savedState("proj-2"));
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => true,
      drives: () => true,
    });
    await relaunchTerminalsLostToHostRestart("proj-1", lost, {
      isCurrent: () => false,
      drives: () => true,
    });

    expect(restorePanelsPhase).not.toHaveBeenCalled();
  });
});
