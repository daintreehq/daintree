import path from "node:path";
import { app } from "electron";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { ensureWorkspaceClient, isWorkspaceClientStarting } from "../boot/hostServices.js";
import { notifyRemoteViewEndpointOpened } from "../ipc/hostSendRelay.js";
import { setRemoteBoundViewFilter } from "../ipc/utils.js";
import { releaseWindowTerminalPort, setRemoteViewHooks } from "../window/portDistribution.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import { resolveLiveWebContents } from "../window/webContentsRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { toDisposable } from "../utils/lifecycle.js";
import { isRemoteHostSupported } from "./buildGate.js";
import { initRemoteHostsClient } from "./client/initClient.js";
import { defaultCommandRunner } from "./client/commandRunner.js";
import { closeSshMasters, exitStaleSshMasters } from "./client/sshTransport.js";
import { installViewReverseRequests } from "./client/viewRequests.js";
import { installHostFileClient } from "./files/clientInstall.js";
import { installHostUploadClient } from "./files/uploadClient.js";
import { installHostMetricsClient } from "./metrics/clientInstall.js";
import { installCanopyHostsClient } from "./canopy/clientInstall.js";
import { installDeviceAnswerHostsClient } from "./deviceAnswer/clientInstall.js";
import { installVoicePaneHostsClient } from "./voice/clientInstall.js";
import { installHostControl, installHostControlLinkClient } from "./assistant/install.js";
import { getRemoteService } from "./runtime.js";
import {
  acceptLocalPushForRemoteView,
  installHybridSplits,
  installNotificationPolicyPush,
  releaseHostNotifications,
  ViewVisibilityReporter,
} from "./hybrid/index.js";
import { installClipboardSplits } from "./hybrid/clipboard.js";
import { installPickerSplits } from "./hybrid/pickers.js";
import { installPluginClient } from "./plugins/install.js";
import { installPluginInstallSplits, installPluginParityClient } from "./plugins/parity/install.js";
import { installSettingsCopyClient } from "./settingsCopy/install.js";
import { installSettingsControlClient } from "./settingsControl/install.js";
import { installPortForwardClient } from "./ports/clientInstall.js";
import { installHostSwitchService } from "./projects/clientInstall.js";
import type { HostDescriptor } from "../../shared/types/remoteHosts.js";
import type { LinkTransport } from "./client/transport.js";
import type { HostSocketLocation } from "./host/hostSocketPath.js";
import {
  attachClientTerminalRelay,
  detachClientTerminalRelayFor,
  disposeAllClientTerminalRelays,
  installClientTerminalPortOverride,
} from "./terminal/clientAttach.js";
import {
  attachClientWorktreeRelay,
  detachClientWorktreeRelayFor,
  disposeAllClientWorktreeRelays,
  installClientWorktreePortOverride,
  installWorktreePortRedelivery,
  redeliverClientWorktreePort,
} from "./worktreePort/attach.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("main:boot");

// The composition root owns window creation; it installs the opener through this module.
export { setRemoteHostsWindowOpener } from "./client/initClient.js";

/**
 * Entry point for everything Remote Hosts starts in the main process. Loaded
 * only through `if (__DAINTREE_REMOTE_HOSTS__) { await import("./remote/boot.js") }`,
 * and the Host role (./hostBoot.ts) only under `__DAINTREE_REMOTE_HOST_ROLE__`,
 * so a Windows build carries the Shell alone. Services register themselves
 * into `./runtime.ts`; core code reaches them from there.
 *
 * The client side always starts. It dials a host when something needs it (a
 * window, a switch, an operation, a forward, the hosts overview), and at
 * launch only the hosts whose notifications are on; its per-view stream
 * wiring (port overrides, relays) is installed only on first use. The host side (a listening socket) starts
 * only in Host mode: here when it is on at launch, or later from its switch.
 */

