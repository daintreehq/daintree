import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { TriangleAlert } from "lucide-react";
import { pluginAgentMcpClient } from "@/clients/pluginAgentMcpClient";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import type {
  AgentMcpAccess,
  ProjectAgentToolGroup,
  ProjectAgentToolPlugin,
  AgentToolsRelaunchSession,
  ProjectAgentToolsSnapshot,
  SetProjectAgentToolAccessPayload,
} from "@shared/types/ipc/pluginAgentMcp";

const AGENT_TOOLS_DESCRIPTION =
  "How much of each plugin's tools agents in this project may use. More access applies to agents started from now on; less also cuts off agents already running.";

const ACCESS_LABELS: Record<AgentMcpAccess, string> = {
  off: "Off",
  "read-only": "Read only",
  "read-write": "Read and write",
};

/** How long a run of runtime-status pushes is gathered into one snapshot read. */
const STATUS_BURST_COALESCE_MS = 50;

function openMcpSettings() {
  window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail: { tab: "mcp" } }));
}

/** A failure line inside the group: severity on the glyph, the words in body text. */
function FailureRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <p role="alert" className="flex items-start gap-1.5 text-xs text-text-secondary">
        <TriangleAlert
          className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
          aria-hidden="true"
        />
        <span>{message}</span>
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Running agents whose tools changed since they started, each with a restart:
 * more access, or a plugin that came back with different tools, only reaches
 * an agent when it is launched again. Agents this window doesn't show are left
 * to the window that does.
 */
function RelaunchNeededGroup({
  sessions,
  onRestarted,
}: {
  sessions: readonly AgentToolsRelaunchSession[];
  onRestarted: () => void;
}) {
  // Read through the accessor, not the panel store: settings stay off the
  // store's import graph. Read as the snapshot arrives, which is when the
  // list changes.
  const panelsById = getPanelStoreSnapshot()?.panelsById ?? {};
  const shown = sessions.flatMap((session) => {
    const panel = panelsById[session.terminalId];
    return panel === undefined ? [] : [{ session, title: panel.title || "Agent" }];
  });
  if (shown.length === 0) return null;
  return (
    <SettingsGroup
      label="Agents that need a restart"
      rootAttributes={{ "data-testid": "project-agent-tools-relaunch" }}
    >
      {shown.map(({ session, title }) => (
        <SettingsRow
          key={session.terminalId}
          label={title}
          description={`Started before its tools from ${session.pluginDisplayNames.join(", ")} changed, so it only gets them once restarted`}
          control={
            <Button
              variant="outline"
              size="sm"
              // The action's own confirm guards interrupting a running agent.
              onClick={() =>
                void actionService
                  .dispatch(
                    "terminal.restart",
                    { terminalId: session.terminalId },
                    { source: "user" }
                  )
                  .then(onRestarted)
              }
            >
              Restart
            </Button>
          }
        />
      ))}
    </SettingsGroup>
  );
}

interface FailedWrite {
  plugin: ProjectAgentToolPlugin;
  payload: SetProjectAgentToolAccessPayload;
}

function originLabel(plugin: ProjectAgentToolPlugin): string {
  return plugin.origin === "project" ? "Project" : "Installed";
}

/**
 * The plugin's own tools when a level reaches them. A plugin whose tools come
 * in groups has none: each group is allowed on its own instead.
 */
function levelTools(plugin: ProjectAgentToolPlugin): ProjectAgentToolPlugin["pluginTools"] {
  return plugin.toolGroups === undefined ? plugin.pluginTools : undefined;
}

/** Whether a level control means anything: a grouped plugin with no databases has nothing for one. */
function hasLevel(plugin: ProjectAgentToolPlugin): boolean {
  return plugin.toolGroups === undefined || plugin.hasDatabases;
}

/** Whether this project's agents may use anything of the plugin: a level above off, or a group. */
function agentsHaveAccess(plugin: ProjectAgentToolPlugin): boolean {
  return plugin.access !== "off" || (plugin.toolGroups ?? []).some((group) => group.allowed);
}

