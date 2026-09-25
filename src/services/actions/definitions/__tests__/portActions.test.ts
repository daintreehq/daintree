// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const { overview } = vi.hoisted(() => ({
  overview: { registered: false, ok: true },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    has: vi.fn(() => overview.registered),
    dispatch: vi.fn(() => Promise.resolve({ ok: overview.ok })),
  },
}));

import { actionService } from "@/services/ActionService";
import { registerPortActions } from "../portActions";

const forward = vi.fn();

function callbacks(overrides: Partial<ActionCallbacks> = {}): ActionCallbacks {
  return {
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenResumeSessionsPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
    ...overrides,
  };
}

function registry(overrides: Partial<ActionCallbacks> = {}): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerPortActions(actions, callbacks(overrides));
  return actions;
}

function run(actions: ActionRegistry, args?: unknown) {
  return actions.get("host.forwardPort")!().run(args, {} as ActionContext);
}

beforeEach(() => {
  overview.registered = false;
  overview.ok = true;
  vi.mocked(actionService.dispatch).mockClear();
  forward.mockReset();
  forward.mockImplementation(async ({ hostId, remotePort }) => ({
    forwardId: "f1",
    hostId,
    remotePort,
    localPort: 3000,
    origin: "manual",
    label: null,
    createdAt: 1,
  }));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { portForwards: { forward } },
  });
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
});

describe("host.forwardPort", () => {
  it("forwards a port from this window's host and returns the local end", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    await expect(run(registry(), { port: 5173 })).resolves.toEqual({
      forwardId: "f1",
      hostId: "studio-01",
      remotePort: 5173,
      localPort: 3000,
    });
    expect(forward).toHaveBeenCalledWith({
      hostId: "studio-01",
      remotePort: 5173,
      origin: "manual",
    });
  });

  it("needs a host when the window runs on this machine", async () => {
    await expect(run(registry(), { port: 5173 })).rejects.toMatchObject({ code: "VALIDATION" });
    await run(registry(), { port: 8080, hostId: "studio-02", label: "API" });
    expect(forward).toHaveBeenCalledWith({
      hostId: "studio-02",
      remotePort: 8080,
      origin: "manual",
      label: "API",
    });
  });

  it("opens the Ports view in the hosts overview with no args, or Settings → Hosts until it exists", async () => {
    const onOpenSettingsTab = vi.fn();
    await run(registry({ onOpenSettingsTab }));
    expect(actionService.dispatch).not.toHaveBeenCalled();
    expect(onOpenSettingsTab).toHaveBeenCalledWith({ tab: "hosts" });

    overview.registered = true;
    onOpenSettingsTab.mockClear();
    await run(registry({ onOpenSettingsTab }));
    expect(actionService.dispatch).toHaveBeenCalledWith("host.overview.open", undefined, {
      source: "user",
    });
    expect(onOpenSettingsTab).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    await expect(run(registry(), { port: 70000, hostId: "studio-01" })).rejects.toThrow();
    expect(forward).not.toHaveBeenCalled();
  });
});
