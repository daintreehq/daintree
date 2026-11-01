import crypto from "node:crypto";
import path from "node:path";
import { app, type WebContents } from "electron";
import type { HostRestartImpact, RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import { MetricsLinkMethod, RestartImpactSchema } from "../metrics/linkMethods.js";
import {
  isLocalHostId,
  parseHostScopedKey,
  toHostScopedKey,
  type HostConnection,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  discardFromAllProjectHistories,
  getProjectHistory,
} from "../../services/ProjectHistoryService.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { AppError, isAppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  getAllAppWebContents,
  getAppWebContents,
  getProjectForWebContents,
  getWindowForWebContents,
  resolveLiveWebContents,
} from "../../window/webContentsRegistry.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { completeLocalProjectActivation } from "../../window/localProjectActivation.js";
import {
  claimProjectActivation,
  findOtherProjectOwner,
  hasReusableProjectView,
  redirectToProjectOwner,
  releaseCachedOwner,
  revealWindow,
  type ProjectOwner,
} from "../../window/projectOwnership.js";
import { hasPendingActivation } from "../../window/projectActivationClaims.js";
import { confirmColdOpenAtMemoryPressure } from "../../services/projectOpenMemoryPressure.js";
import { checkKernelPressureCritical } from "../../services/SystemMemoryPressureMonitor.js";
import { activateScratchInWindow } from "../../ipc/handlers/scratch/activation.js";
import {
  getPtyClient,
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
} from "../../window/serviceRefs.js";
import { toDisposable } from "../../utils/lifecycle.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import {
  forgetRemoteWorkspaceTitles,
  setRemoteHostNameResolver,
} from "../../window/windowTitle.js";
import { clearPendingRemoteRestoresForHost } from "../../window/openWindowsTracker.js";
import { forgetRemoteRestoresForHost } from "../../window/remoteWindowRestore.js";
import { clearHostPartitions } from "../../services/sessionCacheCleaner.js";
import { getSystemSleepService } from "../../services/SystemSleepService.js";
import { forgetHostState, type HostStateCleanup } from "./forgetHostState.js";
import { HostRegistry, type RemoteHostsStore } from "./HostRegistry.js";
import {
  RemoteHostManager,
  type EndpointClosedInfo,
  type HostReadiness,
  type EndpointSessionInfo,
  type ViewSink,
} from "./RemoteHostManager.js";
import { RemoteHostsClient, type WindowControl } from "./RemoteHostsClient.js";
import { watchOwnedHostCleanup } from "./ownedHostCleanup.js";
import { RemoteRouterImpl, type SenderLookup } from "./RemoteRouter.js";
import { answerReverseRequest } from "./reverseRequests.js";
import { requireSupportedConnection } from "./connection.js";
import { SshTransport } from "./sshTransport.js";
import { HostStarts } from "./hostStarts.js";
import { WslKeepalive } from "./wslKeepalive.js";
import { WslTransport } from "./wslTransport.js";
import { UnusableConnectionError, type LinkTransport } from "./transport.js";
import { WindowHostBinding } from "./WindowHostBinding.js";
import { defaultCommandRunner } from "./commandRunner.js";
import { readOrCreateDeviceId } from "./deviceId.js";
import { machineDisplayName } from "../../utils/machineName.js";
import { detectClientBundle, downloadArtifact } from "./clientBuild.js";
import { HostSetupService, RELEASE_FEED_PREFIXES } from "./HostSetupService.js";

declare module "../runtime.js" {
  interface RemoteServices {
    remoteHostsClient: RemoteHostsClient;
    hostSetup: HostSetupService;
  }
}

type AgentsSource = (hostId: HostId) => { working: number; waiting: number } | null;

let agentsSource: AgentsSource | null = null;

/**
 * Every check before a restart asks the host afresh: a count from an earlier
 * refusal may say zero after an agent has started.
 */
const MISMATCH_OBSERVATION_MAX_AGE_MS = 0;

/**
 * Where a host's agent counts come from for the update gate when the host
 * can't list what a restart ends (one from before it could). Until a source
 * is set the host list's summary frame is read; with no summary the count is
 * unknown, and the update says so.
 */
export function setHostAgentsSource(source: AgentsSource | null): void {
  agentsSource = source;
}

/** How long an update waits for a host it has to dial before asking it what a restart ends. */
const RESTART_IMPACT_CONNECT_MS = 15_000;

/** `onRegistered` runs synchronously, before window setup awaits anything. */
type WindowOpener = (options?: { onRegistered?: (windowId: number) => void }) => Promise<number>;

let windowOpener: WindowOpener | null = null;

/**
 * How a Cmd/Ctrl-click on a host opens a fresh window. Window creation lives
 * in the composition root, which sets this once windows can be made.
 */