/** The ids of the groups allowed, with one switched on or off. */
function withGroup(
  groups: readonly ProjectAgentToolGroup[],
  key: "allowed" | "assistantAllowed",
  groupId: string,
  on: boolean
): string[] {
  const ids = groups.filter((group) => group[key]).map((group) => group.id);
  return on ? [...new Set([...ids, groupId])] : ids.filter((id) => id !== groupId);
}

function groupDescription(group: ProjectAgentToolGroup): string[] {
  const lines = group.description ? [group.description] : [];
  lines.push(
    group.access === "read"
      ? "The plugin says these tools read and search; your agent still asks before using them"
      : "The plugin says these tools make changes"
  );
  if (group.reclassified) {
    lines.push(
      "The plugin changed what it says these tools do, so they stay off until allowed again"
    );
  }
  return lines;
}

/** Only the levels that mean something for what the plugin offers. */
function accessOptions(plugin: ProjectAgentToolPlugin): SegmentedRadioOption<AgentMcpAccess>[] {
  if (!plugin.available) {
    // Nothing new can be allowed until the plugin offers tools again.
    return plugin.access === "off"
      ? [{ value: "off", label: ACCESS_LABELS.off }]
      : [
          { value: "off", label: ACCESS_LABELS.off },
          { value: plugin.access, label: ACCESS_LABELS[plugin.access] },
        ];
  }
  if (!levelTools(plugin) && !plugin.hasDatabaseWrites) {
    return [
      { value: "off", label: ACCESS_LABELS.off },
      { value: "read-only", label: ACCESS_LABELS["read-only"] },
    ];
  }
  if (!plugin.hasDatabases) {
    return [
      { value: "off", label: ACCESS_LABELS.off },
      { value: "read-write", label: "On" },
    ];
  }
  return (["off", "read-only", "read-write"] as const).map((value) => ({
    value,
    label: ACCESS_LABELS[value],
  }));
}

function levelName(plugin: ProjectAgentToolPlugin, access: AgentMcpAccess): string {
  if (access === "read-write" && !plugin.hasDatabases) return "on";
  return ACCESS_LABELS[access].toLowerCase();
}

/**
 * Whether a level that includes an installed plugin's shared database tools is
 * on offer, for this project or as the default for every project. A plugin
 * that is gone offers nothing new, so only access it still holds counts.
 */
function offersSharedDatabases(plugin: ProjectAgentToolPlugin): boolean {
  if (!plugin.sharedAcrossProjects) return false;
  if (plugin.available) return true;
  return (
    plugin.access !== "off" ||
    (plugin.allProjectsAccess !== undefined && plugin.allProjectsAccess !== "off")
  );
}

