import { ipcMain, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { PLUGIN_METRICS_METHOD_CHANNELS } from "./pluginMetrics.preload.js";
import { parseRendererMetricsEnvelopes } from "../../schemas/pluginMetrics.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import type { PluginMetricsService } from "../../services/plugin/PluginMetricsService.js";
import type { PluginPerfSnapshot } from "../../../shared/types/pluginMetrics.js";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
import type { IpcContext } from "../types.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";

/** Report messages accepted per renderer per second; the renderer drains every ~2 s. */
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

  // Per-sender message budget. A renderer is trusted to be ours, not to be
  // well-behaved: a report loop gone wrong must not become main-thread load.
  const reportWindows = new WeakMap<WebContents, { start: number; count: number }>();
  const allowReport = (sender: WebContents): boolean => {
    const now = Date.now();
    const window = reportWindows.get(sender);
    if (!window || now - window.start >= 1_000) {
      reportWindows.set(sender, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= MAX_REPORTS_PER_SECOND;
  };

  const handleReport = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!allowReport(event.sender)) return;
    // Pinned synchronously: the sender's binding can change while the service loads.
    const senderProjectId = projectFor(event.sender.id);
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
  ipcMain.on(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, handleReport);
  cleanups.push(() => ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, handleReport));

  // Snapshots are pushed only to renderers that asked, and the metrics service
  // only samples worker memory while at least one is listening.
  const subscribers = new Map<WebContents, () => void>();
  let feed: (() => void) | null = null;
  let feedStarting = false;

  const send = (snapshots: PluginPerfSnapshot[]): void => {
    for (const sender of [...subscribers.keys()]) {
      if (sender.isDestroyed()) {
        removeSubscriber(sender);
        continue;
      }
      try {
        sender.send(
          CHANNELS.PLUGIN_PERF_SNAPSHOTS_CHANGED,
          snapshotsFor(snapshots, projectFor(sender.id))
        );
      } catch {
        // A renderer mid-teardown; its `destroyed` listener removes it.
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

  function removeSubscriber(sender: WebContents): void {
    const detach = subscribers.get(sender);
    if (!detach) return;
    subscribers.delete(sender);
    detach();
    stopFeedIfIdle();
  }

  const handleSubscribe = (event: Electron.IpcMainEvent): void => {
    const sender = event.sender;
    if (sender.isDestroyed() || subscribers.has(sender)) return;
    const onGone = (): void => removeSubscriber(sender);
    // A reload starts a fresh preload that re-subscribes if it still wants the feed.
    const onNavigate = (): void => removeSubscriber(sender);
    sender.once("destroyed", onGone);
    sender.once("did-navigate", onNavigate);
    subscribers.set(sender, () => {
      sender.removeListener("destroyed", onGone);
      sender.removeListener("did-navigate", onNavigate);
    });
    startFeed();
  };
  const handleUnsubscribe = (event: Electron.IpcMainEvent): void => {
    removeSubscriber(event.sender);
  };
  ipcMain.on(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, handleSubscribe);
  ipcMain.on(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, handleUnsubscribe);
  cleanups.push(() => {
    ipcMain.removeListener(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE, handleSubscribe);
    ipcMain.removeListener(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE, handleUnsubscribe);
    for (const sender of [...subscribers.keys()]) removeSubscriber(sender);
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    resolveMetrics = defaultResolveMetrics;
  };
}
