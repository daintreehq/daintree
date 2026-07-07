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
import type { WindowContext } from "./WindowRegistry.js";
import type { PtyClient } from "../services/PtyClient.js";

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

  if (ptyClient) {
    ptyClient.connectMessagePort(ctx.windowId, port2);
  }

  if (win && !win.isDestroyed() && !targetWc.isDestroyed()) {
    targetWc.postMessage("terminal-port-token", { token: handshakeToken });
    targetWc.postMessage("terminal-port", { token: handshakeToken }, [port1]);
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
  targetWc.postMessage("terminal-worker-port", { token, terminalId }, [port1]);
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
