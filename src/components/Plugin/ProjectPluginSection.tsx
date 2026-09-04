import { AlertCircle, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { PluginLogsSection, usePluginLogs } from "@/components/Plugin/PluginLogsSection";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { cn } from "@/lib/utils";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type ProjectPluginInfo,
  type ProjectPluginState,
} from "@shared/types/plugin";

/** Same badge vocabulary as the installed rows — origin is a badge, not a colour. */
const BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-border-default/50 text-text-secondary uppercase tracking-wide";

const SECTION_HEADER_CLASS =
  "px-3 text-3xs font-medium uppercase tracking-wider text-text-secondary select-none";

const STATE_BADGE: Record<Exclude<ProjectPluginState, "active">, string> = {
  staged: "Staged",
  blocked: "Off",
  invalid: "Unreadable",
};

/**
 * One plugin the *project* ships, in the manager's master list.
 *
 * It reads like an installed row and is deliberately not one: no enable switch,
 * because trust here is granted at the folder and not per plugin — a per-row
 * toggle would promise a granularity the trust model does not have. The single
 * exception is a staged plugin, whose whole affordance is the one click that
 * lets it run.
 */
function ProjectPluginRow({
  plugin,
  selected,
  activating,
  onSelect,
  onActivate,
}: {
  plugin: ProjectPluginInfo;
  selected: boolean;
  activating: boolean;
  onSelect: () => void;
  onActivate: () => void;
}) {
  const running = plugin.state === "active";

  return (
    <div
      className={cn(
        "relative flex items-center gap-2 rounded-[var(--radius-md)] border text-text-primary transition-colors",
        selected
          ? "bg-overlay-soft border-overlay before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r-[var(--radius-sm)] before:bg-accent-primary before:content-['']"
          : "border-transparent hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className="flex items-start gap-2.5 min-w-0 flex-1 py-2.5 pl-3 pr-1 text-left rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      >
        <Package
          className={cn(
            "w-4 h-4 shrink-0 mt-0.5",
            running ? "text-text-secondary" : "text-text-placeholder"
          )}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span
            className={cn(
              "text-sm font-medium flex items-center gap-1.5 flex-wrap",
              !running && "text-text-secondary"
            )}
          >
            <span className="truncate">{plugin.displayName}</span>
            {plugin.version && (
              <span className="text-2xs font-normal text-text-secondary">v{plugin.version}</span>
            )}
          </span>
          <span className="mt-0.5 block text-2xs text-text-secondary truncate font-mono">
            {plugin.id}
          </span>
          <span className="mt-1 flex items-center gap-1 flex-wrap">
            <span className={BADGE_CLASS}>Project</span>
            {plugin.state !== "active" && (
              <span className={BADGE_CLASS}>{STATE_BADGE[plugin.state]}</span>
            )}
            {plugin.collidesWithGlobal && (
              <span className="inline-flex items-center gap-0.5 text-3xs font-medium text-status-warning uppercase tracking-wide">
                <AlertCircle className="w-3 h-3" aria-hidden="true" />
                Id clash
              </span>
            )}
          </span>
        </span>
      </button>

      {plugin.state === "staged" && (
        <span className="shrink-0 pr-2.5">
          <Button variant="outline" size="xs" onClick={onActivate} loading={activating}>
            Activate
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * The project's own plugins, as a section at the head of the manager's master
 * list. Rendered above the category groups because a folder in the repository
 * the user just opened is the most local — and least expected — thing in the
 * list; burying it under "Utilities" would make its provenance the hardest fact
 * to find rather than the first.
 *
 * Purely reactive: `plugin:project-plugins-changed` pushes a full snapshot on
 * every open, trust change and activation, so nothing here refetches.
 */
export function ProjectPluginSection({
  plugins,
  selectedId,
  onSelect,
}: {
  plugins: readonly ProjectPluginInfo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const activating = useProjectPluginStore((s) => s.activating);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);

  if (plugins.length === 0) return null;

  return (
    <div role="presentation" className="space-y-1">
      {/* A disabled option, not a role="group" label — group labels drop under
          Chromium 146 + VoiceOver (LESSON #9006). Matches the category headers. */}
      <div
        className={SECTION_HEADER_CLASS}
        role="option"
        aria-disabled="true"
        aria-selected="false"
        aria-label="This project"
      >
        This project
        <span className="ml-1.5 normal-case tracking-normal text-text-placeholder">
          {plugins.length}
        </span>
      </div>
      {plugins.map((plugin) => (
        <ProjectPluginRow
          key={plugin.id}
          plugin={plugin}
          selected={plugin.id === selectedId}
          activating={activating.has(plugin.id)}
          onSelect={() => onSelect(plugin.id === selectedId ? null : plugin.id)}
          onActivate={() => void activateStaged(plugin.id)}
        />
      ))}
    </div>
  );
}

/**
 * Detail for one project plugin.
 *
 * The capability list here is a **disclosure**, and the caption says so. There
 * is no sandbox behind a project plugin, so a per-capability control would
 * claim an enforcement that does not exist — `docs/plugins/trust-model.md`
 * commits against exactly that. The only real control is the folder-level one
 * at the bottom, which is why it says what it actually does.
 */
export function ProjectPluginDetailPane({ plugin }: { plugin: ProjectPluginInfo }) {
  const trust = useProjectPluginStore((s) => s.trust);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const activating = useProjectPluginStore((s) => s.activating);
  const error = useProjectPluginStore((s) => s.error);
  const decide = useProjectPluginStore((s) => s.decide);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);

  const declared = new Set(plugin.capabilities);
  const granted = BUILT_IN_PLUGIN_CAPABILITIES.filter((c) => declared.has(c));
  const enabled = trust?.enabled === true;
  // The audience this pane serves is the one writing the plugin, so the log
  // buffer belongs here as much as on the installed-plugin pane (#12214). Keyed
  // by manifest id *and* owning project: the hook resolves the instance key the
  // plugin runs under, and another open project can ship the same manifest id.
  const logs = usePluginLogs(plugin.id, plugin.projectId);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-medium text-text-primary break-words">{plugin.displayName}</h3>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={BADGE_CLASS}>Project</span>
          {plugin.state !== "active" && (
            <span className={BADGE_CLASS}>{STATE_BADGE[plugin.state]}</span>
          )}
          {plugin.version && <span className={BADGE_CLASS}>v{plugin.version}</span>}
        </div>
        {plugin.description && (
          <p className="text-sm text-text-secondary break-words">{plugin.description}</p>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">Source</h4>
        <p className="font-mono text-2xs text-text-secondary break-all">
          .daintree/plugins/{plugin.dirName}
        </p>
        <p className="font-mono text-2xs text-text-secondary break-all">{plugin.id}</p>
      </div>

      {plugin.state === "invalid" && plugin.error && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-2xs text-status-danger break-words">{plugin.error}</p>
        </div>
      )}

      {plugin.collidesWithGlobal && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5" />
          <p className="text-2xs text-status-warning break-words">
            An installed plugin already uses this id. Both load — this one under the project — so
            check which one a command or panel came from.
          </p>
        </div>
      )}

      {granted.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
            Declared capabilities
          </h4>
          <p className="text-2xs text-text-secondary leading-relaxed">
            What the plugin says it uses. Daintree doesn&apos;t sandbox project plugins, so this is
            a description of intent, not a limit on it — the only control is turning the
            project&apos;s plugins off.
          </p>
          <ul className="space-y-1.5">
            {granted.map((capability) => (
              <CapabilityRow key={capability} capability={capability} />
            ))}
          </ul>
        </div>
      )}

      {logs.lines && logs.lines.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">Logs</h4>
          <PluginLogsSection {...logs} />
        </div>
      )}

      <div className="space-y-2 pt-2 border-t border-border-default">
        {plugin.state === "staged" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void activateStaged(plugin.id)}
              loading={activating.has(plugin.id)}
            >
              Activate plugin
            </Button>
            <p className="text-2xs text-text-secondary leading-relaxed">
              New to this project, so it was read but never run. Activating starts it now and on
              every future open.
            </p>
          </>
        ) : enabled ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void decide("disabled")}
              loading={deciding === "disabled"}
            >
              Turn off project plugins
            </Button>
            <p className="text-2xs text-text-secondary leading-relaxed">
              Unloads every plugin this project ships straight away, not just this one.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void decide("enabled")}
                loading={deciding === "enabled"}
              >
                Enable for this project
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void decide("session")}
                loading={deciding === "session"}
              >
                Enable for this session
              </Button>
            </div>
            <p className="text-2xs text-text-secondary leading-relaxed">
              Runs every plugin in this project&apos;s folder with your account. Daintree
              doesn&apos;t sandbox it.
            </p>
          </>
        )}
        {error && <p className="text-2xs text-status-danger leading-tight">{error}</p>}
      </div>
    </div>
  );
}
