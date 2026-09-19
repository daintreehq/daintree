/**
 * #12514: a cached view demotes its terminals to "background" through the
 * activity-tier IPC, and the pty-host keeps one cadence per terminal (last
 * writer wins). The same project can be open in two windows, so a cached view
 * must not demote terminals another window is still showing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => null) },
}));

const { cachedViewIds, viewsByProject } = vi.hoisted(() => ({
  cachedViewIds: new Set<number>(),
  viewsByProject: new Map<string, number[]>(),
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn((projectId: string) =>
    (viewsByProject.get(projectId) ?? []).map((id) => ({ id }))
  ),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn((id: number) => cachedViewIds.has(id)),
}));

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: vi.fn(),
  releaseTerminalWorkerPort: vi.fn(),
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

/** Window A shows project P; window B has P cached behind another project. */
const VISIBLE_P = 101;
const CACHED_P = 202;

const TERMINAL_PROJECTS = new Map<string, string | null>([
  ["term-p", "project-p"],
  ["term-unowned", null],
]);

const setActivityTier = vi.fn();
const getTerminalProjectId = vi.fn((id: string) => TERMINAL_PROJECTS.get(id) ?? null);

function setTier(
  senderId: number,
  payload: { id: string; tier: "active" | "background"; pollingIntervalMs?: number }
): void {
  const call = ipcMainMock.on.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_SET_ACTIVITY_TIER
  );
  if (!call) throw new Error("activity-tier handler was never registered");
  const handler = call[1] as (...args: unknown[]) => void;
  handler({ sender: { id: senderId } }, payload);
}

describe("terminal activity tier — cached sender with a visible sibling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    cachedViewIds.clear();
    cachedViewIds.add(CACHED_P);
    viewsByProject.clear();
    viewsByProject.set("project-p", [VISIBLE_P, CACHED_P]);

    registerTerminalIOHandlers({
      ptyClient: { setActivityTier, getTerminalProjectId },
    } as unknown as HandlerDependencies);
  });

  it("drops a cached view's demotion while another window shows the project", () => {
    setTier(CACHED_P, { id: "term-p", tier: "background", pollingIntervalMs: 1000 });

    expect(setActivityTier).not.toHaveBeenCalled();
  });

  it("forwards a cached view's demotion once no other view of the project is visible", () => {
    cachedViewIds.add(VISIBLE_P);

    setTier(CACHED_P, { id: "term-p", tier: "background", pollingIntervalMs: 1000 });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", 1000);
  });

  it("forwards a cached view's demotion when it is the project's only view", () => {
    viewsByProject.set("project-p", [CACHED_P]);

    setTier(CACHED_P, { id: "term-p", tier: "background" });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", undefined);
  });

  it("forwards a demotion from a view that is not cached", () => {
    setTier(VISIBLE_P, { id: "term-p", tier: "background", pollingIntervalMs: 200 });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", 200);
  });

  it("forwards a promotion from a cached view", () => {
    setTier(CACHED_P, { id: "term-p", tier: "active" });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "active", undefined);
  });

  it("forwards a cached view's demotion of a terminal with no known project", () => {
    setTier(CACHED_P, { id: "term-unowned", tier: "background" });

    expect(getTerminalProjectId).toHaveBeenCalledWith("term-unowned");
    expect(setActivityTier).toHaveBeenCalledWith("term-unowned", "background", undefined);
  });
});
