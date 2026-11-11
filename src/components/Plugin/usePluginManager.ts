import { useCallback, useEffect, useRef, useState } from "react";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { describePluginInstallSource } from "@shared/utils/pluginInstallSource";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type {
  LoadedPluginInfo,
  PluginDeepLinkIntent,
  PluginDeepLinkRefusal,
  PluginInstallError,
  PluginInstallExpectation,
  PluginInstallResult,
  PluginUpdateExpectation,
  PluginInstallProgressEvent,
  PluginUrlInstallPreview,
  PluginUrlInstallPreviewResult,
} from "@shared/types/plugin";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";
import { pluralize } from "@/lib/pluralize";
import { UNSAVED_READ_FAILED, hasUnshownPanels, readUnsavedPanels } from "./unsavedPluginPanels";
import type { PluginInstallApproval } from "./PluginInstallConfirmDialog";

/**
 * Alphabetical by display name, regardless of enabled state. Disabled plugins
 * are conveyed in place (dimmed row + badge) rather than re-sorted, so a toggle
 * never teleports the row out from under the pointer.
 */
function sortPlugins(list: readonly LoadedPluginInfo[]): LoadedPluginInfo[] {
  return [...list].sort((a, b) => {
    const aName = a.manifest.displayName ?? a.manifest.name;
    const bName = b.manifest.displayName ?? b.manifest.name;
    return aName.localeCompare(bName);
  });
}

const UP_TO_DATE_NOTIFICATION_DURATION_MS = 4000;

/**
 * Map a structured install failure to user-facing copy. The bounded-fetch codes
 * (F24) and manifest schema failures get tailored guidance; everything else
 * falls back to the error's own message.
 */
function installErrorMessage(
  error: PluginInstallError | undefined,
  intent: InstallIntent = "install",
  fromLink = false
): string {
  switch (error?.code) {
    case "fetch_timeout":
      return "The download timed out. Check your connection and try again.";
    case "size_exceeded":
      return "That plugin is larger than the 30 MB limit.";
    case "content_type_rejected":
      return "That URL didn't return a plugin archive (.dntr). Check the URL and try again.";
    case "fetch_failed":
      return "Couldn't download the plugin. Check the URL and try again.";
    case "extraction_timeout":
      // The archive itself may be fine — it just never finished arriving, so
      // "check the file" would send the user down the wrong path (#11302).
      return "Unpacking the plugin took too long and was stopped. Try installing it again.";
    case "manifest_invalid": {
      // A schema failure carries the field, and its message is the validator's
      // ("expected string, received undefined"), which names neither the field
      // nor what to do. Only the author can fix a manifest. "The archive", not
      // "this plugin": the selected plugin sits right beside this message.
      const field = error?.path?.join(".");
      if (!field) break;
      const problem = /received undefined/.test(error?.message ?? "")
        ? `is missing "${field}"`
        : `has an invalid "${field}" value`;
      return `The archive's plugin.json ${problem}, so it can't be installed. Ask the plugin's author for a corrected archive.`;
    }
    case "archive_mismatch":
      // The install no longer matches the preview the user approved — the
      // server sent different bytes, or the plugin was installed or removed
      // since (#12612, #16776). Reviewing again shows what's there now.
      // An install link's pin or catalog listing lives in the link, so
      // reviewing again means opening the link, not pasting its URL (#16779).
      return intent === "update"
        ? "This update no longer matches what you reviewed, so nothing was installed. Check for updates again."
        : fromLink
          ? "This plugin no longer matches what you reviewed, so nothing was installed. Open the install link again to review it."
          : "This plugin no longer matches what you reviewed, so nothing was installed. Install it from the URL again to review it.";
  }
  return error?.message ?? "Installation failed. Check the file and try again.";
}

type UnsavedPanelsRead = { pluginId: string; panels: PluginUnsavedPanel[] };

/** A disable or a retry held for the user's Discard / Cancel (#15031). */
export type PendingDiscard = {
  plugin: LoadedPluginInfo;
  action: "disable" | "retry";
  panels: PluginUnsavedPanel[];
};

type PendingUpdate = {
  plugin: LoadedPluginInfo;
  result: Extract<
    Awaited<ReturnType<typeof window.electron.plugin.checkForUpdate>>,
    { status: "available" }
  >;
};

/**
 * What a finished install or update did, published once the refreshed list
 * holds it (#16654). The view selects an install's last plugin and announces
 * both kinds; publishing earlier would select against a list that doesn't have
 * the plugin yet.
 */
export interface InstallOutcome {
  /** New per outcome, so installing the same plugin twice still reads as new. */
  nonce: number;
  kind: "installed" | "updated";
  /** The plugin ids in install order, the last being the one to show. */
  ids: string[];
  /** The same ids as the refreshed list has them; one missing from it is skipped. */
  plugins: LoadedPluginInfo[];
  /** Files from the same drop that didn't install. */
  failedCount: number;
}

type PendingOutcome = Omit<InstallOutcome, "nonce" | "plugins">;

/**
 * Whether an install result came from adding a plugin or from updating one. Main
 * answers both with `installed`, and only an install moves the selection.
 */
type InstallIntent = "install" | "update";

/**
 * A URL or catalog install's archive under review (#16776, #16779), with a key
 * per review. `catalog` is set for a catalog release, whose confirm resolves
 * the release again in main instead of installing `url`. `fromLink` marks a
 * review a pinned or catalog install link started.
 */
export type UrlInstallReview = PluginUrlInstallPreview & { key: string; fromLink: boolean };

/**
 * Why a `daintree://plugin/install` link was refused before anything was
 * downloaded (#16779). Nothing falls back to an ordinary URL install.
 */
const DEEP_LINK_REFUSAL_MESSAGES: Record<PluginDeepLinkRefusal, string> = {
  "malformed-url":
    "The install link's archive URL is missing or isn't a web address, so nothing was installed.",
  "insecure-url":
    "The install link pins a SHA-256 but its archive URL isn't https://, so nothing was installed.",
  "malformed-sha256":
    "The install link's SHA-256 isn't 64 hex digits, so nothing was installed. Ask whoever shared it for a corrected link.",
  "malformed-id":
    "The install link's plugin id isn't a community plugin id, so nothing was installed.",
  "malformed-version":
    "The install link's version isn't a valid version number, so nothing was installed.",
  "conflicting-params":
    "The install link combines parameters that don't go together, so nothing was installed.",
};

/** An install link held to reviewed bytes: a pinned URL or a catalog release. */
type LinkedInstallIntent =
  | Extract<PluginDeepLinkIntent, { action: "install-catalog" }>
  | (Extract<PluginDeepLinkIntent, { action: "install" }> & { sha256: string });

/** An install link held to reviewed bytes arrived while another install was under way. */
const LINKED_INSTALL_BUSY =
  "Finish or cancel the current install, then open the install link again.";

/**
 * A URL failure the user can fix by editing the URL: a malformed URL, a
 * download error (404 / DNS), or a response that wasn't a plugin archive. These
 * keep the URL dialog open; size and timeout failures close it.
 */
function isCorrectableUrlFailure(result: PluginInstallResult): boolean {
  return (
    result.status === "invalid-url" ||
    (result.status === "failed" &&
      (result.errors[0]?.code === "fetch_failed" ||
        result.errors[0]?.code === "content_type_rejected"))
  );
}

/**
 * All plugin-management state and lifecycle handlers for the plugin manager
 * dialog (#9548): list, install (file / URL / drop), enable/disable, uninstall,
 * and the manual check-for-update flow. Extracted from the former Settings
 * `PluginsTab` so the dialog stays a thin presentational consumer.
 *
 * `isOpen` is the dialog's visibility. A single data-loading effect keyed on
 * `refreshKey` owns the `plugin.list()` pull; reopening the dialog bumps that
 * counter rather than splitting into a second list-fetching effect that would
 * cross-cancel the initial load (#4958).
 */
export interface PluginManagerDeepLink {
  /** The pending `daintree://` intent, or `null` when none. */
  intent: PluginDeepLinkIntent | null;
  /** Called once the intent has been applied so the source can clear it. */
  onConsumed?: () => void;
}

