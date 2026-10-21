import { useEffect, useRef } from "react";
import { useNotificationStore, type NotificationAction } from "@/store/notificationStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryAction,
} from "@/store/slices/notificationHistorySlice";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useDistributionStore } from "@/store/distributionStore";

const UPDATE_CORRELATION_ID = "app-update";
const CHANGELOG_URL = "https://daintree.org/changelog";

/** The stage of the update the user is currently being told about. */
type UpdateStage = { version: string; downloaded: boolean };

// One card walks every stage: the title names the stage, the body is the
// version and never changes, so the user always knows which release this is.
const versionLine = (version: string) => `Version ${version}`;

function downloadProgress(version: string, percent: number | null) {
  return { value: percent, label: `Downloading version ${version}` };
}

function findLiveUpdateToastId(): string | null {
  const match = useNotificationStore
    .getState()
    .notifications.find((n) => !n.dismissed && n.correlationId === UPDATE_CORRELATION_ID);
  return match?.id ?? null;
}

function restartAction() {
  return {
    label: "Restart to update",
    onClick: () => {
      const promise = window.electron?.update?.quitAndInstall();
      if (promise) {
        safeFireAndForget(promise, { context: "Quit and install update" });
      }
    },
  };
}

function changelogHistoryAction(): NotificationHistoryAction {
  // Site-wide changelog, not a per-version page: daintree.org anchors its
  // entries by date (#2026-09-07), which the updater's bare semver cannot
  // resolve, so there is nothing version-specific to deep-link to.
  return {
    label: "View changelog",
    // Secondary keeps "Restart to update" the single load-bearing CTA — this is
    // an informational escape hatch, not a competing decision.
    variant: "secondary",
    // actionId + actionArgs (not bare onClick) so the button survives the
    // inbox-history filter in notify.ts — actions without an actionId are
    // silently dropped, leaving history text with no way to act on it.
    actionId: "system.openExternal",
    actionArgs: { url: CHANGELOG_URL },
  };
}

function changelogAction(): NotificationAction {
  return {
    ...changelogHistoryAction(),
    onClick: () => {
      const promise = window.electron?.system?.openExternal(CHANGELOG_URL);
      if (promise) {
        safeFireAndForget(promise, { context: "Open changelog" });
      }
    },
  };
}

function surfaceAvailable(version: string): void {
  // Repeats and re-checks collapse onto the same toast via correlationId; no
  // bespoke dedup ref needed. The store's collapse path resets the auto-dismiss
  // timer and increments the count badge.
  notify({
    type: "info",
    title: "Downloading update",
    message: versionLine(version),
    inboxMessage: `Version ${version} is downloading in the background.`,
    priority: "high",
    duration: 0,
    correlationId: UPDATE_CORRELATION_ID,
    // Retires a stale "Update ready" row, so the inbox only ever holds the
    // stage the update is actually in.
    supersedeKey: UPDATE_CORRELATION_ID,
    // The download starts with the announcement; the bar is unmeasured until
    // the first progress tick.
    progress: downloadProgress(version, null),
    // Explicit undefined: if a prior "Update ready" toast is live (stage
    // regression), clear its "Restart to update" action so the user does not
    // accidentally restart into a stale build while a newer one is still
    // downloading. The "View changelog" link goes with it — it stays valid, but
    // this stage is an announcement, not a control surface.
    action: undefined,
    actions: undefined,
    // Forwarded to main only when the user explicitly closes the toast —
    // MAX_VISIBLE_TOASTS eviction and programmatic dismissals bypass this.
    onDismiss: () => {
      // why: stays on the lightweight logError path — analytics-grade forward to
      // main, not worth surfacing through Sentry/error store.
      const promise = window.electron?.update?.notifyDismiss?.(version);
      promise?.catch((err) => logError("[useUpdateListener] notifyDismiss failed", err));
    },
  });
}

const READY_INBOX_MESSAGE = (version: string) =>
  `Version ${version} is downloaded. Restart Daintree whenever it suits you to install it.`;

function surfaceDownloaded(version: string): void {
  const liveId = findLiveUpdateToastId();
  if (liveId) {
    // Patching the toast in place bypasses notify(), so the inbox would keep
    // saying "downloading" after the toast is gone. Write the stage there too,
    // retiring the downloading row, and link the toast to the new row so a
    // later stack eviction marks the right one unseen.
    const historyEntryId = useNotificationHistoryStore.getState().addEntry({
      type: "success",
      title: "Update ready",
      message: READY_INBOX_MESSAGE(version),
      correlationId: UPDATE_CORRELATION_ID,
      supersedeKey: UPDATE_CORRELATION_ID,
      // Seen only if the window is focused to show the patched toast — the
      // same focus gate notify() applies — so a blurred stage change stays
      // unread instead of quietly clearing the badge.
      seenAsToast: typeof document === "undefined" || document.hasFocus(),
      actions: [changelogHistoryAction()],
    });
    // Stage transition: clear the Available-stage onDismiss so dismissing the
    // "Update ready" toast does not start the 24h Available cooldown. The user
    // still needs to be re-reminded about the pending install.
    useNotificationStore.getState().updateNotification(liveId, {
      type: "success",
      title: "Update ready",
      message: versionLine(version),
      inboxMessage: READY_INBOX_MESSAGE(version),
      historyEntryId,
      duration: 0,
      dismissed: false,
      onDismiss: undefined,
      progress: undefined,
      action: restartAction(),
      actions: [changelogAction()],
    });
    return;
  }
  // Either no Available toast was ever shown (quiet period, or this renderer
  // mounted after that stage), or the user dismissed it. Either way "Downloaded"
  // is a distinct stage and must not be swallowed by the Available-stage
  // cooldown — raise a fresh toast.
  //
  // urgent: an install is genuinely ready, so it outranks a scheduled quiet
  // window.
  notify({
    type: "success",
    title: "Update ready",
    message: versionLine(version),
    inboxMessage: READY_INBOX_MESSAGE(version),
    priority: "high",
    urgent: true,
    duration: 0,
    correlationId: UPDATE_CORRELATION_ID,
    supersedeKey: UPDATE_CORRELATION_ID,
    progress: undefined,
    action: restartAction(),
    actions: [changelogAction()],
  });
}

