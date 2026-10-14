import { useEffect } from "react";
import { isRemoteShellSupported } from "@/lib/remoteHosts";

/**
 * Follow this view's window on its way to another host, from the app's first
 * render: a window reopening on its host at launch is switching before its
 * state has loaded, and typing must go nowhere for as long as any switch is
 * pending. Its code loads only where Remote Hosts can exist.
 */
export function usePendingHostSwitchSync(): void {
  useEffect(() => {
    if (!isRemoteShellSupported()) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void import("@/components/HostSwitch/pendingHostSwitchFeedback").then(
      ({ watchPendingHostSwitch }) => {
        if (disposed) return;
        stop = watchPendingHostSwitch(window.electron?.remoteHosts ?? {});
      },
      () => {}
    );
    return () => {
      disposed = true;
      stop?.();
      stop = null;
    };
  }, []);
}