export function setRemoteHostsWindowOpener(opener: WindowOpener | null): void {
  windowOpener = opener;
}

function broadcastLocal(event: RemoteHostsEvent): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.REMOTE_HOSTS_EVENT, event);
    } catch {
      // A view mid-teardown.
    }
  }
}

function createViewSink(hostOf: (webContentsId: number) => HostId | null): ViewSink {
  const sink: ViewSink = {
    send(webContentsId, channel, args) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) return false;
      const deliver = () => {
        try {
          wc.send(channel, ...args);
          return true;
        } catch {
          return false;
        }
      };
      // The host waits on this view's answer to a resume, and a cached view
      // may be frozen: thawed first, as the host thaws its own.
      if (channel === CHANNELS.CANOPY_RESUME_REQUESTED) {
        thawThenSend(wc, () => !wc.isDestroyed(), deliver);
        return true;
      }
      return deliver();
    },
    watch(webContentsId, onGone) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) {
        queueMicrotask(onGone);
        return () => {};
      }
      return onWebContentsDestroyed(wc, onGone);
    },
    resync(webContentsId, hostId, reason, previousEnd) {
      const event: RemoteHostsEvent = {
        type: "resync-required",
        hostId,
        reason,
        ...(reason === "host-restarted" && previousEnd && { previousEnd }),
      };
      sink.send(webContentsId, CHANNELS.REMOTE_HOSTS_EVENT, [event]);
    },
    hostOf,
    agentActivated(webContentsId) {
      const wc = resolveLiveWebContents(webContentsId);
      const win = wc ? getWindowForWebContents(wc) : null;
      if (!win || win.isDestroyed()) return;
      // The sweep re-asks the host per view, so it wakes only views still
      // cached, still bound to it and still active, and only under efficiency.
      getWindowRegistry()
        ?.getByWindowId(win.id)
        ?.services.projectViewManager?.unfreezeActiveAgentViews();
    },
  };
  return sink;
}

const senders: SenderLookup = {
  projectKeyFor: (webContentsId) => getProjectForWebContents(webContentsId),
  windowIdFor(webContentsId) {
    const wc = resolveLiveWebContents(webContentsId);
    const win = wc ? getWindowForWebContents(wc) : null;
    return win && !win.isDestroyed() ? win.id : null;
  },
  onGone(webContentsId, callback) {
    const wc = resolveLiveWebContents(webContentsId);
    if (wc) onWebContentsDestroyed(wc, callback);
    else queueMicrotask(callback);
  },
};

function managerFor(windowId: number) {
  const pvm = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
  if (!pvm) {
    throw new AppError({ code: "INTERNAL", message: `Window ${windowId} has no project views` });
  }
  return pvm;
}

export interface RemoteHostsClientHooks {
  /** How each host is reached; system ssh unless given. */
  createTransport?: (descriptor: HostDescriptor) => LinkTransport;
  /** The first time a host is actually used (see RemoteHostsClientOptions.onFirstUse). */
  onFirstUse?: () => void;
  /** A window now shows a remote project view: newly created, or a cached one reactivated. */
  onRemoteViewActivated?: (windowId: number, webContents: WebContents, isNew: boolean) => void;
  /** A window this client moved back to a workspace on this machine now shows its view. */
  onLocalViewActivated?: (windowId: number, webContents: WebContents) => void;
}

/**
 * Fold a switch this client made into the window's history, the list the
 * "previous workspace" toggle reads: the workspace being left first, so it
 * lands directly behind the one arrived at. Remote workspaces are recorded by
 * their host-scoped key, so toggling back returns to the right host too.
 */
function recordWindowSwitch(windowId: number, from: string | null, to: string): void {
  const history = getProjectHistory(windowId);
  if (from) history.record(from);
  history.record(to);
}

/** A local workspace a window can return to: an open project, or a scratch that still exists. */
function isOpenLocalWorkspace(workspaceId: string): boolean {
  if (isScratchWorkspaceId(workspaceId)) return Boolean(scratchStore.getScratchById(workspaceId));
  const project = projectStore.getProjectById(workspaceId);
  return project !== null && project !== undefined && project.status !== "closed";
}

/** A view key naming one of this machine's projects: not a scratch, not a host's. */
function isLocalProjectKey(key: string): boolean {
  return isLocalHostId(parseHostScopedKey(key).hostId) && !isScratchWorkspaceId(key);
}

/** The window other than `windowId` with a live view of a workspace (a view key), if any. */
function otherOwnerOf(key: string, windowId: number | null) {
  const registry = getWindowRegistry() ?? undefined;
  return findOtherProjectOwner(
    registry,
    key,
    windowId === null
      ? {}
      : {
          windowId,
          projectViewManager:
            registry?.getByWindowId(windowId)?.services.projectViewManager ?? null,
        }
  );
}

