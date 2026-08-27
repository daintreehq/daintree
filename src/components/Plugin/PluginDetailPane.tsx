import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import {
  getPluginCategoryMeta,
  resolvePluginCategory,
} from "@shared/config/pluginCategoryRegistry";
import { PluginIconTile } from "./pluginIcons";
import { CapabilityRow } from "./capabilityMeta";
import { PluginMcpServersSection } from "./PluginMcpServersSection";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import {
  SettingsSubtabBar,
  type SettingsSubtabItem,
} from "@/components/Settings/SettingsSubtabBar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { systemClient } from "@/clients/systemClient";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type LoadedPluginInfo,
  type PanelContribution,
  type PluginActionContribution,
  type PluginAuthor,
  type PluginCapability,
  type PluginInstallSource,
} from "@shared/types/plugin";

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

/**
 * Declared capabilities in the order {@link BUILT_IN_PLUGIN_CAPABILITIES} defines
 * them, so the Permissions list reads the same for every plugin. Computed by the
 * pane (not inside {@link PluginCapabilityList}) because the same emptiness that
 * would render a bare "no permissions" line is what hides the tab entirely.
 */
function grantedCapabilities(plugin: LoadedPluginInfo) {
  const declared = new Set(plugin.manifest.capabilities ?? []);
  return BUILT_IN_PLUGIN_CAPABILITIES.filter((c) => declared.has(c));
}

/**
 * Surfaces a plugin's declared capabilities (#9556) as a labelled, risk-coloured
 * list with an effective-danger summary. Read-only — the data already rides on
 * `LoadedPluginInfo`; this only presents it so users can audit what an installed
 * plugin is allowed to do without re-opening the install dialog.
 *
 * Only rendered when `granted` is non-empty (#11302) — a plugin that declares no
 * capabilities has no Permissions tab at all, so there's no empty branch here.
 */
