import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const calls: string[] = [];
  const record = (name: string): void => {
    calls.push(name);
  };

  type Listener<T> = (value: T) => void;
  const server = {
    sessionListeners: new Set<Listener<unknown>>(),
    expiredListeners: new Set<Listener<unknown>>(),
    listen: vi.fn(async () => record("server.listen")),
    close: vi.fn(async () => record("server.close")),
    onSession: vi.fn((l: Listener<unknown>) => {
      server.sessionListeners.add(l);
      return () => server.sessionListeners.delete(l);
    }),
    onSessionExpired: vi.fn((l: Listener<unknown>) => {
      server.expiredListeners.add(l);
      return () => server.expiredListeners.delete(l);
    }),
    onSessionDetached: vi.fn(() => () => undefined),
  };

  const openedListeners = new Set<(endpoint: unknown, handle: unknown) => void>();
  const transportListeners = new Set<(endpointIds: string[], attached: boolean) => void>();
  const sessionHost = {
    onEndpointOpened: vi.fn((l: (endpoint: unknown, handle: unknown) => void) => {
      openedListeners.add(l);
      return () => openedListeners.delete(l);
    }),
    onTransportChange: vi.fn((l: (endpointIds: string[], attached: boolean) => void) => {
      transportListeners.add(l);
      return () => transportListeners.delete(l);
    }),
  };

  const clientOpenedListeners = new Set<(hostId: string, info: unknown) => void>();
  const clientClosedListeners = new Set<(hostId: string, info: unknown) => void>();
  const sessionAttachedListeners = new Set<(hostId: string, info: { resumed: boolean }) => void>();
  const viewHosts = new Map<number, string>();
  const clientHooks: {
    current: {
      onFirstUse?: () => void;
      onRemoteViewActivated?: (windowId: number, wc: unknown, isNew: boolean) => void;
      onLocalViewActivated?: (windowId: number, wc: unknown) => void;
    };
  } = { current: {} };
  const hostEntries: Array<{
    descriptor: { id: string; connection: { kind: "ssh"; target: string } };
  }> = [];
  const client = {
    client: {
      connect: vi.fn(),
      openHostForNotice: vi.fn(async (_window: unknown, _notice: unknown) => ({})),
      list: vi.fn(() => hostEntries),
      isDisconnectedByPerson: vi.fn((hostId: string) => hostId === "control-on"),
    },
    sessionFor: vi.fn((_hostId: string) => null as unknown),
    onEndpointOpened: vi.fn((l: (hostId: string, info: unknown) => void) => {
      clientOpenedListeners.add(l);
      return () => clientOpenedListeners.delete(l);
    }),
    onEndpointClosed: vi.fn((l: (hostId: string, info: unknown) => void) => {
      clientClosedListeners.add(l);
      return () => clientClosedListeners.delete(l);
    }),
    hostForView: (id: number) => viewHosts.get(id) ?? null,
    manager: {
      onSessionOpened: vi.fn((_l: unknown) => () => {}),
      onSessionAttached: vi.fn((l: (hostId: string, info: { resumed: boolean }) => void) => {
        sessionAttachedListeners.add(l);
        return () => sessionAttachedListeners.delete(l);
      }),
      touch: vi.fn((_hostId: string) => {}),
      hold: vi.fn((_hostId: string) => () => {}),
      addUseCheck: vi.fn((_check: unknown) => () => {}),
      onStateChange: vi.fn((_l: unknown) => () => {}),
    },
    registry: {
      get: vi.fn(
        (hostId: string) =>
          ({ "control-on": { assistantControlEnabled: true, name: "studio-01" } })[hostId] ?? null
      ),
      list: vi.fn(() => [{ id: "control-on" }]),
      onChange: vi.fn((_l: unknown) => () => {}),
    },
    router: { name: "router" },
    emitLocal: vi.fn((_event: unknown) => {}),
    dispose: vi.fn(async () => record("client.dispose")),
  };
  const leaseListeners = new Set<(state: unknown) => void>();
  const lease = {
    noteEndpointClient: vi.fn(),
    noteEndpointTransport: vi.fn(),
    noteSessionChange: vi.fn(),
    getDriveTarget: vi.fn((_projectId: string) => ({ kind: "vacant" }) as unknown),
    onChange: vi.fn((l: (state: unknown) => void) => {
      leaseListeners.add(l);
      return () => leaseListeners.delete(l);
    }),
  };
  const viewFilter: { current: ((id: number, ch: string, args: unknown[]) => boolean) | null } = {
    current: null,
  };
  const mcpResolver: {
    current: ((projectId: string, change?: { linkSessionId: string | null }) => unknown) | null;
  } = { current: null };
  const remoteViewHooks: { current: unknown } = { current: null };

  return {
    calls,
    record,
    server,
    sessionHost,
    openedListeners,
    transportListeners,
    client,
    lease,
    leaseListeners,
    viewFilter,
    mcpResolver,
    installHybridSplits: vi.fn(() => {
      record("install hybrid splits");
      return vi.fn();
    }),
    uninstallPickerSplits: vi.fn(() => record("uninstall picker splits")),
    uninstallHostFileClient: vi.fn(() => record("uninstall host file client")),
    installHostFileClient: vi.fn(),
    installHostUploadClient: vi.fn(),
    uninstallHostUploadClient: vi.fn(() => record("uninstall host upload client")),
    installClipboardSplits: vi.fn(() => record("install clipboard splits")),
    uninstallClipboardSplits: vi.fn(() => record("uninstall clipboard splits")),
    installHostUploadService: vi.fn(),
    hostUploadsDispose: vi.fn(() => record("host uploads dispose")),
    attachHostUploads: vi.fn(),
    hostEntries,
    installPluginClient: vi.fn(),
    uninstallPluginClient: vi.fn(() => record("uninstall plugin client")),
    installPortForwardClient: vi.fn(),
    uninstallPortForwardClient: vi.fn(() => record("uninstall port forward client")),
    installHostSwitchService: vi.fn(),
    uninstallHostSwitchService: vi.fn(() => record("uninstall host switch service")),
    installHostPortService: vi.fn(),
    uninstallHostPortService: vi.fn(() => record("uninstall host port service")),
    installProjectsHost: vi.fn(),
    uninstallProjectsHost: vi.fn(() => record("uninstall projects host")),
    installPluginHost: vi.fn(),
    installPluginParityClient: vi.fn(),
    uninstallPluginParityClient: vi.fn(() => record("uninstall plugin parity client")),
    installPluginInstallSplits: vi.fn(() => record("install plugin install splits")),
    uninstallPluginInstallSplits: vi.fn(() => record("uninstall plugin install splits")),
    installPluginParityHost: vi.fn(),
    uninstallPluginParityHost: vi.fn(() => record("uninstall plugin parity host")),
    installSettingsCopyClient: vi.fn(),
    uninstallSettingsCopyClient: vi.fn(() => record("uninstall settings copy client")),
    installSettingsCopyHost: vi.fn(),
    uninstallSettingsCopyHost: vi.fn(() => record("uninstall settings copy host")),
    installSettingsControlClient: vi.fn(),
    uninstallSettingsControlClient: vi.fn(() => record("uninstall settings control client")),
    installSettingsControlHost: vi.fn(),
    uninstallSettingsControlHost: vi.fn(() => record("uninstall settings control host")),
    uninstallPluginHost: vi.fn(() => record("uninstall plugin host")),
    attachHostPluginAssets: vi.fn(),
    hostFilesDispose: vi.fn(() => record("host files dispose")),
    installHostFileService: vi.fn(),
    attachHostFiles: vi.fn(),
    admitHybridHostLegs: vi.fn(() => vi.fn()),
    installNotificationPolicyPush: vi.fn(() => vi.fn()),
    installNotificationPolicyHost: vi.fn(() => vi.fn()),
    acceptLocalPushForRemoteView: vi.fn((channel: string) => channel === "shell:ok"),
    releaseHostNotifications: vi.fn(),
    uninstallViewRequests: vi.fn(),
    uninstallWorktreeRedelivery: vi.fn(),
    clientOpenedListeners,
    clientClosedListeners,
    sessionAttachedListeners,
    viewHosts,
    clientHooks,
    remoteViewHooks,
    HostServer: vi.fn(function HostServer() {
      record("new HostServer");
      return server;
    }),
    initRemoteHostsHost: vi.fn(() => {
      record("initRemoteHostsHost");
      return { sessionHost, dispose: vi.fn(() => record("host.dispose")) };
    }),
    initRemoteHostsClient: vi.fn((hooks: typeof clientHooks.current = {}) => {
      record("initRemoteHostsClient");
      clientHooks.current = hooks;
      return client;
    }),
    attachTerminalBridge: vi.fn(),
    detachTerminalBridge: vi.fn(),
    disposeAllTerminalBridges: vi.fn(() => record("disposeAllTerminalBridges")),
    attachWorktreePortBridge: vi.fn(),
    detachWorktreePortBridge: vi.fn(),
    attachClientTerminalRelay: vi.fn(),
    attachClientWorktreeRelay: vi.fn(),
    detachClientTerminalRelayFor: vi.fn(),
    detachClientWorktreeRelayFor: vi.fn(),
    disposeAllClientTerminalRelays: vi.fn(() => record("dispose terminal relays")),
    disposeAllClientWorktreeRelays: vi.fn(() => record("dispose worktree relays")),
    redeliverClientWorktreePort: vi.fn(),
    releaseWindowTerminalPort: vi.fn(),
    installTerminalOverride: vi.fn(),
    installWorktreeOverride: vi.fn(),
    uninstallHooks: vi.fn(() => {
      record("uninstall view hooks");
      remoteViewHooks.current = null;
    }),
    uninstallTerminal: vi.fn(() => record("uninstall terminal override")),
    uninstallWorktree: vi.fn(() => record("uninstall worktree override")),
    statsPush: vi.fn(),
    fleetPush: vi.fn(),
    runHistoryPush: vi.fn(),
    isWorkspaceClientStarting: vi.fn(() => false),
    ensureWorkspaceClient: vi.fn(async () => ({})),
    resolveLiveWebContents: vi.fn((id: number) => ({ id })),
    visibility: {
      noteEndpointOpened: vi.fn(),
      noteEndpointClosed: vi.fn(),
      noteViewActivated: vi.fn(),
      noteWindowClosed: vi.fn(),
    },
    /** What each fake window's cleanup was handed, by window id. */
    windowCleanups: [] as Array<[number, { dispose(): void }]>,
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-user-data", getVersion: () => "0.0.0", isPackaged: false },
}));
vi.mock("../../boot/hostServices.js", () => ({
  ensureWorkspaceClient: m.ensureWorkspaceClient,
  isWorkspaceClientStarting: m.isWorkspaceClientStarting,
}));
vi.mock("../../ipc/handlers/projectCrud/index.js", () => ({
  getProjectStatsService: () => ({ pushSnapshotToEndpoint: m.statsPush }),
  getFleetSnapshotService: () => ({ pushSnapshotToEndpoint: m.fleetPush }),
}));
vi.mock("../../services/runHistory/runHistoryService.js", () => ({
  pushRunHistorySnapshotToEndpoint: m.runHistoryPush,
}));
vi.mock("../../window/webContentsRegistry.js", () => ({
  resolveLiveWebContents: m.resolveLiveWebContents,
}));
vi.mock("../../window/portDistribution.js", () => ({
  releaseWindowTerminalPort: m.releaseWindowTerminalPort,
  setRemoteViewHooks: vi.fn((hooks: unknown) => {
    m.remoteViewHooks.current = hooks;
    return m.uninstallHooks;
  }),
}));
vi.mock("../../window/serviceRefs.js", () => ({ getPtyClient: () => ({ pty: true }) }));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: () => ({
    getByWindowId: (id: number) => ({
      windowId: id,
      cleanup: { add: (d: { dispose(): void }) => m.windowCleanups.push([id, d]) },
    }),
  }),
}));
vi.mock("../client/initClient.js", () => ({
  initRemoteHostsClient: m.initRemoteHostsClient,
  setRemoteHostsWindowOpener: vi.fn(),
}));
vi.mock("../handshakeInfo.js", () => ({ getLocalHandshakeInfo: () => ({ version: "test" }) }));
vi.mock("../host/HostServer.js", () => ({ HostServer: m.HostServer }));
vi.mock("../host/initHost.js", () => ({ initRemoteHostsHost: m.initRemoteHostsHost }));
vi.mock("../terminal/clientAttach.js", () => ({
  attachClientTerminalRelay: m.attachClientTerminalRelay,
  detachClientTerminalRelayFor: m.detachClientTerminalRelayFor,
  disposeAllClientTerminalRelays: m.disposeAllClientTerminalRelays,
  installClientTerminalPortOverride: vi.fn((hostForView: unknown) => {
    m.installTerminalOverride(hostForView);
    return m.uninstallTerminal;
  }),
}));
vi.mock("../terminal/hostAttach.js", () => ({
  attachTerminalBridge: m.attachTerminalBridge,
  detachTerminalBridge: m.detachTerminalBridge,
  disposeAllTerminalBridges: m.disposeAllTerminalBridges,
}));
vi.mock("../worktreePort/attach.js", () => ({
  attachWorktreePortBridge: m.attachWorktreePortBridge,
  detachWorktreePortBridge: m.detachWorktreePortBridge,
  attachClientWorktreeRelay: m.attachClientWorktreeRelay,
  detachClientWorktreeRelayFor: m.detachClientWorktreeRelayFor,
  disposeAllClientWorktreeRelays: m.disposeAllClientWorktreeRelays,
  redeliverClientWorktreePort: m.redeliverClientWorktreePort,
  installWorktreePortRedelivery: vi.fn(() => m.uninstallWorktreeRedelivery),
  installClientWorktreePortOverride: vi.fn((hostForView: unknown) => {
    m.installWorktreeOverride(hostForView);
    return m.uninstallWorktree;
  }),
}));