/**
 * Where a window coming back to this machine lands: its own most recent local
 * workspace, else the most recently opened project. One another window is
 * showing is passed over, since a project has one view in the app. One of this
 * window's own that another window only keeps cached is let go by that window
 * when this one opens it; the fallback never takes one, so windows returning
 * home together don't take each other's projects.
 */
function lastLocalProjectId(windowId: number | null): string | null {
  if (windowId !== null) {
    for (const key of getProjectHistory(windowId).snapshot().entries) {
      if (
        isLocalHostId(parseHostScopedKey(key).hostId) &&
        isOpenLocalWorkspace(key) &&
        !shownElsewhere(key, windowId)
      ) {
        return key;
      }
    }
  }
  let latest: { id: string; lastOpened: number } | null = null;
  for (const project of projectStore.getAllProjects()) {
    if (project.status === "closed" || otherOwnerOf(project.id, windowId)) continue;
    const lastOpened = typeof project.lastOpened === "number" ? project.lastOpened : 0;
    if (!latest || lastOpened > latest.lastOpened) latest = { id: project.id, lastOpened };
  }
  return latest?.id ?? null;
}

/** Best effort: a title that fails to update must not fail the switch that committed. */
function refreshWindowTitles(): void {
  void import("../../services/NotificationService.js").then(
    ({ notificationService }) => notificationService.refreshTitles(),
    () => {}
  );
}

/** This window's projects on `hostId`, most recent first, from its own history. */
function recentProjectsOnHost(windowId: number | null, hostId: HostId): string[] {
  if (windowId === null) return [];
  const projectIds: string[] = [];
  for (const key of getProjectHistory(windowId).snapshot().entries) {
    const parsed = parseHostScopedKey(key);
    if (parsed.hostId === hostId && !projectIds.includes(parsed.projectId)) {
      projectIds.push(parsed.projectId);
    }
  }
  return projectIds;
}

/**
 * Whether a window other than `windowId` is showing a workspace, or on its way
 * to it: a cached view its own window has claimed is being brought to the front.
 */
function shownElsewhere(key: string, windowId: number | null): boolean {
  const owner = otherOwnerOf(key, windowId);
  return owner !== null && isShowing(owner, key);
}

function isShowing(owner: ProjectOwner, key: string): boolean {
  return owner.state !== "cached" || hasPendingActivation(key, owner.context.windowId);
}

