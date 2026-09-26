// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { HostListEntry } from "@shared/types/remoteHosts";

const { supported, menuAnswers } = vi.hoisted(() => ({
  supported: { value: true },
  menuAnswers: { value: false },
}));

vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => supported.value }));
vi.mock("@/components/Hosts/hostMenuRequests", () => ({
  requestHostMenu: vi.fn(() => menuAnswers.value),
}));

import { createActionDefinitions } from "../../actionDefinitions";
import { registerHostActions } from "../hostActions";
import { registerPortActions } from "../portActions";
import { requestHostMenu } from "@/components/Hosts/hostMenuRequests";
import { buildDefaultKeybindings } from "@shared/config/defaultKeybindings";
import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
  registerHostSwitchDialogHost,
} from "@/components/HostSwitch/hostSwitchRequests";
import {
  _resetHostsOverviewRequestsForTesting,
  isHostsOverviewOpen,
  registerHostsOverviewHost,
} from "@/components/Hosts/Overview/hostsOverviewRequests";

const HOST_ACTION_IDS = ["host.switch", "host.add", "host.overview.open", "project.openOnHost"];

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

function host(id: string): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      sshTarget: id,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

async function run(registry: ActionRegistry, id: string, args?: unknown) {
  const definition = registry.get(id)!();
  return definition.run(args, {} as ActionContext);
}

const list = vi.fn(() => Promise.resolve([host("studio-01")]));
const switchWindowHost = vi.fn(() => Promise.resolve());

beforeEach(() => {
  supported.value = true;
  menuAnswers.value = false;
  vi.mocked(requestHostMenu).mockClear();
  list.mockClear();
  switchWindowHost.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { remoteHosts: { list, switchWindowHost } },
  });
});

describe("host action registration", () => {
  it("registers the host actions where Remote Hosts is supported", () => {
    const registry = createActionDefinitions(callbacks());
    for (const id of HOST_ACTION_IDS) expect(registry.has(id), id).toBe(true);
  });

  it("registers none of them where it isn't, so they never reach the palette or MCP", () => {
    supported.value = false;
    const registry = createActionDefinitions(callbacks());
    for (const id of HOST_ACTION_IDS) expect(registry.has(id), id).toBe(false);
  });

  it("registers nothing from the gated registrars where it isn't, including actions added later", () => {
    const gated: ActionRegistry = new Map();
    registerHostActions(gated, callbacks());
    registerPortActions(gated, callbacks());
    expect([...gated.keys()]).toEqual(
      expect.arrayContaining([...HOST_ACTION_IDS, "host.forwardPort"])
    );
    supported.value = false;
    const registry = createActionDefinitions(callbacks());
    for (const id of gated.keys()) expect(registry.has(id), id).toBe(false);
  });
});

describe("host action visibility", () => {
  it("keeps switching out of the palette and MCP listing while no other host exists", () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    const ctx = {} as ActionContext;
    expect(registry.get("host.switch")!().isVisible?.(ctx)).toBe(false);
    expect(registry.get("project.openOnHost")!().isVisible?.(ctx)).toBe(false);
    expect(registry.get("host.overview.open")!().isVisible?.(ctx)).toBe(false);
    expect(registry.get("host.add")!().isVisible).toBeUndefined();
  });
});

describe("Switch host keybinding", () => {
  it("is bound where Remote Hosts exists and not on Windows, where the action isn't", () => {
    const bound = (isWindows: boolean) =>
      buildDefaultKeybindings(isWindows).some((binding) => binding.actionId === "host.switch");
    expect(bound(false)).toBe(true);
    expect(bound(true)).toBe(false);
  });
});

