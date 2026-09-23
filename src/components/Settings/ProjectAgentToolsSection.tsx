import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { TriangleAlert } from "lucide-react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { pluginAgentMcpClient } from "@/clients/pluginAgentMcpClient";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { logError } from "@/utils/logger";
import { PROJECT_PLUGIN_INSTANCE_PREFIX } from "@shared/types/plugin";
import type {
  ProjectAgentToolEndpoint,
  ProjectAgentToolsSnapshot,
} from "@shared/types/ipc/pluginAgentMcp";

const AGENT_TOOLS_DESCRIPTION =
  "Which plugin tools Claude agents in this project may call. Turning one on applies to agents started from now on; turning it off also cuts off agents already running.";

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

interface FailedToggle {
  endpoint: ProjectAgentToolEndpoint;
  enabled: boolean;
}

function rowKey(endpoint: Pick<ProjectAgentToolEndpoint, "pluginInstanceId" | "endpointId">) {
  return JSON.stringify([endpoint.pluginInstanceId, endpoint.endpointId]);
}

/**
 * A project may ship a plugin with the same manifest as an installed one; the
 * two are separate consent targets, so every row says which copy it is.
 */
function originLabel(endpoint: ProjectAgentToolEndpoint): string {
  return endpoint.pluginInstanceId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)
    ? "Project"
    : "Installed";
}

/**
 * Which plugin agent tools this project's agents may use.
 *
 * Enabling a plugin never exposes its tools to agents by itself; this is the
 * separate, per-project, revocable answer. Rendered only when some running
 * plugin offers an endpoint here, or an answer is still on record for one that
 * no longer does — the same "only when there is something to decide" rule the
 * empty-canvas section follows.
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
  const [failed, setFailed] = useState<FailedToggle | null>(null);
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
      .listProjectEndpoints()
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
    if (typeof events?.on === "function") {
      unsubscribers.push(events.on("plugin:runtime-status-changed", refresh));
    }
    const mcpServer = window.electron.mcpServer;
    if (typeof mcpServer?.onRuntimeStateChanged === "function") {
      unsubscribers.push(mcpServer.onRuntimeStateChanged(refresh));
    }
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [refresh, projectPlugins]);

  const setEnabled = async (endpoint: ProjectAgentToolEndpoint, enabled: boolean) => {
    const key = rowKey(endpoint);
    setFailed(null);
    setPending((prev) => new Set(prev).add(key));
    if (writesInFlight.current > 0) writesOverlapped.current = true;
    writesInFlight.current += 1;
    let succeeded = false;
    try {
      const next = await pluginAgentMcpClient.setProjectEndpointEnabled({
        pluginInstanceId: endpoint.pluginInstanceId,
        endpointId: endpoint.endpointId,
        enabled,
      });
      // Main answered after committing, so this beats any list that was sent
      // before the write finished — that one may have read the old answer.
      applied.current = ++issued.current;
      setSnapshot(next);
      setLoadFailed(false);
      succeeded = true;
    } catch (err) {
      logError("Failed to change plugin agent tool access", err);
      setFailed({ endpoint, enabled });
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
    if (failed !== null) void setEnabled(failed.endpoint, failed.enabled);
  };

  // With nothing on screen yet — or an earlier answer that had nothing to show —
  // a failed read is the whole section, so say so rather than render nothing.
  if (loadFailed && (snapshot === null || snapshot.endpoints.length === 0)) {
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

  if (snapshot === null || snapshot.endpoints.length === 0) return null;

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
          {snapshot.endpoints.map((endpoint) => {
            const key = rowKey(endpoint);
            const origin = originLabel(endpoint);
            return (
              <div key={key} data-testid="project-agent-tool-row">
                <SettingsRow
                  label={endpoint.pluginDisplayName}
                  labelText={endpoint.pluginDisplayName}
                  accessory={<Badge size="xs">{origin}</Badge>}
                  description={
                    <>
                      <span className="block">{endpoint.name}</span>
                      {endpoint.description && (
                        <span className="block">{endpoint.description}</span>
                      )}
                      {!endpoint.available && (
                        <span className="block">
                          {endpoint.enabled
                            ? "Not offered here right now. Still allowed, so it applies again if the plugin comes back."
                            : "Not offered here right now"}
                        </span>
                      )}
                    </>
                  }
                  control={({ descriptionId }) => (
                    <SettingsSwitch
                      className="shrink-0"
                      checked={endpoint.enabled}
                      disabled={pending.has(key) || (!endpoint.available && !endpoint.enabled)}
                      onCheckedChange={(next) => void setEnabled(endpoint, next)}
                      aria-label={`Let agents use ${endpoint.name} from ${endpoint.pluginDisplayName} (${origin.toLowerCase()})`}
                      aria-describedby={descriptionId}
                      data-testid="project-agent-tool-switch"
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
              message={`Couldn't change access to ${failed.endpoint.name}`}
              onRetry={retryFailed}
            />
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