function createWindowControl(hooks: RemoteHostsClientHooks): WindowControl {
  // This client's switches run one at a time per window, so each reads the
  // workspace it is leaving only once the one before it has landed: two
  // switches queued together would otherwise both record the same origin.
  const chains = new Map<number, Promise<unknown>>();
  const inTurn = <T>(windowId: number, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(windowId) ?? Promise.resolve()).then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    chains.set(windowId, settled);
    void settled.then(() => {
      if (chains.get(windowId) === settled) chains.delete(windowId);
    });
    return run;
  };
  return {
    async openWindow() {
      if (!windowOpener) {
        throw new AppError({
          code: "UNSUPPORTED",
          message: "Opening a host in a new window is not wired",
          userMessage: "Couldn't open a new window for this host.",
        });
      }
      return windowOpener();
    },
    openRemoteProject(windowId, hostId, projectId, projectPath, focusIntent, request) {
      return inTurn(windowId, async () => {
        const pvm = managerFor(windowId);
        const from = pvm.getActiveProjectId();
        // Before the swap, as a local switch records it: the view consumes it on activation.
        if (focusIntent) pvm.setPendingFocusIntent(toHostScopedKey(hostId, projectId), focusIntent);
        const { view, isNew } = await pvm.switchToHostProject(
          hostId,
          projectId,
          projectPath,
          undefined,
          { ...request, switchScreenHandoff: true }
        );
        recordWindowSwitch(windowId, from, toHostScopedKey(hostId, projectId));
        // The title names the place: "<project> — <host>".
        refreshWindowTitles();
        const wc = view.webContents;
        if (wc && !wc.isDestroyed()) hooks.onRemoteViewActivated?.(windowId, wc, isNew);
      });
    },
    async openLocalProject(windowId, projectId, focusIntent, request) {
      // A scratch is a workspace a view shows like a project, with no project row.
      const scratch = isScratchWorkspaceId(projectId)
        ? scratchStore.getScratchById(projectId)
        : null;
      const project = scratch ? null : projectStore.getProjectById(projectId);
      const workspace = scratch ?? project;
      if (!workspace) {
        throw new AppError({ code: "NOT_FOUND", message: `No local project ${projectId}` });
      }
      await inTurn(windowId, async () => {
        const pvm = managerFor(windowId);
        const from = pvm.getActiveProjectId();
        if (focusIntent) pvm.setPendingFocusIntent(workspace.id, focusIntent);
        const { view, isNew } = await pvm.switchTo(workspace.id, workspace.path, undefined, {
          ...request,
          switchScreenHandoff: true,
        });
        recordWindowSwitch(windowId, from, workspace.id);
        const registry = getWindowRegistry();
        const win = registry?.getByWindowId(windowId)?.browserWindow;
        if (scratch && win && !win.isDestroyed()) {
          activateScratchInWindow({
            scratch,
            windowId,
            window: win,
            view: view.webContents,
            windowRegistry: registry,
            ptyClient: getPtyClient(),
          });
        } else if (project && win && !win.isDestroyed()) {
          await completeLocalProjectActivation({
            targetWindow: win,
            project,
            view,
            isNew,
            outgoingProjectId: from !== null && isLocalProjectKey(from) ? from : null,
            switchId: crypto.randomUUID(),
            clients: {
              workspace: getWorkspaceClientRef(),
              broker: getWorktreePortBrokerRef(),
              pty: getPtyClient(),
            },
            logPrefix: "[RemoteHosts]",
          });
        }
        refreshWindowTitles();
        const wc = view.webContents;
        if (wc && !wc.isDestroyed()) hooks.onLocalViewActivated?.(windowId, wc);
      });
    },
    async restoreRemoteProjectInBackground(
      windowId,
      hostId,
      projectId,
      projectPath,
      { lastUsed, stillWanted }
    ) {
      // First, as the local restore queue does: the kernel pressure reading
      // its admission works from may hold nothing yet at startup (#13530).
      await checkKernelPressureCritical();
      const pvm = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
      // A quit, or the host removed or re-pointed, while the reading was taken.
      if (!pvm || pvm.disposed || !stillWanted()) return "cancelled";
      const key = toHostScopedKey(hostId, projectId);
      // Asked again after the reading, in the same tick the view is registered.
      if (otherOwnerOf(key, windowId)) return "owned-elsewhere";
      // Never on this window's switch turn: a background boot runs for tens of
      // seconds, and the view manager reconciles a switch to it that lands meanwhile.
      const result = await pvm.restoreInBackground(key, projectPath, { lastUsed });
      return result.status === "skipped" ? result.reason : result.status;
    },
    lastLocalProjectId,
    recentProjectsOnHost,
    projectOwner(hostId, projectId, exceptWindowId) {
      const key = isLocalHostId(hostId) ? projectId : toHostScopedKey(hostId, projectId);
      const owner = otherOwnerOf(key, exceptWindowId);
      return owner ? { windowId: owner.context.windowId, showing: isShowing(owner, key) } : null;
    },
    claimProject(hostId, projectId, windowId) {
      const key = isLocalHostId(hostId) ? projectId : toHostScopedKey(hostId, projectId);
      return claimProjectActivation(key, windowId);
    },
    releaseCachedProject(hostId, projectId, windowId, projectName) {
      const key = isLocalHostId(hostId) ? projectId : toHostScopedKey(hostId, projectId);
      const name =
        projectName ??
        projectStore.getProjectById(projectId)?.name ??
        scratchStore.getScratchById(projectId)?.name ??
        projectId;
      return releaseCachedOwner(otherOwnerOf(key, windowId), key, name)?.context.windowId ?? null;
    },
    redirectToLocalOwner(projectId, exceptWindowId) {
      const owner = otherOwnerOf(projectId, exceptWindowId);
      // One holding the project only in its cache is never switched to it.
      if (!owner || owner.state === "cached") return null;
      const project = projectStore.getProjectById(projectId);
      if (project) {
        const result = redirectToProjectOwner(owner, project);
        return "targetWindowId" in result ? result.targetWindowId : owner.context.windowId;
      }
      // A scratch has no project row to hand over: its window comes forward.
      revealWindow(owner.context.browserWindow);
      return owner.context.windowId;
    },
    admitProjectOpen({ windowId, askingWindowId, hostId, projectId, projectName, signal }) {
      const registry = getWindowRegistry();
      if (windowId !== null) {
        const key = isLocalHostId(hostId) ? projectId : toHostScopedKey(hostId, projectId);
        // A view the window can show as it is starts nothing.
        const pvm = registry?.getByWindowId(windowId)?.services.projectViewManager;
        if (hasReusableProjectView(pvm, key)) return Promise.resolve(true);
      }
      const parentId = windowId ?? askingWindowId;
      const answer = confirmColdOpenAtMemoryPressure({
        projectId,
        projectName:
          projectName ??
          projectStore.getProjectById(projectId)?.name ??
          scratchStore.getScratchById(projectId)?.name ??
          projectId,
        parent: parentId === null ? null : registry?.getByWindowId(parentId)?.browserWindow,
        signal,
      });
      return answer.then((choice) => choice !== "cancel");
    },
    revealWindow(windowId) {
      const ctx = getWindowRegistry()?.getByWindowId(windowId);
      if (!ctx || ctx.browserWindow.isDestroyed()) return;
      revealWindow(ctx.browserWindow);
      // Focusing the window doesn't hand keyboard focus to its project view.
      const wc = ctx.services.projectViewManager?.getActiveView()?.webContents;
      if (wc && !wc.isDestroyed()) wc.focus();
    },
    focusInWindow(windowId, hostId, projectId, focusIntent) {
      const pvm = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
      if (!pvm) return;
      const key = isLocalHostId(hostId) ? projectId : toHostScopedKey(hostId, projectId);
      // On screen there and done arriving: the view hears it now. Otherwise the
      // switch bringing it there delivers it, and any other switch discards it.
      const wc = pvm.getActiveProjectId() === key ? pvm.getActiveView()?.webContents : undefined;
      if (wc && !wc.isDestroyed() && pvm.getOutgoingBridgeProjectId() === null) {
        wc.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, focusIntent);
        return;
      }
      pvm.setPendingFocusIntent(key, focusIntent);
    },
    showsHost(windowId, hostId) {
      const pvm = getWindowRegistry()?.getByWindowId(windowId)?.services.projectViewManager;
      if (!pvm) return false;
      return [pvm.getActiveProjectId(), pvm.getOutgoingBridgeProjectId()].some(
        (key) => key !== null && parseHostScopedKey(key).hostId === hostId
      );
    },
    showsView(windowId, webContentsId) {
      const win = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!win || win.isDestroyed()) return false;
      return (win.contentView?.children ?? []).some(
        (child) =>
          (child as { webContents?: Electron.WebContents }).webContents?.id === webContentsId
      );
    },
    async replaceWithLocalWindow(windowId) {
      const old = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!old || old.isDestroyed()) return;
      if (!windowOpener) throw new Error("No window can be opened yet");
      const opener = windowOpener;
      const bounds = old.getNormalBounds();
      const maximized = old.isMaximized();
      const fullScreen = old.isFullScreen();
      let replaced = false;
      // The old window closes the moment its successor exists, synchronously:
      // nothing (a switch, a quit's window snapshot) can come between the two,
      // and there is never a moment with neither window open.
      await opener({
        onRegistered: (nextId) => {
          const created = getWindowRegistry()?.getByWindowId(nextId)?.browserWindow;
          if (!created || created.isDestroyed() || old.isDestroyed()) return;
          // In the old window's place and mode, over whatever the last window's saved state was.
          if (created.isMaximized()) created.unmaximize();
          created.setBounds(bounds);
          if (maximized) created.maximize();
          if (fullScreen) {
            created.once("show", () => {
              if (!created.isDestroyed()) created.setFullScreen(true);
            });
          }
          old.close();
          replaced = true;
        },
      });
      if (!replaced && !old.isDestroyed()) throw new Error("The replacement window didn't open");
    },
    appViewId(windowId) {
      const win = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!win || win.isDestroyed()) return null;
      const wc = getAppWebContents(win);
      return wc.isDestroyed() ? null : wc.id;
    },
    offerHostProjects(windowId) {
      const win = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!win || win.isDestroyed()) return;
      // A window with no project shows its first view.
      const view = win.contentView.children[0] as
        { webContents?: Electron.WebContents } | undefined;
      const wc = view?.webContents;
      // A view still loading asks for the offer itself once it can show it.
      if (!wc || wc.isDestroyed() || wc.isLoadingMainFrame()) return;
      const event: RemoteHostsEvent = { type: "project-offer" };
      wc.send("remote-hosts:event", event);
    },
    notifyWindow(windowId, event) {
      const win = getWindowRegistry()?.getByWindowId(windowId)?.browserWindow;
      if (!win || win.isDestroyed()) return;
      // The views on screen: a cached view picks the state up when shown, by asking.
      for (const child of win.contentView?.children ?? []) {
        const wc = (child as { webContents?: Electron.WebContents }).webContents;
        if (!wc || wc.isDestroyed()) continue;
        try {
          wc.send(CHANNELS.REMOTE_HOSTS_EVENT, event);
        } catch {
          // A view mid-teardown.
        }
      }
    },
    watchWindow(windowId, onClosed) {
      const ctx = getWindowRegistry()?.getByWindowId(windowId);
      if (!ctx || ctx.browserWindow.isDestroyed()) {
        queueMicrotask(onClosed);
        return;
      }
      // The window's own cleanup, not another "closed" listener: the main
      // window already carries ten, and an unpackaged build exits on the
      // eleventh (devDiagnostics' MaxListenersExceededWarning guard).
      ctx.cleanup.add(toDisposable(onClosed));
    },
  };
}