describe("host.switch", () => {
  it("opens the host menu when called with no host", async () => {
    menuAnswers.value = true;
    const onOpenSettings = vi.fn();
    const onOpenSettingsTab = vi.fn();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks({ onOpenSettings, onOpenSettingsTab }));
    await run(registry, "host.switch");
    expect(requestHostMenu).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onOpenSettingsTab).not.toHaveBeenCalled();
    expect(switchWindowHost).not.toHaveBeenCalled();
  });

  it("falls through to adding a host when there is no host menu to open", async () => {
    const onOpenSettings = vi.fn();
    const onOpenSettingsTab = vi.fn();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks({ onOpenSettings, onOpenSettingsTab }));
    await run(registry, "host.switch");
    expect(onOpenSettings.mock.calls.length + onOpenSettingsTab.mock.calls.length).toBe(1);
  });

  it("switches directly to a named host, in a new window when asked", async () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await run(registry, "host.switch", { hostId: "studio-01", newWindow: true });
    expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "studio-01", newWindow: true });
    await run(registry, "host.switch", { hostId: "local" });
    expect(switchWindowHost).toHaveBeenLastCalledWith({ hostId: "local", newWindow: false });
  });

  it("refuses a host that isn't in the list", async () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await expect(run(registry, "host.switch", { hostId: "nowhere" })).rejects.toThrow(/nowhere/);
    expect(switchWindowHost).not.toHaveBeenCalled();
  });
});

describe("host.overview.open", () => {
  beforeEach(() => _resetHostsOverviewRequestsForTesting());

  it("opens the overview in this view", async () => {
    const release = registerHostsOverviewHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await run(registry, "host.overview.open");
    expect(isHostsOverviewOpen()).toBe(true);
    release();
    expect(isHostsOverviewOpen()).toBe(false);
  });

  it("says so when no view can show it", async () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await expect(run(registry, "host.overview.open")).rejects.toThrow(/hosts overview/);
  });
});

describe("project.openOnHost", () => {
  let releaseHost: (() => void) | null = null;

  beforeEach(() => {
    _resetHostSwitchRequestsForTesting();
    releaseHost = null;
  });

  function withDialogHost(): void {
    releaseHost = registerHostSwitchDialogHost();
  }

  it("opens the switch dialog for the window's project, with its active worktree", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    const definition = registry.get("project.openOnHost")!();
    await definition.run({ hostId: "studio-01", projectId: "p1" }, {
      projectId: "p1",
      activeWorktreePath: "/repo-worktrees/feature",
    } as ActionContext);
    expect(currentHostSwitchRequest()).toMatchObject({
      toHostId: "studio-01",
      projectId: "p1",
      worktreePath: "/repo-worktrees/feature",
    });
    expect(switchWindowHost).not.toHaveBeenCalled();
    releaseHost?.();
  });

  it("carries a placed worktree and the new-window choice into the dialog, and names the request", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    const worktree = {
      newBranch: "feature/placed",
      baseBranch: "main",
      fromRemote: false,
      useExistingBranch: false,
      relativePath: "../repo-worktrees/feature-placed",
      recipeId: "setup",
    };
    const result = await registry.get("project.openOnHost")!().run(
      { hostId: "studio-01", projectId: "p1", newWindow: true, worktree },
      { projectId: "p1" } as ActionContext
    );
    const request = currentHostSwitchRequest()!;
    expect(request).toMatchObject({ toHostId: "studio-01", newWindow: true, worktree });
    expect(result).toEqual({ requestId: request.id });
    releaseHost?.();
  });

  it("uses the project folder for a project other than the window's", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await registry.get("project.openOnHost")!().run({ hostId: "studio-01", projectId: "p2" }, {
      projectId: "p1",
      activeWorktreePath: "/elsewhere",
    } as ActionContext);
    expect(currentHostSwitchRequest()?.worktreePath).toBeNull();
    releaseHost?.();
  });

  it("refuses a host that isn't in the list, and the window's own host", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await expect(
      run(registry, "project.openOnHost", { hostId: "nowhere", projectId: "p1" })
    ).rejects.toThrow(/nowhere/);
    await expect(
      run(registry, "project.openOnHost", { hostId: "local", projectId: "p1" })
    ).rejects.toThrow(/already on that host/);
    expect(currentHostSwitchRequest()).toBeNull();
    releaseHost?.();
  });

  it("says so when no view can show the dialog", async () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await expect(
      run(registry, "project.openOnHost", { hostId: "studio-01", projectId: "p1" })
    ).rejects.toThrow(/dialog/);
  });
});
