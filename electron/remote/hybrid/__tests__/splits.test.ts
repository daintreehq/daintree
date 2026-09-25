import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  writeText: vi.fn(),
  readShellHydrateFields: vi.fn(() => ({
    safeMode: false,
    gpuWebGLHardware: true,
    systemTmpDir: "/client/tmp",
    keybindingOverrides: { "panel.close": ["Cmd+W"] },
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
        descriptor: { id: "studio", name: "studio-01", sshTarget: "greg@studio-01" },
        connection: { status: "connected" },
        summary: null,
      },
    ]),
    switchWindowHost: vi.fn(async () => undefined),
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
  shell: { openExternal: mocks.openExternal },
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
    terminalConfig: { fontSize: 11, scrollbackLines: 5000 },
    project: { id: "p1", path: "/home/greg/repo" },
    workspaceId: "p1",
    safeMode: true,
    systemTmpDir: "/host/tmp",
    keybindingOverrides: {},
    hostPlatform: "linux",
    hostHomeDir: "/home/greg",
    hostTmpDir: "/tmp",
    projects: [{ id: "p1" }],
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
    expect(result.terminalConfig).toEqual({ fontSize: 15, scrollbackLines: 5000 });
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
      () => ({ fontSize: 9, scrollbackLines: 7000, performanceMode: true }),
      () => ({ fontSize: 14, scrollbackLines: 1000, performanceMode: false })
    );
    await expect(invoke(CHANNELS.TERMINAL_CONFIG_GET, [])).resolves.toEqual({
      fontSize: 14,
      scrollbackLines: 7000,
      performanceMode: true,
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

  it("merges notification settings: policy from the host, sound and presentation from here", async () => {
    const { invoke } = setup(
      () => ({
        enabled: false,
        waitingEnabled: false,
        quietHoursEnabled: true,
        soundEnabled: false,
        completedSoundFile: "host.mp3",
      }),
      () => ({
        enabled: true,
        waitingEnabled: true,
        quietHoursEnabled: false,
        soundEnabled: true,
        completedSoundFile: "local.mp3",
        flashEnabled: true,
      })
    );
    await expect(invoke(CHANNELS.NOTIFICATION_SETTINGS_GET, [])).resolves.toEqual({
      enabled: false,
      waitingEnabled: false,
      quietHoursEnabled: true,
      soundEnabled: true,
      completedSoundFile: "local.mp3",
      flashEnabled: true,
    });
  });

  it("divides a notification settings update between the two machines", async () => {
    const forward = vi.fn(() => undefined);
    const { invoke, listener } = setup(forward, () => undefined);
    await invoke(CHANNELS.NOTIFICATION_SETTINGS_SET, [
      { soundEnabled: false, waitingEnabled: true, quietHoursStartMin: 60 },
    ]);
    expect(listener).toHaveBeenCalledWith(expect.anything(), { soundEnabled: false });
    expect(forward).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SETTINGS_SET, [
      { waitingEnabled: true, quietHoursStartMin: 60 },
    ]);
  });

  it("keeps a sound-only notification settings update on this machine", async () => {
    const forward = vi.fn(() => undefined);
    const { invoke, listener } = setup(forward, () => undefined);
    await invoke(CHANNELS.NOTIFICATION_SETTINGS_SET, [{ flashEnabled: false }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("keeps keep-awake on each machine", async () => {
    const forward = vi.fn();
    const { invoke } = setup(forward, () => ({ enabled: true }));
    await expect(invoke(CHANNELS.KEEP_AWAKE_GET_STATE, [])).resolves.toEqual({ enabled: true });
    expect(forward).not.toHaveBeenCalled();
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
      { hostId: "studio", projectId: "p2", newWindow: false }
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

  it("shows nothing when the host did not switch", async () => {
    const { invoke } = setup(
      () => ({ outcome: "redirected" }),
      () => "local"
    );
    await invoke(CHANNELS.PROJECT_SWITCH, ["p2"]);
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

  it("falls back to Copy host path for an editor with no remote URL", async () => {
    const { invoke } = setup(
      () => ({ preferredEditor: { id: "zed" }, discoveredEditors: [] }),
      () => "local"
    );
    await expect(
      invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, [{ path: "/home/greg/a.ts", projectId: "p1" }])
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(mocks.openExternal).not.toHaveBeenCalled();
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

  it("refuses native pickers and clipboard capture clearly", async () => {
    const forward = vi.fn();
    const { invoke, listener } = setup(forward, () => "local");
    for (const channel of [
      CHANNELS.CLIPBOARD_SAVE_IMAGE,
      CHANNELS.PROJECT_OPEN_DIALOG,
      CHANNELS.PLUGIN_PICK_PATH,
    ]) {
      await expect(invoke(channel, [])).rejects.toMatchObject({ code: "UNSUPPORTED" });
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
