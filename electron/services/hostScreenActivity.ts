import type { ClientEndpoint } from "../ipc/endpoint.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { readUserPresence } from "./userPresence.js";

/**
 * Whether a view on this machine's own screen is in active use: it is the
 * active view of a focused window, and the person here hasn't stepped away.
 * Presence that can't be read counts as in use, so an unreadable idle state
 * never lets another machine take the project from someone sitting at it.
 */
export function isLocalViewInActiveUse(endpoint: Pick<ClientEndpoint, "kind" | "handle">): boolean {
  if (endpoint.kind !== "local-view") return false;
  const shown = getWindowRegistry()
    ?.all()
    .some((ctx) => {
      const window = ctx.browserWindow;
      if (window.isDestroyed() || !window.isFocused()) return false;
      const active = ctx.services.projectViewManager?.getActiveView()?.webContents;
      return active !== undefined && !active.isDestroyed() && active.id === endpoint.handle;
    });
  return shown === true && readUserPresence() !== "away";
}