export function useUpdateListener(suppressToasts = false): void {
  const updatesManagedByStore = useDistributionStore((s) => s.isWindowsStore);
  const suppressRef = useRef(suppressToasts);
  const pendingUpdateRef = useRef<UpdateStage | null>(null);

  // Keep ref in sync
  useEffect(() => {
    suppressRef.current = suppressToasts;
  }, [suppressToasts]);

  // Surface pending update when suppression lifts
  useEffect(() => {
    if (updatesManagedByStore) return;
    if (suppressToasts) return;
    if (!pendingUpdateRef.current) return;

    const { version, downloaded } = pendingUpdateRef.current;
    pendingUpdateRef.current = null;

    if (downloaded) surfaceDownloaded(version);
    else surfaceAvailable(version);
  }, [suppressToasts, updatesManagedByStore]);

  useEffect(() => {
    if (updatesManagedByStore) return;
    if (!window.electron?.update) return;

    // Set before the listeners are torn down, so a hydrate response that lands
    // after this view is unmounted (or evicted from the LRU) can't toast into a
    // renderer that is going away.
    let disposed = false;
    // A live event always tells us at least as much as the snapshot the hydrate
    // call is fetching, so once one arrives the in-flight snapshot is redundant
    // at best and stale at worst. Without this, a slow `getLatest()` resolving
    // "available" after `update-downloaded` already fired would collapse onto the
    // live toast via correlationId and regress it from "Update ready" (with its
    // restart action) back to "downloading…".
    let liveStateSeen = false;
    // Progress ticks carry only a percent; the version comes from whichever
    // stage last named it.
    let knownVersion: string | null = null;

    const surface = (stage: UpdateStage) => {
      knownVersion = stage.version;
      if (suppressRef.current) {
        // Never downgrade a pending "downloaded" to "available" — a follow-up
        // re-check (or a hydrate) during the startup quiet period must not roll
        // the stored stage back, so the user is still told "Update ready" once
        // toasts unmute.
        if (stage.downloaded || !pendingUpdateRef.current?.downloaded) {
          pendingUpdateRef.current = stage;
        }
        return;
      }
      if (stage.downloaded) surfaceDownloaded(stage.version);
      else surfaceAvailable(stage.version);
    };

    const cleanupAvailable = window.electron.update.onUpdateAvailable((info) => {
      liveStateSeen = true;
      surface({ version: info.version, downloaded: false });
    });

    const cleanupProgress = window.electron.update.onDownloadProgress((info) => {
      const liveId = findLiveUpdateToastId();
      if (!liveId || !knownVersion) return;
      // Only the bar moves: the title, body and live region stay put, so a
      // screen reader hears the stage once rather than every tick.
      useNotificationStore.getState().updateNotification(liveId, {
        type: "info",
        title: "Downloading update",
        message: versionLine(knownVersion),
        progress: downloadProgress(knownVersion, info.percent),
        // A download in flight means there is nothing ready to install, so the
        // restart button cannot be valid; the changelog link is dropped with it
        // to keep the downloading toast a pure progress readout rather than a
        // control surface. surfaceAvailable() normally clears both on the stage
        // regression, but it routes through notify(), which drops the payload
        // entirely while suppressed (quiet hours, blurred, rate-limited).
        // Without this the previous version's controls ride along onto the
        // downloading toast.
        action: undefined,
        actions: undefined,
      });
    });

    const cleanupDownloaded = window.electron.update.onUpdateDownloaded((info) => {
      liveStateSeen = true;
      surface({ version: info.version, downloaded: true });
    });

    // Pull the current stage from main, because the events above are one-shot
    // broadcasts: a renderer created after they fired — a second project view, a
    // new window, a view rebuilt after LRU eviction — would otherwise never learn
    // an update is waiting. Subscribe first, then hydrate, so an event landing
    // mid-flight is caught by the listeners rather than falling in the gap.
    const hydrate = window.electron.update.getLatest?.();
    hydrate
      ?.then((stage) => {
        if (disposed || liveStateSeen || !stage) return;
        surface(stage);
      })
      .catch((err) => logError("[useUpdateListener] getLatest failed", err));

    return () => {
      disposed = true;
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, [updatesManagedByStore]);
}
