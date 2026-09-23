import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
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
  "Tools plugins offer to agents. Turning one on lets Claude agents you start in this project from now on call that plugin's tools. Turning it off cuts off agents that are already running straight away.";

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
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p role="alert" className="text-xs text-status-error">
                Couldn&apos;t load which plugin tools agents can use here.
              </p>
              <Button variant="outline" size="xs" onClick={refresh}>
                Retry
              </Button>
            </div>
          </SettingsGroup>
        </SettingsSection>
      </div>
    );
  }

  if (snapshot === null || snapshot.endpoints.length === 0) return null;

  return (
    <div data-testid="project-agent-tools">
      <SettingsSection title="Agent tools" description={AGENT_TOOLS_DESCRIPTION}>
        {!snapshot.mcpServerEnabled && (
          <p className="text-xs text-text-secondary leading-relaxed">
            Agents reach these tools through Daintree&apos;s MCP server, which is off. Turn it on in
            Settings → MCP Server.
          </p>
        )}
        <SettingsGroup>
          {snapshot.endpoints.map((endpoint) => {
            const key = rowKey(endpoint);
            const origin = originLabel(endpoint);
            return (
              <div
                key={key}
                className="flex items-start justify-between gap-3 px-4 py-3"
                data-testid="project-agent-tool-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-text-primary break-words">
                      {endpoint.pluginDisplayName}
                    </span>
                    <Badge size="xs">{origin}</Badge>
                  </div>
                  <p className="text-xs text-text-secondary break-words">{endpoint.name}</p>
                  {endpoint.description && (
                    <p className="text-xs text-text-secondary break-words">
                      {endpoint.description}
                    </p>
                  )}
                  {!endpoint.available && (
                    <p className="text-xs text-text-secondary leading-relaxed">
                      Not offered here right now, but still on. It applies again if the plugin comes
                      back.
                    </p>
                  )}
                </div>
                <SettingsSwitch
                  className="shrink-0"
                  checked={endpoint.enabled}
                  disabled={pending.has(key) || (!endpoint.available && !endpoint.enabled)}
                  onCheckedChange={(next) => void setEnabled(endpoint, next)}
                  aria-label={`Let agents use ${endpoint.name} from ${endpoint.pluginDisplayName} (${origin.toLowerCase()})`}
                  data-testid="project-agent-tool-switch"
                />
              </div>
            );
          })}
          {loadFailed && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <p role="alert" className="text-xs text-status-error">
                Couldn&apos;t refresh this list, so it may be out of date.
              </p>
              <Button variant="outline" size="xs" onClick={refresh}>
                Retry
              </Button>
            </div>
          )}
          {failed !== null && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <p role="alert" className="text-xs text-status-error">
                Couldn&apos;t change access to {failed.endpoint.name}.
              </p>
              <Button variant="outline" size="xs" onClick={retryFailed}>
                Retry
              </Button>
            </div>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
