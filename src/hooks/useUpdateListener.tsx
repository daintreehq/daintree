import { useEffect, useRef } from "react";
import { useNotificationStore, type NotificationAction } from "@/store/notificationStore";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useDistributionStore } from "@/store/distributionStore";

const AVAILABLE_HINT = 'Use "Check for Updates..." to check again.';
const UPDATE_CORRELATION_ID = "app-update";
const RELEASE_NOTES_BASE_URL = "https://github.com/daintreehq/daintree/releases/tag";

/** The stage of the update the user is currently being told about. */
type UpdateStage = { version: string; downloaded: boolean };

function DownloadProgress({ percent }: { percent: number }) {
  const pct = Math.round(percent);
  return (
    <div className="space-y-1">
      <span>{pct}% complete</span>
      <div className="h-1 w-full rounded-full bg-tint/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-primary transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
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

function releaseNotesAction(version: string): NotificationAction {
  // `version` arrives as bare semver from the updater while GitHub tags carry a
  // leading `v`. It is NOT pre-validated: AutoUpdaterService runs semver.valid
  // only to gate the persisted pendingUpdateVersion and broadcasts the raw
  // string, so encode it as a single path segment — a stray `/`, `?` or `#`
  // would otherwise retarget the URL elsewhere on github.com.
  const url = `${RELEASE_NOTES_BASE_URL}/v${encodeURIComponent(version)}`;
  return {
    label: "View release notes",
    // Secondary keeps "Restart to update" the single load-bearing CTA — this is
    // an informational escape hatch, not a competing decision.
    variant: "secondary",
    // actionId + actionArgs (not bare onClick) so the button survives the
    // inbox-history filter in notify.ts — actions without an actionId are
    // silently dropped, leaving history text with no way to act on it.
    actionId: "system.openExternal",
    actionArgs: { url },
    onClick: () => {
      const promise = window.electron?.system?.openExternal(url);
      if (promise) {
        safeFireAndForget(promise, { context: "Open release notes" });
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
    title: "Update available",
    message: `Version ${version} is downloading...`,
    inboxMessage: `Version ${version} is downloading. ${AVAILABLE_HINT}`,
    priority: "high",
    duration: 0,
    correlationId: UPDATE_CORRELATION_ID,
    // Explicit undefined: if a prior "Update ready" toast is live (stage
    // regression), clear its "Restart to update" action so the user does not
    // accidentally restart into a stale build while a newer one is still
    // downloading, and clear its "View release notes" link so it cannot point
    // at the superseded version's tag.
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

function surfaceDownloaded(version: string): void {
  const liveId = findLiveUpdateToastId();
  if (liveId) {
    // Stage transition: clear the Available-stage onDismiss so dismissing the
    // "Update ready" toast does not start the 24h Available cooldown. The user
    // still needs to be re-reminded about the pending install.
    useNotificationStore.getState().updateNotification(liveId, {
      type: "success",
      title: "Update ready",
      message: `Version ${version} is ready to install.`,
      inboxMessage: `Version ${version} ready to install`,
      duration: 0,
      dismissed: false,
      onDismiss: undefined,
      action: restartAction(),
      actions: [releaseNotesAction(version)],
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
    message: `Version ${version} is ready to install.`,
    inboxMessage: `Version ${version} ready to install`,
    priority: "high",
    urgent: true,
    duration: 0,
    correlationId: UPDATE_CORRELATION_ID,
    action: restartAction(),
    actions: [releaseNotesAction(version)],
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

    const surface = (stage: UpdateStage) => {
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
      if (!liveId) return;
      useNotificationStore.getState().updateNotification(liveId, {
        title: "Downloading update",
        message: <DownloadProgress percent={info.percent} />,
        inboxMessage: `Downloading update: ${Math.round(info.percent)}%`,
        // A download in flight means there is nothing ready to install, so
        // neither control can be valid here. surfaceAvailable() normally clears
        // them on the stage regression, but it routes through notify(), which
        // drops the payload entirely while suppressed (quiet hours, blurred,
        // rate-limited). Without this the previous version's restart button and
        // release-notes link ride along onto the downloading toast.
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
