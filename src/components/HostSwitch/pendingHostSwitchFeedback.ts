import type { PendingHostSwitch, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { notify } from "@/lib/notify";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useNotificationStore } from "@/store/notificationStore";
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";

/** Past this, a wait that is still going says so (the loading-gate family's "Still working…"). */
export const STILL_WORKING_MS = 5_000;

const WAITING_MESSAGE = "This window stays as it is until then.";
const STILL_WORKING_MESSAGE = "Still working…";

/** What a switch that is taking a while says it is doing. */
export function pendingHostSwitchTitle(pending: PendingHostSwitch): string {
  switch (pending.phase) {
    case "connecting":
      return `Connecting to ${pending.hostName}…`;
    case "starting":
      return `Starting Daintree on ${pending.hostName}…`;
    case "opening":
      return pending.projectName
        ? `Opening ${pending.projectName} on ${pending.hostName}…`
        : `Opening ${pending.hostName}…`;
  }
}

interface RemoteHostsSwitchApi {
  onEvent?: (callback: (event: RemoteHostsEvent) => void) => () => void;
  getPendingSwitch?: () => Promise<PendingHostSwitch | null>;
  cancelPendingSwitch?: (payload: { switchId: string }) => Promise<boolean>;
}

/**
 * Keep this view told where its window's switch to a host is, and show it
 * once it has taken long enough to notice. A fast switch shows nothing; a slow
 * one gets one progress notice that follows its phase, carries Cancel, and
 * goes away however the switch ends. No success notice: the window moving is
 * the news.
 */
export function watchPendingHostSwitch(api: RemoteHostsSwitchApi): () => void {
  const store = usePendingHostSwitchStore;
  let heardEvent = false;
  let disposed = false;
  const stopEvents = api.onEvent?.((event) => {
    if (disposed || event.type !== "switch-pending") return;
    heardEvent = true;
    store.getState().setPending(event.pending);
  });
  // A view that mounts while its window is already switching asks once; an
  // event that arrived meanwhile is newer than this answer.
  void api.getPendingSwitch?.().then(
    (pending) => {
      if (!disposed && !heardEvent) store.getState().setPending(pending);
    },
    () => {}
  );

  let shownFor: string | null = null;
  let notificationId: string | null = null;
  let stillWorking = false;
  let onsetTimer: ReturnType<typeof setTimeout> | null = null;
  let stillWorkingTimer: ReturnType<typeof setTimeout> | null = null;

  // A notice held back while the window was in the background (it goes to
  // no inbox: it is only worth seeing while the switch is on its way) shows
  // when the window is looked at again.
  const showWhenFocused = () => {
    // Not before the gate: a switch that hasn't been slow yet shows nothing.
    if (onsetTimer || notificationId) return;
    const current = store.getState().pending;
    if (current && current.switchId === shownFor) show(current);
  };
  const focusSource = typeof window === "undefined" ? null : window;
  focusSource?.addEventListener("focus", showWhenFocused);

  const withdraw = () => {
    if (onsetTimer) clearTimeout(onsetTimer);
    if (stillWorkingTimer) clearTimeout(stillWorkingTimer);
    onsetTimer = null;
    stillWorkingTimer = null;
    if (notificationId) useNotificationStore.getState().dismissNotification(notificationId);
    notificationId = null;
    shownFor = null;
    stillWorking = false;
  };

  const show = (pending: PendingHostSwitch) => {
    if (notificationId) return;
    if (stillWorkingTimer) clearTimeout(stillWorkingTimer);
    notificationId =
      notify({
        type: "info",
        priority: "high",
        transient: true,
        context: { eventKind: "connectivity" },
        title: pendingHostSwitchTitle(pending),
        message: WAITING_MESSAGE,
        duration: 0,
        actions: [
          {
            label: "Cancel",
            variant: "secondary",
            onClick: () => {
              void api.cancelPendingSwitch?.({ switchId: pending.switchId }).catch(() => {});
            },
          },
        ],
      }) || null;
    if (stillWorking) {
      if (notificationId) {
        useNotificationStore.getState().updateNotification(notificationId, {
          message: STILL_WORKING_MESSAGE,
        });
      }
      return;
    }
    stillWorkingTimer = setTimeout(() => {
      stillWorkingTimer = null;
      stillWorking = true;
      if (notificationId) {
        useNotificationStore.getState().updateNotification(notificationId, {
          message: STILL_WORKING_MESSAGE,
        });
      }
    }, STILL_WORKING_MS - UI_DOHERTY_THRESHOLD);
  };

  const apply = (pending: PendingHostSwitch | null) => {
    if (!pending || pending.switchId !== shownFor) withdraw();
    if (!pending) return;
    if (shownFor === pending.switchId) {
      // The same switch moved on to its next phase.
      if (notificationId) {
        useNotificationStore.getState().updateNotification(notificationId, {
          title: pendingHostSwitchTitle(pending),
          message: stillWorking ? STILL_WORKING_MESSAGE : WAITING_MESSAGE,
        });
      }
      return;
    }
    shownFor = pending.switchId;
    onsetTimer = setTimeout(() => {
      onsetTimer = null;
      const current = store.getState().pending;
      if (current?.switchId === shownFor) show(current);
    }, UI_DOHERTY_THRESHOLD);
  };

  apply(store.getState().pending);
  const stopStore = store.subscribe((state, previous) => {
    if (state.pending !== previous.pending) apply(state.pending);
  });

  return () => {
    disposed = true;
    focusSource?.removeEventListener("focus", showWhenFocused);
    stopEvents?.();
    stopStore();
    withdraw();
    store.getState().setPending(null);
  };
}
