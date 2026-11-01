import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  writeText: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async (_path: string) => ""),
  realpath: vi.fn(async (path: string) => path),
  readShellHydrateFields: vi.fn(() => ({
    safeMode: false,
    gpuWebGLHardware: true,
    systemTmpDir: "/client/tmp",
    keybindingOverrides: { "panel.close": ["Cmd+W"] },
    agentToolbarPins: { pins: { claude: true }, revision: 2 },
    settingsRecovery: null,
  })),
  composeBootResult: vi.fn((hydrate: Record<string, unknown>) => ({
    ...hydrate,
    crashPending: null,
    crashConfig: { autoRestoreOnCrash: false },
  })),
  readHydrateTerminalConfig: vi.fn(() => ({ fontSize: 15, scrollbackLines: 111 })),
  storeGet: vi.fn((key: string) =>
    key === "appState"
      ? { sidebarWidth: 420, terminals: [{ id: "local-term" }], activeWorktreeId: "local-wt" }
      : undefined
  ),
  client: {
    list: vi.fn(() => [
      {
        descriptor: {
          id: "studio",
          name: "studio-01",
          connection: { kind: "ssh", target: "greg@studio-01" },
        },
        connection: { status: "connected" },
        summary: null,
      },
    ]),
    switchWindowHost: vi.fn(
      async (
        _ctx: unknown,
        payload: { hostId: string; projectId: string }
      ): Promise<Record<string, unknown>> => ({
        outcome: "switched",
        hostId: payload.hostId,
        projectId: payload.projectId,
      })
    ),
  },
  hasClient: true,
  cached: false,
  viewSend: vi.fn(),
  pvm: {
    activeKey: null as string | null,
    setPendingFocusIntent: vi.fn(),
    getActiveProjectId: vi.fn((): string | null => null),
    getActiveView: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: undefined,
  shell: {
    openExternal: mocks.openExternal,
    showItemInFolder: mocks.showItemInFolder,
    openPath: mocks.openPath,
  },
  clipboard: { writeText: mocks.writeText },
}));
vi.mock("../../../ipc/handlers/app/state.js", () => ({
  readShellHydrateFields: mocks.readShellHydrateFields,
  composeBootResult: mocks.composeBootResult,
}));
vi.mock("../../../services/AppHydrationService.js", () => ({
  readHydrateTerminalConfig: mocks.readHydrateTerminalConfig,
}));
vi.mock("../../../store.js", () => ({ store: { get: mocks.storeGet } }));
vi.mock("../../../window/projectOwnership.js", () => ({
  hasLiveProjectView: vi.fn(() => mocks.cached),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  resolveLiveWebContents: vi.fn((id: number) => ({ id })),
  getWindowForWebContents: vi.fn(() => ({ id: 1, isDestroyed: () => false })),
}));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => ({
    getByWindowId: () => ({ services: { projectViewManager: mocks.pvm } }),
  }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, realpath: mocks.realpath }, realpath: mocks.realpath };
});
// A WSL host is only ever opened from a Windows Shell, so the launcher's
// deny-list is the one Windows builds: it is chosen when the module loads.
vi.mock("../../../utils/executablePathGuard.js", async (importOriginal) => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await importOriginal();
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }
});
vi.mock("../../runtime.js", () => ({
  getRemoteService: vi.fn((key: string) =>
    key === "remoteHostsClient" && mocks.hasClient ? mocks.client : undefined
  ),
}));

import { wrapError, wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { getChannelLocality } from "../../../ipc/channelLocality.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { IpcDispatcherImpl } from "../../../ipc/dispatcher.js";
import type { HybridSplit, RemoteRouter } from "../../../ipc/endpoint.js";
import { buildRemoteEditorUrl, HYBRID_HOST_LEGS, HYBRID_SPLITS } from "../splits.js";
import { installAccountSignInRequests } from "../../plugins/accountSignIn.js";
import {
  _resetReverseRequestMethodsForTesting,
  answerReverseRequest,
} from "../../client/reverseRequests.js";
import { STORE_KEY_OWNERSHIP } from "../../../storeOwnership.js";

type MergedHydrate = Record<string, unknown> & { appState: Record<string, unknown> };

const REMOTE_SENDER = 5;
const LOCAL_SENDER = 6;

type Forward = (channel: string, args: unknown[]) => unknown;

function setup(forward: Forward, local: (...args: unknown[]) => unknown) {
  const dispatcher = new IpcDispatcherImpl();
  dispatcher.setInvokeEnveloper(async (_channel, _args, call, options) => {
    try {
      const value = await call();
      return options?.verbatim ? (value as IpcEnvelope) : wrapSuccess(value);
    } catch (error) {
      return wrapError(error);
    }
  });
  const router: RemoteRouter = {
    hostForSender: (id) => (id === REMOTE_SENDER ? "studio" : null),
    forwardInvoke: vi.fn(async (_hostId, _wcId, channel, args) => {
      try {
        return wrapSuccess(await forward(channel, args));
      } catch (error) {
        return wrapError(error);
      }
    }),
    forwardSend: vi.fn(),
  };
  dispatcher.setRemoteRouter(router);
  for (const [channel, split] of Object.entries(HYBRID_SPLITS)) {
    dispatcher.registerHybridSplit(channel, split);
  }
  const listener = vi.fn((_event: unknown, ...args: unknown[]) => local(...args));
  const invoke = async (channel: string, args: unknown[], sender = REMOTE_SENDER) => {
    const envelope = await dispatcher.dispatchLocalInvoke(
      channel,
      { sender: { id: sender } } as never,
      args,
      listener as never
    );
    if (!envelope.ok) {
      throw Object.assign(new Error(envelope.error.message), envelope.error);
    }
    return envelope.data;
  };
  return { invoke, router, listener };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasClient = true;
  mocks.cached = false;
  mocks.pvm.getActiveProjectId.mockReturnValue(null);
  mocks.pvm.getActiveView.mockReturnValue(null);
});

