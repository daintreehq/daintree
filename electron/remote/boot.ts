import path from "node:path";
import { app } from "electron";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { isHostModeRequested } from "../boot/hostModeLaunch.js";
import { ensureWorkspaceClient, isWorkspaceClientStarting } from "../boot/hostServices.js";
import { notifyRemoteViewEndpointOpened } from "../ipc/hostSendRelay.js";
import { setRemoteBoundViewFilter } from "../ipc/utils.js";
import { releaseWindowTerminalPort, setRemoteViewHooks } from "../window/portDistribution.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { resolveLiveWebContents } from "../window/webContentsRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { toDisposable } from "../utils/lifecycle.js";
import { initRemoteHostsClient } from "./client/initClient.js";
import { closeSshMasters } from "./client/sshTransport.js";
import { installViewReverseRequests } from "./client/viewRequests.js";
import { installHostFileClient } from "./files/clientInstall.js";
import { installHostUploadClient } from "./files/uploadClient.js";
import { installHostMetricsClient } from "./metrics/clientInstall.js";
import {
  installAssistantExchangeClient,
  installAssistantMessagingPolicy,
} from "./assistant/install.js";
import { followAppImageMoves } from "./host/appImageRelocation.js";
import { createHostModeService } from "./host/hostModeDefaults.js";
import {
  acceptLocalPushForRemoteView,
  installHybridSplits,
  ViewVisibilityReporter,
} from "./hybrid/index.js";
import { installClipboardSplits } from "./hybrid/clipboard.js";
import { installPickerSplits } from "./hybrid/pickers.js";
import { installPluginClient } from "./plugins/install.js";
import { installPluginInstallSplits, installPluginParityClient } from "./plugins/parity/install.js";
import { installPortForwardClient } from "./ports/clientInstall.js";
import { installHostSwitchService } from "./projects/clientInstall.js";
import { registerRemoteService } from "./runtime.js";
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

// The composition root owns window creation; it installs the opener through this module.
export { setRemoteHostsWindowOpener } from "./client/initClient.js";

/**
 * Entry point for everything Remote Hosts starts in the main process. Loaded
 * only through `if (__DAINTREE_REMOTE_HOSTS__) { await import("./remote/boot.js") }`
 * so Windows builds carry none of it. Services register themselves into
 * `./runtime.ts`; core code reaches them from there.
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

/** Run in reverse on stop, so each piece goes before what it was built on. */
let teardowns: Teardown[] = [];
let started = false;

/** Each ssh master may take this long to answer `-O exit` at quit; they are asked together. */
const MASTER_EXIT_TIMEOUT_MS = 1_000;
/** Long enough for a sleeping host's link to come back; a send that can't wait reports it unreachable. */
const ASSISTANT_EXCHANGE_CONNECT_MS = 10_000;

function startClient(options: StartRemoteHostsOptions): void {
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
    if (activated || !started) return;
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
    })
  );
  // Host summaries and notifications: dials only hosts whose notifications are on.
  teardowns.push(
    installHostMetricsClient({
      manager: client.manager,
      registry: client.registry,
      hostForView: client.hostForView,
    })
  );
  // Holds consent only; nothing reaches an assistant through it until a person enrolls a lane.
  teardowns.push(
    installAssistantMessagingPolicy({
      isHostMessagingEnabled: (hostId) =>
        client.registry.get(hostId)?.assistantMessagingEnabled === true,
    })
  );
  // Exchanges this Shell sends to hosts' assistants: reconciled whenever a session to one opens.
  teardowns.push(
    installAssistantExchangeClient({
      async session(hostId) {
        if (!client.registry.get(hostId)) return null;
        client.manager.touch(hostId);
        if (client.manager.connectionState(hostId).status !== "connected") {
          await client.client.connectAndWait(hostId, ASSISTANT_EXCHANGE_CONNECT_MS);
        }
        const session = client.sessionFor(hostId);
        return session?.isOpen ? session : null;
      },
      onSessionOpened: (listener) => client.manager.onSessionOpened(listener),
      knownHosts: () => client.registry.list().map((host) => host.id),
      onHostsChanged: (listener) => client.registry.onChange(listener),
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
      console.warn("[RemoteHosts] Workspace client failed; remote worktree ports are off:", error);
    }
  }
  if (!started) return;
  startClient(options);
  // Registered whatever the setting, so the switch can start it at runtime.
  const hostMode = createHostModeService({ location: options.hostLocation });
  teardowns.push(registerRemoteService("hostMode", hostMode));
  teardowns.push(() => hostMode.dispose());
  const listenError: { error: unknown } | null = options.hostMode
    ? await hostMode.startListening().then(
        () => null,
        (error: unknown) => ({ error })
      )
    : null;
  // Started by its login item or unit: bring that item up to this build's text.
  if (isHostModeRequested(process.argv)) void hostMode.refreshStartAtLogin();
  // Never torn down: the updater renames an AppImage after this has stopped.
  followAppImageMoves();
  if (listenError) throw new HostModeListenError(listenError.error);
}

export async function stopRemoteHosts(): Promise<void> {
  started = false;
  const pending = teardowns;
  teardowns = [];
  for (const teardown of pending.reverse()) {
    try {
      await teardown();
    } catch (error) {
      console.error("[RemoteHosts] Teardown step failed:", error);
    }
  }
}
