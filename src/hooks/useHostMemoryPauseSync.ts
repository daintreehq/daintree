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
 * on mount, when a cached view is revealed, and when the page becomes visible.
 * The push listener goes on first, so a pull can only ever be redundant, never
 * a gap — and a pull that a push overtook is dropped rather than applied.
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

    const apply = (snapshot: HostMemoryPauseSnapshot, live: boolean) => {
      const { setSnapshot, setVisible, visible } = useHostMemoryPauseStore.getState();
      setSnapshot(snapshot);

      if (!snapshot.active) {
        clearGate();
        if (!visible) return;
        setVisible(false);
        if (live) {
          useAnnouncerStore.getState().announce(HOST_MEMORY_PAUSE_COPY.announceEnded, "polite");
        }
        return;
      }

      if (visible) return;
      if (!live) {
        clearGate();
        setVisible(true);
        return;
      }
      if (gateTimer !== null) return;
      gateTimer = setTimeout(() => {
        gateTimer = null;
        const current = useHostMemoryPauseStore.getState().snapshot;
        if (disposed || !current?.active) return;
        useHostMemoryPauseStore.getState().setVisible(true);
        useAnnouncerStore
          .getState()
          .announce(
            current.paused
              ? HOST_MEMORY_PAUSE_COPY.announcePaused
              : HOST_MEMORY_PAUSE_COPY.monitoring.title,
            "polite"
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
          // The next push still recovers this view; a pull that keeps failing is
          // why a revealed view would sit stale, so it isn't swallowed.
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
    // DOM lifecycle event; main's reveal signal is what marks it current again.
    const offRevealed = window.electron?.app?.onViewRevealed?.(() => pull());

    return () => {
      disposed = true;
      clearGate();
      offPush();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      offRevealed?.();
    };
  }, []);
}