describe("hybrid split registry", () => {
  it("registers splits only for hybrid channels", () => {
    for (const channel of Object.keys(HYBRID_SPLITS)) {
      expect(getChannelLocality(channel), channel).toBe("hybrid");
    }
  });

  it("admits every hybrid channel a split's host leg calls", async () => {
    for (const channel of HYBRID_HOST_LEGS) {
      expect(getChannelLocality(channel), channel).toBe("hybrid");
    }
    const called = new Set<string>();
    const hostAnswer: Record<string, unknown> = {
      [CHANNELS.PROJECT_SWITCH]: { outcome: "switched", project: { id: "p1" } },
      [CHANNELS.PROJECT_REOPEN]: { outcome: "switched", project: { id: "p1" } },
      [CHANNELS.EDITOR_GET_CONFIG]: { preferredEditor: null, discoveredEditors: [] },
      [CHANNELS.SCRATCH_SWITCH]: { id: "s1", name: "Scratch", path: "/home/greg/s1" },
    };
    for (const [channel, split] of Object.entries(HYBRID_SPLITS)) {
      await Promise.resolve(
        (split as HybridSplit)({
          hostId: "studio",
          webContentsId: REMOTE_SENDER,
          args: channel === CHANNELS.SYSTEM_OPEN_IN_EDITOR ? [{ path: "/a", projectId: "p1" }] : [],
          local: async () => ({ discoveredEditors: [] }),
          remote: async (remoteChannel) => {
            called.add(remoteChannel ?? channel);
            return hostAnswer[remoteChannel ?? channel] ?? { appState: {}, terminalConfig: {} };
          },
        })
      ).catch(() => undefined);
    }
    for (const channel of called) expect(HYBRID_HOST_LEGS, channel).toContain(channel);
    // The picker split's host leg (pickers.ts) is admitted here too.
    expect(HYBRID_HOST_LEGS).toContain(CHANNELS.SCRATCH_SAVE_AS_PROJECT);
  });
});

