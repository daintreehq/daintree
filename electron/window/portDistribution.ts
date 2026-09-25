/**
 * PTY MessagePort distribution — creates and delivers MessagePort pairs
 * to specific WebContents views for direct pty-host ↔ renderer communication.
 *
 * Extracted into its own module to avoid circular dependencies between
 * windowServices.ts and IPC handlers that need to distribute ports on
 * project switch.
 */

import { BrowserWindow, MessageChannelMain } from "electron";
import { randomBytes } from "crypto";
import {
  clearPortHolderWebContents,
  isCachedViewWebContents,
  registerPortHolderWebContents,
} from "./webContentsRegistry.js";
import type { WindowContext } from "./WindowRegistry.js";
import type { PtyClient } from "../services/PtyClient.js";

/**
 * Claims a view whose terminal port comes from somewhere other than this
 * process's pty-host — a view bound to a remote host, whose port is relayed
 * over the link. Returns true when it (re)delivered that port itself.
 */
export type TerminalPortOverride = (targetWc: Electron.WebContents) => boolean;

let terminalPortOverride: TerminalPortOverride | null = null;

/**
 * Install the override consulted before every local port distribution, so the
 * paths that re-broker a view's port (load, reload, project switch, pty-host
 * restart) re-deliver the relayed port instead of replacing it with a local one.
 */
export function setTerminalPortOverride(override: TerminalPortOverride | null): () => void {
  terminalPortOverride = override;
  return () => {
    if (terminalPortOverride === override) terminalPortOverride = null;
  };
}

/**
 * What core window code asks about a view whose ports come from a remote
 * host. Installed by Remote Hosts only once a host is actually in use, so
 * with nothing installed every view is local and nothing here runs.
 */
export interface RemoteViewHooks {
  /** The view is bound to a remote host (its ports are relayed over the link). */
  isRemoteView(webContents: Electron.WebContents): boolean;
  /** Re-post a remote view's relayed worktree port (after a reload or reactivation). */
  redeliverWorktreePort(webContents: Electron.WebContents): void;
}

let remoteViewHooks: RemoteViewHooks | null = null;

export function setRemoteViewHooks(hooks: RemoteViewHooks | null): () => void {
  remoteViewHooks = hooks;
  return () => {
    if (remoteViewHooks === hooks) remoteViewHooks = null;
  };
}

export function getRemoteViewHooks(): RemoteViewHooks | null {
  return remoteViewHooks;
}

/**
 * Retire a window's local terminal port pair and its worker ports: the view
 * the window now shows is served over the link, and the pty-host must stop
 * streaming the previous local project into a view nobody is looking at —
 * what a local switch does by replacing the pair.
 */
export function releaseWindowTerminalPort(ctx: WindowContext, ptyClient: PtyClient | null): void {
  releaseAllTerminalWorkerPorts(ctx, ptyClient);
  const hadPort = ctx.services.activePtyHostPort !== undefined;
  for (const port of [ctx.services.activeRendererPort, ctx.services.activePtyHostPort]) {
    try {
      port?.close();
    } catch {
      /* ignore */
    }
  }
  ctx.services.activeRendererPort = undefined;
  ctx.services.activePtyHostPort = undefined;
  if (hadPort) ptyClient?.disconnectMessagePort(ctx.windowId);
  clearPortHolderWebContents(ctx.windowId);
}

/**
 * Hand a view the renderer end of a fresh terminal port using the token
 * handshake the renderer's terminal client expects: the token first, then the
 * port carrying it. Returns the other end, or null when the view could not
 * take it (both ends are closed then).
 */
