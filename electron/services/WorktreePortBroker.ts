/**
 * WorktreePortBroker — Creates and manages dedicated MessagePort channels
 * between workspace host UtilityProcesses and renderer WebContentsViews.
 *
 * Each view gets its own MessagePort to its project's host. The port IS the
 * isolation boundary — no routing, no filtering, no fallbacks.
 */

import { ipcMain, MessageChannelMain, type WebContents } from "electron";
import type { WorkspaceHostProcess } from "./WorkspaceHostProcess.js";
import { CHANNELS } from "../ipc/channels.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("main:WorktreePortBroker");

interface PortEntry {
  /** The host-side port (port1). Kept for cleanup — closing it signals the host. */
  hostPort: Electron.MessagePortMain;
  /** Reference to the host process that owns port1 */
  host: WorkspaceHostProcess;
  /** The webContents.id this port pair serves */
  webContentsId: number;
  /** Identifies this transfer in the renderer's receipt. */
  token: number;
  /**
   * True once the renderer has acknowledged attaching port2. A successful
   * `postMessage` is not delivery: a port posted before the preload listener
   * exists, or into a document an in-flight navigation replaces, is dropped
   * without an error on either side (#12576).
   */
  confirmed: boolean;
  /** Pending {@link WorktreePortBroker.waitForConfirmation} callers. */
  confirmationWaiters: Set<(confirmed: boolean) => void>;
  /** Cleanup functions for webContents listeners (prevents listener accumulation) */
  cleanupListeners: () => void;
}

export interface BrokerPortOptions {
  /**
   * Post a fresh port even when the renderer has confirmed the current one.
   * For explicit recovery, where the renderer needs its ready callbacks to run
   * again and refetch its state.
   */
  force?: boolean;
}

type PostReason = "new" | "unconfirmed" | "forced" | "host-changed";

export class WorktreePortBroker {
  /** Active port pairs keyed by webContents.id */
  private ports = new Map<number, PortEntry>();

  /** Reverse map: host projectPath → set of webContents IDs with ports to that host */
  private hostToViews = new Map<string, Set<number>>();

  private nextToken = 0;

