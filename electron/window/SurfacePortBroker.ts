/**
 * SurfacePortBroker — direct pty-host MessagePorts for paint-fabric surface
 * views (docs/architecture/terminal-paint-fabric.md, Phase 1V substrate).
 *
 * The pty-host keys renderer connections by an opaque numeric id with its own
 * per-connection queue and batcher, so a surface view gets its own direct
 * pty-host port — bytes flow pty-host ↔ surface view without touching the
 * compositor or the primary view — by connecting under a synthetic connection
 * id. Synthetic ids live far above any real BrowserWindow id (both real
 * window ids and webContents ids are small sequential ints and can collide
 * with each other), so the two id spaces can never alias.
 *
 * Port delivery reuses the proven token handshake from portDistribution.ts:
 * the token lands before the port so the preload relay can pair them, and the
 * same preload relay (terminal-port/terminal-port-token) serves surface views
 * because they load the same trusted renderer bundle.
 */

import { MessageChannelMain } from "electron";
import { randomBytes } from "crypto";
import type { MessagePortMain } from "electron";
import type { PtyClient } from "../services/PtyClient.js";

// Comfortably above any realistic BrowserWindow id; unique per brokered
// connection for the process lifetime.
export const SURFACE_CONNECTION_ID_BASE = 1 << 30;
let nextConnectionOffset = 0;

export function allocateSurfaceConnectionId(): number {
  nextConnectionOffset += 1;
  return SURFACE_CONNECTION_ID_BASE + nextConnectionOffset;
}

interface BrokeredSurfacePort {
  surfaceId: string;
  connectionId: number;
  rendererPort: MessagePortMain;
  hostPort: MessagePortMain;
  cleanup: () => void;
}

export interface BrokerSurfacePortOptions {
  surfaceId: string;
  wc: Electron.WebContents;
  projectId: string | null;
  projectPath?: string;
}

export class SurfacePortBroker {
  private entries = new Map<string, BrokeredSurfacePort>();
  // Survives releaseSurfacePort so a post-reload re-broker can reuse the
  // surface's project context without a fresh IPC round-trip.
  private lastOptionsBySurfaceId = new Map<
    string,
    { projectId: string | null; projectPath?: string }
  >();

  constructor(private readonly getPtyClient: () => PtyClient | null) {}

  connectionIdFor(surfaceId: string): number | null {
    return this.entries.get(surfaceId)?.connectionId ?? null;
  }

  /**
   * Create a MessagePort pair for a surface view and connect the host half to
   * the pty-host under a fresh synthetic connection id. Re-brokering the same
   * surface (view reload, crash recovery) releases the previous pair first —
   * the pty-host only ever sees one live connection per surface.
   */
  brokerSurfacePort(options: BrokerSurfacePortOptions): number {
    const { surfaceId, wc, projectId, projectPath } = options;
    this.releaseSurfacePort(surfaceId);

    const ptyClient = this.getPtyClient();
    if (!ptyClient) {
      throw new Error("Cannot broker surface port: pty client unavailable");
    }
    if (wc.isDestroyed()) {
      throw new Error(`Cannot broker surface port: webContents destroyed (${surfaceId})`);
    }

    const connectionId = allocateSurfaceConnectionId();
    const { port1, port2 } = new MessageChannelMain();
    const handshakeToken = randomBytes(32).toString("hex");

    // Context before connect: connectMessagePort derives the owning shard
    // from this registration and replays it to the host.
    ptyClient.registerAuxConnectionContext(connectionId, projectId, projectPath);
    ptyClient.connectMessagePort(connectionId, port2);

    // Host-side close fallback (#7589): renderer-side cleanup alone misses a
    // pty-host-initiated teardown of this connection.
    const handlePortClose = () => this.releaseSurfacePort(surfaceId);
    port1.on("close", handlePortClose);

    // A destroyed webContents never re-brokers — forget its context too.
    const handleWcDestroyed = () =>
      this.releaseSurfacePort(surfaceId, { forgetContext: true });
    const handleWcNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ) => {
      // A real navigation tears down the renderer context that held the
      // port; same-document navigations do not.
      if (details.isMainFrame && !details.isSameDocument) this.releaseSurfacePort(surfaceId);
    };
    wc.once("destroyed", handleWcDestroyed);
    wc.on("did-start-navigation", handleWcNavigation);

    this.entries.set(surfaceId, {
      surfaceId,
      connectionId,
      rendererPort: port1,
      hostPort: port2,
      cleanup: () => {
        port1.removeListener("close", handlePortClose);
        wc.removeListener("destroyed", handleWcDestroyed);
        wc.removeListener("did-start-navigation", handleWcNavigation);
      },
    });
    this.lastOptionsBySurfaceId.set(surfaceId, { projectId, projectPath });

    // A failed delivery must not leave a live pty-host connection with no
    // renderer holding the other end of the pair.
    try {
      wc.postMessage("terminal-port-token", { token: handshakeToken });
      wc.postMessage("terminal-port", { token: handshakeToken }, [port1]);
    } catch (error) {
      this.releaseSurfacePort(surfaceId, { forgetContext: true });
      throw error;
    }

    return connectionId;
  }

  /**
   * Re-broker after a surface view reload using the context of the last
   * successful broker (a reload releases the port via did-start-navigation,
   * but the surface's project never changed). Returns null when this surface
   * was never brokered.
   */
  rebrokerFromLast(surfaceId: string, wc: Electron.WebContents): number | null {
    const last = this.lastOptionsBySurfaceId.get(surfaceId);
    if (!last) return null;
    return this.brokerSurfacePort({
      surfaceId,
      wc,
      projectId: last.projectId,
      projectPath: last.projectPath,
    });
  }

  /**
   * Release a surface's pty-host connection. The remembered project context
   * survives by default (a reload releases and then re-brokers); pass
   * `forgetContext` on terminal paths — surface destroy, webContents gone,
   * failed initial delivery — so contexts don't accumulate across
   * create/destroy cycles.
   */
  releaseSurfacePort(surfaceId: string, options?: { forgetContext?: boolean }): void {
    if (options?.forgetContext) {
      this.lastOptionsBySurfaceId.delete(surfaceId);
    }
    const entry = this.entries.get(surfaceId);
    if (!entry) return;
    this.entries.delete(surfaceId);

    try {
      entry.cleanup();
    } catch {
      // Listener detach is best-effort on a dying webContents.
    }

    const ptyClient = this.getPtyClient();
    if (ptyClient) {
      try {
        ptyClient.disconnectMessagePort(entry.connectionId);
      } catch (error) {
        console.warn("[SurfacePortBroker] disconnectMessagePort failed:", error);
      }
    }

    for (const port of [entry.rendererPort, entry.hostPort]) {
      try {
        port.close();
      } catch {
        // Transferred ports are neutered; closing them is best-effort.
      }
    }
  }

  dispose(): void {
    for (const surfaceId of Array.from(this.entries.keys())) {
      this.releaseSurfacePort(surfaceId);
    }
    this.lastOptionsBySurfaceId.clear();
  }
}
