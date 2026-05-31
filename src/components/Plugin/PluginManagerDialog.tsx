import { Plug, FilePlus, Link2, Info, Download, AlertCircle } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import { usePluginManager } from "./usePluginManager";
import { PluginDetailPane, SOURCE_BADGE_LABELS, pluginLabel } from "./PluginDetailPane";
import type { LoadedPluginInfo, PluginDeepLinkIntent } from "@shared/types/plugin";

const ROW_BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 uppercase tracking-wide";

interface PluginRowProps {
  plugin: LoadedPluginInfo;
  selected: boolean;
  toggling: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Attached to the row root so a deep-link `open` (#9559) can scroll it into view. */
  innerRef?: (el: HTMLDivElement | null) => void;
  /** Transient neutral highlight when a deep-link `open` targets this row. */
  highlighted?: boolean;
}

/**
 * One installed-plugin row in the master list (#9555): a compact, selectable
 * entry showing name, version, provenance, and the enable toggle. Selecting it
 * populates the detail pane on the right — the full metadata, actions, and
 * settings live there now, so the row stays scannable and never shifts layout.
 *
 * The selection target is a `<button role="option">` covering the info area;
 * the enable toggle is a sibling control (not nested) so it keeps its own click
 * target. Selected styling follows the master-detail precedent (`bg-overlay-soft`
 * + a single 2px accent bar via `before:*`), reserving the accent for the one
 * load-bearing selection signal.
 *
 * A deep-link `open` (#9559) scrolls the row into view via `innerRef` and flags
 * it with a transient neutral `highlighted` outline — distinct from the accent
 * selection stripe so the two signals never collide.
 */
function PluginRow({
  plugin,
  selected,
  toggling,
  onSelect,
  onToggle,
  innerRef,
  highlighted,
}: PluginRowProps) {
  const label = pluginLabel(plugin);
  const enabled = plugin.disabled !== true;
  const restartRequired = plugin.pendingRestart === true;
  const sourceLabel = SOURCE_BADGE_LABELS[plugin.source] ?? plugin.source;

  return (
    <div
      ref={innerRef}
      className={cn(
        "relative flex items-center gap-2 rounded-[var(--radius-md)] border text-daintree-text transition-colors",
        selected
          ? "bg-overlay-soft border-overlay before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
          : highlighted
            ? "border-daintree-text/40 bg-overlay-subtle"
            : "border-transparent hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className="flex items-start gap-2.5 min-w-0 flex-1 py-2.5 pl-3 pr-1 text-left rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
      >
        <Plug
          className={
            enabled
              ? "w-4 h-4 mt-0.5 text-daintree-text/70"
              : "w-4 h-4 mt-0.5 text-daintree-text/40"
          }
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            <span className="truncate">{label}</span>
            <span className="text-[11px] font-normal text-daintree-text/40">
              v{plugin.manifest.version}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-1 flex-wrap">
            <span className={ROW_BADGE_CLASS}>{sourceLabel}</span>
            {plugin.devMode && <span className={ROW_BADGE_CLASS}>Dev</span>}
            {restartRequired && (
              <span className={`${ROW_BADGE_CLASS} text-daintree-text/50`}>Restart required</span>
            )}
            {plugin.loadError && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-danger uppercase tracking-wide">
                <AlertCircle className="w-3 h-3" aria-hidden="true" />
                Failed
              </span>
            )}
          </span>
        </span>
      </button>

      <span className="shrink-0 pr-2.5">
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={toggling}
          aria-label={`Enable ${label}`}
        />
      </span>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="w-full flex items-center gap-2.5 py-2.5 px-3 rounded-[var(--radius-md)]">
      <div className="flex items-center gap-2.5 w-full animate-pulse-delayed">
        <div className="w-4 h-4 rounded bg-daintree-text/10" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 rounded bg-daintree-text/10" />
          <div className="h-2 w-16 rounded bg-daintree-text/10" />
        </div>
        <div className="w-9 h-5 rounded-full bg-daintree-text/10" />
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
  // Selection is pure UI state owned by the dialog — `usePluginManager` stays
  // data/IPC only. The detail pane derives from the selected id.
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const selectedPlugin =
    selectedPluginId === null
      ? null
      : (pm.plugins.find((p) => p.manifest.name === selectedPluginId) ?? null);

  // Row elements keyed by plugin name, so a `daintree://plugin/open` (#9559) can
  // scroll its target into view.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [highlightedPluginId, setHighlightedPluginId] = useState<string | null>(null);

  // Re-validate the selection after every list refresh (reopen, uninstall,
  // cross-window provenance change). A single effect keyed on the list nulls a
  // selection whose plugin is gone — kept here rather than in a second reset
  // effect that could race the hook's `isOpen` reset (#4958).
  useEffect(() => {
    if (
      selectedPluginId !== null &&
      !pm.plugins.some((p) => p.manifest.name === selectedPluginId)
    ) {
      setSelectedPluginId(null);
    }
  }, [pm.plugins, selectedPluginId]);

  // When the hook resolves a deep-link `open` target to an installed plugin
  // (#9559), select it, scroll its row into view, and apply a transient neutral
  // highlight, then clear the focus request so it doesn't re-trigger on the next
  // render.
  const focusPluginId = pm.focusPluginId;
  const clearFocusPluginId = pm.clearFocusPluginId;
  useEffect(() => {
    if (!focusPluginId) return;
    if (!pm.plugins.some((p) => p.manifest.name === focusPluginId)) return;
    setSelectedPluginId(focusPluginId);
    const row = rowRefs.current.get(focusPluginId);
    if (!row) return; // Row not rendered yet — the not-found notice path handles misses.
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedPluginId(focusPluginId);
    clearFocusPluginId();
    const timer = setTimeout(() => setHighlightedPluginId(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusPluginId, clearFocusPluginId, pm.plugins]);

  const hasPlugins = pm.plugins.length > 0;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      maxHeight="h-[75vh]"
      className="min-h-[480px] max-h-[800px]"
      data-testid="plugin-manager-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Plug className="w-5 h-5 text-daintree-text/70" />}>
          Plugins
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        onDragEnter={pm.handleDragEnter}
        onDragOver={pm.handleDragOver}
        onDragLeave={pm.handleDragLeave}
        onDrop={pm.handleDrop}
      >
        {pm.isDragOverFiles && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-daintree-bg/80 border-2 border-dashed border-daintree-border pointer-events-none">
            <Download className="w-6 h-6 text-daintree-text/60" aria-hidden="true" />
            <p className="text-sm font-medium text-daintree-text">Drop a .dntr file to install</p>
          </div>
        )}

        {/* Master: installed-plugin list + install controls. */}
        <div className="w-72 shrink-0 border-r border-daintree-border flex flex-col overflow-hidden">
          <div className="p-4 border-b border-daintree-border shrink-0 space-y-3">
            <div>
              <h3 className="text-sm font-medium text-daintree-text">Installed plugins</h3>
              <p className="text-xs text-daintree-text/50 mt-1 select-text">
                Extend Daintree with panels, commands, and integrations. Turn one off to keep its
                settings without loading it.
              </p>
            </div>
            <div className="flex flex-col gap-2">
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
            {pm.notice && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border">
                <Info className="w-3.5 h-3.5 text-daintree-text/50 shrink-0 mt-0.5" />
                <p className="text-[11px] text-daintree-text/70">{pm.notice}</p>
              </div>
            )}
            {pm.error && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
                <p className="text-[11px] text-status-danger">{pm.error}</p>
              </div>
            )}
          </div>

          {pm.loading ? (
            pm.showInlineLoading ? (
              <div className="p-2 space-y-1">
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : null
          ) : !hasPlugins && !pm.error ? (
            // Suppress the empty state when a load error is showing — the error
            // banner above owns that case so we don't invite a redundant install.
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Plug />}
              title="No plugins installed"
              description="Install one from a file or URL to add panels, commands, and integrations."
            />
          ) : !hasPlugins ? null : (
            <ScrollShadow
              className="flex-1 min-h-0"
              scrollClassName="p-2 space-y-1"
              role="listbox"
              aria-label="Installed plugins"
            >
              {pm.plugins.map((plugin) => (
                <PluginRow
                  key={plugin.manifest.name}
                  plugin={plugin}
                  selected={plugin.manifest.name === selectedPluginId}
                  toggling={pm.pending.has(plugin.manifest.name)}
                  onSelect={() => setSelectedPluginId(plugin.manifest.name)}
                  onToggle={() => void pm.handleToggle(plugin)}
                  highlighted={highlightedPluginId === plugin.manifest.name}
                  innerRef={(el) => {
                    if (el) rowRefs.current.set(plugin.manifest.name, el);
                    else rowRefs.current.delete(plugin.manifest.name);
                  }}
                />
              ))}
            </ScrollShadow>
          )}
        </div>

        {/* Detail: selected plugin's metadata, actions, and settings. The key
            is on the scroll container (not the pane) so switching plugins
            remounts the whole subtree — resetting scrollTop to the top and
            re-initializing PluginSettingsForm drafts from the new plugin's
            stored values. */}
        <ScrollShadow
          key={selectedPlugin?.manifest.name ?? "empty"}
          className="flex-1 min-h-0"
          scrollClassName="p-6"
        >
          {selectedPlugin ? (
            <PluginDetailPane
              plugin={selectedPlugin}
              checkingUpdate={pm.checkingUpdate.has(selectedPlugin.manifest.name)}
              upToDate={pm.upToDateId === selectedPlugin.manifest.name}
              onUninstall={() => pm.armUninstall(selectedPlugin)}
              onCheckForUpdate={() => void pm.handleCheckForUpdate(selectedPlugin)}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                variant="filtered-empty"
                scale="canvas"
                title={hasPlugins ? "Select a plugin" : "No plugin selected"}
                description={
                  hasPlugins
                    ? "Choose a plugin from the list to view its details and settings."
                    : "Install a plugin to view its details and settings here."
                }
              />
            </div>
          )}
        </ScrollShadow>
      </div>

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