export function postTerminalPortToView(
  targetWc: Electron.WebContents
): Electron.MessagePortMain | null {
  if (targetWc.isDestroyed()) return null;
  const { port1, port2 } = new MessageChannelMain();
  const handshakeToken = randomBytes(32).toString("hex");
  try {
    targetWc.postMessage("terminal-port-token", { token: handshakeToken });
    targetWc.postMessage("terminal-port", { token: handshakeToken }, [port1]);
    return port2;
  } catch (error) {
    console.warn("[portDistribution] Failed to deliver relayed terminal MessagePort:", error);
    for (const port of [port1, port2]) {
      try {
        port.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/**
 * Create a MessagePort pair and send it to a specific WebContents.
 * Each call replaces the window's active port pair — the pty-host only
 * keeps one renderer connection per windowId.
 */
export function distributePortsToView(
  win: BrowserWindow,
  ctx: WindowContext,
  targetWc: Electron.WebContents,
  ptyClient: PtyClient | null
): void {
  if (terminalPortOverride?.(targetWc)) {
    // A cached view reloading in the background must not take the port from
    // the window's active local view; only the view being shown retires it.
    if (!isCachedViewWebContents(targetWc.id)) releaseWindowTerminalPort(ctx, ptyClient);
    return;
  }

  // Dedicated worker-ingest ports share the window port's lifecycle chokepoint:
  // replacing the window pair (project switch, reload) severs them too — the
  // outgoing view's parse workers must not keep receiving bytes once the
  // window's routing moves on (#6283). The renderer sees the port close and
  // falls back; a re-engage mints fresh ports lazily.
  releaseAllTerminalWorkerPorts(ctx, ptyClient);

  if (ctx.services.activeRendererPort) {
    try {
      ctx.services.activeRendererPort.close();
    } catch {
      /* ignore */
    }
  }
  if (ctx.services.activePtyHostPort) {
    try {
      ctx.services.activePtyHostPort.close();
    } catch {
      /* ignore */
    }
  }

  const { port1, port2 } = new MessageChannelMain();
  const handshakeToken = randomBytes(32).toString("hex");

  ctx.services.activeRendererPort = port1;
  ctx.services.activePtyHostPort = port2;

  // Cleared before the host-side connect, restored only once the renderer end
  // is confirmed delivered below (#12557). Between those two points this
  // window has no confirmed port holder, which is exactly right: the outgoing
  // view may still be draining the old pair, the incoming one has nothing yet,
  // and both must stay eligible for the project-scoped IPC fallback rather
  // than be excluded from it on the strength of a port neither holds.
  clearPortHolderWebContents(ctx.windowId);

  if (ptyClient) {
    ptyClient.connectMessagePort(ctx.windowId, port2, targetWc.id);
  }

  if (win && !win.isDestroyed() && !targetWc.isDestroyed()) {
    try {
      targetWc.postMessage("terminal-port-token", { token: handshakeToken });
      targetWc.postMessage("terminal-port", { token: handshakeToken }, [port1]);
      // Confirmed: this view owns the window's port, so Main may exclude it
      // from an IPC fallback the host says its port already carried.
      registerPortHolderWebContents(ctx.windowId, targetWc.id);
    } catch (error) {
      // A reloading frame can be disposed while its WebContents still reports
      // alive, so postMessage throws despite the isDestroyed() checks. Keep
      // the pair wired: closing port1 would fire the pty-host's port-close
      // teardown and sever the connection just re-established; onViewReady
      // re-brokers a fresh pair once the frame finishes reloading.
      console.warn(
        `[portDistribution] Failed to deliver terminal MessagePort to window ${ctx.windowId}; awaiting re-broker:`,
        error
      );
    }
  }
}

/**
 * Mint and deliver a dedicated worker-ingest MessagePort pair for one
 * terminal (issue #10960): the pty-host end goes to the terminal's owning
 * shard, the renderer end is posted to the view with a handshake token that
 * the requesting IPC invoke also returns — the renderer matches the two and
 * re-transfers the port into its parse worker without ever reading it.
 * Returns null when the port cannot be delivered (no pty client, window
 * gone); the renderer's request timeout handles the rest.
 */
export function distributeTerminalWorkerPortToView(
  win: BrowserWindow,
  ctx: WindowContext,
  targetWc: Electron.WebContents,
  ptyClient: PtyClient | null,
  terminalId: string
): { token: string } | null {
  releaseTerminalWorkerPort(ctx, ptyClient, terminalId);

  if (!ptyClient || !win || win.isDestroyed() || targetWc.isDestroyed()) {
    return null;
  }

  const { port1, port2 } = new MessageChannelMain();
  const token = randomBytes(32).toString("hex");

  const ports = (ctx.services.terminalWorkerPorts ??= new Map());
  ports.set(terminalId, { rendererPort: port1, ptyHostPort: port2 });

  ptyClient.connectTerminalMessagePort(ctx.windowId, terminalId, port2);
  try {
    targetWc.postMessage("terminal-worker-port", { token, terminalId }, [port1]);
  } catch (error) {
    // Same disposed-frame race as above. Worker ports are lazy and
    // best-effort, so a failed delivery releases the pair immediately —
    // the renderer's request timeout mints a fresh one on re-engage.
    console.warn(
      `[portDistribution] Failed to deliver worker MessagePort for terminal ${terminalId} in window ${ctx.windowId}; releasing pair:`,
      error
    );
    releaseTerminalWorkerPort(ctx, ptyClient, terminalId);
    return null;
  }
  return { token };
}

/** Close one terminal's dedicated worker-ingest pair and tell the shard. */
export function releaseTerminalWorkerPort(
  ctx: WindowContext,
  ptyClient: PtyClient | null,
  terminalId: string
): void {
  const pair = ctx.services.terminalWorkerPorts?.get(terminalId);
  if (!pair) return;
  ctx.services.terminalWorkerPorts?.delete(terminalId);
  ptyClient?.disconnectTerminalMessagePort(ctx.windowId, terminalId);
  try {
    pair.rendererPort.close();
  } catch {
    /* ignore */
  }
  try {
    // Neutered no-op when already transferred to the pty-host process.
    pair.ptyHostPort.close();
  } catch {
    /* ignore */
  }
}

/** Close every dedicated worker-ingest pair for a window. */
export function releaseAllTerminalWorkerPorts(
  ctx: WindowContext,
  ptyClient: PtyClient | null
): void {
  const ports = ctx.services.terminalWorkerPorts;
  if (!ports) return;
  for (const terminalId of [...ports.keys()]) {
    releaseTerminalWorkerPort(ctx, ptyClient, terminalId);
  }
}