export function usePluginManager(isOpen: boolean, deepLink?: PluginManagerDeepLink) {
  const [plugins, setPlugins] = useState<LoadedPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A notice is neutral unless it reports something that went partly wrong.
  const [noticeTone, setNoticeTone] = useState<"neutral" | "warning">("neutral");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  // A load failure's own message, so the refresh that succeeds clears that and
  // nothing else: an install's failures are written before the refresh it
  // triggers lands, and a blanket clear erased them (#16654).
  const listLoadErrorRef = useRef<string | null>(null);
  // An install or update waiting on the refresh that will hold its plugins.
  const pendingOutcomeRef = useRef<PendingOutcome | null>(null);
  const outcomeNonceRef = useRef(0);
  const [installOutcome, setInstallOutcome] = useState<InstallOutcome | null>(null);
  // The plugin an update is replacing, from its download until its outcome is
  // published. Main broadcasts a provenance change when the install commits, so
  // a refresh can bring the new record before the install call returns; the
  // view keeps this plugin selected across that gap even if the new record no
  // longer matches the search.
  const [updatingPluginId, setUpdatingPluginId] = useState<string | null>(null);
  // Mirror of `refreshKey` for async staleness checks. A list refresh (reopen,
  // mutation, or cross-window provenance change) bumps the key; an update check
  // that started before the bump must discard its result rather than surface a
  // confirm for a plugin that may no longer exist.
  const refreshKeyRef = useRef(0);
  useEffect(() => {
    refreshKeyRef.current = refreshKey;
  }, [refreshKey]);
  const [pendingUninstall, setPendingUninstall] = useState<LoadedPluginInfo | null>(null);
  // Defaults off so stored secrets survive a reinstall — the user opts in to
  // wiping them. Reset whenever a new uninstall is armed so a prior tick can't
  // carry over to the next plugin.
  const [deleteSettings, setDeleteSettings] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  // What the open uninstall and update confirms would discard (#15031), read
  // when each opens and again on confirm. Keyed by plugin so a read that lands
  // after its dialog moved on to another plugin shows nothing.
  const [uninstallUnsaved, setUninstallUnsaved] = useState<UnsavedPanelsRead | null>(null);
  const [updateUnsaved, setUpdateUnsaved] = useState<UnsavedPanelsRead | null>(null);
  // A disable or retry waiting on Discard / Cancel. The ref is the live value
  // the confirm checks after its own read, so a prompt closed or replaced
  // meanwhile is never acted on.
  const [pendingDiscard, setPendingDiscardState] = useState<PendingDiscard | null>(null);
  const pendingDiscardRef = useRef<PendingDiscard | null>(null);
  const setPendingDiscard = (next: PendingDiscard | null) => {
    pendingDiscardRef.current = next;
    setPendingDiscardState(next);
  };
  // Plugins whose unsaved-work read is in flight, so a double-click on the
  // switch can't start two disables.
  const unsavedReadsRef = useRef<Set<string>>(new Set());
  // The prompt whose Discard is being re-read, so a replacement prompt's own
  // Discard isn't held up by a cancelled one's read.
  const confirmingDiscardRef = useRef<PendingDiscard | null>(null);
  // Bumped whenever the list may have changed under an open confirm (a
  // provenance change, a reopen). An answer read across a bump is dropped: it
  // was given about a record that may be gone.
  const listGenerationRef = useRef(0);

  // The uninstall confirm and the URL dialog render the shared error inline as
  // an alert, so opening either must drop an unrelated earlier failure rather
  // than announce it as if the dialog's own action had failed.
  const armUninstall = (plugin: LoadedPluginInfo) => {
    setError(null);
    setDeleteSettings(false);
    setPendingUninstall(plugin);
  };

  const closeUninstall = () => {
    setPendingUninstall(null);
    setDeleteSettings(false);
    setUninstallUnsaved(null);
  };
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  // A URL install's review (#16776): the archive main downloaded and read,
  // held until the user confirms or cancels. Fixed once shown — the confirm
  // installs its own `url` bound to its `archiveHash`, never `urlInput`. The
  // ref is the live value, so confirm and cancel are one-shot.
  const [urlReview, setUrlReviewState] = useState<UrlInstallReview | null>(null);
  const urlReviewRef = useRef<UrlInstallReview | null>(null);
  const setUrlReview = (next: UrlInstallReview | null) => {
    urlReviewRef.current = next;
    setUrlReviewState(next);
  };
  // Held from the moment a preview is asked for until it settles: two presses
  // in one tick would otherwise both read a stale `isInstalling` and start two
  // downloads.
  const urlPreviewingRef = useRef(false);
  // The preview download's job, so closing the manager can cancel it.
  const previewJobIdRef = useRef<string | null>(null);
  // Bumped when the manager closes or reopens. A preview that lands across a
  // bump belongs to a session the user left, so it is dropped.
  const urlFlowGenerationRef = useRef(0);
  const openUrlDialog = useCallback(() => {
    setError(null);
    setShowUrlDialog(true);
  }, []);
  // `daintree://plugin/open` target — the dialog scrolls to and highlights the
  // matching row, then clears it. Held in a ref for the consumption effect so
  // `onConsumed` isn't a reactive dependency that re-fires the effect.
  const [focusPluginId, setFocusPluginId] = useState<string | null>(null);
  // Stable identity so the consumer's deep-link highlight effect doesn't tear
  // down its 2s timer the instant it clears the focus request (#9557 review).
  const clearFocusPluginId = useCallback(() => setFocusPluginId(null), []);
  const deepLinkConsumedRef = useRef<(() => void) | undefined>(undefined);
  deepLinkConsumedRef.current = deepLink?.onConsumed;
  // Mirror `showUrlDialog` so the deep-link effect can read the latest value
  // without taking it as a dependency — otherwise opening the dialog would
  // re-run the effect and fire `onConsumed` twice for one intent.
  const showUrlDialogRef = useRef(showUrlDialog);
  showUrlDialogRef.current = showUrlDialog;
  // The preview a pinned or catalog install link starts (#16779), assigned
  // once the review flow below is defined.
  const linkedPreviewRef = useRef<((intent: LinkedInstallIntent) => void) | null>(null);
  // Update-check state. `checkingUpdate` drives the per-row spinner; the ref is
  // the synchronous reentrancy guard (state batches, leaving a double-click
  // window — #4703). `upToDateId` shows the transient "Already up to date" note;
  // `pendingUpdate` holds the fetched manifest preview for the confirm dialog.
  const [checkingUpdate, setCheckingUpdate] = useState<Set<string>>(new Set());
  const checkingUpdateRef = useRef<Set<string>>(new Set());
  const [upToDateId, setUpToDateId] = useState<string | null>(null);
  const upToDateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  // Render mirrors the deep-link effect reads without taking them as
  // dependencies, which would re-run it and consume one intent twice.
  const pendingUpdateRef = useRef(pendingUpdate);
  pendingUpdateRef.current = pendingUpdate;
  const pendingUninstallRef = useRef(pendingUninstall);
  pendingUninstallRef.current = pendingUninstall;
  const isUninstallingRef = useRef(isUninstalling);
  isUninstallingRef.current = isUninstalling;
  const [isReinstalling, setIsReinstalling] = useState(false);
  // Synchronous reentrancy guard for the reinstall — `isReinstalling` state lags
  // a render, leaving a double-click window that would fire two installs and
  // double-advance the batch queue (same class as the #4703 check guard).
  const reinstallingRef = useRef(false);
  const [pendingHttpUrl, setPendingHttpUrl] = useState<string | null>(null);
  // Render mirror of `httpFromReinstallRef`, so the HTTP confirm reached from an
  // "Update all" reinstall can offer the batch's skip and stop (#15042).
  const [pendingHttpFromReinstall, setPendingHttpFromReinstall] = useState(false);
  // Synchronous mirror of `pendingHttpUrl` so confirm/cancel are one-shot even
  // if the dialog fires a re-entrant close before the state flush — otherwise a
  // second cancel could re-read stale state and reopen the manual URL dialog.
  const pendingHttpUrlRef = useRef<string | null>(null);
  // The reviewed-archive binding of a reinstall parked behind the HTTP confirm,
  // so the install that follows is held to the preview the user approved
  // (#12612). Null for a manual URL install. Cleared with `pendingHttpUrlRef`.
  const pendingHttpExpectedRef = useRef<PluginUpdateExpectation | null>(null);
  // The update a reinstall parked behind the HTTP confirm, with the unsaved
  // panels its confirm showed, so confirming HTTP checks for work that turned
  // dirty while it was open and can put the update back up (#15031).
  const pendingHttpReviewRef = useRef<{
    update: PendingUpdate;
    panels: PluginUnsavedPanel[];
  } | null>(null);
  // "Update all" (#10893) drains available updates through the SAME per-plugin
  // capability-diff confirm as a single check: the queue holds the not-yet-shown
  // updates, `pendingUpdate` shows the head, and each confirm/skip/HTTP-gate
  // resolution advances to the next. Refs (not state) so the async confirm flow
  // reads the live queue without a render lag.
  const [isCheckingAllUpdates, setIsCheckingAllUpdates] = useState(false);
  const isCheckingAllUpdatesRef = useRef(false);
  const pendingQueueRef = useRef<PendingUpdate[]>([]);
  const isBatchActiveRef = useRef(false);
  // Where the confirm on screen sits in the run, for "Update 2 of 5" (#15042).
  // `position` moves only when the next update is shown, so an update parked
  // behind the HTTP confirm or put back up for unsaved work keeps its place.
  const [updateBatch, setUpdateBatch] = useState<{ position: number; total: number } | null>(null);
  // True while an HTTP-downgrade confirm originated from a reinstall (single or
  // batch) rather than a manual URL install — so cancelling it doesn't wrongly
  // reopen the manual install dialog, and resolving it advances the batch queue.
  const httpFromReinstallRef = useRef(false);
  // Integer depth counter so the overlay survives child enter/leave churn
  // without flicker (same pattern as the terminal drop zone). The boolean is
  // derived from it for the overlay render.
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);
  // Synchronous mutex for the drop install loop. The `isInstalling` state lags
  // a render, so two drops dispatched before React flushes could both read a
  // stale `false`; the ref flips immediately and serializes them.
  const installingRef = useRef(false);
  // Install progress + cancellation (#11302). `installJobIdRef` is the live
  // correlation key: the push channel is already scoped to this window, but one
  // window installs several archives in sequence (a multi-file drop), so events
  // are matched against the job that is actually in flight. Held in a ref, not
  // state, so the subscription below can stay mounted-once and never re-bind.
  const installJobIdRef = useRef<string | null>(null);
  const [installProgress, setInstallProgress] = useState<PluginInstallProgressEvent | null>(null);
  // Whether ANY install job is in flight. The banner gates on this rather than
  // on `isInstalling`, because the pre-existing activity booleans are per-entry-
  // point (`isInstalling` for file/URL/drop, `isReinstalling` for an update) and
  // are cleared unconditionally by whichever call settles first — so a
  // reinstall would show no banner at all, and a superseded install's `finally`
  // could hide its successor's. This one is set by `runInstallJob` (or by the
  // job's first event, for a file-picker install) and cleared under the same
  // job-identity guard as the progress state.
  const [hasActiveInstallJob, setHasActiveInstallJob] = useState(false);
  // Set the moment the user clicks Cancel, so the button stops accepting
  // clicks before main answers. Never unset here: either the install ends (and
  // `runInstallJob` clears it) or main refused because the install already
  // committed — in which case there is nothing left to cancel either way.
  const [cancelRequested, setCancelRequested] = useState(false);
  // Main refused the cancel: the install raced past its commit point before the
  // request landed. Cancel stays unavailable from here, even in the moment
  // before main's next event says so itself.
  const [cancelRefused, setCancelRefused] = useState(false);
  // What the in-flight job is installing, as the caller knew it before main's
  // first event. Main's events carry the authoritative label; this covers the
  // gap before the first one.
  const [pendingInstallSource, setPendingInstallSource] = useState<string | null>(null);

  // Progress subscription. Its own mount-once effect with no dependencies —
  // folding it into the `refreshKey` loading effect would resubscribe on every
  // list refresh and cross-cancel the load (#4958). Mirrors the shape of the
  // provenance subscription below.
  useEffect(() => {
    return window.electron.plugin.onInstallProgress((event) => {
      if (event.jobId !== installJobIdRef.current) return;
      setInstallProgress(event);
      setHasActiveInstallJob(true);
    });
  }, []);

  /**
   * Run an install under a fresh progress/cancel job. The id is minted here (not
   * by main) so the Cancel button has a target from the very first render,
   * rather than only after the first progress event arrives. The `finally`
   * clears state only if this job is still the current one, so a superseding
   * install can't have its banner wiped by its predecessor settling late.
   *
   * `source` is the path or URL when the caller already knows it. Without one,
   * main is still asking the user for it in the native file picker — the job
   * only begins once a path exists — so it counts as active from main's first
   * event rather than behind a picker the user hasn't answered.
   */
  const runInstallJob = async <T>(
    run: (jobId: string) => Promise<T>,
    source?: string
  ): Promise<T> => {
    const jobId = crypto.randomUUID();
    installJobIdRef.current = jobId;
    setInstallProgress(null);
    setCancelRequested(false);
    setCancelRefused(false);
    setPendingInstallSource(source === undefined ? null : describePluginInstallSource(source));
    setHasActiveInstallJob(source !== undefined);
    try {
      return await run(jobId);
    } finally {
      if (installJobIdRef.current === jobId) {
        installJobIdRef.current = null;
        setInstallProgress(null);
        setCancelRequested(false);
        setCancelRefused(false);
        setPendingInstallSource(null);
        setHasActiveInstallJob(false);
      }
    }
  };

  /**
   * Ask main to abort the in-flight install. Deliberately does NOT clear the
   * install state: the original install promise is still pending and owns the
   * teardown, and main may refuse (the install has passed its commit point) —
   * in which case the banner goes back to the real phase, with Cancel held
   * unavailable, rather than reporting a cancel that isn't happening.
   */
  const cancelActiveInstall = () => {
    const jobId = installJobIdRef.current;
    if (!jobId || cancelRequested || cancelRefused) return;
    setCancelRequested(true);
    safeFireAndForget(
      window.electron.plugin.cancelInstall(jobId).then((accepted) => {
        if (accepted || installJobIdRef.current !== jobId) return;
        setCancelRefused(true);
        setCancelRequested(false);
      }),
      { context: "usePluginManager.cancelActiveInstall" }
    );
  };

  // Clear the "Already up to date" auto-dismiss timer on unmount.
  useEffect(() => {
    return () => {
      if (upToDateTimerRef.current) clearTimeout(upToDateTimerRef.current);
    };
  }, []);

  // Single data-loading effect, keyed on `refreshKey`. Mutations re-pull by
  // bumping the counter rather than splitting into a second effect that shares
  // the `cancelled` flag (that would cross-cancel the initial load — #4958).
  useEffect(() => {
    let cancelled = false;
    // Read when the load starts: a load already in flight when an install
    // finished returns a list from before it, so it can't settle the outcome.
    const outcome = pendingOutcomeRef.current;
    window.electron.plugin
      .list()
      .then((list) => {
        if (cancelled) return;
        // `plugin:list` also carries loaded project plugins, which the manager
        // lists from the project inventory instead; kept here they showed as a
        // second, installed-looking row whose toggle targets the global id.
        const next = sortPlugins(list.filter((plugin) => plugin.origin !== "project"));
        setPlugins(next);
        const loadError = listLoadErrorRef.current;
        if (loadError !== null) {
          listLoadErrorRef.current = null;
          setError((current) => (current === loadError ? null : current));
        }
        if (outcome && pendingOutcomeRef.current === outcome) {
          pendingOutcomeRef.current = null;
          // The outcome carries the update from here.
          if (outcome.kind === "updated") setUpdatingPluginId(null);
          outcomeNonceRef.current += 1;
          setInstallOutcome({
            ...outcome,
            nonce: outcomeNonceRef.current,
            plugins: outcome.ids.flatMap((id) => next.filter((p) => p.manifest.name === id)),
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = formatErrorMessage(err, "Failed to load plugins");
        listLoadErrorRef.current = message;
        setError(message);
        logError("Failed to load plugins", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Reopening the dialog clears transient surfaces (errors, notices, open
  // confirms) and re-pulls the authoritative list. The very first open already
  // loads via the `refreshKey` effect, so skip the bump then to avoid a
  // duplicate fetch. This is the single reset path — it only bumps the counter,
  // never fetches directly, so it can't cross-cancel the load effect (#4958).
  // It runs on a real reopen only: StrictMode replaying the mount's effects is
  // no reopen, and resetting there dropped a preview a deep link had started.
  const hasOpenedRef = useRef(false);
  const lastOpenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const reopened = isOpen && lastOpenRef.current === false && hasOpenedRef.current;
    lastOpenRef.current = isOpen;
    if (!isOpen) {
      // Closing abandons a URL install's review: one still downloading is
      // cancelled, and whatever it returns is dropped (#16776).
      urlFlowGenerationRef.current++;
      urlReviewRef.current = null;
      setUrlReviewState(null);
      const previewJobId = previewJobIdRef.current;
      if (previewJobId !== null) {
        safeFireAndForget(window.electron.plugin.cancelInstall(previewJobId), {
          context: "usePluginManager.cancelPreviewOnClose",
        });
      }
      return;
    }
    hasOpenedRef.current = true;
    if (!reopened) return;
    setError(null);
    setNotice(null);
    setUpToDateId(null);
    setPendingUninstall(null);
    setDeleteSettings(false);
    setPendingUpdate(null);
    setPendingHttpUrl(null);
    setPendingHttpFromReinstall(false);
    pendingHttpUrlRef.current = null;
    pendingHttpExpectedRef.current = null;
    pendingHttpReviewRef.current = null;
    pendingDiscardRef.current = null;
    setPendingDiscardState(null);
    listGenerationRef.current++;
    urlFlowGenerationRef.current++;
    urlReviewRef.current = null;
    setUrlReviewState(null);
    // Abandon any in-flight "Update all" batch — the fresh list supersedes it.
    isBatchActiveRef.current = false;
    pendingQueueRef.current = [];
    setUpdateBatch(null);
    httpFromReinstallRef.current = false;
    setShowUrlDialog(false);
    // The deep-link effect runs after this one in the same commit and reads
    // these mirrors, which still hold the closed session's last render.
    showUrlDialogRef.current = false;
    pendingUninstallRef.current = null;
    pendingUpdateRef.current = null;
    setUrlInput("");
    // Reset the drop overlay so a drag-enter that was interrupted by a
    // close (leaving the depth counter non-zero) doesn't suppress the overlay
    // on the next open.
    dragDepthRef.current = 0;
    setIsDragOverFiles(false);
    setRefreshKey((k) => k + 1);
  }, [isOpen]);

  // Apply a pending `daintree://` deep-link intent. Defined after the reopen
  // reset above so that on a reopen it runs second and its writes win — the
  // reset clears `urlInput`/`showUrlDialog`, then this re-applies them. For an
  // install the URL is pre-filled and the dialog opened (the user still presses
  // install, so the HTTP-warning and security gates fire — never silent). For
  // an open the target row is flagged for scroll/highlight. `onConsumed` clears
  // the source intent so it can't re-fire on the next reopen.
  const deepLinkIntent = deepLink?.intent ?? null;
  // The intent last applied, so StrictMode replaying this effect doesn't apply
  // it twice: a second pass would find the first one's preview in flight and
  // turn the link away as busy.
  const appliedIntentRef = useRef<PluginDeepLinkIntent | null>(null);
  useEffect(() => {
    if (!isOpen || !deepLinkIntent) return;
    if (appliedIntentRef.current === deepLinkIntent) return;
    appliedIntentRef.current = deepLinkIntent;
    const linked: LinkedInstallIntent | null =
      deepLinkIntent.action === "install-catalog"
        ? deepLinkIntent
        : deepLinkIntent.action === "install" && deepLinkIntent.sha256 !== undefined
          ? { ...deepLinkIntent, sha256: deepLinkIntent.sha256 }
          : null;
    if (deepLinkIntent.action === "install-refused") {
      const message = DEEP_LINK_REFUSAL_MESSAGES[deepLinkIntent.reason];
      // The URL dialog and the uninstall confirm render the shared error as
      // their own failure, so a refusal arriving over either is a notice, and
      // neither is closed for it.
      if (showUrlDialogRef.current || pendingUninstallRef.current !== null) {
        setNoticeTone("warning");
        setNotice(message);
      } else {
        setNotice(null);
        setError(message);
      }
    } else if (linked !== null) {
      // A pinned or catalog link goes straight to its preview: there is no URL
      // for the user to edit, so the pin can't be lost to an edit. It never
      // replaces an install the user already has going, for the same reason an
      // ordinary link doesn't; it says so rather than vanish.
      // Anything that installs, updates, uninstalls, or holds a confirm open
      // counts: an update still reading unsaved panels has no install job yet.
      const busy =
        showUrlDialogRef.current ||
        urlPreviewingRef.current ||
        urlReviewRef.current !== null ||
        pendingHttpUrlRef.current !== null ||
        installJobIdRef.current !== null ||
        reinstallingRef.current ||
        isCheckingAllUpdatesRef.current ||
        isBatchActiveRef.current ||
        checkingUpdateRef.current.size > 0 ||
        pendingUpdateRef.current !== null ||
        pendingUninstallRef.current !== null ||
        isUninstallingRef.current ||
        pendingDiscardRef.current !== null;
      if (busy) {
        setNoticeTone("warning");
        setNotice(LINKED_INSTALL_BUSY);
      } else {
        linkedPreviewRef.current?.(linked);
      }
    } else if (deepLinkIntent.action === "install") {
      // Don't clobber an install dialog the user already has open — they may be
      // mid-edit, and silently swapping in a fresh (attacker-supplied) URL is a
      // social-engineering risk. The same goes for an install from a URL that
      // is past the dialog: behind the HTTP warning, downloading for review,
      // or under review (#16776). Skip the pre-fill; the user can paste it.
      const urlFlowBusy =
        urlPreviewingRef.current ||
        urlReviewRef.current !== null ||
        pendingHttpUrlRef.current !== null;
      if (!showUrlDialogRef.current && !urlFlowBusy) {
        // The URL dialog and the uninstall confirm each render the shared
        // error themselves, on the assumption that only one is ever open. A
        // deep link is the one path that can open this one over the other.
        setPendingUninstall(null);
        setUrlInput(deepLinkIntent.url);
        openUrlDialog();
      }
    } else {
      setFocusPluginId(deepLinkIntent.pluginId);
    }
    deepLinkConsumedRef.current?.();
  }, [isOpen, deepLinkIntent, openUrlDialog]);

  // A `daintree://plugin/open` for a plugin that isn't installed gets a quiet
  // inline notice rather than a silent no-op. Waits for the list to settle so a
  // mid-load check doesn't false-negative.
  useEffect(() => {
    if (!focusPluginId || loading) return;
    if (!plugins.some((p) => p.manifest.name === focusPluginId)) {
      setNoticeTone("neutral");
      setNotice(`Plugin "${focusPluginId}" isn't installed.`);
      setFocusPluginId(null);
    }
  }, [focusPluginId, loading, plugins]);

  // Re-pull when any view installs or uninstalls a plugin (#9285 cross-view
  // propagation). The event carries no payload, so always re-fetch the full
  // list rather than patching from a stale closure (#5087).
  useEffect(() => {
    return window.electron.plugin.onProvenanceChanged(() => {
      setRefreshKey((k) => k + 1);
      // A plugin may have been uninstalled (or uninstalled-then-reinstalled with
      // the same name) in another window — close any open confirm so it can't
      // fire `installFromUrl` / `uninstall` against a stale record. Exception:
      // during an "Update all" batch, each reinstall we perform fires this same
      // provenance broadcast; clearing here would nuke the next queued update, so
      // the batch owns `pendingUpdate` and advances it itself (#10893).
      if (!isBatchActiveRef.current) setPendingUpdate(null);
      setPendingUninstall(null);
      pendingDiscardRef.current = null;
      setPendingDiscardState(null);
      listGenerationRef.current++;
    });
  }, []);

  useEffect(() => {
    if (!pendingUninstall) return;
    const pluginId = pendingUninstall.manifest.name;
    let cancelled = false;
    void readUnsavedPanels(pluginId).then((panels) => {
      if (!cancelled && panels) setUninstallUnsaved({ pluginId, panels });
    });
    return () => {
      cancelled = true;
    };
  }, [pendingUninstall]);

  useEffect(() => {
    if (!pendingUpdate) return;
    const pluginId = pendingUpdate.plugin.manifest.name;
    let cancelled = false;
    void readUnsavedPanels(pluginId).then((panels) => {
      if (!cancelled && panels) setUpdateUnsaved({ pluginId, panels });
    });
    return () => {
      cancelled = true;
    };
  }, [pendingUpdate]);

  const uninstallPanels =
    pendingUninstall && uninstallUnsaved?.pluginId === pendingUninstall.manifest.name
      ? uninstallUnsaved.panels
      : [];
  const updatePanels =
    pendingUpdate && updateUnsaved?.pluginId === pendingUpdate.plugin.manifest.name
      ? updateUnsaved.panels
      : [];

  /**
   * Read a plugin's unsaved panels before an action that unloads it. True when
   * the action can go ahead; otherwise the Discard / Cancel prompt is up.
   */
  const clearUnsavedBefore = async (
    plugin: LoadedPluginInfo,
    action: PendingDiscard["action"]
  ): Promise<boolean> => {
    const id = plugin.manifest.name;
    if (unsavedReadsRef.current.has(id)) return false;
    unsavedReadsRef.current.add(id);
    const generation = listGenerationRef.current;
    const panels = await readUnsavedPanels(id);
    unsavedReadsRef.current.delete(id);
    if (listGenerationRef.current !== generation) return false;
    if (panels === null) {
      setError(UNSAVED_READ_FAILED);
      return false;
    }
    if (panels.length === 0) return true;
    setPendingDiscard({ plugin, action, panels });
    return false;
  };

  const handleToggle = async (plugin: LoadedPluginInfo) => {
    if (pending.has(plugin.manifest.name)) return;
    // Turning a plugin off unloads its panels, so ask first when one of them
    // holds unsaved work (#15031). Turning one on loses nothing.
    if (plugin.disabled !== true && !(await clearUnsavedBefore(plugin, "disable"))) return;
    await applyToggle(plugin);
  };

  const applyToggle = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    if (pending.has(id)) return;
    const next = plugin.disabled === true; // currently disabled → enabling
    const wasDisabled = plugin.disabled;
    const wasPendingRestart = plugin.pendingRestart;

    setPending((prev) => new Set(prev).add(id));
    // Optimistic flip. All plugins — built-in and user — now transition live
    // (#9304, #10887): `setEnabled` reconciles running and desired state
    // immediately, so their authoritative `pendingRestart` stays false. Match
    // that by holding `pendingRestart` at false; inverting it would flash a
    // false "restart required" badge until the next refresh (#10512).
    setPlugins((prev) =>
      prev.map((p) =>
        p.manifest.name === id ? { ...p, disabled: !next, pendingRestart: false } : p
      )
    );
    try {
      setError(null);
      await window.electron.plugin.setEnabled(id, next);
    } catch (err) {
      // Revert only this plugin's fields with a functional updater — a
      // whole-list snapshot could resurrect a plugin another view uninstalled
      // (via onProvenanceChanged) while this toggle was in flight.
      setPlugins((prev) =>
        prev.map((p) =>
          p.manifest.name === id
            ? { ...p, disabled: wasDisabled, pendingRestart: wasPendingRestart }
            : p
        )
      );
      setError(formatErrorMessage(err, "Failed to update plugin"));
      logError("Failed to update plugin enabled state", err);
    } finally {
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
  };

  // Retry for a plugin whose load or activation failed. There is no dedicated
  // retry IPC, but switching a plugin off unloads it and switching it on runs
  // the full load + activate path again (`PluginService._applyEnabledToggle`,
  // serialized per plugin in main), so this is the same retry the user could do
  // by hand with the switch — in one action, without the intermediate "off"
  // flashing through the row. The provenance broadcast at the end of each
  // toggle refreshes the list, which is what clears or restates `loadError`.
  const retryPlugin = async (plugin: LoadedPluginInfo) => {
    if (pending.has(plugin.manifest.name) || plugin.disabled === true) return;
    // A retry unloads what did load, so it asks like a disable does (#15031).
    if (!(await clearUnsavedBefore(plugin, "retry"))) return;
    await applyRetry(plugin);
  };

  const applyRetry = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    if (pending.has(id) || plugin.disabled === true) return;
    setPending((prev) => new Set(prev).add(id));
    try {
      setError(null);
      await window.electron.plugin.setEnabled(id, false);
      await window.electron.plugin.setEnabled(id, true);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to retry plugin"));
      logError("Failed to retry plugin load", err);
    } finally {
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
  };

  const closeDiscard = () => setPendingDiscard(null);

  const confirmDiscard = async () => {
    const prompt = pendingDiscardRef.current;
    if (!prompt || confirmingDiscardRef.current === prompt) return;
    confirmingDiscardRef.current = prompt;
    const current = await readUnsavedPanels(prompt.plugin.manifest.name);
    if (confirmingDiscardRef.current === prompt) confirmingDiscardRef.current = null;
    if (pendingDiscardRef.current !== prompt) return;
    if (current === null) {
      setPendingDiscard(null);
      setError(UNSAVED_READ_FAILED);
      return;
    }
    // Work that turned dirty under the open prompt wasn't part of the answer.
    if (hasUnshownPanels(current, prompt.panels)) {
      setPendingDiscard({ ...prompt, panels: current });
      return;
    }
    setPendingDiscard(null);
    if (prompt.action === "disable") {
      if (prompt.plugin.disabled !== true) await applyToggle(prompt.plugin);
    } else {
      await applyRetry(prompt.plugin);
    }
  };

  /** Re-pull the list and publish what was installed or updated once it lands. */
  const settleOutcome = (outcome: PendingOutcome) => {
    pendingOutcomeRef.current = outcome;
    setRefreshKey((k) => k + 1);
  };

  const handleInstallResult = (
    result: Awaited<ReturnType<typeof window.electron.plugin.installFromFile>>,
    intent: InstallIntent,
    fromLink = false
  ) => {
    // An update that didn't install has nothing left to carry the selection
    // across; one that did hands it to its outcome.
    if (intent === "update" && result.status !== "installed") setUpdatingPluginId(null);
    switch (result.status) {
      case "installed":
        // An update leaves the notice and error alone, here and on failure:
        // during "Update all" they hold the run's warning and any earlier
        // plugin's failure.
        if (intent === "install") {
          setError(null);
          setNotice(null);
        }
        settleOutcome({
          kind: intent === "install" ? "installed" : "updated",
          ids: [result.pluginId],
          failedCount: 0,
        });
        return;
      case "cancelled":
        return;
      case "not-implemented":
        setNoticeTone("neutral");
        setNotice("Installing plugins isn't available yet — it lands with an upcoming release.");
        return;
      case "invalid-url":
        setError("That doesn't look like a valid URL. Check it and try again.");
        return;
      case "failed": {
        if (intent === "install") setNotice(null);
        setError(installErrorMessage(result.errors[0], intent, fromLink));
        return;
      }
    }
  };

  const handleInstallFromFile = async () => {
    if (isInstalling) return;
    setIsInstalling(true);
    try {
      const result = await runInstallJob((jobId) => window.electron.plugin.installFromFile(jobId));
      handleInstallResult(result, "install");
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to install plugin"));
      logError("Failed to install plugin from file", err);
    } finally {
      setIsInstalling(false);
    }
  };

  /**
   * Install from a URL held to `expected`: an update approved from its review
   * (#12612), or a URL install approved from its own (#16776). `intent` says
   * which, since a URL install that replaces a plugin still reads as an install.
   */
  const performInstallFromUrl = async (
    url: string,
    expected: PluginInstallExpectation,
    intent: InstallIntent,
    install: (jobId: string) => Promise<PluginInstallResult> = (jobId) =>
      window.electron.plugin.installFromUrl(url, jobId, expected),
    fromLink = false
  ) => {
    setIsInstalling(true);
    if (intent === "update" && expected.pluginId !== undefined) {
      setUpdatingPluginId(expected.pluginId);
    }
    try {
      const result = await runInstallJob(install, url);
      handleInstallResult(result, intent, fromLink);
      if (!isCorrectableUrlFailure(result)) {
        setShowUrlDialog(false);
        setUrlInput("");
      }
    } catch (err) {
      if (intent === "update") setUpdatingPluginId(null);
      setError(formatErrorMessage(err, "Failed to install plugin"));
      logError("Failed to install plugin from URL", err);
    } finally {
      setIsInstalling(false);
    }
  };

  /**
   * Download an archive and put what it would install up for review (#16776,
   * #16779). Nothing is installed here: main reads the archive, deletes the
   * download, and returns its disclosure and digest. A failure is reported the
   * way an install's is, keeping the URL dialog open when the URL is the
   * problem. `source` names the download in the progress banner.
   */
  const previewForReview = async (
    preview: (jobId: string) => Promise<PluginUrlInstallPreviewResult>,
    source: string,
    fromLink = false
  ) => {
    if (urlPreviewingRef.current) return;
    urlPreviewingRef.current = true;
    const generation = urlFlowGenerationRef.current;
    setIsInstalling(true);
    try {
      const result = await runInstallJob((jobId) => {
        previewJobIdRef.current = jobId;
        return preview(jobId).finally(() => {
          if (previewJobIdRef.current === jobId) previewJobIdRef.current = null;
        });
      }, source);
      if (urlFlowGenerationRef.current !== generation) return;
      if (result.status === "preview") {
        setError(null);
        setShowUrlDialog(false);
        setUrlInput("");
        setUrlReview({ ...result.preview, key: crypto.randomUUID(), fromLink });
        return;
      }
      handleInstallResult(result, "install", fromLink);
      if (!isCorrectableUrlFailure(result)) {
        setShowUrlDialog(false);
        setUrlInput("");
      }
    } catch (err) {
      // A host too old to preview refuses the call; nothing installs unbound.
      if (urlFlowGenerationRef.current !== generation) return;
      setError(formatErrorMessage(err, "Failed to download plugin"));
      logError("Failed to preview plugin for install", err);
    } finally {
      urlPreviewingRef.current = false;
      setIsInstalling(false);
    }
  };

  /** Preview a URL's archive, held to `sha256` when a link pinned one. */
  const previewInstallFromUrl = (url: string, sha256?: string) =>
    previewForReview(
      (jobId) =>
        sha256 === undefined
          ? window.electron.plugin.previewFromUrl(url, jobId)
          : window.electron.plugin.previewFromUrl(url, jobId, sha256),
      url,
      sha256 !== undefined
    );

  /**
   * Start the preview a pinned or catalog install link asks for (#16779). Read
   * by the deep-link effect through a ref, so the effect doesn't re-run with
   * every render's copy of this function.
   */
  const startLinkedPreview = (intent: LinkedInstallIntent) => {
    if (intent.action === "install") {
      void previewInstallFromUrl(intent.url, intent.sha256);
      return;
    }
    const { pluginId, version } = intent;
    void previewForReview(
      (jobId) =>
        window.electron.plugin.previewFromCatalog(
          version === undefined ? { pluginId } : { pluginId, version },
          jobId
        ),
      version === undefined ? pluginId : `${pluginId}@${version}`,
      true
    );
  };
  linkedPreviewRef.current = startLinkedPreview;

  /**
   * Install the reviewed archive. The confirm downloads the URL again, so it is
   * bound to the digest the review was read from, and to what the review said
   * about the installed plugin: a fresh install refuses to replace one that
   * turned up since, a replacement refuses when it has gone. Main refuses
   * anything else, and nothing is ever retried unbound.
   */
  const confirmUrlReview = async ({ replacesInstalled }: PluginInstallApproval) => {
    const review = urlReviewRef.current;
    if (review === null || isInstalling) return;
    setUrlReview(null);
    const binding = {
      pluginId: review.manifest.name,
      archiveHash: review.archiveHash,
    };
    const expected: PluginInstallExpectation = replacesInstalled
      ? { kind: "update", ...binding }
      : { kind: "install", ...binding };
    const { catalog } = review;
    // A catalog release is installed by naming it, never by its URL: main
    // looks it up again and fetches what the catalog lists (#16779).
    await performInstallFromUrl(
      review.url,
      expected,
      "install",
      catalog === undefined
        ? undefined
        : (jobId) =>
            window.electron.plugin.installFromCatalog(
              { pluginId: catalog.id, version: catalog.version, repo: catalog.repo, expected },
              jobId
            ),
      review.fromLink
    );
  };

  /** Close the review. Its download is already gone, so nothing is left behind. */
  const cancelUrlReview = () => {
    if (urlReviewRef.current === null) return;
    setUrlReview(null);
  };

  const handleInstallFromUrl = async () => {
    const url = urlInput.trim();
    if (!url || isInstalling || urlPreviewingRef.current) return;
    // Tier D2: a plaintext HTTP download is unauthenticated and unencrypted, so
    // gate it behind an explicit confirm before the request leaves the app. The
    // IPC handler still accepts http:// — this is the renderer's risk surface.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      // Let the handler return invalid-url so the messaging stays consistent.
      await previewInstallFromUrl(url);
      return;
    }
    if (protocol === "http:") {
      // Stack avoidance: close the URL input and surface the confirm on its
      // own. Cancelling reopens the input with the URL intact so the user can
      // switch to https; confirming proceeds with the install.
      setShowUrlDialog(false);
      pendingHttpUrlRef.current = url;
      pendingHttpExpectedRef.current = null;
      setPendingHttpFromReinstall(false);
      setPendingHttpUrl(url);
      return;
    }
    await previewInstallFromUrl(url);
  };

  const confirmHttpInstall = async () => {
    // Read+clear the ref synchronously so a re-entrant confirm is a one-shot.
    const url = pendingHttpUrlRef.current;
    if (!url) return;
    pendingHttpUrlRef.current = null;
    const expected = pendingHttpExpectedRef.current ?? undefined;
    pendingHttpExpectedRef.current = null;
    const review = pendingHttpReviewRef.current;
    pendingHttpReviewRef.current = null;
    const fromReinstall = httpFromReinstallRef.current;
    httpFromReinstallRef.current = false;
    setPendingHttpUrl(null);
    setPendingHttpFromReinstall(false);
    // A manual install downloads its archive for review first (#16776); only
    // an update, reviewed already, installs straight from here.
    if (!expected) {
      await previewInstallFromUrl(url);
      return;
    }
    // The staleness check `confirmReinstall` makes before its own download: a
    // plugin uninstalled (say, in another window) while this confirm was open
    // has nothing left to update. Main refuses it anyway; this skips the
    // download and the misleading "no longer matches" error it would surface.
    if (!plugins.some((p) => p.manifest.name === expected.pluginId)) {
      if (fromReinstall && isBatchActiveRef.current) advanceUpdateQueue();
      return;
    }
    if (review) {
      const pluginId = review.update.plugin.manifest.name;
      const generation = listGenerationRef.current;
      const current = await readUnsavedPanels(pluginId);
      // A reopen abandoned this update (and any batch) while it was read.
      if (!isBatchActiveRef.current && listGenerationRef.current !== generation) return;
      if (current === null) {
        setError(UNSAVED_READ_FAILED);
        if (isBatchActiveRef.current) advanceUpdateQueue();
        return;
      }
      // Work that turned dirty behind the HTTP confirm puts the update back up
      // with it named, rather than installing over it.
      if (hasUnshownPanels(current, review.panels)) {
        setUpdateUnsaved({ pluginId, panels: current });
        setPendingUpdate(review.update);
        return;
      }
    }
    await performInstallFromUrl(url, expected, "update");
    // A reinstall-over-http came from the update flow, not the manual install
    // dialog — advance the "Update all" queue if one is draining (#10893).
    if (fromReinstall && isBatchActiveRef.current) advanceUpdateQueue();
  };

  const cancelHttpInstall = () => {
    // Read+clear the ref synchronously so a re-entrant close can't reclassify a
    // reinstall cancel as a manual one (or double-advance the batch).
    if (!pendingHttpUrlRef.current) return;
    pendingHttpUrlRef.current = null;
    pendingHttpExpectedRef.current = null;
    pendingHttpReviewRef.current = null;
    const fromReinstall = httpFromReinstallRef.current;
    httpFromReinstallRef.current = false;
    setPendingHttpUrl(null);
    setPendingHttpFromReinstall(false);
    // A reinstall-over-http cancel must NOT reopen the manual install dialog
    // (that URL was never user-entered); during a batch it just skips to the
    // next queued update (#10893). Manual installs keep the reopen-to-edit UX.
    if (fromReinstall) {
      if (isBatchActiveRef.current) advanceUpdateQueue();
      return;
    }
    setShowUrlDialog(true);
  };

  // Install one or more dropped `.dntr` files sequentially through #9292's
  // install lock — one dialog per file, no batch UX (#9295). Non-`.dntr` drops
  // surface a quiet inline notice; an empty path (synthetic File object that
  // `getDroppedFilePaths` can't resolve) is a structured error, not a missing
  // file.
  const installDroppedFiles = async (files: File[]) => {
    const dntrFiles = files.filter((f) => f.name.toLowerCase().endsWith(".dntr"));
    if (dntrFiles.length === 0) {
      setError(null);
      setNoticeTone("warning");
      setNotice("Only .dntr files can be installed.");
      return;
    }
    if (installingRef.current) return;
    installingRef.current = true;
    setNotice(null);
    setError(null);
    setIsInstalling(true);
    // Collect per-file failures so a later file's success can't silently clear
    // an earlier file's error (the loop installs one file at a time). Successes
    // are collected too, so the drop reveals and announces once, at the end,
    // rather than moving the selection through every file.
    const failures: string[] = [];
    const installed: string[] = [];
    try {
      const paths = window.electron.files.getDroppedFilePaths(dntrFiles);
      for (const [index, file] of dntrFiles.entries()) {
        const path = paths[index];
        if (!path) {
          failures.push(`${file.name} — couldn't read its location, try Install from file`);
          continue;
        }
        try {
          const result = await runInstallJob(
            (jobId) => window.electron.plugin.installFromPath(path, jobId),
            path
          );
          // A cancel abandons the whole drop, not just this file — the user
          // stopped the batch, so silently installing the rest would ignore them.
          if (result.status === "cancelled") break;
          if (result.status === "installed") {
            // The same plugin dropped twice counts once, at its last position.
            const at = installed.indexOf(result.pluginId);
            if (at !== -1) installed.splice(at, 1);
            installed.push(result.pluginId);
          } else if (result.status === "failed") {
            failures.push(`${file.name} — ${installErrorMessage(result.errors[0])}`);
          } else {
            handleInstallResult(result, "install");
          }
        } catch (err) {
          failures.push(`${file.name} — ${formatErrorMessage(err, "install failed")}`);
          logError("Failed to install plugin from drop", err);
        }
      }
    } finally {
      installingRef.current = false;
      setIsInstalling(false);
    }
    if (failures.length > 0) setError(failures.join("; "));
    if (installed.length > 0) {
      settleOutcome({ kind: "installed", ids: installed, failedCount: failures.length });
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current++;
    if (dragDepthRef.current === 1) setIsDragOverFiles(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.stopPropagation();
    dragDepthRef.current--;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOverFiles(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void installDroppedFiles(files);
  };

  const confirmUninstall = async () => {
    if (!pendingUninstall) return;
    const id = pendingUninstall.manifest.name;
    setIsUninstalling(true);
    // The dialog named what would be lost when it opened; work that turned
    // dirty since gets shown before anything is removed (#15031).
    const generation = listGenerationRef.current;
    const current = await readUnsavedPanels(id);
    if (listGenerationRef.current !== generation || current === null) {
      if (current === null) setError(UNSAVED_READ_FAILED);
      setIsUninstalling(false);
      return;
    }
    if (hasUnshownPanels(current, uninstallPanels)) {
      setUninstallUnsaved({ pluginId: id, panels: current });
      setIsUninstalling(false);
      return;
    }
    try {
      setError(null);
      await window.electron.plugin.uninstall(id, deleteSettings);
      closeUninstall();
      // Re-pull the authoritative list rather than splicing the closure (#5087).
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to uninstall plugin"));
      logError("Failed to uninstall plugin", err);
    } finally {
      setIsUninstalling(false);
    }
  };

  const handleCheckForUpdate = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    // Synchronous reentrancy guard — a rapid double-click would otherwise fire
    // two downloads before the first render flips the spinner (#4703).
    if (checkingUpdateRef.current.has(id)) return;
    checkingUpdateRef.current.add(id);
    setCheckingUpdate((prev) => new Set(prev).add(id));
    // A fresh check supersedes any lingering "up to date" note for this plugin.
    if (upToDateId === id) setUpToDateId(null);
    // Snapshot the list generation. If the list refreshes mid-check (a reopen,
    // a mutation, or a cross-window uninstall), the response references a plugin
    // that may no longer exist — discard it rather than surface a stale confirm.
    const startKey = refreshKeyRef.current;
    try {
      setError(null);
      const result = await window.electron.plugin.checkForUpdate(id);
      if (refreshKeyRef.current !== startKey) return;
      switch (result.status) {
        case "up-to-date":
          if (upToDateTimerRef.current) clearTimeout(upToDateTimerRef.current);
          setUpToDateId(id);
          upToDateTimerRef.current = setTimeout(
            () => setUpToDateId(null),
            UP_TO_DATE_NOTIFICATION_DURATION_MS
          );
          break;
        case "available":
          // An "Update all" run that started while this check was out, or
          // whose install is running now, owns the confirm, and it checked
          // this plugin itself. Showing this one would replace its update.
          if (isBatchActiveRef.current) break;
          setPendingUpdate({ plugin, result });
          break;
        case "fetch-failed":
          setError(`Couldn't check for an update: ${result.message}`);
          break;
        case "invalid-id":
          // The button is gated on `originalUrl !== null`, so this is a bug, not
          // a user-facing state — log it without a toast.
          logError("Update check returned invalid-id", new Error(id));
          break;
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to check for update"));
      logError("Failed to check plugin for update", err);
    } finally {
      checkingUpdateRef.current.delete(id);
      setCheckingUpdate((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
  };

  // Advance an in-flight "Update all" batch to the next queued update, or end it
  // when the queue drains. Single-plugin checks (batch inactive) just close the
  // confirm as before (#10893).
  const advanceUpdateQueue = () => {
    if (!isBatchActiveRef.current) {
      setPendingUpdate(null);
      return;
    }
    const next = pendingQueueRef.current.shift() ?? null;
    if (next) {
      setPendingUpdate(next);
      setUpdateBatch((batch) => batch && { ...batch, position: batch.position + 1 });
    } else {
      isBatchActiveRef.current = false;
      setUpdateBatch(null);
      setPendingUpdate(null);
    }
  };

  // The confirm dialog's cancel/skip. During a batch it moves to the next
  // queued update instead of ending the whole run.
  const dismissPendingUpdate = () => {
    advanceUpdateQueue();
  };

  // End an "Update all" run from any of its confirms (#15042): the update on
  // screen and every queued one are dropped, while updates already installed
  // stay installed. Reachable from the HTTP confirm a batch reinstall parks
  // behind, so its parked install is dropped with it.
  const stopUpdateBatch = () => {
    if (!isBatchActiveRef.current) return;
    isBatchActiveRef.current = false;
    pendingQueueRef.current = [];
    setUpdateBatch(null);
    setPendingUpdate(null);
    if (httpFromReinstallRef.current) {
      httpFromReinstallRef.current = false;
      pendingHttpUrlRef.current = null;
      pendingHttpExpectedRef.current = null;
      pendingHttpReviewRef.current = null;
      setPendingHttpUrl(null);
      setPendingHttpFromReinstall(false);
    }
  };

  // "Update all" (#10893): check every URL-installed plugin, then drain the ones
  // with an update through the same per-plugin capability-diff confirm flow as a
  // single check. Reuses `checkForUpdate` + `confirmReinstall`; never installs
  // silently and never collapses the per-plugin capability preview into one
  // blanket accept.
  const checkAllForUpdates = async () => {
    // A run between confirms (installing, say) is still running: a second one
    // would take over its queue, and its install would then advance the new one.
    if (isCheckingAllUpdatesRef.current || isBatchActiveRef.current) return;
    const targets = plugins.filter((p) => !p.isBuiltin && !!p.originalUrl);
    if (targets.length === 0) return;
    isCheckingAllUpdatesRef.current = true;
    setIsCheckingAllUpdates(true);
    setError(null);
    setNotice(null);
    setUpToDateId(null);
    // Same staleness guard as the single check: if the list refreshes mid-run
    // (reopen, mutation, cross-window change), discard rather than surface a
    // confirm for a plugin that may no longer exist.
    const startKey = refreshKeyRef.current;
    const available: PendingUpdate[] = [];
    // A check that FAILED is not a check that found nothing. Counting only
    // `available` meant a run where every request errored still reported "All
    // plugins are up to date" — the most reassuring possible summary of a total
    // failure. Failures are counted separately and reported.
    let failed = 0;
    try {
      for (const plugin of targets) {
        try {
          const result = await window.electron.plugin.checkForUpdate(plugin.manifest.name);
          if (refreshKeyRef.current !== startKey) return;
          if (result.status === "available") {
            available.push({ plugin, result });
          } else if (result.status !== "up-to-date") {
            // `fetch-failed` / `invalid-id` arrive as data, not as a throw.
            failed += 1;
          }
        } catch (err) {
          // Isolate per plugin — one failed check never aborts the batch.
          failed += 1;
          logError("Failed to check plugin for update (Update all)", err);
        }
      }
      if (refreshKeyRef.current !== startKey) return;
      const [first, ...rest] = available;
      if (!first) {
        if (failed === targets.length) {
          setError(
            failed === 1
              ? "Couldn't check for updates. Check your connection and try again."
              : `Couldn't check any of the ${failed} plugins for updates. Check your connection and try again.`
          );
        } else if (failed > 0) {
          setNoticeTone("warning");
          setNotice(`No updates found. ${pluralize(failed, "plugin")} couldn't be checked.`);
        } else {
          setNoticeTone("neutral");
          setNotice("All plugins are up to date.");
        }
        return;
      }
      // Some checks failed AND some found updates: the confirmations open now,
      // so say it here rather than dropping it. Nothing clears `notice` until
      // the next bulk check, so it is waiting in the column when the last
      // confirmation closes.
      if (failed > 0) {
        setNoticeTone("warning");
        setNotice(`${pluralize(failed, "plugin")} couldn't be checked for updates.`);
      }
      pendingQueueRef.current = rest;
      isBatchActiveRef.current = true;
      setUpdateBatch({ position: 1, total: available.length });
      setPendingUpdate(first);
    } finally {
      isCheckingAllUpdatesRef.current = false;
      setIsCheckingAllUpdates(false);
    }
  };

  const confirmReinstall = async () => {
    if (!pendingUpdate) return;
    if (reinstallingRef.current) return;
    // Guard against a plugin uninstalled in another window mid-batch: never
    // reinstall a record that's no longer in the authoritative list. Since a
    // batch suppresses the provenance auto-clear of `pendingUpdate`, this is the
    // batch's equivalent staleness check (#10893).
    const stillInstalled = plugins.some(
      (p) => p.manifest.name === pendingUpdate.plugin.manifest.name
    );
    if (!stillInstalled) {
      advanceUpdateQueue();
      return;
    }
    const url = pendingUpdate.plugin.originalUrl;
    if (!url) {
      advanceUpdateQueue();
      return;
    }
    // Reinstalling unloads the running plugin. Work that turned dirty since
    // the confirm opened gets shown before the download starts (#15031).
    const pluginId = pendingUpdate.plugin.manifest.name;
    reinstallingRef.current = true;
    setIsReinstalling(true);
    const generation = listGenerationRef.current;
    const current = await readUnsavedPanels(pluginId);
    reinstallingRef.current = false;
    setIsReinstalling(false);
    // Outside a batch a provenance change has closed this confirm. A batch
    // keeps its queue across them, and main holds the install to the reviewed
    // archive either way.
    if (!isBatchActiveRef.current && listGenerationRef.current !== generation) return;
    if (current === null) {
      setError(UNSAVED_READ_FAILED);
      advanceUpdateQueue();
      return;
    }
    if (hasUnshownPanels(current, updatePanels)) {
      setUpdateUnsaved({ pluginId, panels: current });
      return;
    }
    // The confirm re-downloads the URL, so hold it to the archive this preview
    // was read from — main refuses anything else (#12612).
    const expected: PluginUpdateExpectation = {
      pluginId: pendingUpdate.plugin.manifest.name,
      archiveHash: pendingUpdate.result.archiveHash,
    };
    // Tier D2: a plugin first installed over http:// keeps an http upstream, so
    // reinstalling re-fetches it unencrypted. Route it through the same HTTP
    // warning gate as a manual install rather than downloading silently.
    let protocol: string | null = null;
    try {
      protocol = new URL(url).protocol;
    } catch {
      // A malformed stored URL falls through to installFromUrl, which returns
      // invalid-url and surfaces a consistent message.
    }
    if (protocol === "http:") {
      setPendingUpdate(null);
      // Mark the origin so the HTTP confirm's cancel doesn't reopen the manual
      // install dialog and its resolution advances the batch (#10893).
      httpFromReinstallRef.current = true;
      pendingHttpUrlRef.current = url;
      pendingHttpExpectedRef.current = expected;
      pendingHttpReviewRef.current = { update: pendingUpdate, panels: updatePanels };
      setPendingHttpFromReinstall(true);
      setPendingHttpUrl(url);
      return;
    }
    reinstallingRef.current = true;
    setIsReinstalling(true);
    // Dismiss the update confirm before the download starts. It has served its
    // purpose (the user accepted), and leaving it up would stack a modal over
    // the progress banner — burying the Cancel button behind the very dialog
    // the user just dismissed. `advanceUpdateQueue` below still drives the
    // batch; it sets the next `pendingUpdate` itself and never reads this one.
    setPendingUpdate(null);
    setUpdatingPluginId(pluginId);
    try {
      // In a batch an earlier plugin's failure stays up until the run ends.
      if (!isBatchActiveRef.current) setError(null);
      const result = await runInstallJob(
        (jobId) => window.electron.plugin.installFromUrl(url, jobId, expected),
        url
      );
      handleInstallResult(result, "update");
      advanceUpdateQueue();
    } catch (err) {
      setUpdatingPluginId(null);
      setError(formatErrorMessage(err, "Failed to update plugin"));
      logError("Failed to update plugin from URL", err);
      // In a batch, skip the failed plugin and keep draining; a single check
      // leaves its confirm untouched (advanceUpdateQueue clears it either way).
      if (isBatchActiveRef.current) advanceUpdateQueue();
    } finally {
      reinstallingRef.current = false;
      setIsReinstalling(false);
    }
  };

  const closeUrlDialog = () => {
    setShowUrlDialog(false);
    setUrlInput("");
  };

  return {
    plugins,
    loading,
    showInlineLoading,
    error,
    notice,
    noticeTone,
    pending,
    pendingUninstall,
    uninstallPanels,
    deleteSettings,
    setDeleteSettings,
    isUninstalling,
    armUninstall,
    closeUninstall,
    confirmUninstall,
    showUrlDialog,
    openUrlDialog,
    closeUrlDialog,
    urlInput,
    setUrlInput,
    isInstalling,
    hasActiveInstallJob,
    installProgress,
    installSource: installProgress?.source ?? pendingInstallSource,
    cancelRequested,
    cancelRefused,
    cancelActiveInstall,
    handleInstallFromFile,
    handleInstallFromUrl,
    urlReview,
    confirmUrlReview,
    cancelUrlReview,
    pendingHttpUrl,
    pendingHttpFromReinstall,
    confirmHttpInstall,
    cancelHttpInstall,
    checkingUpdate,
    upToDateId,
    handleCheckForUpdate,
    pendingUpdate,
    updatePanels,
    setPendingUpdate,
    isReinstalling,
    confirmReinstall,
    dismissPendingUpdate,
    stopUpdateBatch,
    updateBatch,
    checkAllForUpdates,
    isCheckingAllUpdates,
    hasUpdatablePlugins: plugins.some((p) => !p.isBuiltin && !!p.originalUrl),
    handleToggle,
    retryPlugin,
    pendingDiscard,
    confirmDiscard,
    closeDiscard,
    isDragOverFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    focusPluginId,
    clearFocusPluginId,
    installOutcome,
    updatingPluginId,
  };
}