vi.mock("../../ipc/utils.js", () => ({
  setRemoteBoundViewFilter: vi.fn((filter: (id: number, ch: string, a: unknown[]) => boolean) => {
    m.viewFilter.current = filter;
    return () => {
      m.viewFilter.current = null;
    };
  }),
}));
vi.mock("../../services/DriveLeaseService.js", () => ({
  getDriveLeaseService: () => m.lease,
  createDriveLeaseGate: () => () => null,
}));
vi.mock("../../services/mcp-server/driveTarget.js", () => ({
  setMcpDriveTargetResolver: vi.fn((resolver: typeof m.mcpResolver.current) => {
    m.mcpResolver.current = resolver;
    return () => {
      m.mcpResolver.current = null;
    };
  }),
  notifyMcpDriveTargetChange: vi.fn(),
}));
vi.mock("../hybrid/index.js", () => ({
  installHybridSplits: m.installHybridSplits,
  admitHybridHostLegs: m.admitHybridHostLegs,
  installNotificationPolicyPush: m.installNotificationPolicyPush,
  installNotificationPolicyHost: m.installNotificationPolicyHost,
  acceptLocalPushForRemoteView: m.acceptLocalPushForRemoteView,
  releaseHostNotifications: m.releaseHostNotifications,
  ViewVisibilityReporter: vi.fn(function ViewVisibilityReporter() {
    return m.visibility;
  }),
}));
vi.mock("../hybrid/pickers.js", () => ({
  installPickerSplits: vi.fn(() => m.uninstallPickerSplits),
}));
vi.mock("../files/clientInstall.js", () => ({
  installHostFileClient: vi.fn((feed: unknown, hostForView: unknown) => {
    m.installHostFileClient(feed, hostForView);
    return m.uninstallHostFileClient;
  }),
}));
vi.mock("../files/uploadClient.js", () => ({
  installHostUploadClient: vi.fn((feed: unknown, hostForView: unknown) => {
    m.installHostUploadClient(feed, hostForView);
    return m.uninstallHostUploadClient;
  }),
}));
vi.mock("../hybrid/clipboard.js", () => ({
  installClipboardSplits: vi.fn(() => {
    m.installClipboardSplits();
    return m.uninstallClipboardSplits;
  }),
}));
vi.mock("../files/uploadHostInstall.js", () => ({
  installHostUploadService: vi.fn(() => {
    m.installHostUploadService();
    return { service: {}, dispose: m.hostUploadsDispose };
  }),
  attachHostUploads: m.attachHostUploads,
}));
vi.mock("../files/hostInstall.js", () => ({
  installHostFileService: vi.fn(() => {
    m.installHostFileService();
    return { service: {}, dispose: m.hostFilesDispose };
  }),
  attachHostFiles: m.attachHostFiles,
}));
vi.mock("../plugins/install.js", () => ({
  installPluginClient: vi.fn((feed: unknown) => {
    m.installPluginClient(feed);
    return m.uninstallPluginClient;
  }),
  installPluginHost: vi.fn(() => {
    m.installPluginHost();
    return m.uninstallPluginHost;
  }),
  attachHostPluginAssets: m.attachHostPluginAssets,
}));
vi.mock("../plugins/parity/install.js", () => ({
  installPluginParityClient: vi.fn((deps: unknown) => {
    m.installPluginParityClient(deps);
    return m.uninstallPluginParityClient;
  }),
  installPluginInstallSplits: vi.fn(() => {
    m.installPluginInstallSplits();
    return m.uninstallPluginInstallSplits;
  }),
  installPluginParityHost: vi.fn((server: unknown) => {
    m.installPluginParityHost(server);
    return m.uninstallPluginParityHost;
  }),
}));
vi.mock("../settingsCopy/install.js", () => ({
  installSettingsCopyClient: vi.fn((deps: unknown) => {
    m.installSettingsCopyClient(deps);
    return m.uninstallSettingsCopyClient;
  }),
  installSettingsCopyHost: vi.fn((server: unknown) => {
    m.installSettingsCopyHost(server);
    return m.uninstallSettingsCopyHost;
  }),
}));
vi.mock("../settingsControl/install.js", () => ({
  installSettingsControlClient: vi.fn((deps: unknown) => {
    m.installSettingsControlClient(deps);
    return m.uninstallSettingsControlClient;
  }),
  installSettingsControlHost: vi.fn((server: unknown) => {
    m.installSettingsControlHost(server);
    return m.uninstallSettingsControlHost;
  }),
}));
vi.mock("../ports/clientInstall.js", () => ({
  installPortForwardClient: vi.fn((deps: unknown) => {
    m.installPortForwardClient(deps);
    return m.uninstallPortForwardClient;
  }),
}));
vi.mock("../ports/hostPorts.js", () => ({
  installHostPortService: vi.fn((server: unknown) => {
    m.installHostPortService(server);
    return m.uninstallHostPortService;
  }),
}));
vi.mock("../projects/clientInstall.js", () => ({
  installHostSwitchService: vi.fn((deps: unknown) => {
    m.installHostSwitchService(deps);
    return m.uninstallHostSwitchService;
  }),
}));
vi.mock("../projects/hostInstall.js", () => ({
  installProjectsHost: vi.fn((server: unknown) => {
    m.installProjectsHost(server);
    return m.uninstallProjectsHost;
  }),
}));
const metrics = vi.hoisted(() => ({
  installHostMetricsClient: vi.fn((_options: unknown) => () => {}),
  installHostMetricsHost: vi.fn(async (_server: unknown) => () => {}),
}));
vi.mock("../metrics/clientInstall.js", () => ({
  installHostMetricsClient: metrics.installHostMetricsClient,
}));
vi.mock("../metrics/hostMetricsHost.js", () => ({
  installHostMetricsHost: metrics.installHostMetricsHost,
  installLinkActivityHost: vi.fn((_server: unknown, _read: unknown) => () => {}),
  installProcessInventoryHost: vi.fn((_server: unknown, _read: unknown) => () => {}),
}));
const canopy = vi.hoisted(() => ({
  installCanopyHostsClient: vi.fn((_options: unknown) => () => {}),
  installCanopyHost: vi.fn((_server: unknown) => () => {}),
}));
vi.mock("../canopy/clientInstall.js", () => ({
  installCanopyHostsClient: canopy.installCanopyHostsClient,
}));
vi.mock("../canopy/hostInstall.js", () => ({
  installCanopyHost: canopy.installCanopyHost,
}));
const deviceAnswer = vi.hoisted(() => ({
  uninstallClient: vi.fn(),
  uninstallHost: vi.fn(),
  installDeviceAnswerHostsClient: vi.fn(),
  installDeviceAnswerHost: vi.fn(),
}));
vi.mock("../deviceAnswer/clientInstall.js", () => ({
  installDeviceAnswerHostsClient: vi.fn((deps: unknown) => {
    deviceAnswer.installDeviceAnswerHostsClient(deps);
    return deviceAnswer.uninstallClient;
  }),
}));
vi.mock("../deviceAnswer/hostInstall.js", () => ({
  installDeviceAnswerHost: vi.fn((server: unknown) => {
    deviceAnswer.installDeviceAnswerHost(server);
    return deviceAnswer.uninstallHost;
  }),
}));
const voicePane = vi.hoisted(() => ({
  uninstallClient: vi.fn(),
  uninstallHost: vi.fn(),
  installVoicePaneHostsClient: vi.fn(),
  installVoicePaneHost: vi.fn(),
}));
vi.mock("../voice/clientInstall.js", () => ({
  installVoicePaneHostsClient: vi.fn((deps: unknown) => {
    voicePane.installVoicePaneHostsClient(deps);
    return voicePane.uninstallClient;
  }),
}));
vi.mock("../voice/hostInstall.js", () => ({
  installVoicePaneHost: vi.fn((server: unknown) => {
    voicePane.installVoicePaneHost(server);
    return voicePane.uninstallHost;
  }),
}));
const control = vi.hoisted(() => {
  const uninstall = vi.fn();
  const uninstallLink = vi.fn();
  const uninstallSenderHost = vi.fn();
  return {
    uninstall,
    uninstallLink,
    uninstallSenderHost,
    installHostControl: vi.fn((_deps: unknown) => uninstall),
    installHostControlLinkClient: vi.fn((_deps: unknown) => uninstallLink),
    installAssistantSenderHost: vi.fn(async (_server: unknown) => uninstallSenderHost),
  };
});
vi.mock("../assistant/install.js", () => ({
  installHostControl: control.installHostControl,
  installHostControlLinkClient: control.installHostControlLinkClient,
}));
vi.mock("../assistant/hostSenders.js", () => ({
  installAssistantSenderHost: control.installAssistantSenderHost,
}));
vi.mock("../assistant/hostMcpRelay.js", () => ({
  installHostMcpRelay: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("../client/viewRequests.js", () => ({
  installViewReverseRequests: vi.fn(() => m.uninstallViewRequests),
}));
// The real service over the real listener, with the system (store, launchd,
// systemd, mDNS, keychain) faked: boot must never touch this machine.
vi.mock("../host/hostModeDefaults.js", async () => {
  const { HostModeService } = await import("../host/HostModeService.js");
  const { startHostListener } = await import("../host/hostListener.js");
  return {
    createHostModeService: () =>
      new HostModeService({
        platform: "linux",
        readSettings: () => ({ enabled: true, startAtLogin: false, advertise: true }),
        writeSettings: () => {},
        socketPath: "/run/user/501/daintree-dev/host.sock",
        startListener: (signal) => startHostListener({ signal }),
        startAtLogin: null,
        createAdvertiser: () => ({
          start: () => m.record("advertise.start"),
          stop: () => m.record("advertise.stop"),
          getState: () => ({ status: "off" as const }),
        }),
        keychain: {
          getSelectedStorageBackend: () => "basic_text",
          isAsyncEncryptionAvailable: async () => false,
          encryptStringAsync: async () => Buffer.alloc(0),
          decryptStringAsync: async () => ({ result: "" }),
        },
        run: async () => ({ code: null, stdout: "", stderr: "", failure: "not-found" as const }),
        broadcast: () => {},
      }),
  };
});

import { startRemoteHosts, stopRemoteHosts } from "../boot.js";
import { notifyMcpDriveTargetChange } from "../../services/mcp-server/driveTarget.js";
import {
  _resetRemoteServicesForTest,
  getRemoteService,
  registerRemoteService,
} from "../runtime.js";
import { Lane } from "../link/frames.js";
import { ControlKind } from "../link/messages.js";

function fakeEndpoint(endpointId: string, projectId: string | null = null) {
  const closeListeners: Array<() => void> = [];
  let closed = false;
  return {
    endpointId,
    projectId,
    clientEndpointId: endpointId.split(":").at(-1),
    isClosed: () => closed,
    onClose: (l: () => void) => {
      closeListeners.push(l);
      return { dispose: () => {} };
    },
    close() {
      closed = true;
      for (const l of closeListeners) l();
    },
  };
}

function openEndpoint(endpoint: unknown, sessionId: string, link: unknown, client?: unknown) {
  for (const l of [...m.openedListeners]) l(endpoint, { sessionId, link: () => link, client });
}

beforeEach(() => {
  m.calls.length = 0;
  m.server.sessionListeners.clear();
  m.server.expiredListeners.clear();
  m.openedListeners.clear();
  m.transportListeners.clear();
  m.clientOpenedListeners.clear();
  m.clientClosedListeners.clear();
  m.sessionAttachedListeners.clear();
  m.viewHosts.clear();
  m.clientHooks.current = {};
  m.remoteViewHooks.current = null;
  m.leaseListeners.clear();
  m.viewFilter.current = null;
  m.mcpResolver.current = null;
  m.hostEntries.length = 0;
  vi.clearAllMocks();
  _resetRemoteServicesForTest();
});

afterEach(async () => {
  await stopRemoteHosts();
});

describe("startRemoteHosts", () => {
  it("starts only the client side when Host mode is off, and dials nothing", async () => {
    await startRemoteHosts({ hostMode: false });

    expect(m.initRemoteHostsClient).toHaveBeenCalledTimes(1);
    expect(m.HostServer).not.toHaveBeenCalled();
    expect(m.initRemoteHostsHost).not.toHaveBeenCalled();
    expect(m.server.listen).not.toHaveBeenCalled();
    expect(getRemoteService("hostServer")).toBeUndefined();
    // A user with no hosts: boot never asks for a connection.
    expect(m.client.client.connect).not.toHaveBeenCalled();
    // Summary links are started with the client; with no hosts they dial nothing.
    expect(metrics.installHostMetricsClient).toHaveBeenCalledTimes(1);
    expect(m.attachClientTerminalRelay).not.toHaveBeenCalled();
    // Nothing per-view is installed until a host is actually used.
    expect(m.installTerminalOverride).not.toHaveBeenCalled();
    expect(m.installWorktreeOverride).not.toHaveBeenCalled();
    expect(m.remoteViewHooks.current).toBeNull();
    expect(m.clientOpenedListeners.size).toBe(0);
    // Both boot paths already started the workspace client; boot never starts one.
    expect(m.ensureWorkspaceClient).not.toHaveBeenCalled();
  });

  it("opens a host from a banner about one of its agents through the Remote Hosts client", async () => {
    await startRemoteHosts({ hostMode: false });
    const [options] = metrics.installHostMetricsClient.mock.calls[0] as [
      { openHostForNotice(window: unknown, notice: unknown): Promise<unknown> },
    ];
    const notice = { hostId: "studio-01", projectId: null, terminalId: "t1" };
    const result = { outcome: "switched" };
    m.client.client.openHostForNotice.mockResolvedValueOnce(result);
    await expect(options.openHostForNotice(3, notice)).resolves.toBe(result);
    expect(m.client.client.openHostForNotice).toHaveBeenCalledWith(3, notice);
    // A failed switch reaches the banner's click handler, which logs it.
    m.client.client.openHostForNotice.mockRejectedValueOnce(new Error("unreachable"));
    await expect(options.openHostForNotice(3, notice)).rejects.toThrow("unreachable");
  });

  it("installs host control from start, reading each host's switch live", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(control.installHostControl).toHaveBeenCalledTimes(1);
    const [deps] = control.installHostControl.mock.calls[0] as [
      { isHostControlEnabled(hostId: string): boolean },
    ];
    expect(deps.isHostControlEnabled("control-on")).toBe(true);
    expect(deps.isHostControlEnabled("unknown-host")).toBe(false);
    await stopRemoteHosts();
    expect(control.uninstall).toHaveBeenCalledTimes(1);
  });

  it("hands host control each host's last handshake and whether the person disconnected it (#14461)", async () => {
    const handshake = {
      version: "1.0.0",
      commit: "abc1234",
      protocolVersion: 12,
      platform: "darwin",
      arch: "arm64",
    };
    m.hostEntries.push({
      descriptor: { id: "control-on", name: "studio-01", lastSeenAt: 5, lastHandshake: handshake },
      connection: { status: "disconnected" },
      summary: null,
    } as never);
    await startRemoteHosts({ hostMode: false });
    const [deps] = control.installHostControl.mock.calls[0] as [
      { observeHosts(): Array<Record<string, unknown>> },
    ];
    expect(deps.observeHosts()).toEqual([
      {
        hostId: "control-on",
        name: "studio-01",
        connection: { status: "disconnected" },
        lastSeenAt: 5,
        summary: null,
        summaryReceipt: null,
        lastHandshake: handshake,
        disconnectedByPerson: true,
      },
    ]);
    await stopRemoteHosts();
  });

  it("hands host watches the link, host list and summaries, and lets all three go (#14463)", async () => {
    const offs = { registry: vi.fn(), manager: vi.fn(), metrics: vi.fn() };
    const onSummary = vi.fn((_l: unknown) => offs.metrics);
    await startRemoteHosts({ hostMode: false });
    m.client.registry.onChange.mockImplementationOnce(() => offs.registry);
    m.client.manager.onStateChange.mockImplementationOnce(() => offs.manager);
    const offMetrics = registerRemoteService("hostMetrics", { onSummary } as never);
    const [deps] = control.installHostControl.mock.calls[0] as [
      { watchHosts(listener: { changed(): void; summary(hostId: string): void }): () => void },
    ];
    // Only asked once something watches: starting up subscribes nothing for it.
    expect(onSummary).not.toHaveBeenCalled();
    const off = deps.watchHosts({ changed: vi.fn(), summary: vi.fn() });
    expect(onSummary).toHaveBeenCalledTimes(1);
    off();
    expect(offs.registry).toHaveBeenCalledTimes(1);
    expect(offs.manager).toHaveBeenCalledTimes(1);
    expect(offs.metrics).toHaveBeenCalledTimes(1);
    offMetrics();
    await stopRemoteHosts();
  });

  it("hands host control when each host's summary arrived, beside the summary itself (#14462)", async () => {
    const summary = { sampledAt: 1 };
    const receipt = {
      receivedAt: 2,
      at: { wall: 2, mono: 2 },
      hostAgeMs: 0,
      maxAgeMs: 0,
      timed: true,
    };
    const receiptOf = vi.fn((held: object) => (held === summary ? receipt : null));
    m.hostEntries.push({
      descriptor: { id: "control-on", name: "studio-01", lastSeenAt: 5 },
      connection: { status: "disconnected" },
      summary,
    } as never);
    await startRemoteHosts({ hostMode: false });
    registerRemoteService("hostMetrics", { receiptOf, cameOn: () => null } as never);
    const [deps] = control.installHostControl.mock.calls[0] as [
      { observeHosts(): Array<Record<string, unknown>> },
    ];
    expect(deps.observeHosts()[0]).toMatchObject({ summary, summaryReceipt: receipt });
    await stopRemoteHosts();
  });

  it("hands host control whether each host's summary came on its open link (#15736)", async () => {
    const summary = { sampledAt: 1 };
    const current = { isOpen: true };
    const cameOn = vi.fn((held: object, session: unknown) =>
      held === summary ? session === current : null
    );
    m.hostEntries.push({
      descriptor: { id: "control-on", name: "studio-01", lastSeenAt: 5 },
      connection: { status: "connected", rttMs: null },
      summary,
    } as never);
    await startRemoteHosts({ hostMode: false });
    registerRemoteService("hostMetrics", { receiptOf: () => null, cameOn } as never);
    const [deps] = control.installHostControl.mock.calls[0] as [
      { observeHosts(): Array<Record<string, unknown>> },
    ];
    expect(deps.observeHosts()[0]).toMatchObject({ summaryFromCurrentLink: false });
    expect(cameOn).toHaveBeenLastCalledWith(summary, null);

    m.client.sessionFor.mockReturnValueOnce(current);
    expect(deps.observeHosts()[0]).toMatchObject({
      connection: { status: "connected" },
      summaryFromCurrentLink: true,
    });
    expect(m.client.sessionFor).toHaveBeenLastCalledWith("control-on");

    // A summary that came on no link says nothing either way.
    cameOn.mockReturnValue(null);
    expect(deps.observeHosts()[0]).not.toHaveProperty("summaryFromCurrentLink");
    await stopRemoteHosts();
  });

  it("proves this Shell's sender to hosts from start, and reaches only hosts it still knows", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(control.installHostControlLinkClient).toHaveBeenCalledTimes(1);
    const [deps] = control.installHostControlLinkClient.mock.calls[0] as [
      {
        session(hostId: string): Promise<unknown>;
        addUseCheck(check: (hostId: string) => boolean): () => void;
        hostName(hostId: string): string;
      },
    ];
    // Relayed calls keep their host's link through the manager's own idle sweep.
    const check = () => true;
    deps.addUseCheck(check);
    expect(m.client.manager.addUseCheck).toHaveBeenCalledWith(check);
    expect(deps.hostName("control-on")).toBe("studio-01");
    // A host removed from the list is never dialled.
    await expect(deps.session("unknown-host")).resolves.toBeNull();
    expect(m.client.manager.touch).not.toHaveBeenCalledWith("unknown-host");
    await stopRemoteHosts();
    expect(control.uninstallLink).toHaveBeenCalledTimes(1);
  });

  it("answers hosts' view requests from start, and releases them on stop", async () => {
    await startRemoteHosts({ hostMode: false });
    await stopRemoteHosts();
    expect(m.uninstallViewRequests).toHaveBeenCalledTimes(1);
    // A host that reloaded a view's project asks for a fresh worktree port.
    expect(m.uninstallWorktreeRedelivery).toHaveBeenCalledTimes(1);
  });

  it("installs hybrid splits and the remote-view push filter only on first use", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHybridSplits).not.toHaveBeenCalled();
    expect(m.viewFilter.current).toBeNull();

    m.clientHooks.current.onFirstUse?.();
    expect(m.installHybridSplits).toHaveBeenCalledWith({ router: m.client.router });
    const filter = m.viewFilter.current!;
    m.viewHosts.set(11, "studio-01");
    // A local view gets everything; a remote-bound one only Shell-owned pushes.
    expect(filter(12, "host:thing", [])).toBe(true);
    expect(filter(11, "host:thing", [])).toBe(false);
    expect(filter(11, "shell:ok", [])).toBe(true);
    // The local view never reaches the channel check.
    expect(m.acceptLocalPushForRemoteView.mock.calls).toEqual([
      ["host:thing", []],
      ["shell:ok", []],
    ]);

    await stopRemoteHosts();
    expect(m.viewFilter.current).toBeNull();
  });

  it("installs the host picker splits and the host file client on first use", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHostFileClient).not.toHaveBeenCalled();

    m.clientHooks.current.onFirstUse?.();
    expect(m.installHostFileClient).toHaveBeenCalledTimes(1);
    const [feed, hostForView] = m.installHostFileClient.mock.calls[0] as [
      { onEndpointOpened: unknown; onEndpointClosed: unknown },
      (id: number) => unknown,
    ];
    expect(feed.onEndpointOpened).toBe(m.client.onEndpointOpened);
    expect(feed.onEndpointClosed).toBe(m.client.onEndpointClosed);
    m.viewHosts.set(11, "studio-01");
    expect(hostForView(11)).toBe("studio-01");

    await stopRemoteHosts();
    expect(m.uninstallPickerSplits).toHaveBeenCalledTimes(1);
    expect(m.uninstallHostFileClient).toHaveBeenCalledTimes(1);
    // The file client goes before the picker splits that reach it.
    expect(m.calls.indexOf("uninstall host file client")).toBeLessThan(
      m.calls.indexOf("uninstall picker splits")
    );
  });

  it("installs the upload client and clipboard splits on first use, the splits over the base ones", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHostUploadClient).not.toHaveBeenCalled();
    expect(m.installClipboardSplits).not.toHaveBeenCalled();

    m.clientHooks.current.onFirstUse?.();
    expect(m.installHostUploadClient).toHaveBeenCalledTimes(1);
    const [feed, hostForView] = m.installHostUploadClient.mock.calls[0] as [
      { onEndpointOpened: unknown; onEndpointClosed: unknown },
      (id: number) => unknown,
    ];
    expect(feed.onEndpointOpened).toBe(m.client.onEndpointOpened);
    expect(feed.onEndpointClosed).toBe(m.client.onEndpointClosed);
    m.viewHosts.set(11, "studio-01");
    expect(hostForView(11)).toBe("studio-01");
    expect(hostForView(12)).toBeNull();
    // The clipboard splits replace the base refusals, so they must register after them.
    expect(m.calls.indexOf("install hybrid splits")).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf("install hybrid splits")).toBeLessThan(
      m.calls.indexOf("install clipboard splits")
    );

    await stopRemoteHosts();
    expect(m.uninstallHostUploadClient).toHaveBeenCalledTimes(1);
    expect(m.uninstallClipboardSplits).toHaveBeenCalledTimes(1);
  });

  it("installs the port forward client and host switch service with the client, dialling nothing", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.client.client.connect).not.toHaveBeenCalled();

    const switchDeps = m.installHostSwitchService.mock.calls[0]![0] as {
      client: unknown;
      sessionFor(hostId: string): unknown;
      holdHost(hostId: string): () => void;
    };
    expect(switchDeps.client).toBe(m.client.client);
    // Reaching a host through its session counts as using it, and a transfer holds it.
    switchDeps.sessionFor("studio-01");
    expect(m.client.sessionFor).toHaveBeenCalledWith("studio-01");
    expect(m.client.manager.touch).toHaveBeenCalledWith("studio-01");
    switchDeps.holdHost("studio-01");
    expect(m.client.manager.hold).toHaveBeenCalledWith("studio-01");
    expect(m.installPortForwardClient).toHaveBeenCalledTimes(1);
    const deps = m.installPortForwardClient.mock.calls[0]![0] as {
      onEndpointOpened: unknown;
      hostForView(id: number): unknown;
      isKnownHost(hostId: string): boolean;
      sessionFor(hostId: string): unknown;
      onSessionOpened(listener: unknown): () => void;
      connectionFor(hostId: string): { kind: string; target: string } | null;
      clientDir: string;
    };
    expect(deps.onEndpointOpened).toBe(m.client.onEndpointOpened);
    expect(deps.sessionFor).toBe(m.client.sessionFor);
    expect(deps.clientDir).toBe("/tmp/daintree-user-data/rh");
    m.viewHosts.set(11, "studio-01");
    expect(deps.hostForView(11)).toBe("studio-01");
    expect(deps.hostForView(12)).toBeNull();
    m.hostEntries.push({
      descriptor: { id: "studio-01", connection: { kind: "ssh", target: "greg@studio" } },
    });
    expect(deps.isKnownHost("studio-01")).toBe(true);
    expect(deps.isKnownHost("studio-02")).toBe(false);
    const onSession = () => {};
    deps.onSessionOpened(onSession);
    expect(m.client.manager.onSessionOpened).toHaveBeenCalledWith(onSession);
    expect(deps.connectionFor("studio-01")).toEqual({ kind: "ssh", target: "greg@studio" });
    expect(deps.connectionFor("studio-02")).toBeNull();

    await stopRemoteHosts();
    expect(m.uninstallPortForwardClient).toHaveBeenCalledTimes(1);
    expect(m.uninstallHostSwitchService).toHaveBeenCalledTimes(1);
  });

  it("installs plugin parity with the client and the plugin install splits on first use, over the base ones", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.client.client.connect).not.toHaveBeenCalled();
    const parityDeps = m.installPluginParityClient.mock.calls[0]![0] as {
      client: unknown;
      sessionFor(hostId: string): unknown;
    };
    expect(parityDeps.client).toBe(m.client.client);
    parityDeps.sessionFor("studio-01");
    expect(m.client.sessionFor).toHaveBeenCalledWith("studio-01");
    expect(m.installPluginInstallSplits).not.toHaveBeenCalled();

    m.clientHooks.current.onFirstUse?.();
    expect(m.installPluginInstallSplits).toHaveBeenCalledTimes(1);
    // They replace the base refusals for the install channels, so they must register after them.
    expect(m.calls.indexOf("install hybrid splits")).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf("install hybrid splits")).toBeLessThan(
      m.calls.indexOf("install plugin install splits")
    );

    await stopRemoteHosts();
    expect(m.uninstallPluginInstallSplits).toHaveBeenCalledTimes(1);
    expect(m.uninstallPluginParityClient).toHaveBeenCalledTimes(1);
  });

  it("installs the plugin client only on first use, on the client's endpoint feed", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installPluginClient).not.toHaveBeenCalled();

    m.clientHooks.current.onFirstUse?.();
    expect(m.installPluginClient).toHaveBeenCalledWith({
      onEndpointOpened: m.client.onEndpointOpened,
      onEndpointClosed: m.client.onEndpointClosed,
    });
    await stopRemoteHosts();
    expect(m.uninstallPluginClient).toHaveBeenCalledTimes(1);
  });

  it("waits for a workspace client still starting before installing the port overrides", async () => {
    m.isWorkspaceClientStarting.mockReturnValueOnce(true);
    await startRemoteHosts({ hostMode: false });
    expect(m.ensureWorkspaceClient).toHaveBeenCalledTimes(1);
  });

  it("installs the overrides and view hooks once, on the first use of a host", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.clientHooks.current.onFirstUse?.();
    expect(m.installTerminalOverride).toHaveBeenCalledTimes(1);
    expect(m.installWorktreeOverride).toHaveBeenCalledTimes(1);
    const hostForView = m.installTerminalOverride.mock.calls[0]![0] as (id: number) => unknown;
    m.viewHosts.set(11, "studio-01");
    expect(hostForView(11)).toBe("studio-01");
    const hooks = m.remoteViewHooks.current as { isRemoteView(wc: { id: number }): boolean };
    expect(hooks.isRemoteView({ id: 11 })).toBe(true);
    expect(hooks.isRemoteView({ id: 12 })).toBe(false);
  });

  it("attaches both client relays when a view's endpoint is on a session", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.viewHosts.set(11, "studio-01");
    const session = { id: "s" };
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session, webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.attachClientTerminalRelay).toHaveBeenCalledWith(
      session,
      { id: 11 },
      "view-11",
      "studio-01"
    );
    expect(m.attachClientWorktreeRelay).toHaveBeenCalledWith(
      session,
      { id: 11 },
      "view-11",
      "studio-01"
    );
  });

  it("attaches no streams for a view whose authoritative host is another one", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.viewHosts.set(11, "studio-02");
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session: {}, webContentsId: 11, endpointId: "view-11" });
    }
    m.viewHosts.delete(11);
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session: {}, webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.attachClientTerminalRelay).not.toHaveBeenCalled();
    expect(m.attachClientWorktreeRelay).not.toHaveBeenCalled();
  });

  it("retires a view's relays when its endpoint is discarded", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    for (const l of m.clientClosedListeners) {
      l("studio-01", { webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.detachClientTerminalRelayFor).toHaveBeenCalledWith(11, "studio-01", "view-11");
    expect(m.detachClientWorktreeRelayFor).toHaveBeenCalledWith(11, "studio-01", "view-11");
  });

  it("takes down a host's banners once nothing on it can close them, and keeps them across a resume", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    for (const l of m.clientClosedListeners) {
      l("studio-01", { webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.releaseHostNotifications).toHaveBeenCalledWith("studio-01", 11);

    m.releaseHostNotifications.mockClear();
    for (const l of m.sessionAttachedListeners) l("studio-01", { resumed: true });
    expect(m.releaseHostNotifications).not.toHaveBeenCalled();
    for (const l of m.sessionAttachedListeners) l("studio-01", { resumed: false });
    expect(m.releaseHostNotifications).toHaveBeenCalledWith("studio-01");

    await stopRemoteHosts();
    expect(m.sessionAttachedListeners.size).toBe(0);
  });

  it("retires the local pair when a remote view is shown, and re-posts a cached view's worktree port", async () => {
    await startRemoteHosts({ hostMode: false });
    const wc = { id: 11 };
    m.clientHooks.current.onRemoteViewActivated?.(3, wc, true);
    expect(m.releaseWindowTerminalPort).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 3 }),
      { pty: true }
    );
    expect(m.redeliverClientWorktreePort).not.toHaveBeenCalled();
    m.clientHooks.current.onRemoteViewActivated?.(3, wc, false);
    expect(m.redeliverClientWorktreePort).toHaveBeenCalledWith(wc);
  });

  it("reports which views each window shows to their hosts", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.viewHosts.set(11, "studio-01");
    const session = { id: "s" };
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session, webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.visibility.noteEndpointOpened).toHaveBeenCalledWith({
      session,
      webContentsId: 11,
      endpointId: "view-11",
    });

    m.windowCleanups.length = 0;
    m.clientHooks.current.onRemoteViewActivated?.(3, { id: 11 }, true);
    expect(m.visibility.noteViewActivated).toHaveBeenCalledWith(3, 11);
    m.clientHooks.current.onRemoteViewActivated?.(3, { id: 11 }, false);
    // One close watch per window, however often it shows a host view.
    expect(m.windowCleanups.map(([id]) => id)).toEqual([3]);

    // Moving the window back to this machine reports its host view hidden.
    m.clientHooks.current.onLocalViewActivated?.(3, { id: 20 });
    expect(m.visibility.noteViewActivated).toHaveBeenLastCalledWith(3, 20);

    for (const l of m.clientClosedListeners) {
      l("studio-01", { webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.visibility.noteEndpointClosed).toHaveBeenCalledWith(11, "view-11");

    m.windowCleanups[0]![1].dispose();
    expect(m.visibility.noteWindowClosed).toHaveBeenCalledWith(3);
  });

  it("reports no visibility for an endpoint whose view belongs to another host", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.viewHosts.set(11, "studio-02");
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session: {}, webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.visibility.noteEndpointOpened).not.toHaveBeenCalled();
  });

  it("skips relays for a view that is already gone", async () => {
    await startRemoteHosts({ hostMode: false });
    m.clientHooks.current.onFirstUse?.();
    m.viewHosts.set(11, "studio-01");
    m.resolveLiveWebContents.mockReturnValueOnce(null as never);
    for (const l of m.clientOpenedListeners) {
      l("studio-01", { session: {}, webContentsId: 11, endpointId: "view-11" });
    }
    expect(m.attachClientTerminalRelay).not.toHaveBeenCalled();
  });

  it("starts the host side in Host mode, registers the server and advertises it", async () => {
    await startRemoteHosts({ hostMode: true });

    expect(m.calls).toEqual([
      "initRemoteHostsClient",
      "new HostServer",
      "initRemoteHostsHost",
      "server.listen",
      "advertise.start",
    ]);
    expect(m.initRemoteHostsHost).toHaveBeenCalledWith(m.server);
    // Every attached Shell gets this host's summaries.
    expect(metrics.installHostMetricsHost).toHaveBeenCalledWith(m.server);
    // And can read its Canopy from a view bound elsewhere.
    expect(canopy.installCanopyHost).toHaveBeenCalledWith(m.server);
    expect(getRemoteService("hostServer")).toBe(m.server);
    expect(getRemoteService("hostMode")).toBeDefined();
  });

  it("registers the Host mode service without listening when Host mode is off", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(getRemoteService("hostMode")).toBeDefined();
    expect(m.calls).not.toContain("advertise.start");

    // The switch starts the same host side at runtime.
    await getRemoteService("hostMode")!.startListening();
    expect(m.calls).toEqual([
      "initRemoteHostsClient",
      "new HostServer",
      "initRemoteHostsHost",
      "server.listen",
      "advertise.start",
    ]);
    await stopRemoteHosts();
    expect(getRemoteService("hostMode")).toBeUndefined();
    expect(m.server.close).toHaveBeenCalled();
  });

  it("installs the lease wiring when the switch starts listening and removes it when switched off", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.mcpResolver.current).toBeNull();
    expect(m.transportListeners.size).toBe(0);
    expect(m.leaseListeners.size).toBe(0);

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(m.admitHybridHostLegs).toHaveBeenCalledTimes(1);
    // The notification sink hears the same resumes, to send the closes it owes.
    const legs = (m.admitHybridHostLegs.mock.calls[0] as unknown[])[0] as {
      onTransportChange: (l: (ids: string[], attached: boolean) => void) => () => void;
    };
    const heard = vi.fn();
    const stopHearing = legs.onTransportChange(heard);
    for (const l of m.transportListeners) l(["remote:s1:view-11"], true);
    expect(heard).toHaveBeenCalledWith(["remote:s1:view-11"], true);
    stopHearing();
    expect(m.mcpResolver.current?.("proj-1")).toEqual({ state: "vacant" });
    for (const l of m.transportListeners) l(["remote:s1:view-11"], false);
    expect(m.lease.noteEndpointTransport).toHaveBeenCalledWith(["remote:s1:view-11"], false);
    const link = { post: vi.fn() };
    openEndpoint(fakeEndpoint("remote:s1:view-11", "proj-1"), "s1", link);
    for (const l of m.leaseListeners) l({ projectId: "proj-1", holder: null });
    expect(link.post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ControlKind.LEASE_CHANGED })
    );

    await hostMode.stopListening();
    expect(m.mcpResolver.current).toBeNull();
    expect(m.transportListeners.size).toBe(0);
    expect(m.leaseListeners.size).toBe(0);
    expect(m.openedListeners.size).toBe(0);
    expect(m.server.close).toHaveBeenCalled();
    // The client side is untouched by the switch.
    expect(m.client.dispose).not.toHaveBeenCalled();
  });

  it("attaches both bridges and replays snapshots when a remote endpoint opens", async () => {
    await startRemoteHosts({ hostMode: true });
    const endpoint = fakeEndpoint("remote:s1:view-11");
    const link = { id: "link-1" };

    openEndpoint(endpoint, "s1", link);
    await vi.waitFor(() => expect(m.runHistoryPush).toHaveBeenCalledWith(endpoint));

    expect(m.attachTerminalBridge).toHaveBeenCalledWith(link, endpoint, {
      onInput: expect.any(Function),
    });
    expect(m.attachWorktreePortBridge).toHaveBeenCalledWith(link, endpoint);
    expect(m.statsPush).toHaveBeenCalledWith(endpoint);
    expect(m.fleetPush).toHaveBeenCalledWith(endpoint);
  });

  it("serves ports, project moves and plugins only while listening, on the server's sessions", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHostPortService).not.toHaveBeenCalled();
    expect(m.installProjectsHost).not.toHaveBeenCalled();
    expect(m.installPluginHost).not.toHaveBeenCalled();
    expect(m.installPluginParityHost).not.toHaveBeenCalled();

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(m.installHostPortService).toHaveBeenCalledWith(m.server);
    expect(m.installProjectsHost).toHaveBeenCalledWith(m.server);
    expect(m.installPluginHost).toHaveBeenCalledTimes(1);
    expect(m.installPluginParityHost).toHaveBeenCalledWith(m.server);

    await hostMode.stopListening();
    expect(m.uninstallHostPortService).toHaveBeenCalledTimes(1);
    expect(m.uninstallProjectsHost).toHaveBeenCalledTimes(1);
    expect(m.uninstallPluginHost).toHaveBeenCalledTimes(1);
    expect(m.uninstallPluginParityHost).toHaveBeenCalledTimes(1);
  });

  it("answers connected hosts' agents for paired devices from start, and serves a Shell's devices only while listening", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.client.client.connect).not.toHaveBeenCalled();
    expect(deviceAnswer.installDeviceAnswerHostsClient).toHaveBeenCalledWith({
      registry: m.client.registry,
      manager: m.client.manager,
      sessionFor: m.client.sessionFor,
    });
    expect(deviceAnswer.installDeviceAnswerHost).not.toHaveBeenCalled();

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(deviceAnswer.installDeviceAnswerHost).toHaveBeenCalledWith(m.server);
    await hostMode.stopListening();
    expect(deviceAnswer.uninstallHost).toHaveBeenCalledTimes(1);

    await stopRemoteHosts();
    expect(deviceAnswer.uninstallClient).toHaveBeenCalledTimes(1);
  });

  it("reads a host's pane for dictation from start, and answers a Shell's only while listening", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(voicePane.installVoicePaneHostsClient).toHaveBeenCalledWith({
      sessionFor: m.client.sessionFor,
    });
    expect(voicePane.installVoicePaneHost).not.toHaveBeenCalled();

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(voicePane.installVoicePaneHost).toHaveBeenCalledWith(m.server);
    await hostMode.stopListening();
    expect(voicePane.uninstallHost).toHaveBeenCalledTimes(1);

    await stopRemoteHosts();
    expect(voicePane.uninstallClient).toHaveBeenCalledTimes(1);
  });

  it("serves plugin assets for opened endpoints and moves them to a resumed link", async () => {
    await startRemoteHosts({ hostMode: true });
    const endpoint = fakeEndpoint("remote:s1:view-11");
    const link = { id: "link-1" };
    openEndpoint(endpoint, "s1", link);
    expect(m.attachHostPluginAssets).toHaveBeenCalledWith(link, endpoint);

    // No link yet: nothing to attach to.
    openEndpoint(fakeEndpoint("remote:s2:view-12"), "s2", null);
    expect(m.attachHostPluginAssets).toHaveBeenCalledTimes(1);

    const resumed = { id: "link-1b" };
    for (const l of m.server.sessionListeners)
      l({ sessionId: "s1", resumed: true, session: resumed });
    expect(m.attachHostPluginAssets).toHaveBeenLastCalledWith(resumed, endpoint);
  });

  it("serves host files only while listening, for opened and resumed endpoints", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHostFileService).not.toHaveBeenCalled();

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(m.installHostFileService).toHaveBeenCalledTimes(1);
    const endpoint = fakeEndpoint("remote:s1:view-11");
    const link = { id: "link-1" };
    openEndpoint(endpoint, "s1", link);
    expect(m.attachHostFiles).toHaveBeenCalledWith(link, endpoint);

    const resumed = { id: "link-1b" };
    for (const l of m.server.sessionListeners)
      l({ sessionId: "s1", resumed: true, session: resumed });
    expect(m.attachHostFiles).toHaveBeenLastCalledWith(resumed, endpoint);

    await hostMode.stopListening();
    expect(m.hostFilesDispose).toHaveBeenCalledTimes(1);
  });

  it("accepts uploads only while listening, for opened and resumed endpoints", async () => {
    await startRemoteHosts({ hostMode: false });
    expect(m.installHostUploadService).not.toHaveBeenCalled();

    const hostMode = getRemoteService("hostMode")!;
    await hostMode.startListening();
    expect(m.installHostUploadService).toHaveBeenCalledTimes(1);
    const endpoint = fakeEndpoint("remote:s1:view-11");
    const link = { id: "link-1" };
    openEndpoint(endpoint, "s1", link);
    expect(m.attachHostUploads).toHaveBeenCalledWith(link, endpoint);

    const resumed = { id: "link-1b" };
    for (const l of m.server.sessionListeners)
      l({ sessionId: "s1", resumed: true, session: resumed });
    expect(m.attachHostUploads).toHaveBeenCalledTimes(2);
    expect(m.attachHostUploads).toHaveBeenLastCalledWith(resumed, endpoint);

    await hostMode.stopListening();
    expect(m.hostUploadsDispose).toHaveBeenCalledTimes(1);
  });

  it("re-attaches a session's endpoints to the new link when it resumes", async () => {
    await startRemoteHosts({ hostMode: true });
    const kept = fakeEndpoint("remote:s1:view-11");
    const closed = fakeEndpoint("remote:s1:view-12");
    const other = fakeEndpoint("remote:s2:view-13");
    openEndpoint(kept, "s1", { id: "link-1" });
    openEndpoint(closed, "s1", { id: "link-1" });
    openEndpoint(other, "s2", { id: "link-2" });
    closed.close();
    m.attachTerminalBridge.mockClear();
    m.attachWorktreePortBridge.mockClear();

    const resumed = { id: "link-1b" };
    for (const l of m.server.sessionListeners)
      l({ sessionId: "s1", resumed: true, session: resumed });
    // A fresh (non-resumed) session opens its endpoints anew; nothing to carry.
    for (const l of m.server.sessionListeners) l({ sessionId: "s2", resumed: false, session: {} });

    expect(m.attachTerminalBridge.mock.calls).toEqual([
      [resumed, kept, { onInput: expect.any(Function) }],
    ]);
    expect(m.attachWorktreePortBridge.mock.calls).toEqual([[resumed, kept]]);
  });

  it("detaches both bridges for every endpoint of an expired session", async () => {
    await startRemoteHosts({ hostMode: true });
    openEndpoint(fakeEndpoint("remote:s1:view-11"), "s1", {});
    openEndpoint(fakeEndpoint("remote:s1:view-12"), "s1", {});
    openEndpoint(fakeEndpoint("remote:s2:view-13"), "s2", {});

    for (const l of m.server.expiredListeners) l({ sessionId: "s1", clientId: "c" });

    expect(m.detachTerminalBridge.mock.calls.flat()).toEqual([
      "remote:s1:view-11",
      "remote:s1:view-12",
    ]);
    expect(m.detachWorktreePortBridge.mock.calls.flat()).toEqual([
      "remote:s1:view-11",
      "remote:s1:view-12",
    ]);
  });

  it("admits hybrid host legs and routes MCP to the lease holder in Host mode", async () => {
    await startRemoteHosts({ hostMode: true });
    expect(m.admitHybridHostLegs).toHaveBeenCalledTimes(1);
    const endpoint = { endpointId: "remote:s1:view-11" };
    m.lease.getDriveTarget.mockReturnValueOnce({ kind: "live", holder: {}, endpoint });
    expect(m.mcpResolver.current?.("proj-1")).toEqual({ state: "live", endpoint });
    expect(m.lease.getDriveTarget).toHaveBeenCalledWith("proj-1");
    // A holder that is away holds its reservation: nobody else is routed to.
    m.lease.getDriveTarget.mockReturnValueOnce({ kind: "reserved", holder: {} });
    expect(m.mcpResolver.current?.("proj-1")).toEqual({ state: "unavailable", reason: "reserved" });
    expect(m.mcpResolver.current?.("proj-2")).toEqual({ state: "vacant" });
    expect(m.lease.noteSessionChange).not.toHaveBeenCalled();
    // Asked for a change the host makes itself while nobody drives, the lease hears of it.
    expect(m.mcpResolver.current?.("proj-2", { linkSessionId: "s1" })).toEqual({ state: "vacant" });
    expect(m.lease.noteSessionChange).toHaveBeenCalledWith("proj-2", "s1");
    expect(m.mcpResolver.current?.("proj-2", { linkSessionId: null })).toEqual({ state: "vacant" });
    expect(m.lease.noteSessionChange).toHaveBeenLastCalledWith("proj-2", null);
    // Nothing is changed where someone drives, or holds the project while away.
    m.lease.getDriveTarget.mockReturnValueOnce({ kind: "live", holder: {}, endpoint });
    m.mcpResolver.current?.("proj-1", { linkSessionId: null });
    m.lease.getDriveTarget.mockReturnValueOnce({ kind: "reserved", holder: {} });
    m.mcpResolver.current?.("proj-1", { linkSessionId: "s1" });
    expect(m.lease.noteSessionChange).toHaveBeenCalledTimes(2);

    await stopRemoteHosts();
    expect(m.mcpResolver.current).toBeNull();
  });

  it("names each endpoint's machine to the lease and tells Shells showing the project of changes", async () => {
    await startRemoteHosts({ hostMode: true });
    const client = { clientId: "c1", clientName: "greg-mbp" };
    const link1 = { post: vi.fn() };
    const link2 = { post: vi.fn() };
    const onProject = fakeEndpoint("remote:s1:view-11", "proj-1");
    openEndpoint(onProject, "s1", link1, client);
    openEndpoint(fakeEndpoint("remote:s2:view-12", "proj-2"), "s2", link2, client);
    expect(m.lease.noteEndpointClient).toHaveBeenCalledWith("remote:s1:view-11", client);

    const state = { projectId: "proj-1", holder: null };
    for (const l of m.leaseListeners) l(state);
    expect(link1.post).toHaveBeenCalledWith({
      lane: Lane.CONTROL,
      kind: ControlKind.LEASE_CHANGED,
      body: state,
    });
    expect(link2.post).not.toHaveBeenCalled();

    // A closed endpoint no longer shows the project; an expired session is forgotten.
    onProject.close();
    link1.post.mockClear();
    for (const l of m.leaseListeners) l(state);
    expect(link1.post).not.toHaveBeenCalled();

    link2.post.mockImplementationOnce(() => {
      throw new Error("closing");
    });
    for (const l of m.leaseListeners) l({ projectId: "proj-2", holder: null });
    for (const l of m.server.expiredListeners) l({ sessionId: "s2", clientId: "c1" });
    link2.post.mockClear();
    for (const l of m.leaseListeners) l({ projectId: "proj-2", holder: null });
    expect(link2.post).not.toHaveBeenCalled();
  });

  it("does not treat a listen interrupted by stop as a failure", async () => {
    let rejectListen!: (error: Error) => void;
    m.server.listen.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectListen = reject))
    );
    const starting = startRemoteHosts({ hostMode: true });
    await vi.waitFor(() => expect(m.server.listen).toHaveBeenCalled());

    const stopping = stopRemoteHosts();
    rejectListen(new Error("Host server was closed before it finished starting"));

    await expect(starting).resolves.toBeUndefined();
    await stopping;
    expect(m.server.close).toHaveBeenCalled();
  });

  it("starts no listener when a stop lands while the Host role is still loading (#15888)", async () => {
    const init = m.initRemoteHostsClient.getMockImplementation()!;
    let stopping: Promise<void> | undefined;
    m.initRemoteHostsClient.mockImplementationOnce((hooks) => {
      // After the Shell is up, before the Host role's module has loaded.
      queueMicrotask(() => {
        stopping = stopRemoteHosts();
      });
      return init(hooks);
    });

    await startRemoteHosts({ hostMode: true });
    await stopping;

    expect(stopping).toBeDefined();
    expect(m.server.listen).not.toHaveBeenCalled();
    expect(getRemoteService("hostMode")).toBeUndefined();
  });

  it("goes no further once a quit begins mid-start, before the quit's stop reaches it (#15888)", async () => {
    let quitting = false;
    m.isWorkspaceClientStarting.mockReturnValueOnce(true);
    m.ensureWorkspaceClient.mockImplementationOnce(async () => {
      quitting = true;
      return {};
    });

    await startRemoteHosts({ hostMode: true, halted: () => quitting });

    expect(m.ensureWorkspaceClient).toHaveBeenCalledTimes(1);
    expect(m.initRemoteHostsClient).not.toHaveBeenCalled();
    expect(m.client.client.connect).not.toHaveBeenCalled();
    expect(m.server.listen).not.toHaveBeenCalled();
    expect(getRemoteService("hostMode")).toBeUndefined();
  });

  it("undoes what host setup registered when a later step throws", async () => {
    m.initRemoteHostsHost.mockImplementationOnce(() => {
      throw new Error("session host failed");
    });
    await expect(startRemoteHosts({ hostMode: true })).rejects.toThrow("session host failed");
    expect(getRemoteService("hostServer")).toBeUndefined();
    expect(m.server.close).toHaveBeenCalled();
    expect(m.server.listen).not.toHaveBeenCalled();
  });

  it("surfaces a listen failure that was not caused by stop", async () => {
    m.server.listen.mockRejectedValueOnce(new Error("no /run/user/501"));
    await expect(startRemoteHosts({ hostMode: true })).rejects.toThrow("no /run/user/501");
  });

  it("tells the lease when a Shell's link drops and resumes", async () => {
    await startRemoteHosts({ hostMode: true });
    const routeChanges = vi.mocked(notifyMcpDriveTargetChange);
    routeChanges.mockClear();
    for (const l of m.transportListeners) l(["remote:s1:view-11"], false);
    expect(m.lease.noteEndpointTransport).toHaveBeenCalledWith(["remote:s1:view-11"], false);
    for (const l of m.transportListeners) l(["remote:s1:view-11"], true);
    expect(m.lease.noteEndpointTransport).toHaveBeenLastCalledWith(["remote:s1:view-11"], true);
    // The holder goes from live to reserved and back without a lease change,
    // so MCP routing hears of it after the lease has (#13350).
    expect(routeChanges).toHaveBeenCalledTimes(2);
    expect(routeChanges.mock.invocationCallOrder[1]).toBeGreaterThan(
      Math.max(...m.lease.noteEndpointTransport.mock.invocationCallOrder)
    );

    await stopRemoteHosts();
    expect(m.transportListeners.size).toBe(0);
  });
});