/**
 * Everything this device keeps under a host's id, cleared when the host is
 * removed. Its windows are already back on this machine by then, so its views
 * here are cached ones, discarded before the storage they could write back to
 * is cleared.
 */
const HOST_STATE_CLEANUPS: readonly HostStateCleanup[] = [
  {
    name: "plugin permissions",
    async run(hostId) {
      const [{ forgetRunClipboardGrants }, { persistedClipboardGrants }, consent, install] =
        await Promise.all([
          import("../plugins/shellRequests.js"),
          import("../plugins/clipboardGrants.js"),
          import("../plugins/pluginViewConsent.js"),
          import("../plugins/install.js"),
        ]);
      // This run's answers and open questions go first, with nothing awaited between.
      forgetRunClipboardGrants(hostId);
      persistedClipboardGrants.reset(hostId);
      install.revokePluginViewDecisions(hostId);
      consent.persistedPluginViewConsent.reset(hostId);
    },
  },
  {
    name: "workspace history",
    run: (hostId) =>
      discardFromAllProjectHistories(
        (workspaceId) => parseHostScopedKey(workspaceId).hostId === hostId
      ),
  },
  { name: "window titles", run: forgetRemoteWorkspaceTitles },
  { name: "window restores", run: clearPendingRemoteRestoresForHost },
  { name: "window restore retries", run: forgetRemoteRestoresForHost },
  {
    name: "window bounds",
    async run(hostId) {
      const { pruneWindowStatesForHost } = await import("../../windowState.js");
      pruneWindowStatesForHost(hostId);
    },
  },
  {
    name: "cached views",
    run(hostId) {
      for (const ctx of getWindowRegistry()?.all() ?? []) {
        const pvm = ctx.services.projectViewManager;
        if (!pvm) continue;
        // What the window shows, or still shows while a switch home loads, stays.
        const onScreen = new Set([pvm.getActiveProjectId(), pvm.getOutgoingBridgeProjectId()]);
        for (const entry of pvm.getAllViews()) {
          if (onScreen.has(entry.projectId)) continue;
          if (parseHostScopedKey(entry.projectId).hostId !== hostId) continue;
          // One still loading has a restore that would finish it: stop that first.
          pvm.abandonBackgroundRestore(entry.projectId);
          pvm.destroyView(entry.projectId);
        }
      }
    },
  },
  {
    name: "view storage",
    run: (hostId) => broadcastLocal({ type: "host-forgotten", hostId }),
  },
  { name: "browser data", run: clearHostPartitions },
];

