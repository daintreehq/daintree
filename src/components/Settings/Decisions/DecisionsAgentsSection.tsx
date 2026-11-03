import { useSyncExternalStore } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { Callout } from "@/components/ui/Callout";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import {
  getPluginAgentRegistrySnapshot,
  subscribeToPluginAgentRegistry,
} from "@shared/config/pluginAgentRegistry";
import type { CliAvailability } from "@shared/types";
import type { DecisionsStatus } from "@shared/types/decisions";
import { isAgentInstalled } from "@shared/utils/agentAvailability";

export interface DecisionsAgentSupport {
  /** Installed agents with launch-time MCP, the only way a launch can hand them `ask_human`. */
  supported: string[];
  /** Installed agents with no launch-time MCP, so no way to be handed it. */
  unsupported: string[];
}

/** The installed agents among `ids`, in order, split by whether a launch can hand them `ask_human`. */
export function decisionsAgentSupport(
  ids: readonly string[],
  availability: CliAvailability
): DecisionsAgentSupport {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const id of ids) {
    if (!isAgentInstalled(availability[id])) continue;
    const config = getAgentConfig(id);
    if (!config) continue;
    (config.capabilities?.launchMcp ? supported : unsupported).push(id);
  }
  return { supported, unsupported };
}

/**
 * Whether a launch now is handed `ask_human`. The route opens once the relay
 * identity has loaded, before the first attempt goes out, and stays open
 * between attempts; a launch while it is still loading waits a bounded time
 * for it. With no relay, a relay stopped for a problem, or a revoked
 * computer, launches get no route at all.
 */
export function decisionsLaunchesGetAsk(status: DecisionsStatus): boolean {
  switch (status.state) {
    case "connecting":
    case "connected":
    case "reconnecting":
    case "replaced":
      return true;
    case "off":
    case "not-connected":
    case "revoked":
      return false;
  }
}

function AgentRow({ id }: { id: string }) {
  const config = getAgentConfig(id);
  const Icon = config?.icon;
  return (
    <SettingsRow
      id={`decisions-agent-${id}`}
      label={
        <span className="inline-flex items-center gap-2">
          {Icon && <Icon size={16} />}
          {config?.name ?? id}
        </span>
      }
      labelText={config?.name ?? id}
    />
  );
}

/**
 * Agents (#16012): which installed agents a launch hands `ask_human`, and
 * which can't be handed it yet. An agent gets it only through its launch-time
 * MCP path, so there is no manual setup to offer the rest: a server set up
 * by hand has no pane to answer into. With no relay connection, launches get
 * nothing, so the list says it applies once one is connected (#16203). Not
 * shown in a remote window: its agents are the host's, launched there under
 * the host's own Decisions.
 */
export function DecisionsAgentsSection({ status }: { status: DecisionsStatus }) {
  const availability = useCliAvailabilityStore((state) => state.availability);
  const hasRealData = useCliAvailabilityStore((state) => state.hasRealData);
  const loadError = useCliAvailabilityStore((state) => state.error);
  const refresh = useCliAvailabilityStore((state) => state.refresh);
  // Both registries feed `getAgentIds`; read here so a change re-renders the list.
  useUserAgentRegistryStore((state) => state.registry);
  useSyncExternalStore(subscribeToPluginAgentRegistry, getPluginAgentRegistrySnapshot);
  const remoteHostName = useRemoteHostName();
  if (remoteHostName !== null) return null;

  const { supported, unsupported } = decisionsAgentSupport(getAgentIds(), availability);
  const none = supported.length === 0 && unsupported.length === 0;
  const failed = !hasRealData && loadError !== null;
  const launchesGetAsk = decisionsLaunchesGetAsk(status);

  return (
    <SettingsSection
      title="Agents"
      id="decisions-agents"
      description={
        launchesGetAsk
          ? "Agents launched while Decisions is on can ask you with ask_human. One already running gets it at its next launch."
          : "Agents launched while a relay is connected can ask you with ask_human. One already running gets it at its next launch."
      }
    >
      {!launchesGetAsk && (
        <Callout severity="neutral" data-testid="decisions-agents-not-connected">
          {status.relayOrigin === undefined
            ? "No relay is connected, so agents launch without ask_human. Connect one under Connection, above."
            : "The relay isn't connected, so agents launch without ask_human. Connection, above, shows why."}
        </Callout>
      )}
      {failed ? (
        <SettingsLoadErrorBanner
          title="Couldn't check which agents are installed"
          message={loadError}
          // A probe that fails again lands in the store's `error`, shown here.
          onRetry={() => void refresh(true).catch(() => {})}
        />
      ) : none ? (
        <SettingsGroup>
          <SettingsEmptyRow>
            {hasRealData
              ? "No agent CLIs found. Install one and Daintree picks it up"
              : "Checking which agents are installed…"}
          </SettingsEmptyRow>
        </SettingsGroup>
      ) : (
        <>
          {supported.length > 0 && (
            <SettingsGroup
              label={launchesGetAsk ? "Get ask_human" : "Get ask_human once connected"}
            >
              {supported.map((id) => (
                <AgentRow key={id} id={id} />
              ))}
            </SettingsGroup>
          )}
          {unsupported.length > 0 && (
            <SettingsGroup label="Not supported yet">
              {unsupported.map((id) => (
                <AgentRow key={id} id={id} />
              ))}
            </SettingsGroup>
          )}
        </>
      )}
    </SettingsSection>
  );
}
