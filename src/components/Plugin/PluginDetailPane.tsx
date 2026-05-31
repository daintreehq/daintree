import { AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type { LoadedPluginInfo, PluginInstallSource } from "@shared/types/plugin";

/** Provenance source → short badge label (built-in / file / URL / catalog). */
export const SOURCE_BADGE_LABELS: Record<PluginInstallSource, string> = {
  builtin: "Built-in",
  sideload: "File",
  url: "URL",
  catalog: "Catalog",
};

export function pluginLabel(plugin: LoadedPluginInfo): string {
  return plugin.manifest.displayName ?? plugin.manifest.name;
}

const BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 uppercase tracking-wide";

interface PluginDetailPaneProps {
  plugin: LoadedPluginInfo;
  checkingUpdate: boolean;
  upToDate: boolean;
  onUninstall: () => void;
  onCheckForUpdate: () => void;
}

/**
 * Detail pane for the selected plugin (#9555). Owns the full provenance and
 * metadata surface — name, version, source, install time, load error — plus the
 * per-plugin actions (check-for-update, uninstall) and the generated settings
 * form. Lifting this out of the list row removes the inline-expansion layout
 * shift: selecting a plugin populates this pane instead of pushing rows down.
 *
 * The settings form is keyed on `plugin.manifest.name` by the parent's pane
 * wrapper, so switching plugins reinitializes its drafts from the new plugin's
 * stored values.
 */
export function PluginDetailPane({
  plugin,
  checkingUpdate,
  upToDate,
  onUninstall,
  onCheckForUpdate,
}: PluginDetailPaneProps) {
  const label = pluginLabel(plugin);
  const restartRequired = plugin.pendingRestart === true;
  const sourceLabel = SOURCE_BADGE_LABELS[plugin.source] ?? plugin.source;
  const hasSettings = (plugin.manifest.contributes.settings?.length ?? 0) > 0;
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
    <div className="space-y-4 text-daintree-text">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-base font-medium truncate">{label}</h3>
            <span className="text-xs font-normal text-daintree-text/40">
              v{plugin.manifest.version}
            </span>
            <span className={BADGE_CLASS}>{sourceLabel}</span>
            {plugin.devMode && <span className={BADGE_CLASS}>Dev</span>}
            {restartRequired && (
              <span className={`${BADGE_CLASS} text-daintree-text/50`}>Restart required</span>
            )}
          </div>
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
            // A native `disabled` button emits no pointer events, so the tooltip
            // wouldn't show — wrap it in a focusable span trigger.
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
        </div>
      </div>

      {plugin.manifest.description && (
        <p className="text-xs text-daintree-text/70 select-text">{plugin.manifest.description}</p>
      )}

      {plugin.loadError && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-[11px] text-status-danger break-words">
            Failed to load: {plugin.loadError.message}
          </p>
        </div>
      )}

      {/* Settings render whether or not the plugin is enabled — values persist
          independently of the plugin's runtime, so users can pre-configure a
          plugin before turning it on, or keep editing it while it's off. */}
      {hasSettings ? (
        <PluginSettingsForm plugin={plugin} />
      ) : (
        <p className="text-xs text-daintree-text/40 pt-1">This plugin has no settings.</p>
      )}
    </div>
  );
}