/**
 * Where a WSL distro's Host may listen: a packaged one's runtime directory,
 * and, for a development build of this app, a development Host's too.
 */
const WSL_RUNTIME_DIR_NAMES = app.isPackaged ? ["daintree"] : ["daintree", "daintree-dev"];

/** How a host's link is opened, by how it is reached. */
function transportFor(
  connection: HostConnection,
  clientDir: string,
  wsl: {
    keepalive: WslKeepalive;
    /** The host is being removed or re-pointed: its old distro must not be held again. */
    isRetiring(connection: HostConnection): boolean;
  },
  ensureRunning?: (signal: AbortSignal) => Promise<boolean>
): LinkTransport {
  let supported: HostConnection;
  try {
    supported = requireSupportedConnection(connection);
  } catch (error) {
    // Reported as the link's own failure, so every caller sees why without a throw to catch.
    const reason = isAppError(error)
      ? (error.userMessage ?? error.message)
      : formatErrorMessage(error, "This host can't be reached from here");
    return {
      open: () => Promise.reject(new UnusableConnectionError(reason, reason)),
    };
  }
  switch (supported.kind) {
    case "ssh":
      return new SshTransport({ target: supported.target, clientDir, ensureRunning });
    case "wsl":
      return new WslTransport({
        distro: supported.distro,
        run: defaultCommandRunner,
        keepalive: (distro) => {
          if (!wsl.isRetiring(supported)) wsl.keepalive.want(distro);
        },
        ensureRunning,
        runtimeDirNames: WSL_RUNTIME_DIR_NAMES,
      });
  }
}

/**
 * Start the Shell side of Remote Hosts: the host list, per-host connections
 * (dialled when something needs the host, kept for one whose notifications
 * are on, and closed again once unused), window bindings and the
 * dispatcher's router (installed on first use, so a user with no hosts runs
 * every call exactly as before).
 */