  private readonly onPortAck = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const token = (payload as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== "number") return;
    this.confirmPort(event.sender.id, token);
  };

  constructor() {
    ipcMain.on(CHANNELS.WORKTREE_PORT_ACK, this.onPortAck);
  }

  /**
   * Create a MessagePort channel between a workspace host and a renderer view.
   *
   * - port1 goes to the host UtilityProcess
   * - port2 goes to the renderer WebContentsView
   *
   * A channel the renderer has confirmed to the same host is reused rather than
   * torn down. Any other existing port for the view is replaced by a fresh one
   * — including an unconfirmed one, which may never have arrived.
   */
  brokerPort(
    host: WorkspaceHostProcess,
    webContents: WebContents,
    options: BrokerPortOptions = {}
  ): boolean {
    if (webContents.isDestroyed()) {
      logger.warn("Worktree port not brokered", {
        webContentsId: webContents.id,
        projectPath: host.projectPath,
        reason: "webcontents-destroyed",
      });
      return false;
    }

    const wcId = webContents.id;

    const existing = this.ports.get(wcId);
    if (existing?.host === host && existing.confirmed && !options.force) {
      logger.info("Worktree port reused", {
        webContentsId: wcId,
        projectPath: host.projectPath,
        token: existing.token,
      });
      return true;
    }
    const reason: PostReason = !existing
      ? "new"
      : existing.host !== host
        ? "host-changed"
        : existing.confirmed
          ? "forced"
          : "unconfirmed";

    const { port1, port2 } = new MessageChannelMain();

    // Send port1 to the workspace host (uses new worktree port protocol).
    // Attached before the existing entry is retired: a host mid-restart
    // refuses the attach, and the view has to stay in `hostToViews` for the
    // restart's re-broker to find it rather than waiting on another Retry.
    const attached = host.attachWorktreePort(port1);
    if (!attached) {
      port1.close();
      port2.close();
      logger.warn("Worktree port not brokered", {
        webContentsId: wcId,
        projectPath: host.projectPath,
        reason: "host-rejected",
      });
      return false;
    }

    // Close existing port for this view if any (also removes old listeners)
    this.closePortsForView(wcId);

    const token = ++this.nextToken;

    // Send port2 to the renderer — if this fails, clean up port1 on the host side
    try {
      webContents.postMessage("worktree-port", { token }, [port2]);
    } catch {
      port1.close();
      port2.close();
      logger.warn("Worktree port not brokered", {
        webContentsId: wcId,
        projectPath: host.projectPath,
        reason: "post-failed",
      });
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
    // A port posted while a main-frame navigation is in flight went to the
    // outgoing document, which can even acknowledge it before the commit
    // replaces it. `did-start-navigation` fired before this entry existed, so
    // retire it at the commit instead; the new document's did-finish-load
    // re-broker then posts one it will actually hold.
    const onCommit = () => {
      this.closePortsForView(wcId);
    };
    const onPortClose = () => {
      this.closePortsForView(wcId);
    };
    webContents.once("destroyed", onDestroyed);
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("did-navigate", onCommit);
    port1.on("close", onPortClose);

    const cleanupListeners = () => {
      port1.removeListener("close", onPortClose);
      webContents.removeListener("destroyed", onDestroyed);
      webContents.removeListener("did-start-navigation", onNavigation);
      webContents.removeListener("did-navigate", onCommit);
    };

    // Track the entry
    const entry: PortEntry = {
      hostPort: port1,
      host,
      webContentsId: wcId,
      token,
      confirmed: false,
      confirmationWaiters: new Set(),
      cleanupListeners,
    };
    this.ports.set(wcId, entry);

    // Update reverse map
    const projectPath = host.projectPath;
    let viewSet = this.hostToViews.get(projectPath);
    if (!viewSet) {
      viewSet = new Set();
      this.hostToViews.set(projectPath, viewSet);
    }
    viewSet.add(wcId);

    logger.info("Worktree port posted", { webContentsId: wcId, projectPath, token, reason });

    return true;
  }

  /**
   * Record the renderer's receipt for a posted port. Only the view's current
   * transfer can be confirmed — a receipt for a port that has since been
   * replaced or closed says nothing about the one the view holds now.
   */
  confirmPort(webContentsId: number, token: number): boolean {
    const entry = this.ports.get(webContentsId);
    if (!entry || entry.token !== token) {
      logger.debug("Ignored stale worktree port receipt", {
        webContentsId,
        token,
        currentToken: entry?.token ?? null,
      });
      return false;
    }
    if (entry.confirmed) return true;
    entry.confirmed = true;
    logger.info("Worktree port confirmed by renderer", {
      webContentsId,
      projectPath: entry.host.projectPath,
      token,
    });
    this.settleConfirmationWaiters(entry, true);
    return true;
  }

  /**
   * Resolve once the view's current port is confirmed by the renderer, or with
   * `false` when it is closed or replaced first, or `timeoutMs` elapses. Never
   * closes anything itself, so a late deadline cannot tear down a newer port.
   */
  waitForConfirmation(webContentsId: number, timeoutMs: number): Promise<boolean> {
    const entry = this.ports.get(webContentsId);
    if (!entry) return Promise.resolve(false);
    if (entry.confirmed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (confirmed: boolean) => {
        clearTimeout(timer);
        entry.confirmationWaiters.delete(settle);
        resolve(confirmed);
      };
      const timer = setTimeout(() => {
        logger.warn("Worktree port not confirmed by renderer", {
          webContentsId,
          projectPath: entry.host.projectPath,
          token: entry.token,
          timeoutMs,
        });
        settle(false);
      }, timeoutMs);
      entry.confirmationWaiters.add(settle);
    });
  }

  private settleConfirmationWaiters(entry: PortEntry, confirmed: boolean): void {
    for (const settle of [...entry.confirmationWaiters]) {
      settle(confirmed);
    }
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
    this.settleConfirmationWaiters(entry, false);

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
   * Check if a view currently has a tracked port. Says nothing about whether
   * the renderer received it.
   */
  hasPort(webContentsId: number): boolean {
    return this.ports.has(webContentsId);
  }

  /**
   * Dispose all tracked ports. Called on app shutdown.
   */
  dispose(): void {
    ipcMain.removeListener(CHANNELS.WORKTREE_PORT_ACK, this.onPortAck);
    for (const wcId of [...this.ports.keys()]) {
      this.closePortsForView(wcId);
    }
  }
}
