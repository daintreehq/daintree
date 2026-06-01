import { useEffect, useRef, useState } from "react";
import {
  Plug,
  AlertCircle,
  FilePlus,
  Link2,
  Trash2,
  RefreshCw,
  Info,
  Download,
} from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { usePluginManager } from "./usePluginManager";
import type {
  LoadedPluginInfo,
  PluginDeepLinkIntent,
  PluginInstallSource,
} from "@shared/types/plugin";

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
  /** Attached to the row root so a deep-link `open` can scroll it into view. */
  innerRef?: (el: HTMLDivElement | null) => void;
  /** Transient neutral highlight when a deep-link `open` targets this row. */
  highlighted?: boolean;
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
  innerRef,
  highlighted,
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
    <div
      ref={innerRef}
      className={`relative w-full p-4 rounded-[var(--radius-lg)] border text-daintree-text transition-colors ${
        highlighted ? "border-daintree-text/40 bg-overlay-subtle" : "border-daintree-border"
      }`}
    >
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

      {/* Settings render whether or not the plugin is enabled — values persist
          independently of the plugin's runtime, so users can pre-configure a
          plugin before turning it on, or keep editing it while it's off. */}
      {(plugin.manifest.contributes.settings?.length ?? 0) > 0 && (
        <PluginSettingsForm plugin={plugin} />
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

interface PluginManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pending `daintree://` deep-link intent (#9559), or `null` when none. */
  deepLinkIntent?: PluginDeepLinkIntent | null;
  /** Called once the intent has been applied so the source can clear it. */
  onDeepLinkConsumed?: () => void;
}

// How long the deep-link `open` target row stays highlighted before fading back.
const DEEP_LINK_HIGHLIGHT_MS = 2000;

/**
 * Dedicated plugin manager dialog (#9548) — the primary surface for plugin
 * lifecycle: install from file or URL (#9290), enable/disable (#9284),
 * uninstall, provenance, and the manual check-for-update flow (#9297). It owns
 * the full management UI lifted out of the former Settings `PluginsTab`, which
 * is now a thin entry point. Files can be dropped anywhere on the body to
 * install. The browse/discovery surface (#9305) ships separately — the body
 * reserves room for it below the installed list.
 *
 * Nested confirm dialogs (uninstall, update, HTTP install) and the URL-input
 * dialog render at `zIndex="nested"` so the LIFO escape backstop closes the
 * inner surface before this dialog (#2828).
 */
export function PluginManagerDialog({
  isOpen,
  onClose,
  deepLinkIntent,
  onDeepLinkConsumed,
}: PluginManagerDialogProps) {
  const pm = usePluginManager(isOpen, {
    intent: deepLinkIntent ?? null,
    onConsumed: onDeepLinkConsumed,
  });

  // Row elements keyed by plugin name, so a `daintree://plugin/open` can scroll
  // its target into view.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [highlightedPluginId, setHighlightedPluginId] = useState<string | null>(null);

  // When the hook resolves a deep-link `open` target to an installed plugin,
  // scroll its row into view and apply a transient neutral highlight, then clear
  // the focus request so it doesn't re-trigger on the next render.
  const focusPluginId = pm.focusPluginId;
  const clearFocusPluginId = pm.clearFocusPluginId;
  useEffect(() => {
    if (!focusPluginId) return;
    const row = rowRefs.current.get(focusPluginId);
    if (!row) return; // Row not rendered yet — the not-found notice path handles misses.
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedPluginId(focusPluginId);
    clearFocusPluginId();
    const timer = setTimeout(() => setHighlightedPluginId(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusPluginId, clearFocusPluginId, pm.plugins]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="plugin-manager-dialog">
      <AppDialog.Header>
        <AppDialog.Title icon={<Plug className="w-5 h-5 text-daintree-text/70" />}>
          Plugins
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div
          className="relative space-y-6"
          onDragEnter={pm.handleDragEnter}
          onDragOver={pm.handleDragOver}
          onDragLeave={pm.handleDragLeave}
          onDrop={pm.handleDrop}
        >
          {pm.isDragOverFiles && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-daintree-bg/80 border-2 border-dashed border-daintree-border pointer-events-none">
              <Download className="w-6 h-6 text-daintree-text/60" aria-hidden="true" />
              <p className="text-sm font-medium text-daintree-text">Drop a .dntr file to install</p>
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-daintree-text">Installed plugins</h3>
              <p className="text-xs text-daintree-text/50 mt-1 select-text">
                Install plugins to extend Daintree with panels, commands, and integrations. Turn one
                off to keep its settings without loading it — changes take effect after you restart.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void pm.handleInstallFromFile()}
                loading={pm.isInstalling}
              >
                <FilePlus />
                Install from file
              </Button>
              <Button variant="outline" size="sm" onClick={() => pm.setShowUrlDialog(true)}>
                <Link2 />
                Install from URL
              </Button>
            </div>
          </div>

          {pm.notice && (
            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border">
              <Info className="w-4 h-4 text-daintree-text/50 shrink-0 mt-0.5" />
              <p className="text-xs text-daintree-text/70">{pm.notice}</p>
            </div>
          )}

          {pm.loading ? (
            pm.showInlineLoading ? (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : null
          ) : pm.plugins.length === 0 && !pm.error ? (
            // Suppress the empty state when a load error is showing — the error
            // banner below owns that case so we don't invite a redundant install.
            <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
              <EmptyState
                variant="zero-data"
                scale="canvas"
                icon={<Plug />}
                title="No plugins installed"
                description="Install one from a file or URL to add panels, commands, and integrations."
              />
            </div>
          ) : pm.plugins.length === 0 ? null : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {pm.plugins.map((plugin) => (
                <PluginRow
                  key={plugin.manifest.name}
                  plugin={plugin}
                  toggling={pm.pending.has(plugin.manifest.name)}
                  checkingUpdate={pm.checkingUpdate.has(plugin.manifest.name)}
                  upToDate={pm.upToDateId === plugin.manifest.name}
                  onToggle={() => void pm.handleToggle(plugin)}
                  onUninstall={() => pm.armUninstall(plugin)}
                  onCheckForUpdate={() => void pm.handleCheckForUpdate(plugin)}
                  highlighted={highlightedPluginId === plugin.manifest.name}
                  innerRef={(el) => {
                    if (el) rowRefs.current.set(plugin.manifest.name, el);
                    else rowRefs.current.delete(plugin.manifest.name);
                  }}
                />
              ))}
            </div>
          )}

          {pm.error && (
            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
              <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
              <p className="text-xs text-status-danger">{pm.error}</p>
            </div>
          )}

          {/* Browse / discovery surface (marketplace) is reserved for #9305 —
              it slots in below the installed list. Intentionally unrendered. */}
        </div>
      </AppDialog.Body>

      <ConfirmDialog
        isOpen={pm.pendingUninstall !== null}
        onClose={pm.isUninstalling ? undefined : pm.closeUninstall}
        title={pm.pendingUninstall ? `Uninstall '${pluginLabel(pm.pendingUninstall)}'?` : ""}
        description="Removes the plugin and deletes its files, unloading its panels, commands, and integrations. Per-project settings under .daintree/ are always kept; this plugin's saved settings are kept too unless you check the box below."
        confirmLabel="Uninstall plugin"
        cancelLabel="Keep plugin"
        onConfirm={() => void pm.confirmUninstall()}
        isConfirmLoading={pm.isUninstalling}
        variant="destructive"
        zIndex="nested"
      >
        <label className="flex items-center gap-2 text-xs text-daintree-text/70 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={pm.deleteSettings}
            onChange={(e) => pm.setDeleteSettings(e.target.checked)}
            disabled={pm.isUninstalling}
            className="size-3.5 rounded-sm border border-daintree-border bg-daintree-bg accent-daintree-text/70"
          />
          Also delete this plugin's saved settings
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pm.pendingUpdate !== null}
        onClose={pm.isReinstalling ? undefined : () => pm.setPendingUpdate(null)}
        title={pm.pendingUpdate ? `Update '${pluginLabel(pm.pendingUpdate.plugin)}'?` : ""}
        description="Downloads the latest archive and reinstalls over the current version. Your settings are kept."
        confirmLabel="Reinstall plugin"
        cancelLabel="Cancel"
        onConfirm={() => void pm.confirmReinstall()}
        isConfirmLoading={pm.isReinstalling}
        variant="default"
        zIndex="nested"
      >
        {pm.pendingUpdate && (
          <div className="mt-3 space-y-1.5 text-xs text-daintree-text/70">
            <div>
              <span className="text-daintree-text/50">New version</span>{" "}
              <span className="font-medium text-daintree-text">
                v{pm.pendingUpdate.result.version}
              </span>
              {pm.pendingUpdate.result.displayName &&
                pm.pendingUpdate.result.displayName !== pluginLabel(pm.pendingUpdate.plugin) && (
                  <span className="text-daintree-text/50">
                    {" "}
                    · now named {pm.pendingUpdate.result.displayName}
                  </span>
                )}
            </div>
            {pm.pendingUpdate.result.capabilities.length > 0 && (
              <div>
                <span className="text-daintree-text/50">Capabilities</span>{" "}
                <span className="text-daintree-text">
                  {pm.pendingUpdate.result.capabilities.join(", ")}
                </span>
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pm.pendingHttpUrl !== null}
        onClose={pm.isInstalling ? undefined : pm.cancelHttpInstall}
        title="Install over HTTP?"
        description="This URL doesn't use HTTPS, so the download isn't encrypted or authenticated in transit. Only continue if you trust the source."
        confirmLabel="Install over HTTP"
        cancelLabel="Cancel"
        onConfirm={() => void pm.confirmHttpInstall()}
        isConfirmLoading={pm.isInstalling}
        variant="destructive"
        zIndex="nested"
      />

      <AppDialog
        isOpen={pm.showUrlDialog}
        onClose={() => {
          if (pm.isInstalling) return;
          pm.closeUrlDialog();
        }}
        size="sm"
        zIndex="nested"
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
            value={pm.urlInput}
            onChange={(e) => pm.setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pm.urlInput.trim()) void pm.handleInstallFromUrl();
            }}
            placeholder="https://example.com/plugin.dntr"
            className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border text-daintree-text placeholder:text-daintree-text/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            aria-label="Plugin URL"
          />
        </AppDialog.Body>
        <AppDialog.Footer
          secondaryAction={{
            label: "Cancel",
            onClick: pm.closeUrlDialog,
            disabled: pm.isInstalling,
          }}
          primaryAction={{
            label: "Install",
            onClick: () => void pm.handleInstallFromUrl(),
            loading: pm.isInstalling,
            disabled: pm.urlInput.trim().length === 0,
          }}
        />
      </AppDialog>
    </AppDialog>
  );
}