export interface StartRemoteHostsOptions {
  /** Host mode is on for this launch: listen for remote Shells. */
  hostMode: boolean;
  /** How the Shell reaches a host; system ssh unless given (the integration harness dials a local socket). */
  createTransport?: (descriptor: HostDescriptor) => LinkTransport;
  /** Where Host mode listens; the platform's socket path unless given. */
  hostLocation?: HostSocketLocation;
}

type Teardown = () => void | Promise<void>;
type Role = "shell" | "host";

/**
 * Run in reverse on stop, so each piece goes before what it was built on. Each
 * names its role, so the Shell alone can be stopped and started again against
 * a Host that stays up (the integration harness's relaunch).
 */
let ledger: Array<{ role: Role; teardown: Teardown }> = [];
let started = false;
/** The running Shell; one that has stopped installs nothing on a late first use. */
let shellLaunch: object | null = null;

function ownedBy(role: Role): { push(teardown: Teardown): void } {
  return { push: (teardown) => ledger.push({ role, teardown }) };
}

/** Each ssh master may take this long to answer `-O exit` at quit; they are asked together. */
const MASTER_EXIT_TIMEOUT_MS = 1_000;
/** Long enough for a sleeping host's link to come back; a call that can't wait reports it unreachable. */
const HOST_CALL_CONNECT_MS = 10_000;

