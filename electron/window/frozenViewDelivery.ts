import type { WebContents } from "electron";
import { isWebContentsFrozen, onFrozenStateChange } from "../utils/webContentsLifecycle.js";
import { isCachedViewWebContents } from "./webContentsRegistry.js";

interface HeldSend {
  channel: string;
  args: unknown[];
}

const heldSends = new WeakMap<WebContents, Map<string, HeldSend>>();
let unsubscribeFrozenState: (() => void) | null = null;

/**
 * A cached project view whose renderer may be CDP-frozen. Its main thread
 * drains no IPC, so every push queues in Mojo and all of them run at once on
 * thaw, inside the warm paint gate (#17038). Both halves are required: the
 * cached mark is cleared the moment a view is activated, so an active view
 * never has its state held even if a thaw it was given has not yet landed.
 */
export function isFrozenCachedView(wc: WebContents): boolean {
  return isCachedViewWebContents(wc.id) && isWebContentsFrozen(wc);
}

/**
 * Send a full-state push whose newest value replaces every older one under
 * the same `key`. A frozen cached view holds only the newest per key and gets
 * it when it thaws or is activated, whichever comes first; any other view gets
 * it now. Only for payloads that replace the renderer's copy outright, never a
 * delta.
 */
export function sendLatestWins(
  wc: WebContents,
  key: string,
  channel: string,
  ...args: unknown[]
): void {
  if (wc.isDestroyed()) return;
  if (isFrozenCachedView(wc)) {
    let pending = heldSends.get(wc);
    if (!pending) {
      pending = new Map();
      heldSends.set(wc, pending);
    }
    // Re-inserted so the replay runs in the order the newest values arrived.
    pending.delete(key);
    pending.set(key, { channel, args });
    unsubscribeFrozenState ??= onFrozenStateChange((thawed, frozen) => {
      if (!frozen) releaseHeldSends(thawed);
    });
    return;
  }
  try {
    wc.send(channel, ...args);
  } catch {
    // A renderer torn down mid-send has nothing left to receive it.
  }
}

/**
 * Send whatever {@link sendLatestWins} held for this view. Activation calls it
 * as it clears the cached mark: the thaw it starts may still be in flight, but
 * these then sit in Mojo ahead of everything activation sends, as the pushes
 * they replace would have.
 */
export function releaseHeldSends(wc: WebContents): void {
  const pending = heldSends.get(wc);
  if (!pending) return;
  heldSends.delete(wc);
  if (wc.isDestroyed()) return;
  for (const { channel, args } of pending.values()) {
    try {
      wc.send(channel, ...args);
    } catch {
      // A renderer torn down mid-send has nothing left to receive it.
    }
  }
}
