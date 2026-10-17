import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { onRemoteViewEndpointOpened, relaySendToHost } from "../hostSendRelay.js";
import { defineIpcNamespace, op } from "../define.js";
import { PLUGIN_METRICS_METHOD_CHANNELS } from "./pluginMetrics.preload.js";
import { parseRendererMetricsEnvelopes } from "../../schemas/pluginMetrics.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import type { PluginMetricsService } from "../../services/plugin/PluginMetricsService.js";
import type { PluginPerfSnapshot } from "../../../shared/types/pluginMetrics.js";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
import type { IpcContext } from "../types.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";

/** Report messages accepted per renderer per second; the renderer drains every 250 ms at most. */
export const MAX_REPORTS_PER_SECOND = 5;

type ProjectResolver = (webContentsId: number) => string | null;

/**
 * App-global plugins are visible to every view; a project instance only to
 * its own project's views, the same scoping `plugin:invoke` applies.
 */
function visibleTo(pluginId: string, projectId: string | null): boolean {
  const owner = projectIdFromPluginInstanceKey(pluginId);
  return owner === null || owner === projectId;
}

function snapshotsFor(snapshots: PluginPerfSnapshot[], projectId: string | null) {
  return snapshots.filter((snapshot) => visibleTo(snapshot.pluginId, projectId));
}

type MetricsResolver = () => Promise<PluginMetricsService>;

