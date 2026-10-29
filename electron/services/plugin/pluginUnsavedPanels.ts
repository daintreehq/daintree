import { parseProjectPluginInstanceKey } from "../../../shared/types/plugin/instanceKeys.js";
import type { PluginUnsavedPanelReport } from "../../../shared/types/pluginUnsavedPanels.js";
import type { PanelLifecycleSourceHandle } from "./PluginPanelLifecycleBroker.js";

/**
 * The plugin panels each view last said hold unsaved work (#15031), so the
 * plugin manager in one view can ask before disabling, updating or uninstalling
 * a plugin whose dirty panel is open in another. Pushed rather than queried: a
 * view that is slow, loading or gone can never hold the action up, and what it
 * last said stands until its document goes away. A view that never reported
 * has nothing dirty, and only a view with something dirty is watched at all.
 */

/** Calls `forget` once the reporting document is gone; returns the teardown. */
export type UnsavedPanelsDocumentWatcher = (forget: () => void) => () => void;

interface SourceReport {
  projectId: string | null;
  panels: PluginUnsavedPanelReport[];
  unwatch: () => void;
}

export interface UnsavedPluginPanel extends PluginUnsavedPanelReport {
  projectId: string | null;
}

/** Bounds on a renderer-supplied report, which main holds in memory. */
const MAX_REPORTED_PANELS = 1_000;
const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 200;
/** Chromium's `net::ERR_ABORTED`: the load was cancelled and the old document stays. */
const ERR_ABORTED = -3;

const reports = new Map<number, SourceReport>();

function parseReport(panels: unknown): PluginUnsavedPanelReport[] {
  if (!Array.isArray(panels)) return [];
  const parsed: PluginUnsavedPanelReport[] = [];
  for (const raw of panels.slice(0, MAX_REPORTED_PANELS)) {
    if (!raw || typeof raw !== "object") continue;
    const { panelId, pluginId, title } = raw as Record<string, unknown>;
    if (typeof panelId !== "string" || panelId.length === 0 || panelId.length > MAX_ID_LENGTH) {
      continue;
    }
    if (typeof pluginId !== "string" || pluginId.length === 0 || pluginId.length > MAX_ID_LENGTH) {
      continue;
    }
    parsed.push({
      panelId,
      pluginId,
      title: typeof title === "string" ? title.slice(0, MAX_TITLE_LENGTH) : "",
    });
  }
  return parsed;
}

/** Replace what `sourceId` says is dirty. An empty report forgets the source. */
export function recordUnsavedPluginPanels(
  sourceId: number,
  watchDocument: UnsavedPanelsDocumentWatcher,
  projectId: string | null,
  panels: unknown
): void {
  const parsed = parseReport(panels);
  const existing = reports.get(sourceId);
  if (parsed.length === 0) {
    if (!existing) return;
    reports.delete(sourceId);
    existing.unwatch();
    return;
  }
  if (existing) {
    existing.projectId = projectId;
    existing.panels = parsed;
    return;
  }
  const entry: SourceReport = { projectId, panels: parsed, unwatch: () => {} };
  reports.set(sourceId, entry);
  entry.unwatch = watchDocument(() => {
    if (reports.get(sourceId) !== entry) return;
    reports.delete(sourceId);
    entry.unwatch();
  });
}

/**
 * The dirty panels of `pluginId` across every view: its own panels, and those
 * of each project's instance of it when it is an installed per-project package.
 * A repository plugin that shares the manifest id is a different plugin.
 */
export function getUnsavedPluginPanels(pluginId: string): UnsavedPluginPanel[] {
  const matches: UnsavedPluginPanel[] = [];
  for (const { projectId, panels } of reports.values()) {
    for (const panel of panels) {
      if (!belongsTo(panel.pluginId, pluginId)) continue;
      matches.push({ ...panel, projectId });
    }
  }
  return matches;
}

function belongsTo(instanceId: string, pluginId: string): boolean {
  if (instanceId === pluginId) return true;
  const instance = parseProjectPluginInstanceKey(instanceId);
  return instance?.installed === true && instance.manifestId === pluginId;
}

/**
 * A local view's document ends on a committed main-frame navigation, a failed
 * main-frame load (an aborted one leaves the old document up), a crash, or the
 * view's destruction. None of its unsaved work survives any of them.
 */
export function watchWebContentsDocument(wc: Electron.WebContents): UnsavedPanelsDocumentWatcher {
  return (forget) => {
    const onGone = () => forget();
    const onFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _description: string,
      _url: string,
      isMainFrame: boolean
    ) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) forget();
    };
    wc.on("did-navigate", onGone);
    wc.on("did-fail-load", onFailLoad);
    wc.once("render-process-gone", onGone);
    wc.once("destroyed", onGone);
    // Destruction leaves JS listeners on the wrapper, so remove them even then.
    return () => {
      wc.removeListener("did-navigate", onGone);
      wc.removeListener("did-fail-load", onFailLoad);
      wc.removeListener("render-process-gone", onGone);
      wc.removeListener("destroyed", onGone);
    };
  };
}

/** A remote view is forgotten when its endpoint closes; a reload replaces its report on mount. */
export function watchSourceHandle(
  handle: PanelLifecycleSourceHandle
): UnsavedPanelsDocumentWatcher {
  return (forget) => {
    const onGone = () => forget();
    handle.once("destroyed", onGone);
    return () => {
      handle.removeListener("destroyed", onGone);
    };
  };
}

/** Test-only: forget every report. */
export function _resetUnsavedPluginPanelsForTests(): void {
  for (const entry of reports.values()) entry.unwatch();
  reports.clear();
}