function startClient(options: StartRemoteHostsOptions): void {
  const launch = {};
  shellLaunch = launch;
  const teardowns = ownedBy("shell");
  // First in, so it runs last: port forwards and links are cancelled on the
  // masters first. ControlPersist keeps a master across reconnects while the
  // app runs; on stop, every master this process used is told to exit, so no
  // ssh outlives the app.
  teardowns.push(() => closeSshMasters(MASTER_EXIT_TIMEOUT_MS));
  let hostForView: (webContentsId: number) => string | null = () => null;
  let activated = false;
  // Tells each host which of its views a window is actually showing, so its
  // close and background guards protect exactly those projects.
  const visibility = new ViewVisibilityReporter();
  const visibilityWatched = new Set<number>();
  // A closed window's record goes with it, once per window that ever showed a host.
  const watchWindowForVisibility = (windowId: number): void => {
    if (visibilityWatched.has(windowId)) return;
    const ctx = getWindowRegistry()?.getByWindowId(windowId);
    if (!ctx) return;
    visibilityWatched.add(windowId);
    ctx.cleanup.add(
      toDisposable(() => {
        visibilityWatched.delete(windowId);
        visibility.noteWindowClosed(windowId);
      })
    );
  };

  // Everything a remote view needs beyond the host list, installed the first
  // time a host is actually used so a user who never adds one runs none of it.
  const activate = (): void => {
    if (activated || shellLaunch !== launch) return;
    activated = true;
    teardowns.push(installClientTerminalPortOverride(hostForView));
    teardowns.push(installClientWorktreePortOverride(hostForView));
    teardowns.push(installHybridSplits({ router: client.router }));
    teardowns.push(installPickerSplits());
    // Replaces the base splits' refusals for paste and attach, so it must follow them.
    teardowns.push(installClipboardSplits());
    // A `.dntr` dropped or picked here installs on the view's host; replaces the base refusals.
    teardowns.push(installPluginInstallSplits());
    const endpointFeed = {
      onEndpointOpened: client.onEndpointOpened,
      onEndpointClosed: client.onEndpointClosed,
    };
    teardowns.push(installHostFileClient(endpointFeed, hostForView));
    // Dropped, pasted and attached files, sent from this machine to the view's host.
    teardowns.push(installHostUploadClient(endpointFeed, hostForView));
    // Host plugins' prompts, consent and view bundles for the views driving their projects.
    teardowns.push(
      installPluginClient(endpointFeed, (webContentsId) => hostForView(webContentsId))
    );
    // This machine's agents, terminals and projects are not a remote view's.
    teardowns.push(
      setRemoteBoundViewFilter(
        (webContentsId, channel, args) =>
          hostForView(webContentsId) === null || acceptLocalPushForRemoteView(channel, args)
      )
    );
    teardowns.push(
      setRemoteViewHooks({
        isRemoteView: (wc) => hostForView(wc.id) !== null,
        redeliverWorktreePort: (wc) => redeliverClientWorktreePort(wc),
      })
    );
    // Relays are keyed by view and checked against its host, so re-attaching
    // on a resume moves the view's streams onto the new session and replays
    // what it missed, while a view that has since moved host gets none.
    teardowns.push(
      client.onEndpointOpened((hostId, { session, webContentsId, endpointId }) => {
        if (hostForView(webContentsId) !== hostId) return;
        const wc = resolveLiveWebContents(webContentsId);
        if (!wc) return;
        visibility.noteEndpointOpened({ session, webContentsId, endpointId });
        attachClientTerminalRelay(session, wc, endpointId, hostId);
        attachClientWorktreeRelay(session, wc, endpointId, hostId);
        notifyRemoteViewEndpointOpened(webContentsId);
      })
    );
    teardowns.push(
      client.onEndpointClosed((hostId, { webContentsId, endpointId }) => {
        visibility.noteEndpointClosed(webContentsId, endpointId);
        detachClientTerminalRelayFor(webContentsId, hostId, endpointId);
        detachClientWorktreeRelayFor(webContentsId, hostId, endpointId);
        releaseHostNotifications(hostId, webContentsId);
      })
    );
    // A fresh session reopens views without closing them first, but the host
    // dropped the old endpoints and with them any way to close their banners.
    teardowns.push(
      client.manager.onSessionAttached((hostId, { resumed }) => {
        if (!resumed) releaseHostNotifications(hostId);
      })
    );
    // Runs before the overrides are uninstalled (teardowns run in reverse).
    teardowns.push(() => {
      disposeAllClientTerminalRelays();
      disposeAllClientWorktreeRelays();
    });
  };

  const client = initRemoteHostsClient({
    createTransport: options.createTransport,
    onFirstUse: activate,
    onRemoteViewActivated: (windowId, wc, isNew) => {
      // Showing a remote view retires the window's local terminal pair, as a
      // local switch would by replacing it. A new view gets its relayed ports
      // on load; a cached one kept its terminal port but lost its worktree
      // port when it was parked.
      const ctx = getWindowRegistry()?.getByWindowId(windowId);
      if (ctx) releaseWindowTerminalPort(ctx, getPtyClient());
      if (!isNew) redeliverClientWorktreePort(wc);
      visibility.noteViewActivated(windowId, wc.id);
      watchWindowForVisibility(windowId);
    },
    // The host hears its view went to the background, or it keeps counting
    // that project as on screen and refuses to close or background it.
    onLocalViewActivated: (windowId, wc) => visibility.noteViewActivated(windowId, wc.id),
  });
  hostForView = client.hostForView;
  teardowns.push(() => client.dispose());
  // Session-level services: both reach a host through its current session,
  // so they work with no local view on it and cost nothing until a host is used.
  // Reaching a host through its session is using it: the idle release starts counting again.
  const usedSessionFor = (hostId: string) => {
    client.manager.touch(hostId);
    return client.sessionFor(hostId);
  };
  teardowns.push(
    installHostSwitchService({
      client: client.client,
      sessionFor: usedSessionFor,
      holdHost: (hostId) => client.manager.hold(hostId),
    })
  );
  // Plugin comparison and install-on-host, reached from Settings with no view needed.
  teardowns.push(
    installPluginParityClient({
      client: client.client,
      sessionFor: usedSessionFor,
      holdHost: (hostId) => client.manager.hold(hostId),
    })
  );
  // This machine's settings copied to a host, from Settings with no view needed.
  teardowns.push(
    installSettingsCopyClient({
      client: client.client,
      sessionFor: usedSessionFor,
      holdHost: (hostId) => client.manager.hold(hostId),
    })
  );
  // A host's own settings read and changed by name, with no view needed (#14167).
  teardowns.push(
    installSettingsControlClient({
      client: client.client,
      sessionFor: usedSessionFor,
      holdHost: (hostId) => client.manager.hold(hostId),
    })
  );
  const hostEntry = (hostId: string) =>
    client.client.list().find((entry) => entry.descriptor.id === hostId);
  teardowns.push(
    installPortForwardClient({
      onEndpointOpened: client.onEndpointOpened,
      hostForView: (webContentsId) => hostForView(webContentsId),
      isKnownHost: (hostId) => hostEntry(hostId) !== undefined,
      onHostsChanged: (listener) => client.registry.onChange(listener),
      addUseCheck: (check) => client.manager.addUseCheck(check),
      onSessionOpened: (listener) => client.manager.onSessionOpened(listener),
      sessionFor: client.sessionFor,
      connectionFor: (hostId) => hostEntry(hostId)?.descriptor.connection ?? null,
      clientDir: path.join(app.getPath("userData"), "rh"),
      hostName: (hostId) => hostEntry(hostId)?.descriptor.name ?? null,
      watchView(webContentsId, onGone) {
        const wc = resolveLiveWebContents(webContentsId);
        if (wc) return onWebContentsDestroyed(wc, onGone);
        queueMicrotask(onGone);
        return () => {};
      },
    })
  );
  // This machine's alert choices, sent to every host it opens a session to (#14701).
  teardowns.push(installNotificationPolicyPush(client.manager));
  // Host summaries and notifications: dials only hosts whose notifications are on.
  teardowns.push(
    installHostMetricsClient({
      manager: client.manager,
      registry: client.registry,
      hostForView: client.hostForView,
      openHostForNotice: (windowId, notice) => client.client.openHostForNotice(windowId, notice),
    })
  );
  // Canopy reading a host the view isn't bound to, This Mac included.
  teardowns.push(
    installCanopyHostsClient({
      manager: client.manager,
      registry: client.registry,
      hostForView: client.hostForView,
    })
  );
  // A device paired here answers the agents on the hosts this Shell is connected to.
  teardowns.push(
    installDeviceAnswerHostsClient({
      registry: client.registry,
      manager: client.manager,
      sessionFor: client.sessionFor,
    })
  );
  // Dictation into a host's pane reads the pane's context from that host (#14782).
  teardowns.push(installVoicePaneHostsClient({ sessionFor: client.sessionFor }));
  // This Shell's assistants' reach into its hosts: `host.list` and `host.call` (#13493).
  const observeHosts = () => {
    const metrics = getRemoteService("hostMetrics");
    return client.client.list().map(({ descriptor, connection, summary }) => {
      const onLink =
        summary && metrics ? metrics.cameOn(summary, client.sessionFor(descriptor.id)) : null;
      return {
        hostId: descriptor.id,
        name: descriptor.name,
        connection,
        lastSeenAt: descriptor.lastSeenAt,
        summary,
        summaryReceipt: summary ? (metrics?.receiptOf(summary) ?? null) : null,
        ...(onLink !== null ? { summaryFromCurrentLink: onLink } : {}),
        lastHandshake: descriptor.lastHandshake,
        disconnectedByPerson: client.client.isDisconnectedByPerson(descriptor.id),
      };
    });
  };
  teardowns.push(
    installHostControl({
      observeHosts,
      listHostProjects: (hostId) => client.client.listHostProjects({ hostId }),
      // Never one the person disconnected: listing it isn't a call to it.
      connect: async (hostId, timeoutMs) => {
        if (client.client.isDisconnectedByPerson(hostId)) return;
        client.manager.touch(hostId);
        await client.client.connectAndWait(hostId, timeoutMs);
      },
      isHostControlEnabled: (hostId) =>
        client.registry.get(hostId)?.assistantControlEnabled === true,
      // What `host.watch` hears (#14463): nothing a host isn't already sending.
      watchHosts: (listener) => {
        const offs = [
          client.registry.onChange(() => listener.changed()),
          client.manager.onStateChange(() => listener.changed()),
          getRemoteService("hostMetrics")?.onSummary((hostId) => listener.summary(hostId)) ??
            (() => {}),
        ];
        return () => {
          for (const off of offs) off();
        };
      },
    })
  );
  // The sender each session proves to a host before a call is relayed there.
  teardowns.push(
    installHostControlLinkClient({
      async session(hostId) {
        if (!client.registry.get(hostId)) return null;
        client.manager.touch(hostId);
        if (client.manager.connectionState(hostId).status !== "connected") {
          await client.client.connectAndWait(hostId, HOST_CALL_CONNECT_MS);
        }
        const session = client.sessionFor(hostId);
        return session?.isOpen ? session : null;
      },
      onSessionOpened: (listener) => client.manager.onSessionOpened(listener),
      knownHosts: () => client.registry.list().map((host) => host.id),
      onHostsChanged: (listener) => client.registry.onChange(listener),
      addUseCheck: (check) => client.manager.addUseCheck(check),
      hostName: (hostId) => client.registry.get(hostId)?.name ?? "a removed host",
    })
  );
  // Answered only once a session exists, so registering costs nothing until then.
  teardowns.push(installViewReverseRequests());
  teardowns.push(installWorktreePortRedelivery());
}

