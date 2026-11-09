import { useEffect } from "react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import { canopyOwnHostId, useCanopyStore } from "@/store/canopyStore";

/**
 * Whether this project view shows Canopy's panel: only before Canopy is on,
 * where it offers to turn it on. Once on, Canopy's one home is its own window
 * (#16578), so a panel asked for here, or still open as Canopy turned on (from
 * the offer itself, or before this view knew Canopy was on), is put away and
 * the window opens in its place. A view the user isn't in only puts it away:
 * a cached view's panel may never have mounted to close itself, and a window
 * the user has left may hear Canopy turn on from another, and the Canopy
 * window opening from either would take focus from where the user is.
 *
 * A view on a remote host reads that host's Canopy, not this machine's, which
 * the window needs: its panel opens only when the window couldn't, and stays.
 */
export function useCanopyPanelShown(): boolean {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const on = useCanopyStore((s) => s.mode === "on");
  const routesToWindow = on && canopyOwnHostId() === LOCAL_HOST_ID;
  useEffect(() => {
    if (!routesToWindow) return;
    const { isOpen: stillOpen, close } = useCanopyStore.getState();
    if (!stillOpen) return;
    close();
    if (isProjectViewCached() || !document.hasFocus()) return;
    void actionService.dispatch("canopy.openWindow", undefined, { source: "user" });
  }, [isOpen, routesToWindow]);
  return isOpen && !routesToWindow;
}