/** What the plugin offers, then where its current access comes from. */
function PluginDescription({ plugin }: { plugin: ProjectAgentToolPlugin }) {
  const lines: string[] = [];
  const pluginTools = levelTools(plugin);
  if (plugin.toolGroups !== undefined && plugin.pluginTools) {
    lines.push(
      plugin.hasDatabaseWrites
        ? `Read only lets agents query its databases; read and write adds the changes it declares. ${plugin.pluginTools.name} is allowed one group at a time`
        : plugin.hasDatabases
          ? `Read only lets agents query its databases. ${plugin.pluginTools.name} is allowed one group at a time`
          : `${plugin.pluginTools.name}, allowed one group at a time`
    );
  } else if (plugin.hasDatabaseWrites && pluginTools) {
    lines.push(
      `Read only lets agents query its databases; read and write adds the changes it declares and ${pluginTools.name}`
    );
  } else if (plugin.hasDatabaseWrites) {
    lines.push(
      "Read only lets agents query its databases; read and write adds the changes it declares"
    );
  } else if (plugin.hasDatabases && pluginTools) {
    lines.push(
      `Read only lets agents query its databases; read and write adds ${pluginTools.name}`
    );
  } else if (pluginTools) {
    lines.push(pluginTools.name);
  } else {
    lines.push("Lets agents query its databases, read only");
  }
  if (plugin.pluginTools?.description) lines.push(plugin.pluginTools.description);

  const allProjects = plugin.allProjectsAccess;
  if (allProjects !== undefined) {
    if (plugin.source === "project") {
      lines.push(
        `Set for this project; every other project follows your default (${levelName(plugin, allProjects)})`
      );
    } else if (plugin.source === "all-projects") {
      lines.push("Your default for every project");
    }
  }
  if (plugin.repositoryAccess !== undefined) {
    lines.push(
      plugin.source === "repository"
        ? "Set by this project's .daintree/mcp.json"
        : `This project's .daintree/mcp.json sets ${levelName(plugin, plugin.repositoryAccess)}; your choice here overrides it`
    );
  }
  if (plugin.databasesWithheld) {
    lines.push("Its database tools stay off, from a choice made before these levels existed");
  }
  if (plugin.writesWithheld) {
    lines.push("The changes it declares stay off, from a choice made before these levels existed");
  }
  if (!plugin.available) {
    lines.push(
      plugin.access !== "off"
        ? "Not offered here right now. Still allowed, so it applies again if the plugin comes back."
        : "Not offered here right now"
    );
  }
  return (
    <>
      {lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </>
  );
}

/** The plugin has something only read and write reaches: its own ungrouped tools, or the changes it declares. */
function offersChanges(plugin: ProjectAgentToolPlugin): boolean {
  return levelTools(plugin) !== undefined || plugin.hasDatabaseWrites === true;
}

/** What allowing changes adds for the Assistant, named the way the plugin's row names it. */
function changesDescription(plugin: ProjectAgentToolPlugin): string {
  const pluginTools = levelTools(plugin);
  if (pluginTools && plugin.hasDatabaseWrites) {
    return `Adds the changes it declares and ${pluginTools.name}`;
  }
  if (pluginTools) return `Adds ${pluginTools.name}`;
  return "Adds the changes it declares";
}

/**
 * One switch per group of the plugin's own tools, under the plugin's row: on
 * for the groups this project's agents may use. A group that is on stays
 * switchable off whatever happens to the plugin.
 */
function ToolGroupRows({
  plugin,
  busy,
  onChange,
}: {
  plugin: ProjectAgentToolPlugin;
  busy: boolean;
  onChange: (groups: string[]) => void;
}) {
  const groups = plugin.toolGroups ?? [];
  return (
    <SettingsDependents>
      {groups.map((group) => (
        <SettingsRow
          key={group.id}
          label={group.name}
          description={
            <>
              {groupDescription(group).map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </>
          }
          disabled={busy || (!plugin.available && !group.allowed)}
          control={({ labelId, descriptionId, disabled }) => (
            <SettingsSwitch
              checked={group.allowed}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(withGroup(groups, "allowed", group.id, checked))
              }
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              data-testid={`project-agent-tool-group-${group.id}`}
            />
          )}
        />
      ))}
    </SettingsDependents>
  );
}

/**
 * Whether this project's Daintree Assistant may use the plugin's tools: a
 * switch that starts it at read only, and under it a second, separate choice
 * for the tools that change things. Neither goes past what the project's
 * agents have, and an answer that is on stays switchable off whatever happens
 * to the agents' access or the plugin.
 */
function AssistantAccessRows({
  plugin,
  busy,
  onChange,
}: {
  plugin: ProjectAgentToolPlugin;
  busy: boolean;
  onChange: (access: AgentMcpAccess, groups?: string[]) => void;
}) {
  const on = plugin.assistantAccess !== "off";
  const changesOn = plugin.assistantAccess === "read-write";
  const groups = plugin.toolGroups ?? [];
  const blocked = !plugin.available
    ? "Not offered here right now"
    : !agentsHaveAccess(plugin)
      ? "Agents in this project have no access to it, and the Assistant never gets more than they do"
      : null;
  const changesBlocked = changesOn
    ? null
    : !on
      ? "Let the Assistant use its tools first"
      : (blocked ??
        (plugin.access !== "read-write"
          ? "Agents in this project can only read it, and the Assistant never gets more than they do"
          : null));

  const lines = [
    "Read only to start. What its tools return reaches an Assistant that can act across this project, so the plugin's data could steer what it does.",
  ];
  if (groups.length > 0) {
    lines.push(
      "Of the plugin's own tools it gets only the groups allowed for it, never one just because the plugin says it reads."
    );
  } else if (!plugin.hasDatabases && offersChanges(plugin)) {
    lines.push(
      "It has no read-only tools, so the Assistant reaches nothing here until changes are allowed."
    );
  }
  if (on && !agentsHaveAccess(plugin)) {
    lines.push("Agents here have no access to it now, so the Assistant has none either.");
  }

  return (
    <SettingsDependents disabled={!on && blocked !== null} reason={blocked ?? undefined}>
      <SettingsRow
        label="Daintree Assistant can use this plugin's tools"
        description={
          <>
            {lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </>
        }
        disabled={busy}
        control={({ labelId, descriptionId, disabled }) => (
          <SettingsSwitch
            checked={on}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked ? "read-only" : "off")}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid="project-agent-tool-assistant"
          />
        )}
      />
      {groups.map((group) => {
        const groupBlocked = group.assistantAllowed
          ? null
          : !on
            ? "Let the Assistant use its tools first"
            : (blocked ??
              (group.allowed ? null : "Allow this group for agents in this project first"));
        return (
          <SettingsDependents
            key={group.id}
            disabled={groupBlocked !== null}
            reason={groupBlocked ?? undefined}
          >
            <SettingsRow
              label={`Assistant can use ${group.name}`}
              description={
                group.access === "read"
                  ? "Tools the plugin says read and search"
                  : "Tools the plugin says make changes"
              }
              disabled={busy}
              control={({ labelId, descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={group.assistantAllowed}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(
                      plugin.assistantAccess,
                      withGroup(groups, "assistantAllowed", group.id, checked)
                    )
                  }
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  data-testid={`project-agent-tool-assistant-group-${group.id}`}
                />
              )}
            />
          </SettingsDependents>
        );
      })}
      {offersChanges(plugin) && (
        <SettingsDependents disabled={changesBlocked !== null} reason={changesBlocked ?? undefined}>
          <SettingsRow
            label="Allow tools that change things"
            description={changesDescription(plugin)}
            disabled={busy}
            control={({ labelId, descriptionId, disabled }) => (
              <SettingsSwitch
                checked={changesOn}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(checked ? "read-write" : "read-only")}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                data-testid="project-agent-tool-assistant-changes"
              />
            )}
          />
        </SettingsDependents>
      )}
    </SettingsDependents>
  );
}

