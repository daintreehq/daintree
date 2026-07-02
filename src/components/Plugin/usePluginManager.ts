import { useCallback, useEffect, useRef, useState } from "react";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type {
  LoadedPluginInfo,
  PluginDeepLinkIntent,
  PluginInstallError,
} from "@shared/types/plugin";

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
 * (F24) get tailored guidance; everything else falls back to the error's own
 * message so manifest/engine failures still read clearly.
 */
function installErrorMessage(error: PluginInstallError | undefined): string {
  switch (error?.code) {
    case "fetch_timeout":
      return "The download timed out. Check your connection and try again.";
    case "size_exceeded":
      return "That plugin is larger than the 30 MB limit.";
    case "content_type_rejected":
      return "That URL didn't return a plugin archive (.dntr). Check the URL and try again.";
    case "fetch_failed":
      return "Couldn't download the plugin. Check the URL and try again.";
    default:
      return error?.message ?? "Installation failed. Check the file and try again.";
  }
}

type PendingUpdate = {
  plugin: LoadedPluginInfo;
  result: Extract<
    Awaited<ReturnType<typeof window.electron.plugin.checkForUpdate>>,
    { status: "available" }
  >;
};

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
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
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

  const armUninstall = (plugin: LoadedPluginInfo) => {
    setDeleteSettings(false);
    setPendingUninstall(plugin);
  };

  const closeUninstall = () => {
    setPendingUninstall(null);
    setDeleteSettings(false);
  };
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
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
  // Update-check state. `checkingUpdate` drives the per-row spinner; the ref is
  // the synchronous reentrancy guard (state batches, leaving a double-click
  // window — #4703). `upToDateId` shows the transient "Already up to date" note;
  // `pendingUpdate` holds the fetched manifest preview for the confirm dialog.
  const [checkingUpdate, setCheckingUpdate] = useState<Set<string>>(new Set());
  const checkingUpdateRef = useRef<Set<string>>(new Set());
  const [upToDateId, setUpToDateId] = useState<string | null>(null);
  const upToDateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [isReinstalling, setIsReinstalling] = useState(false);
  // Synchronous reentrancy guard for the reinstall — `isReinstalling` state lags
  // a render, leaving a double-click window that would fire two installs and
  // double-advance the batch queue (same class as the #4703 check guard).
  const reinstallingRef = useRef(false);
  const [pendingHttpUrl, setPendingHttpUrl] = useState<string | null>(null);
  // Synchronous mirror of `pendingHttpUrl` so confirm/cancel are one-shot even
  // if the dialog fires a re-entrant close before the state flush — otherwise a
  // second cancel could re-read stale state and reopen the manual URL dialog.
  const pendingHttpUrlRef = useRef<string | null>(null);
  // "Update all" (#10893) drains available updates through the SAME per-plugin
  // capability-diff confirm as a single check: the queue holds the not-yet-shown
  // updates, `pendingUpdate` shows the head, and each confirm/skip/HTTP-gate
  // resolution advances to the next. Refs (not state) so the async confirm flow
  // reads the live queue without a render lag.
  const [isCheckingAllUpdates, setIsCheckingAllUpdates] = useState(false);
  const isCheckingAllUpdatesRef = useRef(false);
  const pendingQueueRef = useRef<PendingUpdate[]>([]);
  const isBatchActiveRef = useRef(false);
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
    window.electron.plugin
      .list()
      .then((list) => {
        if (cancelled) return;
        setPlugins(sortPlugins(list));
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatErrorMessage(err, "Failed to load plugins"));
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
  // confirms) and re-pulls the authoritative list. The very first mount already
  // loads via the `refreshKey` effect, so skip the bump then to avoid a
  // duplicate fetch. This is the single reset path — it only bumps the counter,
  // never fetches directly, so it can't cross-cancel the load effect (#4958).
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (!isOpen) return;
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    setError(null);
    setNotice(null);
    setUpToDateId(null);
    setPendingUninstall(null);
    setDeleteSettings(false);
    setPendingUpdate(null);
    setPendingHttpUrl(null);
    pendingHttpUrlRef.current = null;
    // Abandon any in-flight "Update all" batch — the fresh list supersedes it.
    isBatchActiveRef.current = false;
    pendingQueueRef.current = [];
    httpFromReinstallRef.current = false;
    setShowUrlDialog(false);
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
  useEffect(() => {
    if (!isOpen || !deepLinkIntent) return;
    if (deepLinkIntent.action === "install") {
      // Don't clobber an install dialog the user already has open — they may be
      // mid-edit, and silently swapping in a fresh (attacker-supplied) URL is a
      // social-engineering risk. Skip the pre-fill; the user can paste it.
      if (!showUrlDialogRef.current) {
        setUrlInput(deepLinkIntent.url);
        setShowUrlDialog(true);
      }
    } else {
      setFocusPluginId(deepLinkIntent.pluginId);
    }
    deepLinkConsumedRef.current?.();
  }, [isOpen, deepLinkIntent]);

  // A `daintree://plugin/open` for a plugin that isn't installed gets a quiet
  // inline notice rather than a silent no-op. Waits for the list to settle so a
  // mid-load check doesn't false-negative.
  useEffect(() => {
    if (!focusPluginId || loading) return;
    if (!plugins.some((p) => p.manifest.name === focusPluginId)) {
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
    });
  }, []);

  const handleToggle = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    if (pending.has(id)) return;
    const next = plugin.disabled === true; // currently disabled → enabling
    const wasDisabled = plugin.disabled;
    const wasPendingRestart = plugin.pendingRestart;

    setPending((prev) => new Set(prev).add(id));
    // Optimistic flip. For session-fixed user plugins a single toggle flips both
    // the desired state and the running/desired mismatch, so `pendingRestart`
    // inverts. Built-ins transition live (#9304) — `setEnabled` reconciles
    // running and desired state immediately, so their authoritative
    // `pendingRestart` stays false; inverting it flashes a false "restart
    // required" badge until the next refresh (#10512). Match the authoritative
    // value by holding built-ins at false.
    setPlugins((prev) =>
      prev.map((p) =>
        p.manifest.name === id
          ? { ...p, disabled: !next, pendingRestart: p.isBuiltin ? false : !p.pendingRestart }
          : p
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

  const handleInstallResult = (
    result: Awaited<ReturnType<typeof window.electron.plugin.installFromFile>>
  ) => {
    switch (result.status) {
      case "installed":
        setError(null);
        setNotice(null);
        setRefreshKey((k) => k + 1);
        return;
      case "cancelled":
        return;
      case "not-implemented":
        setNotice("Installing plugins isn't available yet — it lands with an upcoming release.");
        return;
      case "invalid-url":
        setError("That doesn't look like a valid URL. Check it and try again.");
        return;
      case "failed": {
        setNotice(null);
        setError(installErrorMessage(result.errors[0]));
        return;
      }
    }
  };

  const handleInstallFromFile = async () => {
    if (isInstalling) return;
    setIsInstalling(true);
    try {
      const result = await window.electron.plugin.installFromFile();
      handleInstallResult(result);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to install plugin"));
      logError("Failed to install plugin from file", err);
    } finally {
      setIsInstalling(false);
    }
  };

  const performInstallFromUrl = async (url: string) => {
    setIsInstalling(true);
    try {
      const result = await window.electron.plugin.installFromUrl(url);
      handleInstallResult(result);
      // Keep the dialog open for URL-correctable failures so the user can edit
      // in place: a malformed URL, a download error (404 / DNS), or a response
      // that wasn't a plugin archive. Size/timeout failures and successful
      // installs close it.
      const correctable =
        result.status === "invalid-url" ||
        (result.status === "failed" &&
          (result.errors[0]?.code === "fetch_failed" ||
            result.errors[0]?.code === "content_type_rejected"));
      if (!correctable) {
        setShowUrlDialog(false);
        setUrlInput("");
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to install plugin"));
      logError("Failed to install plugin from URL", err);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleInstallFromUrl = async () => {
    const url = urlInput.trim();
    if (!url || isInstalling) return;
    // Tier D2: a plaintext HTTP download is unauthenticated and unencrypted, so
    // gate it behind an explicit confirm before the request leaves the app. The
    // IPC handler still accepts http:// — this is the renderer's risk surface.
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      // Let the handler return invalid-url so the messaging stays consistent.
      await performInstallFromUrl(url);
      return;
    }
    if (protocol === "http:") {
      // Stack avoidance: close the URL input and surface the confirm on its
      // own. Cancelling reopens the input with the URL intact so the user can
      // switch to https; confirming proceeds with the install.
      setShowUrlDialog(false);
      pendingHttpUrlRef.current = url;
      setPendingHttpUrl(url);
      return;
    }
    await performInstallFromUrl(url);
  };

  const confirmHttpInstall = async () => {
    // Read+clear the ref synchronously so a re-entrant confirm is a one-shot.
    const url = pendingHttpUrlRef.current;
    if (!url) return;
    pendingHttpUrlRef.current = null;
    const fromReinstall = httpFromReinstallRef.current;
    httpFromReinstallRef.current = false;
    setPendingHttpUrl(null);
    await performInstallFromUrl(url);
    // A reinstall-over-http came from the update flow, not the manual install
    // dialog — advance the "Update all" queue if one is draining (#10893).
    if (fromReinstall && isBatchActiveRef.current) advanceUpdateQueue();
  };

  const cancelHttpInstall = () => {
    // Read+clear the ref synchronously so a re-entrant close can't reclassify a
    // reinstall cancel as a manual one (or double-advance the batch).
    if (!pendingHttpUrlRef.current) return;
    pendingHttpUrlRef.current = null;
    const fromReinstall = httpFromReinstallRef.current;
    httpFromReinstallRef.current = false;
    setPendingHttpUrl(null);
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
  // `getDroppedFilePath` can't resolve) is a structured error, not a missing
  // file.
  const installDroppedFiles = async (files: File[]) => {
    const dntrFiles = files.filter((f) => f.name.toLowerCase().endsWith(".dntr"));
    if (dntrFiles.length === 0) {
      setError(null);
      setNotice("Only .dntr files can be installed.");
      return;
    }
    if (installingRef.current) return;
    installingRef.current = true;
    setNotice(null);
    setError(null);
    setIsInstalling(true);
    // Collect per-file failures so a later file's success can't silently clear
    // an earlier file's error (the loop installs one file at a time).
    const failures: string[] = [];
    try {
      for (const file of dntrFiles) {
        const path = window.electron.plugin.getDroppedFilePath(file);
        if (!path) {
          failures.push(`${file.name} — couldn't read its location, try Install from file`);
          continue;
        }
        try {
          const result = await window.electron.plugin.installFromPath(path);
          if (result.status === "failed") {
            failures.push(`${file.name} — ${result.errors[0]?.message ?? "install failed"}`);
          } else {
            handleInstallResult(result);
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
    } else {
      isBatchActiveRef.current = false;
      setPendingUpdate(null);
    }
  };

  // The confirm dialog's cancel/skip. During a batch it moves to the next
  // queued update instead of ending the whole run.
  const dismissPendingUpdate = () => {
    advanceUpdateQueue();
  };

  // "Update all" (#10893): check every URL-installed plugin, then drain the ones
  // with an update through the same per-plugin capability-diff confirm flow as a
  // single check. Reuses `checkForUpdate` + `confirmReinstall`; never installs
  // silently and never collapses the per-plugin capability preview into one
  // blanket accept.
  const checkAllForUpdates = async () => {
    if (isCheckingAllUpdatesRef.current) return;
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
    try {
      for (const plugin of targets) {
        try {
          const result = await window.electron.plugin.checkForUpdate(plugin.manifest.name);
          if (refreshKeyRef.current !== startKey) return;
          if (result.status === "available") {
            available.push({ plugin, result });
          }
        } catch (err) {
          // Isolate per plugin — one failed check never aborts the batch.
          logError("Failed to check plugin for update (Update all)", err);
        }
      }
      if (refreshKeyRef.current !== startKey) return;
      const [first, ...rest] = available;
      if (!first) {
        setNotice("All plugins are up to date.");
        return;
      }
      pendingQueueRef.current = rest;
      isBatchActiveRef.current = true;
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
      setPendingHttpUrl(url);
      return;
    }
    reinstallingRef.current = true;
    setIsReinstalling(true);
    try {
      setError(null);
      const result = await window.electron.plugin.installFromUrl(url);
      handleInstallResult(result);
      advanceUpdateQueue();
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to reinstall plugin"));
      logError("Failed to reinstall plugin from URL", err);
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
    pending,
    pendingUninstall,
    deleteSettings,
    setDeleteSettings,
    isUninstalling,
    armUninstall,
    closeUninstall,
    confirmUninstall,
    showUrlDialog,
    setShowUrlDialog,
    closeUrlDialog,
    urlInput,
    setUrlInput,
    isInstalling,
    handleInstallFromFile,
    handleInstallFromUrl,
    pendingHttpUrl,
    confirmHttpInstall,
    cancelHttpInstall,
    checkingUpdate,
    upToDateId,
    handleCheckForUpdate,
    pendingUpdate,
    setPendingUpdate,
    isReinstalling,
    confirmReinstall,
    dismissPendingUpdate,
    checkAllForUpdates,
    isCheckingAllUpdates,
    hasUpdatablePlugins: plugins.some((p) => !p.isBuiltin && !!p.originalUrl),
    handleToggle,
    isDragOverFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    focusPluginId,
    clearFocusPluginId,
  };
}
