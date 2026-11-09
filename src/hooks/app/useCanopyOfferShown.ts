import { useEffect } from "react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import { canopyOwnHostId, useCanopyStore } from "@/store/canopyStore";

/**
 * Whether this project view shows Canopy's offer to turn it on. Canopy's inbox
 * opens only in its own window (#16581), so a project view shows the offer
 * alone, and only before Canopy is on. An offer still open as Canopy turns on
 * (from the offer itself, or before this view knew Canopy was on) is put away
 * and the window opens in its place. A view the user isn't in only puts it
 * away: a cached view's offer may never have mounted to close itself, and a
 * window the user has left may hear Canopy turn on from another, and the
 * Canopy window opening from either would take focus from where the user is.
 *
 * A view on a remote host reads that host's Canopy, not this machine's, which
 * the window needs: it offers nothing, and its way in asks for the window.
 */
export function useCanopyOfferShown(): boolean {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const on = useCanopyStore((s) => s.mode === "on");
  const remote = canopyOwnHostId() !== LOCAL_HOST_ID;
  useEffect(() => {
    if (!on && !remote) return;
    const { isOpen: stillOpen, close } = useCanopyStore.getState();
    if (!stillOpen) return;
    close();
    if (remote || isProjectViewCached() || !document.hasFocus()) return;
    void actionService.dispatch("canopy.openWindow", undefined, { source: "user" });
  }, [isOpen, on, remote]);
  return isOpen && !on && !remote;
}