function PluginCapabilityList({
  plugin,
  granted,
}: {
  plugin: LoadedPluginInfo;
  granted: readonly PluginCapability[];
}) {
  const allowedUrls = plugin.manifest.scopes?.network?.allowedUrls;
  const allowedSocketPaths = plugin.manifest.scopes?.socket?.allowedPaths;

  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        Permissions
      </h4>
      {plugin.pluginDanger === "confirm" && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
          <AlertTriangle className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5" />
          <p className="text-[11px] text-status-warning break-words">
            Requests sensitive permissions — review before enabling
          </p>
        </div>
      )}
      <ul className="space-y-1.5">
        {granted.map((capability) => (
          <CapabilityRow
            key={capability}
            capability={capability}
            allowedUrls={allowedUrls}
            allowedSocketPaths={allowedSocketPaths}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The commands a plugin contributes to the command palette (#11302). A minimal
 * plugin's whole surface is often one command, and before this the Plugin
 * Manager never named it — leaving no obvious entry point after install. Read
 * straight off the loaded manifest; no IPC.
 *
 * Styled neutrally (no accent, no manifest-supplied colour): this is reference
 * material, not a focus signal. `kind: "query"` commands are reachable by
 * automation rather than the palette, so the hint distinguishes them. The
 * manifest's self-declared `danger` is deliberately NOT shown — the host's
 * `effectiveDanger` is the only authority on that, and echoing an unverified
 * claim here would read as a host guarantee.
 */
function PluginContributedCommands({ commands }: { commands: PluginActionContribution[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        Commands
      </h4>
      <ul className="space-y-2">
        {commands.map((command) => (
          <li key={command.id} className="text-xs">
            <div className="text-daintree-text/80">{command.title}</div>
            {command.description && (
              <div className="text-[11px] text-daintree-text/50 mt-0.5 break-words">
                {command.description}
              </div>
            )}
            <div className="text-[11px] text-text-secondary mt-0.5">
              {command.kind === "query"
                ? "Available to agents and automation"
                : "Run it from the command palette"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The panel kinds a plugin contributes (#11302), so a freshly installed plugin
 * names the panel you can open instead of leaving you to discover it. Panels
 * hidden from the palette (`showInPalette: false`) are still listed — the plugin
 * opens those itself — but labelled accurately so the row isn't a dead end.
 */
function PluginContributedPanels({ panels }: { panels: PanelContribution[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        Panels
      </h4>
      <ul className="space-y-2">
        {panels.map((panel) => (
          <li key={panel.id} className="text-xs">
            <div className="text-daintree-text/80">{panel.name}</div>
            <div className="text-[11px] text-text-secondary mt-0.5">
              {panel.showInPalette === false
                ? "Opened by the plugin"
                : "Open it from the new-panel menu"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Attribution credits (#10516) for the selected plugin. Each author's `name` is
 * plain text; `url` and `email` (when present) are clickable, routed through
 * `systemClient.openExternal` (the established external-navigation path) rather
 * than bare anchors. Styled neutrally — credits are reference metadata, not a
 * focus signal, so they never take the accent colour (CLAUDE.md accent-restraint).
 * The `url`/`email` were https/format-validated at the manifest gate, so the
 * values handed to `openExternal` are safe to construct.
 */
function PluginContributors({ authors }: { authors: PluginAuthor[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        Contributors
      </h4>
      <ul className="space-y-2">
        {authors.map((author, index) => {
          const { name, url, email, role } = author;
          return (
            <li key={`${name}-${index}`} className="text-xs">
              <div className="text-daintree-text/80">
                {name}
                {role && <span className="text-[11px] text-text-secondary"> · {role}</span>}
              </div>
              {(url || email) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {url && (
                    <button
                      type="button"
                      onClick={() => void systemClient.openExternal(url)}
                      className="text-[11px] text-daintree-text/50 hover:text-daintree-text/80 hover:underline break-all"
                    >
                      {url}
                    </button>
                  )}
                  {email && (
                    <button
                      type="button"
                      onClick={() => void systemClient.openExternal(`mailto:${email}`)}
                      className="text-[11px] text-daintree-text/50 hover:text-daintree-text/80 hover:underline break-all"
                    >
                      {email}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type PluginDetailTab = "overview" | "settings" | "capabilities" | "mcp-servers";

interface PluginDetailPaneProps {
  plugin: LoadedPluginInfo;
  checkingUpdate: boolean;
  upToDate: boolean;
  onUninstall: () => void;
  onCheckForUpdate: () => void;
}

/**
 * Detail pane for the selected plugin (#9555, #9558). Owns the full provenance
 * and metadata surface — name, version, source, install time, load error — plus
 * the per-plugin actions (check-for-update, uninstall) and the generated
 * settings form. Lifting this out of the list row removes the inline-expansion
 * layout shift: selecting a plugin populates this pane instead of pushing rows
 * down.
 *
 * The graduated view (#9558) splits the body into a tabbed master-detail layout
 * modelled on VS Code's Extensions view: a persistent identity header (name,
 * version, provenance, lifecycle actions) sits above an Overview / Settings /
 * Permissions subtab bar, so the plugin you're inspecting stays named no matter
 * which facet you're viewing.
 *
 * Tab state is local and resets to Overview whenever the plugin changes, because
 * the view's scroll wrapper is keyed on `plugin.manifest.name` and remounts this
 * subtree — which also reinitializes `PluginSettingsForm` drafts from the new
 * plugin's stored values.
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
  const categoryLabel = getPluginCategoryMeta(resolvePluginCategory(plugin.manifest)).label;
  const hasSettings = (plugin.manifest.contributes.settings?.length ?? 0) > 0;
  const mcpServers = plugin.manifest.contributes.mcpServers ?? [];
  const hasMcpServers = mcpServers.length > 0;
  const granted = grantedCapabilities(plugin);
  const commands = plugin.manifest.contributes.commands ?? [];
  const panels = plugin.manifest.contributes.panels ?? [];
  const [activeTab, setActiveTab] = useState<PluginDetailTab>("overview");

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

  // Every tab past Overview is earned by content (#11302). A minimal plugin that
  // declares no settings and no capabilities used to get three tabs, two of them
  // a single muted "nothing here" line — which reads as a half-finished install.
  // The MCP-servers tab set this precedent; Settings and Permissions now follow
  // it. Overview is unconditional so there is always somewhere to land.
  const tabs: SettingsSubtabItem[] = [
    { id: "overview", label: "Overview" },
    ...(hasSettings ? [{ id: "settings", label: "Settings" }] : []),
    ...(granted.length > 0 ? [{ id: "capabilities", label: "Permissions" }] : []),
    // Only plugins that actually contribute MCP servers get the runtime tab —
    // it surfaces subprocess health and restart, which is meaningless otherwise.
    ...(hasMcpServers ? [{ id: "mcp-servers", label: "MCP servers" }] : []),
  ];

  // Selecting a *different* plugin remounts this subtree (the scroll wrapper is
  // keyed on `plugin.manifest.name`), which resets `activeTab`. Reinstalling the
  // SAME plugin does not — the key is unchanged — so a version that drops its
  // last setting can strand `activeTab` on a tab that no longer exists. Derive
  // the rendered tab instead of syncing state in an effect: one expression, no
  // extra render, and it doubles as the `onChange` guard so the tab list and the
  // guard can't drift apart the way they did before.
  const isVisibleTab = (id: string): id is PluginDetailTab => tabs.some((t) => t.id === id);
  const currentTab: PluginDetailTab = isVisibleTab(activeTab) ? activeTab : "overview";

  // The derivation above keeps the RENDER correct, but `activeTab` itself would
  // stay pointing at the vanished tab — so a later reinstall that restores it
  // would teleport the user back there without them asking. Fold the fallback
  // into state once the tab set has actually changed. Ordinary local UI state
  // sync, unrelated to the single-data-loading-effect rule (#4958).
  useEffect(() => {
    if (currentTab !== activeTab) setActiveTab(currentTab);
  }, [currentTab, activeTab]);

  return (
    <div className="text-daintree-text">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3.5 min-w-0">
          <PluginIconTile manifest={plugin.manifest} size="lg" dimmed={plugin.disabled === true} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-base font-medium truncate">{label}</h3>
              <span className="text-xs font-normal text-text-secondary">
                v{plugin.manifest.version}
              </span>
              <span className={BADGE_CLASS}>{categoryLabel}</span>
              <span className={BADGE_CLASS}>{sourceLabel}</span>
              {plugin.blocklisted === true && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-danger uppercase tracking-wide">
                  <AlertCircle className="w-3 h-3" aria-hidden="true" />
                  Blocked
                </span>
              )}
              {plugin.blocklisted !== true && plugin.disabled === true && (
                <span className={BADGE_CLASS}>Disabled</span>
              )}
              {plugin.devMode && <span className={BADGE_CLASS}>Dev</span>}
              {restartRequired && (
                <span className={`${BADGE_CLASS} text-daintree-text/50`}>Restart required</span>
              )}
            </div>
            {plugin.manifest.tagline && (
              <p className="text-sm text-daintree-text/60 mt-1">{plugin.manifest.tagline}</p>
            )}
            {!plugin.isBuiltin && plugin.installedAt > 0 && (
              <div className="text-[11px] text-text-secondary mt-1">
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
                  <SpinningIcon icon={RefreshCw} active={checkingUpdate} />
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

      <div className="mt-4">
        <SettingsSubtabBar
          subtabs={tabs}
          activeId={currentTab}
          onChange={(id) => {
            if (isVisibleTab(id)) setActiveTab(id);
          }}
        />
      </div>

      {currentTab === "overview" && (
        <div className="space-y-4">
          {plugin.manifest.description ? (
            <p className="text-xs text-daintree-text/70 select-text">
              {plugin.manifest.description}
            </p>
          ) : (
            <p className="text-xs text-text-secondary">No description provided.</p>
          )}

          {commands.length > 0 && <PluginContributedCommands commands={commands} />}

          {panels.length > 0 && <PluginContributedPanels panels={panels} />}

          {plugin.manifest.authors && plugin.manifest.authors.length > 0 && (
            <PluginContributors authors={plugin.manifest.authors} />
          )}

          {plugin.blocklisted === true && (
            <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
              <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
              <p className="text-[11px] text-status-danger break-words">
                Blocked from loading:{" "}
                {plugin.blocklistReason ?? "flagged by the Daintree blocklist"}
              </p>
            </div>
          )}

          {plugin.loadError && (
            <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
              <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
              <p className="text-[11px] text-status-danger break-words">
                Failed to load: {plugin.loadError.message}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Settings render whether or not the plugin is enabled — values persist
          independently of the plugin's runtime, so users can pre-configure a
          plugin before turning it on, or keep editing it while it's off. The tab
          only exists when the plugin declares settings, so there's no empty
          branch to fall back to. */}
      {currentTab === "settings" && <PluginSettingsForm plugin={plugin} />}

      {currentTab === "capabilities" && <PluginCapabilityList plugin={plugin} granted={granted} />}

      {currentTab === "mcp-servers" && hasMcpServers && (
        <PluginMcpServersSection pluginId={plugin.manifest.name} declared={mcpServers} />
      )}
    </div>
  );
}
