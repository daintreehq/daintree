import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { TriangleAlert } from "lucide-react";
import { pluginAgentMcpClient } from "@/clients/pluginAgentMcpClient";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { logError } from "@/utils/logger";
import type {
  AgentMcpAccess,
  ProjectAgentToolPlugin,
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

interface FailedWrite {
  plugin: ProjectAgentToolPlugin;
  payload: SetProjectAgentToolAccessPayload;
}

function originLabel(plugin: ProjectAgentToolPlugin): string {
  return plugin.origin === "project" ? "Project" : "Installed";
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
  if (!plugin.pluginTools) {
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

/** What the plugin offers, then where its current access comes from. */
function PluginDescription({ plugin }: { plugin: ProjectAgentToolPlugin }) {
  const lines: string[] = [];
  if (plugin.hasDatabases && plugin.pluginTools) {
    lines.push(
      `Read only lets agents query its databases; read and write adds ${plugin.pluginTools.name}`
    );
  } else if (plugin.pluginTools) {
    lines.push(plugin.pluginTools.name);
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

/**
 * How much of each plugin's agent tools this project's agents may use: off,
 * read only (the host's tools for the plugin's databases) or read and write
 * (the plugin's own tools as well). An installed plugin's choice can be made
 * the default for every project, which a project's own choice still overrides.
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
              plugin.access !== plugin.allProjectsAccess;
            // A default left on for a plugin that went away would apply in every
            // project the moment it came back, so it stays clearable from here.
            const canClearDefault =
              plugin.allProjectsAccess !== undefined &&
              plugin.allProjectsAccess !== "off" &&
              !plugin.available;
            return (
              <div key={key} data-testid="project-agent-tool-row">
                <SettingsRow
                  label={plugin.pluginDisplayName}
                  labelText={plugin.pluginDisplayName}
                  accessory={<Badge size="xs">{origin}</Badge>}
                  description={
                    <>
                      <PluginDescription plugin={plugin} />
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
                  control={({ descriptionId }) => (
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
                      aria-label={`Agent access to ${plugin.pluginDisplayName} (${origin.toLowerCase()})`}
                      aria-describedby={descriptionId}
                    />
                  )}
                />
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
      </SettingsSection>
    </div>
  );
}
