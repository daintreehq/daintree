import { useState } from "react";
import { AlertCircle, AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import {
  getPluginCategoryMeta,
  resolvePluginCategory,
} from "@shared/config/pluginCategoryRegistry";
import { PluginIconTile } from "./pluginIcons";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { Button } from "@/components/ui/button";
import {
  SettingsSubtabBar,
  type SettingsSubtabItem,
} from "@/components/Settings/SettingsSubtabBar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { systemClient } from "@/clients/systemClient";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type BuiltInPluginCapability,
  type LoadedPluginInfo,
  type PluginAuthor,
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
 * Per-capability display tier. `danger` is reserved for `shell:exec` —
 * categorically irreversible arbitrary execution; `warning` covers the
 * remaining write/mutation/network capabilities (which also individually
 * trigger install-time confirmation); `neutral` covers read-only and clipboard
 * capabilities. Colours follow the status tokens, never the accent — risk is
 * not a focus signal (see CLAUDE.md accent-restraint).
 */
type CapabilitySeverity = "danger" | "warning" | "neutral";

interface CapabilityMeta {
  label: string;
  description: string;
  severity: CapabilitySeverity;
}

/**
 * Human-readable copy and risk tier for every built-in capability. Lives in the
 * renderer (presentation only) — the authoritative danger verdict for the whole
 * plugin is `plugin.pluginDanger`, computed on main. Iterated in
 * `BUILT_IN_PLUGIN_CAPABILITIES` order so the list is stable regardless of the
 * manifest's declaration order.
 */
const CAPABILITY_META = {
  "fs:project-read": {
    label: "Read project files",
    description: "View files in the open project",
    severity: "neutral",
  },
  "fs:project-write": {
    label: "Write project files",
    description: "Create, edit, or delete files in the open project",
    severity: "warning",
  },
  "fs:user-data-read": {
    label: "Read app data",
    description: "View Daintree's stored data",
    severity: "neutral",
  },
  "fs:user-data-write": {
    label: "Write app data",
    description: "Modify Daintree's stored data",
    severity: "warning",
  },
  "network:fetch": {
    label: "Make network requests",
    description: "Send and receive data over the network",
    severity: "warning",
  },
  "agent:invoke": {
    label: "Launch agents",
    description: "Start agent sessions on your behalf",
    severity: "warning",
  },
  "agent:read": {
    label: "Read agent activity",
    description: "Observe running agent sessions",
    severity: "neutral",
  },
  "agent:register": {
    label: "Register agent CLIs",
    description: "Add launchable agent commands",
    severity: "warning",
  },
  "agent:input": {
    label: "Send input to agents",
    description: "Type and submit text into running agent sessions",
    severity: "warning",
  },
  "git:read": {
    label: "Read git status",
    description: "View branch and change information",
    severity: "neutral",
  },
  "git:write": {
    label: "Run git commands",
    description: "Commit, branch, and modify git state",
    severity: "warning",
  },
  "clipboard:read": {
    label: "Read clipboard",
    description: "Access clipboard contents",
    severity: "neutral",
  },
  "clipboard:write": {
    label: "Write clipboard",
    description: "Replace clipboard contents",
    severity: "neutral",
  },
  "shell:exec": {
    label: "Run shell commands",
    description: "Execute arbitrary commands on your machine",
    severity: "danger",
  },
} satisfies Record<BuiltInPluginCapability, CapabilityMeta>;

const SEVERITY_TEXT_CLASS: Record<CapabilitySeverity, string> = {
  danger: "text-status-danger",
  warning: "text-status-warning",
  neutral: "text-daintree-text/40",
};

function CapabilityRow({
  capability,
  allowedUrls,
}: {
  capability: BuiltInPluginCapability;
  allowedUrls?: string[];
}) {
  const meta = CAPABILITY_META[capability];
  const scoped = capability === "network:fetch" && allowedUrls && allowedUrls.length > 0;
  return (
    <li className="flex items-start gap-2">
      {meta.severity === "danger" ? (
        <AlertCircle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${SEVERITY_TEXT_CLASS.danger}`} />
      ) : meta.severity === "warning" ? (
        <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${SEVERITY_TEXT_CLASS.warning}`} />
      ) : (
        <span
          className="w-1.5 h-1.5 rounded-full bg-daintree-text/30 shrink-0 mt-[7px]"
          aria-hidden
        />
      )}
      <div className="min-w-0">
        <div
          className={`text-xs ${meta.severity === "neutral" ? "text-daintree-text/80" : SEVERITY_TEXT_CLASS[meta.severity]}`}
        >
          {meta.label}
        </div>
        <div className="text-[11px] text-daintree-text/40">{meta.description}</div>
        {scoped && (
          <ul className="mt-0.5 space-y-0.5">
            {allowedUrls.map((url) => (
              <li key={url} className="text-[11px] font-mono text-daintree-text/50 break-all">
                {url}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Surfaces a plugin's declared capabilities (#9556) as a labelled, risk-coloured
 * list with an effective-danger summary. Read-only — the data already rides on
 * `LoadedPluginInfo`; this only presents it so users can audit what an installed
 * plugin is allowed to do without re-opening the install dialog.
 */
function PluginCapabilityList({ plugin }: { plugin: LoadedPluginInfo }) {
  const declared = new Set(plugin.manifest.capabilities ?? []);
  const granted = BUILT_IN_PLUGIN_CAPABILITIES.filter((c) => declared.has(c));
  const allowedUrls = plugin.manifest.scopes?.network?.allowedUrls;

  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-daintree-text/40">
        Permissions
      </h4>
      {granted.length === 0 ? (
        <p className="text-xs text-daintree-text/40">No special permissions</p>
      ) : (
        <>
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
              <CapabilityRow key={capability} capability={capability} allowedUrls={allowedUrls} />
            ))}
          </ul>
        </>
      )}
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
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-daintree-text/40">
        Contributors
      </h4>
      <ul className="space-y-2">
        {authors.map((author, index) => {
          const { name, url, email, role } = author;
          return (
            <li key={`${name}-${index}`} className="text-xs">
              <div className="text-daintree-text/80">
                {name}
                {role && <span className="text-[11px] text-daintree-text/40"> · {role}</span>}
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

type PluginDetailTab = "overview" | "settings" | "capabilities";

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

  const tabs: SettingsSubtabItem[] = [
    { id: "overview", label: "Overview" },
    { id: "settings", label: "Settings" },
    { id: "capabilities", label: "Permissions" },
  ];

  return (
    <div className="text-daintree-text">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3.5 min-w-0">
          <PluginIconTile manifest={plugin.manifest} size="lg" dimmed={plugin.disabled === true} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-base font-medium truncate">{label}</h3>
              <span className="text-xs font-normal text-daintree-text/40">
                v{plugin.manifest.version}
              </span>
              <span className={BADGE_CLASS}>{categoryLabel}</span>
              <span className={BADGE_CLASS}>{sourceLabel}</span>
              {plugin.disabled === true && <span className={BADGE_CLASS}>Disabled</span>}
              {plugin.devMode && <span className={BADGE_CLASS}>Dev</span>}
              {restartRequired && (
                <span className={`${BADGE_CLASS} text-daintree-text/50`}>Restart required</span>
              )}
            </div>
            {plugin.manifest.tagline && (
              <p className="text-sm text-daintree-text/60 mt-1">{plugin.manifest.tagline}</p>
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
          activeId={activeTab}
          onChange={(id) => {
            if (id === "overview" || id === "settings" || id === "capabilities") {
              setActiveTab(id);
            }
          }}
        />
      </div>

      {activeTab === "overview" && (
        <div className="space-y-4">
          {plugin.manifest.description ? (
            <p className="text-xs text-daintree-text/70 select-text">
              {plugin.manifest.description}
            </p>
          ) : (
            <p className="text-xs text-daintree-text/40">No description provided.</p>
          )}

          {plugin.manifest.authors && plugin.manifest.authors.length > 0 && (
            <PluginContributors authors={plugin.manifest.authors} />
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
          plugin before turning it on, or keep editing it while it's off. */}
      {activeTab === "settings" &&
        (hasSettings ? (
          <PluginSettingsForm plugin={plugin} />
        ) : (
          <p className="text-xs text-daintree-text/40">This plugin has no settings.</p>
        ))}

      {activeTab === "capabilities" && <PluginCapabilityList plugin={plugin} />}
    </div>
  );
}
