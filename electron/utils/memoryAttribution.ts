import { refreshAppMetricsSnapshot } from "./appMetricsSnapshot.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";

export interface MemoryAttributionView {
  projectId: string;
  state: "loading" | "active" | "cached";
  webContentsId: number;
  pid: number | null;
  workingSetKb: number | null;
  guestPids: number[];
}

export interface MemoryAttribution {
  sampledAt: number;
  windows: Array<{
    windowId: number;
    activeProjectId: string | null;
    views: MemoryAttributionView[];
  }>;
  processes: {
    browserKb: number;
    gpuKb: number;
    utilityByNameKb: Record<string, number>;
    rendererTotalKb: number;
    /** Renderer footprint no project view (or its guests) claims — surface views, DevTools, orphans. */
    unattributedRendererKb: number;
  };
}

/**
 * One fresh `app.getAppMetrics()` sweep joined to every window's project-view
 * inventory by OS pid. Diagnostics for the switch benchmark: says which
 * renderer belongs to which cached view, and how much of the process tree is
 * nobody's. Always a fresh sweep — a before/after delta across a switch is
 * meaningless against the 5 s shared snapshot.
 */
export function buildMemoryAttribution(windowRegistry: WindowRegistry): MemoryAttribution {
  const metrics = refreshAppMetricsSnapshot();
  const sampledAt = Date.now();
  const kbByPid = new Map<number, number>();
  let browserKb = 0;
  let gpuKb = 0;
  let rendererTotalKb = 0;
  const utilityByNameKb: Record<string, number> = {};
  for (const proc of metrics) {
    const kb = proc.memory.workingSetSize;
    kbByPid.set(proc.pid, kb);
    switch (proc.type) {
      case "Browser":
        browserKb += kb;
        break;
      case "GPU":
        gpuKb += kb;
        break;
      case "Tab":
        rendererTotalKb += kb;
        break;
      default: {
        const name = proc.serviceName || proc.name || proc.type;
        utilityByNameKb[name] = (utilityByNameKb[name] ?? 0) + kb;
      }
    }
  }

  const attributedPids = new Set<number>();
  const windows = windowRegistry.all().map((ctx) => {
    const pvm = ctx.services.projectViewManager;
    const views: MemoryAttributionView[] = (pvm?.getViewInventory() ?? []).map((view) => {
      if (view.pid !== null) attributedPids.add(view.pid);
      for (const pid of view.guestPids) attributedPids.add(pid);
      return {
        projectId: view.projectId,
        state: view.state,
        webContentsId: view.webContentsId,
        pid: view.pid,
        workingSetKb: view.pid !== null ? (kbByPid.get(view.pid) ?? null) : null,
        guestPids: view.guestPids,
      };
    });
    return {
      windowId: ctx.windowId,
      activeProjectId: pvm?.getActiveProjectId() ?? null,
      views,
    };
  });

  let attributedKb = 0;
  for (const pid of attributedPids) attributedKb += kbByPid.get(pid) ?? 0;

  return {
    sampledAt,
    windows,
    processes: {
      browserKb,
      gpuKb,
      utilityByNameKb,
      rendererTotalKb,
      unattributedRendererKb: Math.max(0, rendererTotalKb - attributedKb),
    },
  };
}
