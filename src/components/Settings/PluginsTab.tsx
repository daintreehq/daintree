import { useEffect, useRef, useState } from "react";
import { Plug, AlertCircle, FilePlus, Link2, Trash2, RefreshCw, Info } from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { LoadedPluginInfo, PluginInstallSource } from "@shared/types/plugin";

/** Enabled plugins first, then alphabetically by display name. */
function sortPlugins(list: readonly LoadedPluginInfo[]): LoadedPluginInfo[] {
  return [...list].sort((a, b) => {
    const byEnabled = Number(a.disabled ?? false) - Number(b.disabled ?? false);
    if (byEnabled !== 0) return byEnabled;
    const aName = a.manifest.displayName ?? a.manifest.name;
    const bName = b.manifest.displayName ?? b.manifest.name;
    return aName.localeCompare(bName);
  });
}

/** Provenance source → short badge label (built-in / file / URL / catalog). */
const SOURCE_BADGE_LABELS: Record<PluginInstallSource, string> = {
  builtin: "Built-in",
  sideload: "File",
  url: "URL",
  catalog: "Catalog",
};

function pluginLabel(plugin: LoadedPluginInfo): string {
  return plugin.manifest.displayName ?? plugin.manifest.name;
}

interface PluginRowProps {
  plugin: LoadedPluginInfo;
  toggling: boolean;
  checkingUpdate: boolean;
  upToDate: boolean;
  onToggle: () => void;
  onUninstall: () => void;
  onCheckForUpdate: () => void;
}

/**
 * One installed-plugin row: provenance metadata + per-row actions. Not built on
 * `SettingsSwitchCard` because that card has no slot for the uninstall /
 * check-for-update buttons — this row reuses `SettingsSwitch` directly and
 * extends the same visual language (bordered card, icon, title + subtitle).
 * Row expansion (capabilities, contributed actions, load-error stack trace) is
 * left as a follow-up slot per the issue.
 */
function PluginRow({
  plugin,
  toggling,
  checkingUpdate,
  upToDate,
  onToggle,
  onUninstall,
  onCheckForUpdate,
}: PluginRowProps) {
  const label = pluginLabel(plugin);
  const enabled = plugin.disabled !== true;
  const restartRequired = plugin.pendingRestart === true;
  const sourceLabel = SOURCE_BADGE_LABELS[plugin.source] ?? plugin.source;
  // URL-installed plugins have an upstream to re-fetch and compare against;
  // file-installed plugins and built-ins don't, so the button stays disabled
  // with an explanatory tooltip.
  const canCheckUpdate = plugin.originalUrl !== null;
  const updateTooltip = canCheckUpdate
    ? checkingUpdate
      ? "Checking for a new version…"
      : "Check for a new version"
    : plugin.isBuiltin
      ? "Built-in plugins update with Daintree"
      : "No update URL — reinstall from a file to update";

  return (
    <div className="relative w-full p-4 rounded-[var(--radius-lg)] border border-daintree-border text-daintree-text">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Plug
            className={enabled ? "w-5 h-5 text-daintree-text/70" : "w-5 h-5 text-daintree-text/40"}
            aria-hidden="true"
          />
          <div className="min-w-0 text-left">
            <div className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
              <span className="truncate">{label}</span>
              <span className="text-xs font-normal text-daintree-text/40">
                v{plugin.manifest.version}
              </span>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 uppercase tracking-wide">
                {sourceLabel}
              </span>
              {plugin.devMode && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 uppercase tracking-wide">
                  Dev
                </span>
              )}
              {restartRequired && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/50 uppercase tracking-wide">
                  Restart required
                </span>
              )}
            </div>
            {plugin.manifest.description && (
              <div className="text-xs text-daintree-text/70 mt-0.5">
                {plugin.manifest.description}
              </div>
            )}
            {!plugin.isBuiltin && plugin.installedAt > 0 && (
              <div className="text-[11px] text-daintree-text/40 mt-1">
                {plugin.updatedAt
                  ? `Updated ${formatRelativeTime(plugin.updatedAt)}`
                  : `Installed ${formatRelativeTime(plugin.installedAt)}`}
              </div>
            )}
            {upToDate && (
              <div className="text-[11px] text-daintree-text/50 mt-1" role="status">
                Already up to date
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {canCheckUpdate ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onCheckForUpdate}
                  disabled={checkingUpdate}
                  aria-label={`Check ${label} for updates`}
                >
                  <RefreshCw className={checkingUpdate ? "animate-spin" : undefined} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{updateTooltip}</TooltipContent>
            </Tooltip>
          ) : (
            // A native `disabled` button emits no pointer events, so the
            // tooltip wouldn't show — wrap it in a focusable span trigger.
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled
                    tabIndex={-1}
                    aria-label={`Check ${label} for updates`}
                  >
                    <RefreshCw />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{updateTooltip}</TooltipContent>
            </Tooltip>
          )}

          {!plugin.isBuiltin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onUninstall}
                  aria-label={`Uninstall ${label}`}
                  className="text-daintree-text/50 hover:text-status-error"
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Uninstall plugin</TooltipContent>
            </Tooltip>
          )}

          <SettingsSwitch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={toggling}
            aria-label={`Enable ${label}`}
          />
        </div>
      </div>

      {plugin.loadError && (
        <div className="flex items-start gap-2 mt-3 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-[11px] text-status-danger break-words">
            Failed to load: {plugin.loadError.message}
          </p>
        </div>
      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="w-full p-4 rounded-[var(--radius-lg)] border border-daintree-border">
      <div className="flex items-center gap-3 animate-pulse-delayed">
        <div className="w-5 h-5 rounded bg-daintree-text/10" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-32 rounded bg-daintree-text/10" />
          <div className="h-2.5 w-48 rounded bg-daintree-text/10" />
        </div>
        <div className="w-11 h-6 rounded-full bg-daintree-text/10" />
      </div>
    </div>
  );
}

