import { useEffect } from "react";
import type { HostMemoryPauseSnapshot } from "@shared/types/pty-host";
import { terminalClient } from "@/clients/terminalClient";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { logWarn } from "@/utils/logger";

/**
 * Keeps this view's terminal-host memory pause in step with main and announces
 * it once for the whole app (#12375).
 *
 * Main pushes only to each window's active view, so the snapshot is also pulled:
 * on mount, when a cached view is revealed or a failed switch rolls back to it,
 * and when the page becomes visible. The push listener goes on first, so a pull
 * can only ever be redundant, never a gap — and a pull that a push overtook is
 * dropped rather than applied.
 *
 * A pull reconciles silently: it describes a pause already under way, not a
 * transition the user is witnessing. A pushed episode shows, and is announced,
 * only once it outlives the Doherty gate; its end is announced only if it
 * showed. Nothing is announced as output flaps paused/resumed inside one
 * episode — the episode stays open across a forced resume.
 */
export function useHostMemoryPauseSync(): void {
  useEffect(() => {
    let disposed = false;
    let pushCount = 0;
    let latestPull = 0;
    let gateTimer: ReturnType<typeof setTimeout> | null = null;

    const clearGate = () => {
      if (gateTimer !== null) {
        clearTimeout(gateTimer);
        gateTimer = null;
      }
    };

    // Every window's active view receives the push, so only the view the user
    // is actually in speaks — the rest would repeat it from the background.
    const announce = (message: string) => {
      if (!document.hasFocus()) return;
      useAnnouncerStore.getState().announce(message, "polite");
    };

    const apply = (snapshot: HostMemoryPauseSnapshot, live: boolean) => {
      const { setSnapshot, setVisible, visible } = useHostMemoryPauseStore.getState();
      setSnapshot(snapshot);

      if (!snapshot.active) {
        clearGate();
        if (!visible) return;
        setVisible(false);
        if (live) announce(HOST_MEMORY_PAUSE_COPY.announceEnded);
        return;
      }

      // Already showing, or a pushed pause is still waiting out its gate — a
      // reconciling pull must neither cut that short nor swallow its
      // announcement.
      if (visible || gateTimer !== null) return;
      if (!live) {
        setVisible(true);
        return;
      }
      gateTimer = setTimeout(() => {
        gateTimer = null;
        const current = useHostMemoryPauseStore.getState().snapshot;
        if (disposed || !current?.active) return;
        useHostMemoryPauseStore.getState().setVisible(true);
        announce(
          current.paused
            ? HOST_MEMORY_PAUSE_COPY.announcePaused
            : HOST_MEMORY_PAUSE_COPY.monitoring.title
        );
      }, UI_DOHERTY_THRESHOLD);
    };

    const pull = () => {
      const pullId = ++latestPull;
      const pushesAtStart = pushCount;
      terminalClient.getHostMemoryPause().then(
        (snapshot) => {
          if (disposed || pullId !== latestPull || pushCount !== pushesAtStart) return;
          apply(snapshot, false);
        },
        (error: unknown) => {
          // The next push or reveal still recovers this view; a pull that keeps
          // failing is why it would sit stale, so it isn't swallowed.
          logWarn("[useHostMemoryPauseSync] Failed to read the host memory pause", { error });
        }
      );
    };

    const offPush = terminalClient.onHostMemoryPause((snapshot) => {
      pushCount++;
      apply(snapshot, true);
    });
    pull();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // A cached project view is parked with `setVisible(false)`, which fires no
    // DOM lifecycle event, so main's view signals mark it current again: reveal
    // for a warm switch, warm activation alone for a failed switch rolled back
    // to a view that may never have left the screen.
    const offRevealed = window.electron?.app?.onViewRevealed?.(() => pull());
    const offWarmActivated = window.electron?.app?.onViewWarmActivated?.(() => pull());
    // Parked mid-gate, this view is no longer where the user is. Its pending
    // pause goes unannounced; the pull on its return shows it silently.
    const offCached = window.electron?.app?.onViewCached?.(() => clearGate());

    return () => {
      disposed = true;
      clearGate();
      offPush();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      offRevealed?.();
      offWarmActivated?.();
      offCached?.();
    };
  }, []);
}
