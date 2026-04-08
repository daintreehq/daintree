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