/**
 * Canonical Settings surface for plugin management (#9290): install from file
 * or URL, enable/disable (#9284), uninstall, provenance, and a check-for-update
 * affordance. Section chrome (header + install buttons) paints before the
 * bridge call resolves; the installed list shows `animate-pulse-delayed` row
 * skeletons during the initial pull. The install-from-file/URL flows are thin
 * callers — the atomic extract/validate/swap install (F21/F23/F24) lands
 * separately, so those operations currently surface a "not available yet"
 * notice. The manual update check (#9297) is fully wired: it re-fetches the
 * plugin's URL, compares archive hashes, and either shows "Already up to date"
 * or opens a confirm dialog to reinstall. Uninstall is fully wired (Tier D1
 * `ConfirmDialog`).
 */
export function PluginsTab() {
  const [plugins, setPlugins] = useState<LoadedPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
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
  // Update-check state. `checkingUpdate` drives the per-row spinner; the ref is
  // the synchronous reentrancy guard (state batches, leaving a double-click
  // window — #4703). `upToDateId` shows the transient "Already up to date" note;
  // `pendingUpdate` holds the fetched manifest preview for the confirm dialog.
  const [checkingUpdate, setCheckingUpdate] = useState<Set<string>>(new Set());
  const checkingUpdateRef = useRef<Set<string>>(new Set());
  const [upToDateId, setUpToDateId] = useState<string | null>(null);
  const upToDateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<{
    plugin: LoadedPluginInfo;
    result: Extract<
      Awaited<ReturnType<typeof window.electron.plugin.checkForUpdate>>,
      { status: "available" }
    >;
  } | null>(null);
  const [isReinstalling, setIsReinstalling] = useState(false);

  useSettingsTabValidation("plugins", Boolean(error));

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

  // Re-pull when any view installs or uninstalls a plugin (#9285 cross-view
  // propagation). The event carries no payload, so always re-fetch the full
  // list rather than patching from a stale closure (#5087).
  useEffect(() => {
    return window.electron.plugin.onProvenanceChanged(() => {
      setRefreshKey((k) => k + 1);
      // A plugin may have been uninstalled in another window — close any open
      // reinstall confirm so it can't fire `installFromUrl` on a stale record.
      setPendingUpdate(null);
    });
  }, []);

  const handleToggle = async (plugin: LoadedPluginInfo) => {
    const id = plugin.manifest.name;
    if (pending.has(id)) return;
    const next = plugin.disabled === true; // currently disabled → enabling
    const wasDisabled = plugin.disabled;
    const wasPendingRestart = plugin.pendingRestart;

    setPending((prev) => new Set(prev).add(id));
    // Optimistic flip: a single toggle always flips both the desired state and
    // the running/desired mismatch, so `pendingRestart` simply inverts.
    setPlugins((prev) =>
      prev.map((p) =>
        p.manifest.name === id ? { ...p, disabled: !next, pendingRestart: !p.pendingRestart } : p
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

  const handleInstallFromUrl = async () => {
    const url = urlInput.trim();
    if (!url || isInstalling) return;
    setIsInstalling(true);
    try {
      const result = await window.electron.plugin.installFromUrl(url);
      handleInstallResult(result);
      // Keep the dialog open on an invalid URL so the user can correct it.
      if (result.status !== "invalid-url") {
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
    try {
      setError(null);
      const result = await window.electron.plugin.checkForUpdate(id);
      switch (result.status) {
        case "up-to-date":
          if (upToDateTimerRef.current) clearTimeout(upToDateTimerRef.current);
          setUpToDateId(id);
          upToDateTimerRef.current = setTimeout(() => setUpToDateId(null), 4000);
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

  const confirmReinstall = async () => {
    if (!pendingUpdate) return;
    const url = pendingUpdate.plugin.originalUrl;
    if (!url) {
      setPendingUpdate(null);
      return;
    }
    setIsReinstalling(true);
    try {
      setError(null);
      const result = await window.electron.plugin.installFromUrl(url);
      setPendingUpdate(null);
      handleInstallResult(result);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to reinstall plugin"));
      logError("Failed to reinstall plugin from URL", err);
    } finally {
      setIsReinstalling(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-daintree-text">Installed plugins</h3>
          <p className="text-xs text-daintree-text/50 mt-1 select-text">
            Install plugins to extend Daintree with panels, commands, and integrations. Turn one off
            to keep its settings without loading it — changes take effect after you restart.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleInstallFromFile()}
            loading={isInstalling}
          >
            <FilePlus />
            Install from file
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowUrlDialog(true)}>
            <Link2 />
            Install from URL
          </Button>
        </div>
      </div>

      {notice && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border">
          <Info className="w-4 h-4 text-daintree-text/50 shrink-0 mt-0.5" />
          <p className="text-xs text-daintree-text/70">{notice}</p>
        </div>
      )}

      {loading ? (
        showInlineLoading ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : null
      ) : plugins.length === 0 ? (
        <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<Plug />}
            title="No plugins installed"
            description="Install one from a file or URL to add panels, commands, and integrations."
          />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.manifest.name}
              plugin={plugin}
              toggling={pending.has(plugin.manifest.name)}
              checkingUpdate={checkingUpdate.has(plugin.manifest.name)}
              upToDate={upToDateId === plugin.manifest.name}
              onToggle={() => void handleToggle(plugin)}
              onUninstall={() => armUninstall(plugin)}
              onCheckForUpdate={() => void handleCheckForUpdate(plugin)}
            />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingUninstall !== null}
        onClose={isUninstalling ? undefined : closeUninstall}
        title={pendingUninstall ? `Uninstall '${pluginLabel(pendingUninstall)}'?` : ""}
        description="Removes the plugin and deletes its files, unloading its panels, commands, and integrations. Stored settings and secrets are kept unless you check the box below."
        confirmLabel="Uninstall plugin"
        cancelLabel="Keep plugin"
        onConfirm={() => void confirmUninstall()}
        isConfirmLoading={isUninstalling}
        variant="destructive"
      >
        <label className="flex items-center gap-2 text-xs text-daintree-text/70 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={deleteSettings}
            onChange={(e) => setDeleteSettings(e.target.checked)}
            disabled={isUninstalling}
            className="size-3.5 rounded-sm border border-daintree-border bg-daintree-bg accent-daintree-text/70"
          />
          Also delete stored settings and secrets
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pendingUpdate !== null}
        onClose={isReinstalling ? undefined : () => setPendingUpdate(null)}
        title={pendingUpdate ? `Update '${pluginLabel(pendingUpdate.plugin)}'?` : ""}
        description="Downloads the latest archive and reinstalls over the current version. Your settings are kept."
        confirmLabel="Reinstall plugin"
        cancelLabel="Cancel"
        onConfirm={() => void confirmReinstall()}
        isConfirmLoading={isReinstalling}
      >
        {pendingUpdate && (
          <div className="mt-3 space-y-1.5 text-xs text-daintree-text/70">
            <div>
              <span className="text-daintree-text/50">New version</span>{" "}
              <span className="font-medium text-daintree-text">v{pendingUpdate.result.version}</span>
              {pendingUpdate.result.displayName &&
                pendingUpdate.result.displayName !== pluginLabel(pendingUpdate.plugin) && (
                  <span className="text-daintree-text/50">
                    {" "}
                    · now named {pendingUpdate.result.displayName}
                  </span>
                )}
            </div>
            {pendingUpdate.result.capabilities.length > 0 && (
              <div>
                <span className="text-daintree-text/50">Capabilities</span>{" "}
                <span className="text-daintree-text">
                  {pendingUpdate.result.capabilities.join(", ")}
                </span>
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>

      <AppDialog
        isOpen={showUrlDialog}
        onClose={() => {
          if (isInstalling) return;
          setShowUrlDialog(false);
          setUrlInput("");
        }}
        size="sm"
        initialFocus="first"
      >
        <AppDialog.Header>
          <AppDialog.Title>Install from URL</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body className="space-y-3">
          <AppDialog.Description>
            Enter the URL of a Daintree plugin archive (.dntr). It's downloaded, validated, and
            installed.
          </AppDialog.Description>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlInput.trim()) void handleInstallFromUrl();
            }}
            placeholder="https://example.com/plugin.dntr"
            className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border text-daintree-text placeholder:text-daintree-text/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            aria-label="Plugin URL"
          />
        </AppDialog.Body>
        <AppDialog.Footer
          secondaryAction={{
            label: "Cancel",
            onClick: () => {
              setShowUrlDialog(false);
              setUrlInput("");
            },
            disabled: isInstalling,
          }}
          primaryAction={{
            label: "Install",
            onClick: () => void handleInstallFromUrl(),
            loading: isInstalling,
            disabled: urlInput.trim().length === 0,
          }}
        />
      </AppDialog>
    </div>
  );
}
