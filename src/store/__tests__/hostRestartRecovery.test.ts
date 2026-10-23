// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelRestoreContext } from "@/utils/stateHydration/panelRestorePhase";

const { restorePanelsPhase, addPanel, getAllWithStatus } = vi.hoisted(() => ({
  restorePanelsPhase: vi.fn(async (_saved: unknown[], _ctx: PanelRestoreContext) => ({
    restoreTasks: [],
    savedIdToRestoredId: new Map(),
    ghostedWorktreeIds: new Set(),
  })),
  addPanel: vi.fn(async (args: { requestedId?: string }) => args.requestedId ?? null),
  getAllWithStatus: vi.fn(async () => ({ worktrees: [], gitBacked: true })),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/utils/stateHydration/panelRestorePhase", () => ({ restorePanelsPhase }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({ addPanel }) } }));
vi.mock("@/store/resourceProfileStore", () => ({
  useResourceProfileStore: { getState: () => ({ profile: "balanced" }) },
}));
vi.mock("@/clients", () => ({ worktreeClient: { getAllWithStatus } }));
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => true }));

import { relaunchTerminalsLostToHostRestart } from "../hostRestartRecovery";

const hydrate = vi.fn();

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
  hydrate.mockResolvedValue(savedState());
  Object.defineProperty(window, "electron", {
    value: { app: { hydrate } },
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