/**
 * Host mode couldn't start listening. Everything else is up, so a later
 * handoff or the switch can try again: this run is not deaf for good.
 */
export class HostModeListenError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause, "Host mode couldn't start listening"), { cause });
    this.name = "HostModeListenError";
  }
}

export async function startRemoteHosts(options: StartRemoteHostsOptions): Promise<void> {
  if (started) return;
  started = true;
  // The worktree port override needs the broker, which exists only once the
  // workspace client has finished wiring. Both boot paths start it before
  // this runs; wait out one still in flight, but never start one here.
  if (isWorkspaceClientStarting()) {
    try {
      await ensureWorkspaceClient({});
    } catch (error) {
      logger.warn("Workspace client failed; remote worktree ports are off", { error });
    }
  }
  if (!started) return;
  // A master a crashed launch left behind still holds its port forwards; this
  // launch would otherwise reuse it. Only the system ssh transport makes masters.
  if (!options.createTransport) {
    await exitStaleSshMasters(
      defaultCommandRunner,
      path.join(app.getPath("userData"), "rh"),
      MASTER_EXIT_TIMEOUT_MS
    );
    if (!started) return;
  }
  // This machine's throwaway runs (#14445), for its own assistants and any
  // Shell's; owned by the host role, so a Shell restarted alone keeps them.
  const { registerHostThrowawayRuns } = await import("../services/throwaway/index.js");
  if (!started) return;
  ownedBy("host").push(registerHostThrowawayRuns());
  startClient(options);
  if (__DAINTREE_REMOTE_HOST_ROLE__ && isRemoteHostSupported()) {
    const { startHostRole } = await import("./hostBoot.js");
    // A stop during the load already drained the ledger: nothing would tear a listener down.
    if (!started) return;
    const host = ownedBy("host");
    const listenError = await startHostRole(options, (teardown) => host.push(teardown));
    if (listenError) throw new HostModeListenError(listenError.error);
  }
}

async function drain(role?: Role): Promise<void> {
  const pending = ledger.filter((entry) => role === undefined || entry.role === role);
  ledger = role === undefined ? [] : ledger.filter((entry) => entry.role !== role);
  for (const { teardown } of pending.reverse()) {
    try {
      await teardown();
    } catch (error) {
      console.error("[RemoteHosts] Teardown step failed:", error);
    }
  }
}

export async function stopRemoteHosts(): Promise<void> {
  started = false;
  shellLaunch = null;
  await drain();
}

/**
 * @internal Tests only: the Shell quits, as the app's own stop takes it down
 * (its links say GOODBYE), while the Host in this process keeps running.
 */
export async function _stopRemoteShellForTesting(): Promise<void> {
  shellLaunch = null;
  await drain("shell");
}

/** @internal Tests only: the Shell launches again beside the Host that stayed up. */
export function _startRemoteShellForTesting(options: StartRemoteHostsOptions): void {
  if (!started || shellLaunch !== null) {
    throw new Error("Only a stopped Shell beside a running Host can start again");
  }
  startClient(options);
}
