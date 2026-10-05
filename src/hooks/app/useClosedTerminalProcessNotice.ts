import { useEffect, useRef } from "react";
import type { ProcessInventoryClosedProcess } from "@shared/types/processes";
import { processesClient } from "@/clients/processesClient";
import { notify } from "@/lib/notify";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useNotificationStore } from "@/store/notificationStore";
import { closedProcessKey, describeClosedSummary } from "@/components/Project/processesView";

export const CLOSED_PROCESS_POLL_MS = 15_000;
const SUPERSEDE_KEY = "closed-terminal-processes";

/**
 * Raises one grid-bar notice when a process outlives the terminal that started
 * it (#13174), with a way into the processes view to see and kill it.
 *
 * The first read is a baseline: whatever is already running then was either
 * announced by the view that was visible when it appeared, or is listed in the
 * processes view — announcing it again on every project switch would be noise.
 * After that, only identities this view hasn't seen raise the notice, and it
 * leaves once nothing from a closed terminal is running. Reads only while the
 * view is observable.
 */
export function useClosedTerminalProcessNotice(onView: () => void): void {
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  }, [onView]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let seen: Set<string> | null = null;
    let noticeId: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const clearNotice = () => {
      if (noticeId === null) return;
      useNotificationStore.getState().removeNotification(noticeId);
      noticeId = null;
    };

    const announce = (processes: ProcessInventoryClosedProcess[]) => {
      clearNotice();
      const message =
        "Started in terminals that have since closed, and still running. See them in Running processes.";
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      const id = notify({
        type: "info",
        placement: "grid-bar",
        title: describeClosedSummary(processes),
        message,
        inboxMessage: message,
        duration: 0,
        supersedeKey: SUPERSEDE_KEY,
        actions: [
          {
            label: "View processes",
            variant: "primary",
            onClick: () => {
              clearNotice();
              onViewRef.current();
            },
          },
        ],
      });
      noticeId = id || null;
    };

    const read = () => {
      if (inFlight || !isProjectViewObservable()) return;
      inFlight = true;
      // Deferred so a bridge that isn't there rejects instead of throwing here.
      Promise.resolve()
        .then(() => processesClient.getSnapshot())
        .then(
          (snapshot) => {
            if (cancelled) return;
            const processes = snapshot.closedTerminalProcesses;
            const keys = processes.map(closedProcessKey);
            if (seen === null) {
              seen = new Set(keys);
              return;
            }
            const fresh = keys.filter((key) => !seen!.has(key));
            for (const key of keys) seen.add(key);
            if (processes.length === 0) {
              clearNotice();
              seen = new Set();
            } else if (fresh.length > 0) {
              announce(processes);
            }
          },
          () => {
            // A failed read says nothing about what's running; the processes
            // view owns reporting that the list couldn't be read.
          }
        )
        .finally(() => {
          inFlight = false;
        });
    };

    const start = () => {
      if (timer !== null) return;
      read();
      timer = setInterval(read, CLOSED_PROCESS_POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    if (isProjectViewObservable()) start();
    const offObservability = subscribeProjectViewObservability((observable) => {
      if (observable) start();
      else stop();
    });

    return () => {
      cancelled = true;
      stop();
      offObservability();
    };
  }, []);
}
