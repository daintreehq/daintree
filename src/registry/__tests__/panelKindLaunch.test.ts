import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerPanelKind,
  unregisterPanelKind,
  getPanelKindConfig,
} from "@shared/config/panelKindRegistry";

const addPanelMock = vi.fn();
const panelsByIdRef: { current: Record<string, { location: string }> } = { current: {} };
const actionDispatchMock = vi.fn();

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ addPanel: addPanelMock, panelsById: panelsByIdRef.current }),
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => actionDispatchMock(...args) },
}));

import { launchPanelKind } from "../panelKindLaunch";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";

const PLUGIN_KIND = "test-plugin-launch-kind";

/**
 * The product contract from issue #11668, stated independently of the registry
 * so a wrong value there fails here: routing dev-preview or file-browser
 * through the generic agent path is the bug being fixed.
 */
const expectedLaunchActions = {
  terminal: "agent.launch",
  browser: "agent.launch",
  "dev-preview": "devServer.start",
  "file-browser": "worktree.openFileBrowserPanel",
} as const;

beforeEach(() => {
  addPanelMock.mockReset().mockResolvedValue("panel-1");
  actionDispatchMock.mockReset().mockResolvedValue({ ok: true, result: null });
  panelsByIdRef.current = { "panel-1": { location: "grid" } };
});

afterEach(() => {
  unregisterPanelKind(PLUGIN_KIND);
});

function launch(over: Partial<Parameters<typeof launchPanelKind>[0]> = {}) {
  return launchPanelKind({
    kindId: "file-browser",
    location: "grid",
    cwd: "/repo",
    worktreeId: "wt-1",
    source: "menu",
    ...over,
  });
}

describe("launchPanelKind", () => {
  it("dispatches the action the kind's registry entry names", async () => {
    const outcome = await launch({ kindId: "dev-preview" });

    expect(actionDispatchMock).toHaveBeenCalledTimes(1);
    expect(actionDispatchMock.mock.calls[0]![0]).toBe(
      getPanelKindConfig("dev-preview")!.launchActionId
    );
    expect(addPanelMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ route: "action" });
  });

  it("routes each kind to the action issue #11668 requires", async () => {
    for (const [kindId, actionId] of Object.entries(expectedLaunchActions)) {
      actionDispatchMock.mockClear();
      await launch({ kindId });
      expect(actionDispatchMock.mock.calls[0]![0]).toBe(actionId);
    }
  });

  it("only names actions the app actually registers", () => {
    for (const kindId of Object.keys(expectedLaunchActions)) {
      const actionId = getPanelKindConfig(kindId)!.launchActionId!;
      // A typo here dispatches to nothing and refuses the launch at runtime.
      expect(BUILT_IN_ACTION_IDS).toContain(actionId);
    }
  });

  it("passes the surface's destination to the action", async () => {
    await launch({ kindId: "browser", location: "dock", cwd: "/repo" });

    const [, args, opts] = actionDispatchMock.mock.calls[0]!;
    expect(args).toMatchObject({
      agentId: "browser",
      location: "dock",
      cwd: "/repo",
      activateDockOnCreate: true,
    });
    expect(opts).toEqual({ source: "menu" });
  });

  it("does not ask for dock activation on a grid launch", async () => {
    await launch({ kindId: "browser", location: "grid" });

    expect(actionDispatchMock.mock.calls[0]![1]).toMatchObject({ activateDockOnCreate: false });
  });

  it("never names the surface's worktree as an explicit target", async () => {
    // A launcher's ambient selection is not a named target. `resolveLaunchTarget`
    // keeps an inherited ghost id but makes an explicit one throw (#10812), and
    // `resolveFileBrowserTarget` prefers the focused worktree over the active
    // one — forwarding this would override both.
    await launch({ kindId: "browser", worktreeId: "ghost-wt" });

    expect(actionDispatchMock.mock.calls[0]![1]).not.toHaveProperty("worktreeId");
  });

  it("sends an empty cwd as absent so the action resolves its own", async () => {
    await launch({ kindId: "browser", cwd: "" });

    expect(actionDispatchMock.mock.calls[0]![1]).toMatchObject({ cwd: undefined });
  });

  it("forwards the caller's dispatch source unchanged", async () => {
    await launch({ source: "user" });

    expect(actionDispatchMock.mock.calls[0]![2]).toEqual({ source: "user" });
  });

  it("returns a failed dispatch instead of reporting it", async () => {
    const error = { code: "EXECUTION_ERROR", message: "No folder to browse" };
    actionDispatchMock.mockResolvedValue({ ok: false, error });

    const outcome = await launch();

    expect(outcome).toEqual({
      route: "action",
      actionId: getPanelKindConfig("file-browser")!.launchActionId,
      result: { ok: false, error },
    });
  });

  it("creates a kind with no launch action through addPanel", async () => {
    const outcome = await launch({ kindId: "review" });

    expect(actionDispatchMock).not.toHaveBeenCalled();
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "review",
        cwd: "/repo",
        worktreeId: "wt-1",
        location: "grid",
      })
    );
    expect(outcome).toEqual({ route: "panel", panelId: "panel-1", location: "grid" });
  });

  it("reports where the panel actually landed, not where it was asked to land", async () => {
    panelsByIdRef.current = { "panel-1": { location: "grid" } };

    const outcome = await launch({ kindId: "review", location: "dock" });

    expect(addPanelMock.mock.calls[0]![0]).toMatchObject({ location: "dock" });
    expect(outcome).toMatchObject({ route: "panel", location: "grid" });
  });

  it("reports a refused addPanel without inventing a location", async () => {
    addPanelMock.mockResolvedValue(null);

    const outcome = await launch({ kindId: "review" });

    expect(outcome).toEqual({ route: "panel", panelId: null, location: null });
  });

  it("ignores a launch action a plugin declared for its own kind", async () => {
    registerPanelKind({
      id: PLUGIN_KIND,
      name: "Malicious",
      iconId: "box",
      color: "#fff",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "evil-plugin",
      launchActionId: "worktree.delete",
    });

    const outcome = await launch({ kindId: PLUGIN_KIND });

    expect(actionDispatchMock).not.toHaveBeenCalled();
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: PLUGIN_KIND, location: "grid" })
    );
    expect(outcome).toMatchObject({ route: "panel" });
  });

  it("creates an unregistered kind generically rather than throwing", async () => {
    const outcome = await launch({ kindId: "not-a-registered-kind" });

    expect(actionDispatchMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ route: "panel" });
  });
});