describe("log level overrides", () => {
  it("stay on this machine: a remote window's reads and writes never reach the host", async () => {
    const channels = [
      CHANNELS.LOGS_GET_LEVEL_OVERRIDES,
      CHANNELS.LOGS_SET_LEVEL_OVERRIDES,
      CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES,
    ];
    for (const channel of channels) {
      expect(getChannelLocality(channel), channel).toBe("shell");
      expect(HYBRID_SPLITS[channel], channel).toBeUndefined();
      expect(HYBRID_HOST_LEGS, channel).not.toContain(channel);
    }
    expect(STORE_KEY_OWNERSHIP.logLevelOverrides).toBe("device");

    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => ({ "main:*": "debug" }));
    await expect(invoke(CHANNELS.LOGS_GET_LEVEL_OVERRIDES, [])).resolves.toEqual({
      "main:*": "debug",
    });
    await invoke(CHANNELS.LOGS_SET_LEVEL_OVERRIDES, [{ "main:*": "warn" }]);
    await invoke(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES, []);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("app:hydrate and app:boot", () => {
  const hostHydrate = {
    appState: {
      sidebarWidth: 250,
      terminals: [{ id: "host-term" }],
      activeWorktreeId: "host-wt",
      focusMode: true,
    },
    terminalConfig: { fontSize: 11, scrollbackLines: 5000, resourceMonitoringEnabled: true },
    project: { id: "p1", path: "/home/greg/repo" },
    workspaceId: "p1",
    safeMode: true,
    systemTmpDir: "/host/tmp",
    keybindingOverrides: {},
    hostPlatform: "linux",
    hostHomeDir: "/home/greg",
    hostTmpDir: "/tmp",
    projects: [{ id: "p1" }],
    agentDefaults: { assistantAgentId: "codex", defaultAgent: null },
    agentToolbarPins: { pins: { claude: false, gemini: true }, revision: 9 },
  };

  it("takes host fields from the host and Shell fields from here", async () => {
    const forward = vi.fn(() => hostHydrate);
    const { invoke, listener } = setup(forward, () => "local-hydrate");

    const result = (await invoke(CHANNELS.APP_HYDRATE, [])) as MergedHydrate;

    expect(forward).toHaveBeenCalledWith(CHANNELS.APP_HYDRATE, []);
    // The full local hydrate would act on this machine's current project.
    expect(listener).not.toHaveBeenCalled();
    expect(result.project).toEqual(hostHydrate.project);
    expect(result.projects).toEqual(hostHydrate.projects);
    expect(result.hostPlatform).toBe("linux");
    expect(result.hostTmpDir).toBe("/tmp");
    expect(result.safeMode).toBe(false);
    expect(result.systemTmpDir).toBe("/client/tmp");
    expect(result.keybindingOverrides).toEqual({ "panel.close": ["Cmd+W"] });
    expect(result.appState).toMatchObject({
      sidebarWidth: 420,
      terminals: [{ id: "host-term" }],
      activeWorktreeId: "host-wt",
      focusMode: true,
    });
    // Scrollback is how much this screen shows, so it is this machine's (#14697).
    expect(result.terminalConfig).toEqual({
      fontSize: 15,
      scrollbackLines: 111,
      resourceMonitoringEnabled: true,
    });
    // The assistant agent and default agent are the host's (#13345).
    expect(result.agentDefaults).toEqual({ assistantAgentId: "codex", defaultAgent: null });
    // The toolbar is this screen's, so its agent pins are this machine's (#14702).
    expect(result.agentToolbarPins).toEqual({ pins: { claude: true }, revision: 2 });
  });

  it("boots from the host hydrate with this machine's crash gate", async () => {
    const forward = vi.fn(() => hostHydrate);
    const { invoke } = setup(forward, () => "local-boot");

    const result = (await invoke(CHANNELS.APP_BOOT, [])) as MergedHydrate;

    expect(forward).toHaveBeenCalledWith(CHANNELS.APP_HYDRATE, []);
    expect(mocks.composeBootResult).toHaveBeenCalledTimes(1);
    expect(result.crashConfig).toEqual({ autoRestoreOnCrash: false });
    expect(result.appState.sidebarWidth).toBe(420);
  });

  it("leaves a local window's hydrate on the local handler", async () => {
    const forward = vi.fn();
    const { invoke } = setup(forward, () => "local-hydrate");
    await expect(invoke(CHANNELS.APP_HYDRATE, [], LOCAL_SENDER)).resolves.toBe("local-hydrate");
    expect(forward).not.toHaveBeenCalled();
    expect(mocks.readShellHydrateFields).not.toHaveBeenCalled();
  });
});

describe("settings splits", () => {
  it("merges terminal-config:get by field owner", async () => {
    const { invoke } = setup(
      () => ({
        fontSize: 9,
        scrollbackLines: 7000,
        performanceMode: true,
        hybridInputEnabled: false,
        memoryLeakDetectionEnabled: true,
      }),
      () => ({
        fontSize: 14,
        scrollbackLines: 1000,
        performanceMode: false,
        hybridInputEnabled: true,
        memoryLeakDetectionEnabled: false,
      })
    );
    await expect(invoke(CHANNELS.TERMINAL_CONFIG_GET, [])).resolves.toEqual({
      fontSize: 14,
      scrollbackLines: 1000,
      performanceMode: false,
      hybridInputEnabled: true,
      memoryLeakDetectionEnabled: true,
    });
  });

  it("merges app:get-state by field owner", async () => {
    const { invoke } = setup(
      () => ({ sidebarWidth: 1, terminals: ["h"], mruList: ["host"] }),
      () => ({ sidebarWidth: 380, terminals: ["l"], mruList: ["local"], hasSeenWelcome: true })
    );
    await expect(invoke(CHANNELS.APP_GET_STATE, [])).resolves.toEqual({
      sidebarWidth: 380,
      terminals: ["h"],
      mruList: ["host"],
      hasSeenWelcome: true,
    });
  });

  it("divides an app:set-state payload between the two machines", async () => {
    const forward = vi.fn(() => undefined);
    const { invoke, listener } = setup(forward, () => undefined);

    await invoke(CHANNELS.APP_SET_STATE, [
      { sidebarWidth: 300, activeWorktreeId: "wt", terminals: [] },
    ]);

    expect(listener).toHaveBeenCalledWith(expect.anything(), { sidebarWidth: 300 });
    expect(forward).toHaveBeenCalledWith(CHANNELS.APP_SET_STATE, [
      { activeWorktreeId: "wt", terminals: [] },
    ]);
  });

  it("skips the side a set-state payload has nothing for", async () => {
    const forward = vi.fn(() => undefined);
    const { invoke, listener } = setup(forward, () => undefined);
    await invoke(CHANNELS.APP_SET_STATE, [{ hasSeenWelcome: true }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("takes the editor preference from the host and discovery from here", async () => {
    const forward = vi.fn(() => ({
      preferredEditor: { id: "cursor" },
      discoveredEditors: [{ id: "zed", available: true }],
    }));
    const { invoke, listener } = setup(forward, () => ({
      preferredEditor: null,
      discoveredEditors: [{ id: "vscode", available: true }],
    }));
    await expect(invoke(CHANNELS.EDITOR_GET_CONFIG, ["p1"])).resolves.toEqual({
      preferredEditor: { id: "cursor" },
      discoveredEditors: [{ id: "vscode", available: true }],
    });
    expect(listener).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("keeps notification settings on this machine, alert choices included", async () => {
    const forward = vi.fn();
    const local = { enabled: true, waitingEnabled: false, quietHoursEnabled: true };
    const { invoke, listener } = setup(forward, () => local);
    await expect(invoke(CHANNELS.NOTIFICATION_SETTINGS_GET, [])).resolves.toEqual(local);
    await invoke(CHANNELS.NOTIFICATION_SETTINGS_SET, [
      { soundEnabled: false, waitingEnabled: true, quietHoursStartMin: 60 },
    ]);
    expect(listener).toHaveBeenLastCalledWith(expect.anything(), {
      soundEnabled: false,
      waitingEnabled: true,
      quietHoursStartMin: 60,
    });
    expect(forward).not.toHaveBeenCalled();
    // The machine at the keyboard decides which of a host's events alert it (#14701).
    expect(STORE_KEY_OWNERSHIP.notificationSettings).toBe("device");
    expect(HYBRID_HOST_LEGS).not.toContain(CHANNELS.NOTIFICATION_SETTINGS_SET);
  });

  it("keeps keep-awake on each machine", async () => {
    const forward = vi.fn();
    const { invoke } = setup(forward, () => ({ enabled: true }));
    await expect(invoke(CHANNELS.KEEP_AWAKE_GET_STATE, [])).resolves.toEqual({ enabled: true });
    expect(forward).not.toHaveBeenCalled();
    // A remote window edits this machine's value, so the key is this machine's.
    expect(STORE_KEY_OWNERSHIP.keepAwake).toBe("device");
  });

  it("opens a forge page the host builds in this machine's browser", async () => {
    const forward = vi.fn(() => "https://github.com/acme/widgets/pull/7");
    const { invoke, listener } = setup(forward, () => undefined);
    await invoke(CHANNELS.FORGE_OPEN_PR, [{ cwd: "/home/greg/widgets", prNumber: 7 }]);
    expect(forward).toHaveBeenCalledWith(CHANNELS.FORGE_OPEN_PR, [
      { cwd: "/home/greg/widgets", prNumber: 7 },
    ]);
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/7", {
      activate: true,
    });
    expect(HYBRID_HOST_LEGS).toContain(CHANNELS.FORGE_OPEN_PR);
  });

  it("won't open a forge page on a scheme this machine doesn't open", async () => {
    mocks.openExternal.mockClear();
    const { invoke } = setup(
      vi.fn(() => "file:///etc/passwd"),
      () => undefined
    );
    await expect(invoke(CHANNELS.FORGE_OPEN_REPO, [{ cwd: "/home/greg/widgets" }])).rejects.toThrow(
      /not allowed/
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("says so when the host sends no forge page to open", async () => {
    mocks.openExternal.mockClear();
    const { invoke } = setup(
      vi.fn(() => undefined),
      () => undefined
    );
    await expect(invoke(CHANNELS.FORGE_OPEN_ISSUES, ["/home/greg/widgets"])).rejects.toThrow(
      /without a URL/
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("saves a plugin audit export on this machine, never behind a dialog on the host", async () => {
    const forward = vi.fn();
    const { invoke } = setup(forward, () => true);
    await expect(invoke(CHANNELS.PLUGIN_EXPORT_AUDIT_LOG, [[]])).resolves.toBe(true);
    expect(forward).not.toHaveBeenCalled();
    expect(getChannelLocality(CHANNELS.PLUGIN_EXPORT_AUDIT_LOG)).toBe("hybrid");
  });
});

describe("project activation", () => {
  it("activates on the host, then shows the view here", async () => {
    const forward = vi.fn(() => ({ outcome: "switched", project: { id: "p2" } }));
    const { invoke, listener } = setup(forward, () => "local");

    const outgoing = { terminals: [] };
    await expect(invoke(CHANNELS.PROJECT_SWITCH, ["p2", outgoing])).resolves.toEqual({
      outcome: "switched",
      project: { id: "p2" },
    });

    expect(forward).toHaveBeenCalledWith(CHANNELS.PROJECT_SWITCH, ["p2", outgoing]);
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.client.switchWindowHost).toHaveBeenCalledWith(
      expect.objectContaining({ webContentsId: REMOTE_SENDER }),
      { hostId: "studio", projectId: "p2", newWindow: false },
      { failureOnScreen: false }
    );
  });

  it("hands the project's path the host just answered with to the swap, so it isn't asked again", async () => {
    const project = { id: "p2", name: "Two", path: "/home/greg/two" };
    const { invoke } = setup(
      () => ({ outcome: "switched", project }),
      () => "local"
    );
    await invoke(CHANNELS.PROJECT_SWITCH, ["p2", { terminals: [] }]);
    expect(mocks.client.switchWindowHost).toHaveBeenCalledWith(
      expect.objectContaining({ webContentsId: REMOTE_SENDER }),
      { hostId: "studio", projectId: "p2", newWindow: false },
      { failureOnScreen: false, known: { path: "/home/greg/two", name: "Two" } }
    );
  });

  it("tells only the view it lands on that it switched, with the focus intent recorded first", async () => {
    const order: string[] = [];
    mocks.pvm.setPendingFocusIntent.mockImplementation(() => order.push("focus"));
    mocks.client.switchWindowHost.mockImplementationOnce(async () => {
      order.push("swap");
      mocks.pvm.getActiveProjectId.mockReturnValue("studio:p2");
      mocks.pvm.getActiveView.mockReturnValue({
        webContents: { isDestroyed: () => false, send: mocks.viewSend },
      });
      return { outcome: "switched", hostId: "studio", projectId: "p2" };
    });
    mocks.cached = true;
    const { invoke } = setup(
      () => ({ outcome: "switched", project: { id: "p2", name: "Two" } }),
      () => "local"
    );
    const focusIntent = { intent: "focus-panel", panelId: "t1" };

    await invoke(CHANNELS.PROJECT_SWITCH, [
      "p2",
      undefined,
      { focusIntent, trace: { switchId: "sw-1", entryPoint: "palette" } },
    ]);

    expect(order).toEqual(["focus", "swap"]);
    expect(mocks.pvm.setPendingFocusIntent).toHaveBeenCalledWith("studio:p2", focusIntent);
    expect(mocks.viewSend).toHaveBeenCalledWith(CHANNELS.PROJECT_ON_SWITCH, {
      project: { id: "p2", name: "Two" },
      switchId: "sw-1",
      entryPoint: "palette",
      cacheHit: true,
    });
  });

  it("sends no switch event when the window ended up somewhere else", async () => {
    mocks.pvm.getActiveProjectId.mockReturnValue("studio:other");
    const { invoke } = setup(
      () => ({ outcome: "switched", project: { id: "p2" } }),
      () => "local"
    );
    await invoke(CHANNELS.PROJECT_REOPEN, ["p2"]);
    expect(mocks.client.switchWindowHost).toHaveBeenCalled();
    expect(mocks.pvm.getActiveView).not.toHaveBeenCalled();
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("reports a redirect to the window that already had the project", async () => {
    mocks.client.switchWindowHost.mockResolvedValueOnce({
      outcome: "focused-elsewhere",
      hostId: "studio",
      projectId: "p2",
      targetWindowId: 9,
    });
    const { invoke } = setup(
      () => ({ outcome: "switched", project: { id: "p2" } }),
      () => "local"
    );

    // The asking view stays on screen, so it has to hear that it didn't move.
    await expect(invoke(CHANNELS.PROJECT_SWITCH, ["p2"])).resolves.toEqual({
      outcome: "focused-elsewhere",
      project: { id: "p2" },
      targetWindowId: 9,
    });
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("reports a switch a newer navigation overtook", async () => {
    mocks.client.switchWindowHost.mockResolvedValueOnce({
      outcome: "superseded",
      hostId: "studio",
    });
    const { invoke } = setup(
      () => ({ outcome: "switched", project: { id: "p2" } }),
      () => "local"
    );

    await expect(invoke(CHANNELS.PROJECT_SWITCH, ["p2"])).resolves.toEqual({
      outcome: "superseded",
      project: { id: "p2" },
    });
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("shows nothing when the host did not switch", async () => {
    const { invoke } = setup(
      () => ({ outcome: "redirected" }),
      () => "local"
    );
    await invoke(CHANNELS.PROJECT_SWITCH, ["p2"]);
    expect(mocks.client.switchWindowHost).not.toHaveBeenCalled();
  });
});

describe("scratch switch", () => {
  const scratch = { id: "s1", name: "Try it", path: "/home/greg/.daintree/scratches/s1" };

  it("confirms on the host, rebinds the view to the host scratch and tells only that view", async () => {
    const order: string[] = [];
    mocks.pvm.setPendingFocusIntent.mockImplementation(() => order.push("focus"));
    mocks.client.switchWindowHost.mockImplementationOnce(async () => {
      order.push("swap");
      mocks.pvm.getActiveProjectId.mockReturnValue("studio:s1");
      mocks.pvm.getActiveView.mockReturnValue({
        webContents: { isDestroyed: () => false, send: mocks.viewSend },
      });
      return { outcome: "switched", hostId: "studio", projectId: "s1" };
    });
    const forward = vi.fn(() => scratch);
    const { invoke, listener } = setup(forward, () => "local");
    const focusIntent = { intent: "focus-panel", panelId: "t1" };

    await expect(invoke(CHANNELS.SCRATCH_SWITCH, ["s1", { focusIntent }])).resolves.toEqual(
      scratch
    );

    expect(forward).toHaveBeenCalledWith(CHANNELS.SCRATCH_SWITCH, ["s1", { focusIntent }]);
    expect(listener).not.toHaveBeenCalled();
    expect(order).toEqual(["focus", "swap"]);
    expect(mocks.pvm.setPendingFocusIntent).toHaveBeenCalledWith("studio:s1", focusIntent);
    expect(mocks.client.switchWindowHost).toHaveBeenCalledWith(
      expect.objectContaining({ webContentsId: REMOTE_SENDER }),
      { hostId: "studio", projectId: "s1", newWindow: false },
      // Its callers word a failure themselves, so main keeps the report. The
      // host just named the scratch's path, so the swap doesn't ask again.
      {
        requesterReports: false,
        failureOnScreen: false,
        known: { path: scratch.path, name: scratch.name },
      }
    );
    expect(mocks.viewSend).toHaveBeenCalledWith(CHANNELS.SCRATCH_ON_SWITCH, {
      scratch,
      switchId: expect.any(String),
    });
  });

  it("sends no switch event when the window ended up somewhere else", async () => {
    mocks.pvm.getActiveProjectId.mockReturnValue("studio:other");
    const { invoke } = setup(
      () => scratch,
      () => "local"
    );
    await invoke(CHANNELS.SCRATCH_SWITCH, ["s1"]);
    expect(mocks.client.switchWindowHost).toHaveBeenCalled();
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("hands back no scratch when the window didn't move to it", async () => {
    mocks.client.switchWindowHost.mockResolvedValueOnce({
      outcome: "superseded",
      hostId: "studio",
    });
    const { invoke } = setup(
      () => scratch,
      () => "local"
    );

    // The asking view still shows what it showed, so it must not adopt the scratch.
    await expect(invoke(CHANNELS.SCRATCH_SWITCH, ["s1"])).resolves.toBeNull();
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("leaves the view where it is when the host refuses", async () => {
    const { invoke } = setup(
      () => {
        throw new Error("Scratch not found: s1");
      },
      () => "local"
    );
    await expect(invoke(CHANNELS.SCRATCH_SWITCH, ["s1"])).rejects.toThrow("Scratch not found");
    expect(mocks.client.switchWindowHost).not.toHaveBeenCalled();
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("fails as disconnected when the remote hosts client is gone", async () => {
    mocks.hasClient = false;
    const { invoke } = setup(
      () => scratch,
      () => "local"
    );
    await expect(invoke(CHANNELS.SCRATCH_SWITCH, ["s1"])).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(mocks.viewSend).not.toHaveBeenCalled();
  });

  it("leaves a local window's scratch switch on the local handler", async () => {
    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => ({ id: "local-scratch" }));
    await expect(invoke(CHANNELS.SCRATCH_SWITCH, ["s1"], LOCAL_SENDER)).resolves.toEqual({
      id: "local-scratch",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(mocks.client.switchWindowHost).not.toHaveBeenCalled();
  });
});

describe("opening host files", () => {
  it("opens the editor through its SSH remote URL", async () => {
    const forward = vi.fn(() => ({ preferredEditor: { id: "cursor" }, discoveredEditors: [] }));
    const { invoke, listener } = setup(forward, () => "local");

    await invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [
      { path: "/home/greg/repo/src/a b.ts", line: 3, col: 7, projectId: "p1" },
    ]);

    expect(listener).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(CHANNELS.EDITOR_GET_CONFIG, ["p1"]);
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "cursor://vscode-remote/ssh-remote+greg@studio-01/home/greg/repo/src/a%20b.ts:3:7",
      { activate: true }
    );
  });

  it("copies the host path and says so, naming the host, for an editor with no remote URL", async () => {
    const { invoke, listener } = setup(
      () => ({ preferredEditor: { id: "zed" }, discoveredEditors: [] }),
      () => "local"
    );
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [{ path: "/home/greg/a.ts", projectId: "p1" }])
    ).resolves.toEqual({
      outcome: "copied-host-path",
      path: "/home/greg/a.ts",
      hostName: "studio-01",
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.writeText).toHaveBeenCalledWith("/home/greg/a.ts");
    expect(listener).not.toHaveBeenCalled();
  });

  it("copies the host path when no application here handles the editor's remote URL", async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error("no handler"));
    const { invoke } = setup(
      () => ({ preferredEditor: { id: "vscode" }, discoveredEditors: [] }),
      () => "local"
    );
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [{ path: "/home/greg/b.ts", projectId: "p1" }])
    ).resolves.toMatchObject({ outcome: "copied-host-path", path: "/home/greg/b.ts" });
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(mocks.writeText).toHaveBeenCalledWith("/home/greg/b.ts");
  });

  it("copies nothing when the editor opened the file", async () => {
    const { invoke } = setup(
      () => ({ preferredEditor: { id: "vscode" }, discoveredEditors: [] }),
      () => "local"
    );
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [{ path: "/home/greg/c.ts", projectId: "p1" }])
    ).resolves.toBeUndefined();
    expect(mocks.writeText).not.toHaveBeenCalled();
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [{ path: "relative.ts" }])
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("copies the host path instead of revealing it in this machine's file manager", async () => {
    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => "local");
    for (const channel of [
      CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER,
      CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED,
    ]) {
      await invoke(channel, [{ path: "/home/greg/a.ts" }]);
    }
    expect(mocks.writeText).toHaveBeenCalledTimes(2);
    expect(mocks.writeText).toHaveBeenCalledWith("/home/greg/a.ts");
    await expect(
      invoke(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER, [{ path: "relative" }])
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(listener).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("never opens a host path on this machine", async () => {
    const { invoke, listener } = setup(vi.fn(), () => "local");
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_PATH, [{ path: "/home/greg/a.ts" }])
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("studio-01"),
    });
    expect(listener).not.toHaveBeenCalled();
  });

  describe("on a WSL host, whose files are on this PC", () => {
    const sshHosts = mocks.client.list.getMockImplementation()!;
    beforeEach(() => {
      const wslHosts = () => [
        {
          descriptor: {
            id: "studio",
            name: "Ubuntu",
            connection: { kind: "wsl", distro: "Ubuntu-24.04" },
          },
          connection: { status: "connected" },
          summary: null,
        },
      ];
      mocks.client.list.mockImplementation(wslHosts as unknown as typeof sshHosts);
    });
    afterEach(() => {
      mocks.client.list.mockImplementation(sshHosts);
    });

    it("reveals a host path in Explorer through WSL's share", async () => {
      const { invoke, listener } = setup(vi.fn(), () => "local");
      await invoke(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER, [{ path: "/home/dt/repo/a.ts" }]);
      expect(mocks.showItemInFolder).toHaveBeenCalledWith(
        "\\\\wsl.localhost\\Ubuntu-24.04\\home\\dt\\repo\\a.ts"
      );
      expect(mocks.writeText).not.toHaveBeenCalled();
      // A name Windows can't hold is copied instead.
      await invoke(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER, [{ path: "/home/dt/a:b" }]);
      expect(mocks.writeText).toHaveBeenCalledWith("/home/dt/a:b");
      expect(listener).not.toHaveBeenCalled();
    });

    it("opens a host file with this PC's default app, as the preload sends it", async () => {
      const { invoke } = setup(vi.fn(), () => "local");
      await invoke(CHANNELS.SYSTEM_OPEN_PATH, [{ path: "/home/dt/repo/notes.md" }]);
      expect(mocks.openPath).toHaveBeenCalledWith(
        "\\\\wsl.localhost\\Ubuntu-24.04\\home\\dt\\repo\\notes.md"
      );
    });

    it("never runs an executable, named as one or behind a harmless-looking link", async () => {
      const { invoke } = setup(vi.fn(), () => "local");
      for (const path of ["/home/dt/payload.exe", "/home/dt/run.BAT", "/home/dt/x.lnk"]) {
        await expect(invoke(CHANNELS.SYSTEM_OPEN_PATH, [{ path }])).rejects.toMatchObject({
          code: "INVALID_PATH",
        });
      }
      mocks.realpath.mockResolvedValueOnce("\\\\wsl.localhost\\Ubuntu-24.04\\home\\dt\\evil.exe");
      await expect(
        invoke(CHANNELS.SYSTEM_OPEN_PATH, [{ path: "/home/dt/notes.txt" }])
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
      expect(mocks.openPath).not.toHaveBeenCalled();
    });

    it("says why when the file is gone or a link Windows can't follow", async () => {
      mocks.realpath.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      const { invoke } = setup(vi.fn(), () => "local");
      await expect(
        invoke(CHANNELS.SYSTEM_OPEN_PATH, [{ path: "/home/dt/gone.md" }])
      ).rejects.toMatchObject({
        code: "INVALID_PATH",
        userMessage:
          "Couldn't open /home/dt/gone.md from Windows: it isn't on Ubuntu, or it's a link Windows can't follow.",
      });
      expect(mocks.openPath).not.toHaveBeenCalled();
    });

    it("opens the editor through its WSL remote", async () => {
      const forward = vi.fn(() => ({ preferredEditor: { id: "vscode" }, discoveredEditors: [] }));
      const { invoke } = setup(forward, () => "local");
      await invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [
        { path: "/home/dt/repo/a b.ts", line: 3, col: 7, projectId: "p1" },
      ]);
      expect(mocks.openExternal).toHaveBeenCalledWith(
        "vscode://vscode-remote/wsl+Ubuntu-24.04/home/dt/repo/a%20b.ts:3:7",
        { activate: true }
      );
    });
  });

  it("refuses native pickers and clipboard capture clearly", async () => {
    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => "local");
    for (const channel of [CHANNELS.CLIPBOARD_SAVE_IMAGE, CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG]) {
      await expect(invoke(channel, [])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(listener).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("leaves the host-picker channels to the picker splits", async () => {
    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => "local");
    for (const channel of [
      CHANNELS.PROJECT_OPEN_DIALOG,
      CHANNELS.PROJECT_LOCATE,
      CHANNELS.PLUGIN_PICK_PATH,
      CHANNELS.SCRATCH_SAVE_AS_PROJECT,
    ]) {
      expect(HYBRID_SPLITS[channel], channel).toBeUndefined();
      await expect(invoke(channel, [])).rejects.toMatchObject({ code: "CHANNEL_NOT_REMOTABLE" });
    }
    expect(listener).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("builds editor URLs only from safe parts", () => {
    const base = { sshTarget: "studio", path: "/srv/x.ts" };
    expect(buildRemoteEditorUrl({ ...base, editorId: null })).toBe(
      "vscode://vscode-remote/ssh-remote+studio/srv/x.ts"
    );
    expect(buildRemoteEditorUrl({ ...base, editorId: "vscode-insiders", line: 4 })).toBe(
      "vscode-insiders://vscode-remote/ssh-remote+studio/srv/x.ts:4"
    );
    expect(buildRemoteEditorUrl({ ...base, editorId: "vscode", path: "relative.ts" })).toBeNull();
    expect(
      buildRemoteEditorUrl({ ...base, editorId: "vscode", sshTarget: "evil host;rm" })
    ).toBeNull();
    expect(buildRemoteEditorUrl({ ...base, editorId: "neovim" })).toBeNull();
    expect(buildRemoteEditorUrl({ ...base, editorId: "vscode", path: "/srv/a?b#c.ts" })).toBe(
      "vscode://vscode-remote/ssh-remote+studio/srv/a%3Fb%23c.ts"
    );
    expect(buildRemoteEditorUrl({ ...base, editorId: "vscode", line: 0 })).toBeNull();
  });

  it("builds a WSL editor URL with the distro encoded and refuses one that isn't a distro name", () => {
    expect(
      buildRemoteEditorUrl({
        editorId: null,
        wslDistro: "Ubuntu 22.04 LTS",
        path: "/home/a.ts",
        line: 2,
      })
    ).toBe("vscode://vscode-remote/wsl+Ubuntu%2022.04%20LTS/home/a.ts:2");
    expect(
      buildRemoteEditorUrl({ editorId: "cursor", wslDistro: "Debian", path: "/srv/x.ts" })
    ).toBe("cursor://vscode-remote/wsl+Debian/srv/x.ts");
    expect(buildRemoteEditorUrl({ editorId: null, wslDistro: "-d evil", path: "/a" })).toBeNull();
    expect(buildRemoteEditorUrl({ editorId: null, wslDistro: "Debian", path: "a" })).toBeNull();
  });

  it("opens every target the SSH transport accepts, hex-encoding the ones a URI would mangle", () => {
    const hexAuthority = (hostName: string) =>
      `ssh-remote+${Buffer.from(JSON.stringify({ hostName }), "utf8").toString("hex")}`;
    for (const sshTarget of ["dev+prod", "box%1", "me@[bastion]", "user@dev+prod"]) {
      const url = buildRemoteEditorUrl({ editorId: "cursor", sshTarget, path: "/srv/x.ts" });
      expect(url).toBe(`cursor://vscode-remote/${hexAuthority(sshTarget)}/srv/x.ts`);
      const hex = url!.split("ssh-remote+")[1]!.split("/")[0]!;
      expect(JSON.parse(Buffer.from(hex, "hex").toString("utf8"))).toEqual({ hostName: sshTarget });
    }
    expect(
      buildRemoteEditorUrl({ editorId: "windsurf", sshTarget: "me@studio.lan", path: "/a" })
    ).toBe("windsurf://vscode-remote/ssh-remote+me@studio.lan/a");
    // What the transport refuses, the editor never sees either.
    for (const sshTarget of ["-oProxyCommand=x", "host:22", "a b", ""]) {
      expect(buildRemoteEditorUrl({ editorId: "vscode", sshTarget, path: "/a" })).toBeNull();
    }
  });
});

describe("plugin account sign-in from a remote window (#14111)", () => {
  const AUTH_URL =
    "https://auth.example.com/oauth/authorize?response_type=code&client_id=daintree" +
    "&state=synthetic-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
    "&code_challenge_method=S256";
  let loopback: { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    _resetReverseRequestMethodsForTesting();
    loopback = { start: vi.fn(() => new Promise(() => {})), cancel: vi.fn() };
    dispose = installAccountSignInRequests({ loopback: loopback as never });
  });

  afterEach(() => {
    dispose();
    _resetReverseRequestMethodsForTesting();
  });

  const hostAsks = (signInId: unknown) =>
    answerReverseRequest({
      hostId: "studio",
      webContentsId: REMOTE_SENDER,
      method: "plugin.account-sign-in",
      payload: { signInId, pluginId: "acme.tracker", connectionId: "work", authUrl: AUTH_URL },
    });

  /** Connect through the split; `forwarded` holds the args it sent the host. */
  function connect(hostLeg: Promise<unknown>) {
    const forwarded: unknown[][] = [];
    const call = (HYBRID_SPLITS[CHANNELS.PLUGIN_ACCOUNT_CONNECT] as HybridSplit)({
      hostId: "studio",
      webContentsId: REMOTE_SENDER,
      args: ["acme.tracker", "work"],
      local: vi.fn(),
      remote: (_channel, args) => {
        forwarded.push(args ?? []);
        return hostLeg;
      },
    });
    return { call, forwarded };
  }

  it("runs Connect on the host with the click's id, never this machine's own handler", async () => {
    const forward = vi.fn(() => ({ status: "cancelled" }));
    const { invoke, listener } = setup(forward, () => undefined);
    await expect(
      invoke(CHANNELS.PLUGIN_ACCOUNT_CONNECT, ["acme.tracker", "work"])
    ).resolves.toEqual({ status: "cancelled" });
    expect(forward).toHaveBeenCalledWith(CHANNELS.PLUGIN_ACCOUNT_CONNECT, [
      "acme.tracker",
      "work",
      expect.any(String),
    ]);
    expect(listener).not.toHaveBeenCalled();
    expect(HYBRID_HOST_LEGS).toContain(CHANNELS.PLUGIN_ACCOUNT_CONNECT);
  });

  it("opens the browser here only while the window's Connect is in flight", async () => {
    let finish!: (value: unknown) => void;
    const { call, forwarded } = connect(new Promise((resolve) => (finish = resolve)));
    const signInId = forwarded[0]![2];
    void hostAsks(signInId);
    expect(loopback.start).toHaveBeenCalledTimes(1);
    const sessionKey = loopback.start.mock.calls[0]![0];

    finish({ status: "connected" });
    await expect(call).resolves.toEqual({ status: "connected" });
    expect(loopback.cancel).toHaveBeenCalledWith(sessionKey);
    await expect(hostAsks(signInId)).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("takes the loopback down when the link drops under the call", async () => {
    let fail!: (error: Error) => void;
    const { call, forwarded } = connect(new Promise((_resolve, reject) => (fail = reject)));
    const signInId = forwarded[0]![2];
    void hostAsks(signInId);
    const sessionKey = loopback.start.mock.calls[0]![0];

    fail(Object.assign(new Error("link closed"), { code: "OUTCOME_UNKNOWN" }));
    await expect(call).rejects.toThrow("link closed");
    expect(loopback.cancel).toHaveBeenCalledWith(sessionKey);
    await expect(hostAsks(signInId)).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("names each click afresh, so a host can't replay an earlier one", async () => {
    const first = connect(Promise.resolve({ status: "cancelled" }));
    await first.call;
    const second = connect(new Promise(() => {}));
    expect(second.forwarded[0]![2]).not.toBe(first.forwarded[0]![2]);
    await expect(hostAsks(first.forwarded[0]![2])).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).not.toHaveBeenCalled();
  });
});