describe("stopRemoteHosts", () => {
  it("tears the host down before the client, in reverse of start", async () => {
    await startRemoteHosts({ hostMode: true });
    m.clientHooks.current.onFirstUse?.();
    m.calls.length = 0;

    await stopRemoteHosts();

    expect(m.calls).toEqual([
      "dispose terminal relays",
      "dispose worktree relays",
      "uninstall view hooks",
      "uninstall plugin client",
      "uninstall host upload client",
      "uninstall host file client",
      "uninstall plugin install splits",
      "uninstall clipboard splits",
      "uninstall picker splits",
      "uninstall worktree override",
      "uninstall terminal override",
      "advertise.stop",
      "uninstall plugin host",
      "uninstall settings control host",
      "uninstall settings copy host",
      "uninstall plugin parity host",
      "uninstall projects host",
      "uninstall host port service",
      "host uploads dispose",
      "host files dispose",
      "disposeAllTerminalBridges",
      "host.dispose",
      "server.close",
      "uninstall port forward client",
      "uninstall settings control client",
      "uninstall settings copy client",
      "uninstall plugin parity client",
      "uninstall host switch service",
      "client.dispose",
    ]);
    expect(getRemoteService("hostServer")).toBeUndefined();
    expect(m.openedListeners.size).toBe(0);
    expect(m.server.sessionListeners.size).toBe(0);
    expect(m.clientOpenedListeners.size).toBe(0);
    expect(m.clientClosedListeners.size).toBe(0);
  });

  it("disposes client relays on every stop while a view survives reconnects", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await startRemoteHosts({ hostMode: false });
      m.clientHooks.current.onFirstUse?.();
      m.viewHosts.set(11, "studio-01");
      // Disconnect and reconnect: the endpoint is discarded, then reopened.
      for (const l of m.clientClosedListeners) {
        l("studio-01", { webContentsId: 11, endpointId: "view-11" });
      }
      for (const l of m.clientOpenedListeners) {
        l("studio-01", { session: { cycle }, webContentsId: 11, endpointId: "view-11" });
      }
      await stopRemoteHosts();
      expect(m.clientOpenedListeners.size).toBe(0);
      expect(m.clientClosedListeners.size).toBe(0);
      expect(m.remoteViewHooks.current).toBeNull();
    }
    expect(m.detachClientTerminalRelayFor).toHaveBeenCalledTimes(3);
    expect(m.attachClientTerminalRelay).toHaveBeenCalledTimes(3);
    expect(m.disposeAllClientTerminalRelays).toHaveBeenCalledTimes(3);
    expect(m.disposeAllClientWorktreeRelays).toHaveBeenCalledTimes(3);
    expect(m.uninstallTerminal).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when nothing started, and a second stop does nothing more", async () => {
    await stopRemoteHosts();
    await startRemoteHosts({ hostMode: false });
    await stopRemoteHosts();
    m.calls.length = 0;
    await stopRemoteHosts();
    expect(m.calls).toEqual([]);
  });
});