export function initRemoteHostsClient(hooks: RemoteHostsClientHooks = {}): {
  client: RemoteHostsClient;
  /** Every time a local view's endpoint is live on a host session (opened, or carried by a resume). */
  onEndpointOpened(listener: (hostId: string, info: EndpointSessionInfo) => void): () => void;
  /** A view's endpoint on a host was discarded (view gone, moved host, connection stopped). */
  onEndpointClosed(listener: (hostId: string, info: EndpointClosedInfo) => void): () => void;
  /** The view's authoritative host, or null when it runs on this machine. */
  hostForView(webContentsId: number): HostId | null;
  /** The dispatcher's router, for Shell-side relays that forward on a view's behalf. */
  router: RemoteRouterImpl;
  /** The host's open session, whether or not a local view has an endpoint on it. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** Per-host links and the host list, for session-level services such as host summaries. */
  manager: RemoteHostManager;
  /** Sends a Remote Hosts event to every view on this machine. */
  emitLocal(event: RemoteHostsEvent): void;
  registry: HostRegistry;
  dispose(): Promise<void>;
} {
  const registry = new HostRegistry(store as unknown as RemoteHostsStore);
  // Remote windows' titles name their host as it is called now.
  setRemoteHostNameResolver((hostId) => registry.get(hostId)?.name ?? null);
  const stopTitleRefresh = registry.onChange(refreshWindowTitles);
  const clientDir = path.join(app.getPath("userData"), "rh");
  const wslKeepalive = new WslKeepalive();
  // Bound below: the sink needs the router's answer, the router needs the manager.
  let router: RemoteRouterImpl | null = null;
  const hostForView = (webContentsId: number) => router?.hostForSender(webContentsId) ?? null;
  const sleep = getSystemSleepService();
  const awakeSince = (since: number) => sleep.getAwakeTimeSince(since);
  const manager = new RemoteHostManager({
    registry,
    createTransport:
      hooks.createTransport ??
      ((descriptor) =>
        transportFor(
          descriptor.connection,
          clientDir,
          // A dial while the host is removed or re-pointed (a notification, an
          // update's reconnect) would hold the old distro after its release.
          { keepalive: wslKeepalive, isRetiring: (connection) => client.isRetiring(connection) },
          (signal) => starts.ensureRunning(descriptor.id, descriptor.connection, signal)
        )),
    handshake: getLocalHandshakeInfo,
    client: {
      // Per launch: a session only resumes within one run of this app.
      clientId: crypto.randomUUID(),
      clientName: machineDisplayName(),
      deviceId: readOrCreateDeviceId(clientDir),
      platform:
        process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    },
    views: createViewSink(hostForView),
    reverseRequests: answerReverseRequest,
    session: { awakeSince },
    awakeSince,
  });
  const stopWakeWatch = sleep.onWake(() => manager.systemResumed());
  const bindings = new WindowHostBinding();
  const remoteRouter = new RemoteRouterImpl(manager, bindings, senders);
  router = remoteRouter;
  const client: RemoteHostsClient = new RemoteHostsClient({
    registry,
    manager,
    bindings,
    router: remoteRouter,
    senders,
    windows: createWindowControl(hooks),
    installRouter: (next) => {
      if (next) remoteRouter.learn(getAllAppWebContents().map((wc) => wc.id));
      getIpcDispatcher().setRemoteRouter(next);
    },
    emit: broadcastLocal,
    onFirstUse: hooks.onFirstUse,
    onForget: async (descriptor): Promise<void> => {
      await forgetHostState(descriptor.id, HOST_STATE_CLEANUPS);
      await setup.forgetArtifacts(descriptor);
    },
    // The id stays, so everything kept under it about the old machine goes, as on removal.
    onRetarget: async (before): Promise<void> => {
      await forgetHostState(before.id, HOST_STATE_CLEANUPS);
      await setup.forgetArtifacts(before);
    },
    isStarting: (hostId) => starts.isStarting(hostId),
    isInstalling: (connection) => setup.isInstallRunning(connection),
    onRetry: (hostId) => recheckStart(hostId),
  });
  const starts = new HostStarts({
    setup: {
      ensureHostRunning: (connection, signal, onStart) =>
        setup.ensureHostRunning(connection, signal, onStart),
    },
    onChange: (hostId) => client.refreshPendingSwitches(hostId),
  });
  const recheckStart = (hostId: HostId): void => {
    const descriptor = registry.get(hostId);
    if (descriptor) setup.recheckStart(descriptor.connection);
  };
  const setup: HostSetupService = new HostSetupService({
    run: defaultCommandRunner,
    clientDir,
    platform: process.platform,
    knownConnections: () => registry.list().map((host) => host.connection),
    clientBuild: () => {
      const handshake = getLocalHandshakeInfo();
      return {
        platform: handshake.platform,
        arch: handshake.arch,
        version: handshake.version,
        commit: handshake.commit,
        channel: store.get("updateChannel") === "nightly" ? "nightly" : "stable",
        bundle: detectClientBundle({
          isPackaged: app.isPackaged,
          exePath: app.getPath("exe"),
          platform: process.platform,
          env: process.env,
        }),
      };
    },
    async restartImpact(hostId): Promise<HostRestartImpact> {
      const unknown: HostRestartImpact = { detail: null, agents: null };
      if (!hostId || !registry.get(hostId)) return unknown;
      // Nothing dials a host on its own any more: asking what a restart ends is a use,
      // and an update waiting for idle keeps its connection from being released.
      manager.touch(hostId);
      if (manager.connectionState(hostId).status !== "connected") {
        await client.connectAndWait(hostId, RESTART_IMPACT_CONNECT_MS);
      }
      const connection = manager.get(hostId);
      // A host on another build refuses the link, and with it everything below;
      // its refusal says how many agents are working, and nothing about waiting.
      if (connection?.linkState.status === "version-mismatch") {
        const working = await connection.workingAgentsWhileMismatched({
          maxAgeMs: MISMATCH_OBSERVATION_MAX_AGE_MS,
          timeoutMs: 15_000,
        });
        return { detail: null, agents: working === null ? null : { working, waiting: null } };
      }
      const session = connection?.currentSession ?? null;
      if (session) {
        try {
          const parsed = RestartImpactSchema.safeParse(
            await session.call(MetricsLinkMethod.RESTART_IMPACT, null, { timeoutMs: 10_000 })
          );
          if (parsed.success && parsed.data.detail) return parsed.data;
        } catch {
          // A host from before it could say (UNSUPPORTED), or one that didn't answer: counts below.
        }
      }
      // Only a connected host's counts are current: a summary kept from before
      // a drop may say zero about agents that have started since.
      if (manager.connectionState(hostId).status !== "connected") return unknown;
      const agents = agentsSource
        ? agentsSource(hostId)
        : (() => {
            const observed = client.list().find((host) => host.descriptor.id === hostId)
              ?.summary?.agentsObserved;
            return observed ? { working: observed.working, waiting: observed.waiting } : null;
          })();
      return { detail: null, agents };
    },
    async reconnect(hostId) {
      // Dialled whether or not a link was up: an update can follow a Disconnect.
      if (!registry.get(hostId)) return null;
      const readiness: HostReadiness = await client.connectAndWait(hostId, 30_000);
      if (readiness === "version-mismatch") return false;
      if (readiness !== "ready") return null;
      // Confirming an update takes the exact build answering: a different one
      // still connects, best effort, so being connected alone proves nothing.
      const state = manager.get(hostId)?.linkState;
      return state?.status === "connected" && state.buildMismatch === null;
    },
    download: (url, destination, signal) =>
      downloadArtifact({ url, destination, signal, allowedPrefixes: RELEASE_FEED_PREFIXES }),
    emit: broadcastLocal,
    isRetiring: (connection) => client.isRetiring(connection),
    wslKeepalive,
  });
  // A host whose Daintree answered is checked afresh the next time it isn't serving.
  const stopStartRechecks = manager.onStateChange((hostId, state) => {
    if (state.status === "connected") recheckStart(hostId);
  });
  const stopOwnedHostCleanup = watchOwnedHostCleanup({
    list: () => registry.list(),
    forget: (hostId) => client.forget({ hostId }),
  });
  const unregister = registerRemoteService("remoteHostsClient", client);
  const unregisterWindowHosts = registerRemoteService("windowHosts", client);
  const unregisterSetup = registerRemoteService("hostSetup", setup);
  // Views restored before Remote Hosts started read an empty list, and nothing
  // else tells them the configured hosts until one is dialled or edited.
  broadcastLocal({ type: "hosts-changed", hosts: client.list() });
  return {
    client,
    onEndpointOpened: (listener) => manager.onEndpointOpened(listener),
    onEndpointClosed: (listener) => manager.onEndpointClosed(listener),
    hostForView,
    router: remoteRouter,
    sessionFor: (hostId) => manager.get(hostId)?.currentSession ?? null,
    manager,
    emitLocal: broadcastLocal,
    registry,
    async dispose() {
      stopWakeWatch();
      stopStartRechecks();
      stopOwnedHostCleanup();
      unregister();
      unregisterWindowHosts();
      unregisterSetup();
      stopTitleRefresh();
      setRemoteHostNameResolver(() => null);
      await client.dispose();
      // Last: closing the links above may still have needed their distros up.
      wslKeepalive.dispose();
    },
  };
}
