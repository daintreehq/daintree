/**
 * WorktreePortBroker — Creates and manages dedicated MessagePort channels
 * between workspace host UtilityProcesses and renderer WebContentsViews.
 *
 * Each view gets its own MessagePort to its project's host. The port IS the
 * isolation boundary — no routing, no filtering, no fallbacks.
 */

import { MessageChannelMain, type WebContents } from "electron";
import type { WorkspaceHostProcess } from "./WorkspaceHostProcess.js";

interface PortEntry {
  /** The host-side port (port1). Kept for cleanup — closing it signals the host. */
  hostPort: Electron.MessagePortMain;
  /** Reference to the host process that owns port1 */
  host: WorkspaceHostProcess;
  /** The webContents.id this port pair serves */
  webContentsId: number;
  /** Cleanup functions for webContents listeners (prevents listener accumulation) */
  cleanupListeners: () => void;
}

export class WorktreePortBroker {
  /** Active port pairs keyed by webContents.id */
  private ports = new Map<number, PortEntry>();

  /** Reverse map: host projectPath → set of webContents IDs with ports to that host */
  private hostToViews = new Map<string, Set<number>>();

  /**
   * Create a MessagePort channel between a workspace host and a renderer view.
   *
   * - port1 goes to the host UtilityProcess
   * - port2 goes to the renderer WebContentsView
   *
   * If the view already has a port, the old one is closed first.
   */
  brokerPort(host: WorkspaceHostProcess, webContents: WebContents): boolean {
    if (webContents.isDestroyed()) return false;

    const wcId = webContents.id;

    const existing = this.ports.get(wcId);
    if (existing?.host === host) return true;

    // Close existing port for this view if any (also removes old listeners)
    this.closePortsForView(wcId);

    const { port1, port2 } = new MessageChannelMain();

    // Send port1 to the workspace host (uses new worktree port protocol)
    const attached = host.attachWorktreePort(port1);
    if (!attached) {
      port1.close();
      port2.close();
      return false;
    }

    // Send port2 to the renderer — if this fails, clean up port1 on the host side
    try {
      webContents.postMessage("worktree-port", null, [port2]);
    } catch {
      port1.close();
      port2.close();
      return false;
    }

    // Lifecycle listeners (stored for cleanup to prevent accumulation).
    // port1.on("close") covers host-side shutdown/transfer paths where the
    // renderer-side webContents events don't fire; closePortsForView is
    // already idempotent via the map-deletion guard.
    const onDestroyed = () => {
      this.closePortsForView(wcId);
    };
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ) => {
      if (details.isMainFrame && !details.isSameDocument && !webContents.isDestroyed()) {
        this.closePortsForView(wcId);
      }
    };
    const onPortClose = () => {
      this.closePortsForView(wcId);
    };
    webContents.once("destroyed", onDestroyed);
    webContents.on("did-start-navigation", onNavigation);
    port1.on("close", onPortClose);

    const cleanupListeners = () => {
      port1.removeListener("close", onPortClose);
      webContents.removeListener("destroyed", onDestroyed);
      webContents.removeListener("did-start-navigation", onNavigation);
    };

    // Track the entry
    const entry: PortEntry = { hostPort: port1, host, webContentsId: wcId, cleanupListeners };
    this.ports.set(wcId, entry);

    // Update reverse map
    const projectPath = host.projectPath;
    let viewSet = this.hostToViews.get(projectPath);
    if (!viewSet) {
      viewSet = new Set();
      this.hostToViews.set(projectPath, viewSet);
    }
    viewSet.add(wcId);

    return true;
  }

  /**
   * Close and clean up the port for a specific renderer view.
   */
  closePortsForView(webContentsId: number): void {
    const entry = this.ports.get(webContentsId);
    if (!entry) return;

    // Remove listeners first to prevent re-entrant calls
    entry.cleanupListeners();

    try {
      entry.hostPort.close();
    } catch {
      // Port may already be closed
    }

    this.ports.delete(webContentsId);

    // Update reverse map
    const projectPath = entry.host.projectPath;
    const viewSet = this.hostToViews.get(projectPath);
    if (viewSet) {
      viewSet.delete(webContentsId);
      if (viewSet.size === 0) {
        this.hostToViews.delete(projectPath);
      }
    }
  }

  /**
   * Get all webContents IDs currently connected to a host, then close their ports.
   * Returns the IDs so callers can re-broker after the host restarts.
   */
  closePortsForHost(projectPath: string): number[] {
    const viewSet = this.hostToViews.get(projectPath);
    if (!viewSet) return [];

    // Snapshot the IDs before closing (closePortsForView mutates the set)
    const wcIds = [...viewSet];
    for (const wcId of wcIds) {
      this.closePortsForView(wcId);
    }
    return wcIds;
  }

  /**
   * Re-broker all views that were connected to a host after it restarts.
   * Called after the host respawns and is ready. Views destroyed between the
   * crash and the re-broker (e.g. an LRU eviction landing mid-restart) are
   * skipped. Returns the number of views actually re-brokered so callers can
   * log the real outcome rather than the snapshot size.
   */
  reBrokerForHost(
    host: WorkspaceHostProcess,
    getWebContents: (wcId: number) => WebContents | undefined,
    wcIds: number[]
  ): number {
    let reBrokered = 0;
    for (const wcId of wcIds) {
      const wc = getWebContents(wcId);
      if (wc && !wc.isDestroyed()) {
        if (this.brokerPort(host, wc)) {
          reBrokered += 1;
        }
      }
    }
    return reBrokered;
  }

  /**
   * Check if a view currently has an active port.
   */
  hasPort(webContentsId: number): boolean {
    return this.ports.has(webContentsId);
  }

  /**
   * Dispose all tracked ports. Called on app shutdown.
   */
  dispose(): void {
    for (const wcId of [...this.ports.keys()]) {
      this.closePortsForView(wcId);
    }
  }
}