/**
 * How much of each plugin's agent tools this project's agents may use: off,
 * read only (the host's tools for the plugin's databases) or read and write
 * (the writes it declares and the plugin's own tools as well). An installed plugin's choice can be made
 * the default for every project, which a project's own choice still overrides.
 * Under each, whether the project's Daintree Assistant may use them too.
 *
 * Enabling a plugin never exposes its tools to agents by itself; this is the
 * separate, revocable answer. Rendered only when some running plugin offers
 * tools here, or an answer is still on record for one that no longer does —
 * the same "only when there is something to decide" rule the empty-canvas
 * section follows.
 *
 * The list is a function of which plugin instances are running and of the MCP
 * listener, so it is re-read on every signal that can move either: provenance
 * (install, uninstall, enable), the project-plugin snapshot, runtime status
 * (dev reloads, stops), the listener's state, and window focus — the last
 * because another window may show this project and change the answer there.
 */
export function ProjectAgentToolsSection() {
  const projectPlugins = useProjectPluginStore((s) => s.plugins);
  const [snapshot, setSnapshot] = useState<ProjectAgentToolsSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<FailedWrite | null>(null);
  // Every request takes a number; a response lands only if nothing newer has
  // landed yet. A failed request lands nothing, so it never blocks an older
  // success.
  const issued = useRef(0);
  const applied = useRef(0);
  const writesInFlight = useRef(0);
  const writesOverlapped = useRef(false);

  const refresh = useCallback(() => {
    const seq = ++issued.current;
    pluginAgentMcpClient
      .listProjectPlugins()
      .then((next) => {
        if (seq <= applied.current) return;
        applied.current = seq;
        setSnapshot(next);
        setLoadFailed(false);
      })
      .catch((err: unknown) => {
        logError("Failed to load plugin agent tools for the project", err);
        if (seq > applied.current) setLoadFailed(true);
      });
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribers = [window.electron.plugin.onProvenanceChanged(refresh)];
    const events = window.electron.events;
    // Status changes arrive in bursts — every unload emits one, so revoking a
    // folder sends one per plugin — and each refresh is a full snapshot read.
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof events?.on === "function") {
      unsubscribers.push(
        events.on("plugin:runtime-status-changed", () => {
          clearTimeout(statusTimer);
          statusTimer = setTimeout(refresh, STATUS_BURST_COALESCE_MS);
        })
      );
    }
    const mcpServer = window.electron.mcpServer;
    if (typeof mcpServer?.onRuntimeStateChanged === "function") {
      unsubscribers.push(mcpServer.onRuntimeStateChanged(refresh));
    }
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(statusTimer);
      window.removeEventListener("focus", refresh);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [refresh, projectPlugins]);

  const setAccess = async (
    plugin: ProjectAgentToolPlugin,
    payload: SetProjectAgentToolAccessPayload
  ) => {
    const key = plugin.pluginInstanceId;
    setFailed(null);
    setPending((prev) => new Set(prev).add(key));
    if (writesInFlight.current > 0) writesOverlapped.current = true;
    writesInFlight.current += 1;
    let succeeded = false;
    try {
      const next = await pluginAgentMcpClient.setPluginAccess(payload);
      // Main answered after committing, so this beats any list that was sent
      // before the write finished — that one may have read the old answer.
      applied.current = ++issued.current;
      setSnapshot(next);
      setLoadFailed(false);
      succeeded = true;
    } catch (err) {
      logError("Failed to change plugin agent tool access", err);
      setFailed({ plugin, payload });
    }
    // After the try/catch rather than in a `finally`: neither branch leaves
    // early, and the React Compiler bails out on a `finally` block.
    writesInFlight.current -= 1;
    setPending((prev) => {
      const out = new Set(prev);
      out.delete(key);
      return out;
    });
    // Overlapping writes can answer out of order, and a failed one may mean the
    // plugin went away underneath the click. Once the last write settles, one
    // fresh read is the truth.
    if (writesInFlight.current === 0) {
      if (!succeeded || writesOverlapped.current) refresh();
      writesOverlapped.current = false;
    }
  };

  const retryFailed = () => {
    if (failed !== null) void setAccess(failed.plugin, failed.payload);
  };

  // With nothing on screen yet — or an earlier answer that had nothing to show —
  // a failed read is the whole section, so say so rather than render nothing.
  if (loadFailed && (snapshot === null || snapshot.plugins.length === 0)) {
    return (
      <div data-testid="project-agent-tools">
        <SettingsSection title="Agent tools" description={AGENT_TOOLS_DESCRIPTION}>
          <SettingsGroup>
            <FailureRow
              message="Couldn't load which plugin tools agents can use here"
              onRetry={refresh}
            />
          </SettingsGroup>
        </SettingsSection>
      </div>
    );
  }

  if (snapshot === null || snapshot.plugins.length === 0) return null;

  return (
    <div data-testid="project-agent-tools">
      <SettingsSection title="Agent tools" description={AGENT_TOOLS_DESCRIPTION}>
        <SettingsGroup>
          {/* The prerequisite sits first in the group it gates, with the way to fix it,
              rather than as a loose paragraph above switches that look live. */}
          {!snapshot.mcpServerEnabled && (
            <SettingsRow
              label="MCP server is off"
              description="Agents reach these tools through Daintree's MCP server, which is off, so the choices below take effect once it's on"
              control={
                <Button variant="outline" size="sm" onClick={openMcpSettings}>
                  Open MCP settings
                </Button>
              }
            />
          )}
          {snapshot.plugins.map((plugin) => {
            const key = plugin.pluginInstanceId;
            const origin = originLabel(plugin);
            const busy = pending.has(key);
            const canSetDefault =
              plugin.allProjectsAccess !== undefined &&
              plugin.available &&
              (plugin.access !== plugin.allProjectsAccess ||
                (plugin.source === "project" &&
                  (plugin.toolGroups ?? []).some((group) => group.allowed)));
            // A default left on for a plugin that went away would apply in every
            // project the moment it came back, so it stays clearable from here.
            const canClearDefault =
              plugin.allProjectsAccess !== undefined &&
              plugin.allProjectsAccess !== "off" &&
              !plugin.available;
            return (
              <div
                key={key}
                data-testid="project-agent-tool-row"
                className="divide-y divide-border-subtle"
              >
                <SettingsRow
                  label={plugin.pluginDisplayName}
                  labelText={plugin.pluginDisplayName}
                  accessory={<Badge size="xs">{origin}</Badge>}
                  description={
                    <>
                      <PluginDescription plugin={plugin} />
                      {offersSharedDatabases(plugin) && (
                        <span
                          className="flex items-start gap-1.5"
                          data-testid="project-agent-tool-shared-warning"
                        >
                          <TriangleAlert
                            className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
                            aria-hidden="true"
                          />
                          <span>
                            {plugin.hasDatabaseWrites
                              ? "Shared by every project: agents with access to its databases can read, and with read and write change, what this plugin stored for your other projects"
                              : "Shared by every project: agents with access to its databases can read what this plugin stored for your other projects"}
                          </span>
                        </span>
                      )}
                      {canSetDefault && (
                        <span className="mt-1.5 block">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void setAccess(plugin, {
                                pluginInstanceId: key,
                                access: plugin.access,
                                scope: "all-projects",
                              })
                            }
                            data-testid="project-agent-tool-set-default"
                          >
                            Use in all projects
                          </Button>
                        </span>
                      )}
                      {canClearDefault && (
                        <span className="mt-1.5 block">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void setAccess(plugin, {
                                pluginInstanceId: key,
                                access: null,
                                scope: "all-projects",
                              })
                            }
                            data-testid="project-agent-tool-clear-default"
                          >
                            Clear default for all projects
                          </Button>
                        </span>
                      )}
                    </>
                  }
                  isModified={plugin.source === "project" && !busy}
                  onReset={() =>
                    void setAccess(plugin, {
                      pluginInstanceId: key,
                      access: null,
                      scope: "project",
                    })
                  }
                  resetAriaLabel={`Use the default access for ${plugin.pluginDisplayName}`}
                  control={
                    hasLevel(plugin)
                      ? ({ descriptionId }) => (
                          <SegmentedRadioGroup
                            className="shrink-0"
                            options={accessOptions(plugin)}
                            value={plugin.access}
                            disabled={busy}
                            onChange={(access) =>
                              void setAccess(plugin, {
                                pluginInstanceId: key,
                                access,
                                scope: "project",
                              })
                            }
                            aria-label={
                              plugin.toolGroups !== undefined
                                ? `Agent access to ${plugin.pluginDisplayName}'s databases (${origin.toLowerCase()})`
                                : `Agent access to ${plugin.pluginDisplayName} (${origin.toLowerCase()})`
                            }
                            aria-describedby={descriptionId}
                          />
                        )
                      : undefined
                  }
                />
                {plugin.toolGroups !== undefined && plugin.toolGroups.length > 0 && (
                  <ToolGroupRows
                    plugin={plugin}
                    busy={busy}
                    onChange={(groups) =>
                      void setAccess(plugin, {
                        pluginInstanceId: key,
                        access: plugin.access,
                        scope: "project",
                        groups,
                      })
                    }
                  />
                )}
                {(plugin.available || plugin.assistantAccess !== "off") && (
                  <AssistantAccessRows
                    plugin={plugin}
                    busy={busy}
                    onChange={(access, groups) =>
                      void setAccess(plugin, {
                        pluginInstanceId: key,
                        access,
                        scope: "assistant",
                        ...(groups !== undefined ? { groups } : {}),
                      })
                    }
                  />
                )}
              </div>
            );
          })}
          {loadFailed && (
            <FailureRow
              message="Couldn't refresh this list, so it may be out of date"
              onRetry={refresh}
            />
          )}
          {failed !== null && (
            <FailureRow
              message={`Couldn't change access to ${failed.plugin.pluginDisplayName}`}
              onRetry={retryFailed}
            />
          )}
        </SettingsGroup>
        <RelaunchNeededGroup sessions={snapshot.relaunchNeeded ?? []} onRestarted={refresh} />
      </SettingsSection>
    </div>
  );
}
