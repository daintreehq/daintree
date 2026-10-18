// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { HostListEntry } from "@shared/types/remoteHosts";

const { supported, remoteHosts, notify } = vi.hoisted(() => ({
  supported: { value: true },
  remoteHosts: { value: [] as HostListEntry[] },
  notify: vi.fn((_payload: unknown) => "toast"),
}));

vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify,
}));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
}));
vi.mock("@/components/Hosts/hostList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/hostList")>()),
  getHostListSnapshot: () => ({ hosts: remoteHosts.value, localSummary: null }),
}));

import { createActionDefinitions } from "../../actionDefinitions";
import { ClientAppError } from "@/utils/clientAppError";
import { registerHostActions } from "../hostActions";
import { registerPortActions } from "../portActions";
import { usePaletteStore } from "@/store/paletteStore";
import { buildDefaultKeybindings } from "@shared/config/defaultKeybindings";
import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
  registerHostSwitchDialogHost,
  setHostSwitchBusy,
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
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
      assistantControlEnabled: false,
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
const switchWindowHost = vi.fn((_payload: unknown): Promise<unknown> => Promise.resolve());

beforeEach(() => {
  supported.value = true;
  remoteHosts.value = [];
  usePaletteStore.setState({ activePaletteId: null });
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
  it("opens the host switcher palette when called with no host", async () => {
    remoteHosts.value = [host("studio-01")];
    const onOpenSettings = vi.fn();
    const onOpenSettingsTab = vi.fn();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks({ onOpenSettings, onOpenSettingsTab }));
    await run(registry, "host.switch");
    expect(usePaletteStore.getState().activePaletteId).toBe("host-switcher");
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onOpenSettingsTab).not.toHaveBeenCalled();
    expect(switchWindowHost).not.toHaveBeenCalled();
  });

  it("falls through to adding a host while there is no other host to switch to", async () => {
    const onOpenSettings = vi.fn();
    const onOpenSettingsTab = vi.fn();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks({ onOpenSettings, onOpenSettingsTab }));
    await run(registry, "host.switch");
    expect(onOpenSettings.mock.calls.length + onOpenSettingsTab.mock.calls.length).toBe(1);
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("switches directly to a named host, in a new window when asked", async () => {
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await run(registry, "host.switch", { hostId: "studio-01", newWindow: true });
    expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "studio-01", newWindow: true });
    await run(registry, "host.switch", { hostId: "local" });
    expect(switchWindowHost).toHaveBeenLastCalledWith({ hostId: "local", newWindow: false });
  });

  it("presents a failed switch the way the host chip does, and still fails the dispatch", async () => {
    remoteHosts.value = [host("studio-01")];
    switchWindowHost.mockRejectedValueOnce(
      new ClientAppError("HOST_DISCONNECTED", "gone", "Couldn't reach this host.")
    );
    notify.mockClear();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());

    // Automation still hears that the window didn't move.
    await expect(run(registry, "host.switch", { hostId: "studio-01" })).rejects.toThrow();
    const toast = notify.mock.calls[0]![0] as { title: string; actions: Array<{ label: string }> };
    expect(toast.title).toBe("Couldn't switch to studio-01");
    expect(toast.actions.map((action) => action.label)).toEqual(["Retry"]);
    expect(registry.get("host.switch")!().selfNotifiesOnExecutionError).toBe(true);
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

  it("has the dialog ask first when an agent or plugin opens it", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    for (const [dispatchSource, askFirst] of [
      ["agent", true],
      ["plugin", true],
      ["user", false],
    ] as const) {
      await registry.get("project.openOnHost")!().run({ hostId: "studio-01", projectId: "p1" }, {
        projectId: "p1",
        dispatchSource,
      } as ActionContext);
      expect(currentHostSwitchRequest()?.askFirst).toBe(askFirst);
    }
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

  it("goes to the host's copy as it is when asked to only navigate, never handing over a branch", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await registry.get("project.openOnHost")!().run(
      { hostId: "studio-01", projectId: "p1", navigateOnly: true },
      { projectId: "p1", activeWorktreePath: "/repo-worktrees/feature" } as ActionContext
    );
    expect(currentHostSwitchRequest()).toMatchObject({ navigateOnly: true, worktreePath: null });
    // The default stays a branch handover.
    await registry.get("project.openOnHost")!().run({ hostId: "studio-01", projectId: "p1" }, {
      projectId: "p1",
      activeWorktreePath: "/repo-worktrees/feature",
    } as ActionContext);
    expect(currentHostSwitchRequest()).toMatchObject({
      navigateOnly: false,
      worktreePath: "/repo-worktrees/feature",
    });
    releaseHost?.();
  });

  it("leaves a dialog that is part way through a step alone", async () => {
    withDialogHost();
    const registry: ActionRegistry = new Map();
    registerHostActions(registry, callbacks());
    await run(registry, "project.openOnHost", { hostId: "studio-01", projectId: "p1" });
    const running = currentHostSwitchRequest()!;
    setHostSwitchBusy(running.id, true);
    await expect(
      run(registry, "project.openOnHost", { hostId: "studio-01", projectId: "p2" })
    ).rejects.toThrow(/already running/);
    expect(currentHostSwitchRequest()?.id).toBe(running.id);
    setHostSwitchBusy(running.id, false);
    await run(registry, "project.openOnHost", { hostId: "studio-01", projectId: "p2" });
    expect(currentHostSwitchRequest()?.projectId).toBe("p2");
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