// Lazy (mirrors plugin.ts): a static import would put the whole PluginService
// graph on the eager startup path.
let cachedPluginService: typeof PluginServiceModule.pluginService | null = null;
async function defaultResolveMetrics(): Promise<PluginMetricsService> {
  if (!cachedPluginService) {
    const mod = await import("../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService.metrics;
}

let resolveMetrics: MetricsResolver = defaultResolveMetrics;

async function handleGetPerfSnapshots(ctx: IpcContext): Promise<PluginPerfSnapshot[]> {
  return snapshotsFor((await resolveMetrics()).getAll(), ctx.projectId);
}

export const pluginMetricsNamespace = defineIpcNamespace({
  name: "pluginMetrics",
  ops: {
    getPerfSnapshots: op(PLUGIN_METRICS_METHOD_CHANNELS.getPerfSnapshots, handleGetPerfSnapshots, {
      withContext: true,
    }),
  },
});

export function registerPluginMetricsHandlers(options?: {
  resolveMetrics?: MetricsResolver;
  projectFor?: ProjectResolver;
}): () => void {
  resolveMetrics = options?.resolveMetrics ?? defaultResolveMetrics;
  const projectFor = options?.projectFor ?? getProjectForWebContents;
  const cleanups: Array<() => void> = [pluginMetricsNamespace.register()];

  // Per-sender message budget, keyed by the reporting WebContents or a remote
  // view's endpoint. A renderer is trusted to be ours, not to be well-behaved:
  // a report loop gone wrong must not become main-thread load.
  const reportWindows = new WeakMap<object, { start: number; count: number }>();
  const allowReport = (sender: object): boolean => {
    const now = Date.now();
    const window = reportWindows.get(sender);
    if (!window || now - window.start >= 1_000) {
      reportWindows.set(sender, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= MAX_REPORTS_PER_SECOND;
  };

  const recordReports = (sender: object, senderProjectId: string | null, payload: unknown) => {
    if (!allowReport(sender)) return;
    const envelopes = parseRendererMetricsEnvelopes(payload).filter(({ report }) =>
      visibleTo(report.pluginId, senderProjectId)
    );
    if (envelopes.length === 0) return;
    void resolveMetrics()
      .then((metrics) => {
        // The service drops reports for plugins it has not loaded, and for a
        // load other than the one currently live under that id.
        for (const { generation, report } of envelopes) {
          metrics.recordRendererReport(report, generation);
        }
      })
      .catch(() => {
        // Metrics are best-effort; a failed load of the service is reported elsewhere.
      });
  };

  const handleReport = (event: Electron.IpcMainEvent, payload: unknown): void => {
    // Pinned synchronously: the sender's binding can change while the service loads.
    recordReports(event.sender, projectFor(event.sender.id), payload);
  };
  ipcMain.on(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, handleReport);
  cleanups.push(() => ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, handleReport));
  // A view on another machine reports over the link, scoped to its endpoint's project.
  cleanups.push(
    getIpcDispatcher().registerSend(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, (ctx, payload) => {
      if (ctx.endpoint.kind !== "remote-view") return;
      recordReports(ctx.endpoint, ctx.endpoint.projectId, payload);
    })
  );

  // Snapshots are pushed only to renderers that asked, and the metrics service
  // only samples worker memory while at least one is listening. A subscriber is
  // a local WebContents or a remote view's endpoint.
  interface Subscriber {
    projectId(): string | null;
    isGone(): boolean;
    deliver(snapshots: PluginPerfSnapshot[]): void;
    detach(): void;
  }
  const subscribers = new Map<object, Subscriber>();
  let feed: (() => void) | null = null;
  let feedStarting = false;

  const send = (snapshots: PluginPerfSnapshot[]): void => {
    for (const [key, subscriber] of [...subscribers]) {
      if (subscriber.isGone()) {
        removeSubscriber(key);
        continue;
      }
      try {
        subscriber.deliver(snapshotsFor(snapshots, subscriber.projectId()));
      } catch {
        // A renderer mid-teardown; its own teardown listener removes it.
      }
    }
  };

  const startFeed = (): void => {
    if (feed || feedStarting) return;
    feedStarting = true;
    void resolveMetrics()
      .then((metrics) => {
        feedStarting = false;
        if (feed || subscribers.size === 0) return;
        const offChange = metrics.onDidChange(() => send(metrics.getAll()));
        const releaseSampling = metrics.acquireSampling();
        feed = () => {
          offChange();
          releaseSampling();
        };
      })
      .catch(() => {
        feedStarting = false;
      });
  };

  const stopFeedIfIdle = (): void => {
    if (subscribers.size > 0 || !feed) return;
    feed();
    feed = null;
  };

  function removeSubscriber(key: object): void {
    const subscriber = subscribers.get(key);
    if (!subscriber) return;
    subscribers.delete(key);
    subscriber.detach();
    stopFeedIfIdle();
  }

  // Shell side: a view bound to a remote host subscribes to its host's feed,
  // not this machine's. Its subscription is kept here, where its reloads and
  // teardown are visible, ended on the host when the view navigates or goes,
  // and re-sent whenever the view gets an endpoint again.
  const relayedSubscribers = new Map<number, { sender: Electron.WebContents; off: () => void }>();
  // Unsubscribes relayed for views that are still alive. A send while the link
  // is down is dropped, and a resume keeps the host's endpoint and its
  // subscription, so each is re-sent on the view's next endpoint.
  const pendingUnsubscribes = new Map<number, { sender: Electron.WebContents; off: () => void }>();
  const dropPendingUnsubscribe = (id: number): void => {
    const pending = pendingUnsubscribes.get(id);
    if (!pending) return;
    pendingUnsubscribes.delete(id);
    pending.off();
  };
  const endRelayed = (id: number, tellHost: boolean): void => {
    const entry = relayedSubscribers.get(id);
    if (!entry) return;
    relayedSubscribers.delete(id);
    entry.off();
    if (!tellHost) return;
    relaySendToHost(id, CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, []);
    const sender = entry.sender;
    if (sender.isDestroyed()) return;
    dropPendingUnsubscribe(id);
    // A closed view's endpoint closes on the host with its subscription.
    const off = onWebContentsDestroyed(sender, () => dropPendingUnsubscribe(id));
    pendingUnsubscribes.set(id, { sender, off });
  };
  const relaySubscribe = (sender: Electron.WebContents): boolean => {
    if (!relaySendToHost(sender.id, CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, [])) return false;
    dropPendingUnsubscribe(sender.id);
    if (relayedSubscribers.has(sender.id)) return true;
    const id = sender.id;
    const onNavigate = (): void => endRelayed(id, true);
    const offGone = onWebContentsDestroyed(sender, () => endRelayed(id, false));
    sender.once("did-navigate", onNavigate);
    relayedSubscribers.set(id, {
      sender,
      off: () => {
        offGone();
        sender.removeListener("did-navigate", onNavigate);
      },
    });
    return true;
  };
  cleanups.push(
    onRemoteViewEndpointOpened((webContentsId) => {
      const unsubscribed = pendingUnsubscribes.get(webContentsId);
      if (unsubscribed) {
        dropPendingUnsubscribe(webContentsId);
        if (!unsubscribed.sender.isDestroyed()) {
          relaySendToHost(webContentsId, CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, []);
        }
      }
      const entry = relayedSubscribers.get(webContentsId);
      if (!entry) return;
      if (entry.sender.isDestroyed() || !relaySubscribe(entry.sender)) {
        endRelayed(webContentsId, false);
      }
    })
  );
  cleanups.push(() => {
    for (const id of [...relayedSubscribers.keys()]) endRelayed(id, false);
    for (const id of [...pendingUnsubscribes.keys()]) dropPendingUnsubscribe(id);
  });

  const handleSubscribe = (event: Electron.IpcMainEvent): void => {
    const sender = event.sender;
    if (sender.isDestroyed() || subscribers.has(sender)) return;
    if (relaySubscribe(sender)) return;
    // A reload starts a fresh preload that re-subscribes if it still wants the feed.
    const onNavigate = (): void => removeSubscriber(sender);
    const offGone = onWebContentsDestroyed(sender, () => removeSubscriber(sender));
    sender.once("did-navigate", onNavigate);
    subscribers.set(sender, {
      projectId: () => projectFor(sender.id),
      isGone: () => sender.isDestroyed(),
      deliver: (snapshots) => sender.send(CHANNELS.PLUGIN_PERF_SNAPSHOTS_CHANGED, snapshots),
      detach: () => {
        offGone();
        sender.removeListener("did-navigate", onNavigate);
      },
    });
    startFeed();
  };
  const handleUnsubscribe = (event: Electron.IpcMainEvent): void => {
    if (relayedSubscribers.has(event.sender.id)) {
      endRelayed(event.sender.id, true);
      return;
    }
    removeSubscriber(event.sender);
  };
  ipcMain.on(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, handleSubscribe);
  ipcMain.on(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, handleUnsubscribe);
  // Host side: a remote view subscribes through its endpoint, which closes
  // when the view goes, its project changes or the link drops; its Shell ends
  // the subscription on a reload and re-sends it on a new endpoint.
  cleanups.push(
    getIpcDispatcher().registerSend(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, (ctx) => {
      const endpoint = ctx.endpoint;
      if (endpoint.kind !== "remote-view" || endpoint.isClosed()) return;
      if (subscribers.has(endpoint)) return;
      const closed = endpoint.onClose(() => removeSubscriber(endpoint));
      subscribers.set(endpoint, {
        projectId: () => endpoint.projectId,
        isGone: () => endpoint.isClosed(),
        deliver: (snapshots) =>
          endpoint.send({
            type: "event",
            channel: CHANNELS.PLUGIN_PERF_SNAPSHOTS_CHANGED,
            args: [snapshots],
          }),
        detach: () => closed.dispose(),
      });
      startFeed();
    }),
    getIpcDispatcher().registerSend(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, (ctx) => {
      if (ctx.endpoint.kind === "remote-view") removeSubscriber(ctx.endpoint);
    })
  );
  cleanups.push(() => {
    ipcMain.removeListener(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, handleSubscribe);
    ipcMain.removeListener(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, handleUnsubscribe);
    for (const key of [...subscribers.keys()]) removeSubscriber(key);
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    resolveMetrics = defaultResolveMetrics;
  };
}
