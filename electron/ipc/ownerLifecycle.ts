import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import type { IpcContext } from "./types.js";

export interface OwnerWatcher {
  /** Starts watching the view behind `ctx` for `owner`; a second call for the same owner is a no-op. */
  watch(ctx: IpcContext, owner: string): void;
  /** Detaches every watch without stopping anything. */
  dispose(): void;
}

/**
 * A view that navigates, crashes, closes or (remotely) drops its endpoint never
 * runs its own cleanup, so work it started is stopped here instead: `stop` runs
 * with the owner key on main-frame navigation, renderer loss, WebContents
 * destruction, or a remote endpoint closing.
 */
export function createOwnerWatcher(stop: (owner: string) => void): OwnerWatcher {
  const watched = new Map<string, () => void>();
  return {
    watch(ctx, owner) {
      if (watched.has(owner)) return;
      const stopOwner = () => stop(owner);
      const sender = ctx.event?.sender;
      if (!sender) {
        const closed = ctx.endpoint.onClose(() => {
          watched.delete(owner);
          stopOwner();
        });
        watched.set(owner, () => closed.dispose());
        return;
      }
      const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) stopOwner();
      };
      sender.on("did-start-navigation", onNavigate);
      sender.on("render-process-gone", stopOwner);
      const unwatchDestroyed = onWebContentsDestroyed(sender, () => {
        watched.delete(owner);
        sender.removeListener("did-start-navigation", onNavigate);
        sender.removeListener("render-process-gone", stopOwner);
        stopOwner();
      });
      watched.set(owner, () => {
        sender.removeListener("did-start-navigation", onNavigate);
        sender.removeListener("render-process-gone", stopOwner);
        unwatchDestroyed();
      });
    },
    dispose() {
      for (const unwatch of watched.values()) unwatch();
      watched.clear();
    },
  };
}
