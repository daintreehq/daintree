import { AlertCircle, Package, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { PluginLogsSection, usePluginLogs } from "@/components/Plugin/PluginLogsSection";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PluginGlyphTile } from "@/components/Plugin/pluginIcons";
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
 *
 * `Error` is its own signal rather than a fourth state badge: a plugin that
 * loaded and then threw is still loaded, still holds its contributions, and is
 * still what the folder ships — the failure is a fact about the last run, not a
 * different kind of row. It stays that generic because the channel behind it
 * carries a manifest command that could not be registered as well as an
 * activation that threw, and only some of those mean "it never started".
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
  const failed = plugin.loadError !== undefined;

  return (
    <li
      data-selected={selected ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "flex items-center gap-2 rounded-[var(--radius-md)] text-text-primary",
        !selected && "hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        title={plugin.version ? `${plugin.displayName} v${plugin.version}` : plugin.displayName}
        className="row-select-target flex items-center gap-2.5 min-w-0 flex-1 py-2 pl-3 pr-1 text-left rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary forced-colors:border-none"
      >
        {/* The same tile and the same two lines as an installed row, so the
            project section reads as part of one list rather than a second
            layout grafted on top of it. */}
        <PluginGlyphTile icon={Package} size="sm" dimmed={!running || failed} />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block text-sm font-medium truncate", !running && "text-text-secondary")}
          >
            {plugin.displayName}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 min-w-0 h-[1.125rem]">
            {failed || plugin.collidesWithGlobal ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 min-w-0 flex-1 text-2xs font-medium",
                  failed ? "text-status-danger" : "text-status-warning"
                )}
              >
                <AlertCircle className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{failed ? "Error" : "Id clash"}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary font-mono">
                {plugin.id}
              </span>
            )}
            {plugin.state !== "active" && (
              <span className={cn(BADGE_CLASS, "shrink-0")}>{STATE_BADGE[plugin.state]}</span>
            )}
            <span className={cn(BADGE_CLASS, "shrink-0")}>Project</span>
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
    </li>
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
    <section aria-labelledby="plugin-category-this-project" className="space-y-1">
      {/* A real heading over a real list. The old disabled-option header only
          existed because this lived inside a listbox, where a role="group" label
          drops under Chromium 146 + VoiceOver (LESSON #9006). */}
      <h3 id="plugin-category-this-project" className={SECTION_HEADER_CLASS}>
        This project{" "}
        <span className="ml-1.5 normal-case tracking-normal text-text-secondary">
          {plugins.length}
        </span>
      </h3>
      <ul role="list" className="space-y-1">
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
      </ul>
    </section>
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
  const reloading = useProjectPluginStore((s) => s.reloading);
  const error = useProjectPluginStore((s) => s.error);
  const decide = useProjectPluginStore((s) => s.decide);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);
  const reload = useProjectPluginStore((s) => s.reload);

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
      {/* The installed-plugin header's shape — tile, name, version as text —
          so switching between the two kinds of detail doesn't change the
          page's anatomy. The version was an uppercase badge here ("V0.1.0"). */}
      <div className="flex items-start gap-3.5 min-w-0">
        <PluginGlyphTile icon={Package} size="lg" dimmed={plugin.state !== "active"} />
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-base font-medium text-text-primary break-words">
              {plugin.displayName}
            </h3>
            {plugin.version && (
              <span className="text-xs font-normal text-text-secondary">v{plugin.version}</span>
            )}
            <span className={BADGE_CLASS}>Project</span>
            {plugin.state !== "active" && (
              <span className={BADGE_CLASS}>{STATE_BADGE[plugin.state]}</span>
            )}
            {plugin.loadError && (
              <span className="inline-flex items-center gap-0.5 text-3xs font-medium text-status-danger uppercase tracking-wide">
                <AlertCircle className="w-3 h-3" aria-hidden="true" />
                Error
              </span>
            )}
          </div>
          {plugin.description && (
            <p className="text-sm text-text-secondary break-words">{plugin.description}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">Source</h4>
        <p className="font-mono text-2xs text-text-secondary break-all">
          .daintree/plugins/{plugin.dirName}
        </p>
        {/* Labelled: two bare mono lines read as one path repeated. */}
        <p className="text-2xs text-text-secondary break-all">
          Plugin id <span className="font-mono">{plugin.id}</span>
        </p>
      </div>

      {plugin.state === "invalid" && plugin.error && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-2xs text-status-danger break-words">{plugin.error}</p>
        </div>
      )}

      {/* The plugin loaded; running it is what went wrong. Same treatment as an
          unreadable manifest above — both are the folder not working — and the
          two can never appear together, since a manifest that failed discovery
          never loads. The cause carries itself: prefixing it would have to name
          a phase the channel doesn't record. The stack stays out of the manager;
          the panel's own error boundary is where a developer reads it. */}
      {plugin.loadError && (
        <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
          <p className="text-2xs text-status-danger break-words">{plugin.loadError.message}</p>
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
        {/* Re-reads `.daintree/plugins/` in place. `plugin:project-reload` and
            the store action behind it both shipped unwired, so switching
            projects and back was the only reload the UI offered (#12212). It
            sits above the trust controls because it is the one thing here that
            is useful whatever the folder's state — including "unreadable",
            where fixing the manifest and reloading is the whole loop. */}
        <Button variant="outline" size="sm" onClick={() => void reload()} loading={reloading}>
          <RefreshCw />
          Reload from folder
        </Button>

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
        ) : (
          // Folder-wide, and headed as such. These sat directly under one
          // plugin's name, so "Enable for this project" read as enabling this
          // plugin — the scope lived only in the small print below the buttons.
          <div className="space-y-2 pt-2">
            <h4 className="text-2xs font-medium uppercase tracking-wide text-text-secondary">
              All plugins in this project
            </h4>
            {enabled ? (
              <>
                <p className="text-2xs text-text-secondary leading-relaxed">
                  Turning them off unloads every plugin this project ships straight away, not just
                  this one.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void decide("disabled")}
                  loading={deciding === "disabled"}
                >
                  Turn off project plugins
                </Button>
              </>
            ) : (
              <>
                <p className="text-2xs text-text-secondary leading-relaxed">
                  Enabling runs every plugin in this project&apos;s folder with your account.
                  Daintree doesn&apos;t sandbox them.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide("enabled")}
                    loading={deciding === "enabled"}
                  >
                    Enable project plugins
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide("session")}
                    loading={deciding === "session"}
                  >
                    Enable for this session only
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {error && <p className="text-2xs text-status-danger leading-tight">{error}</p>}
      </div>
    </div>
  );
}
