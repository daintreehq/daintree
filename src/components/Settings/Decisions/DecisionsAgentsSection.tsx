import { useSyncExternalStore } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import {
  getPluginAgentRegistrySnapshot,
  subscribeToPluginAgentRegistry,
} from "@shared/config/pluginAgentRegistry";
import type { CliAvailability } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";

export interface DecisionsAgentSupport {
  /** Installed agents a launch hands `ask_human`: the ones with launch-time MCP. */
  supported: string[];
  /** Installed agents with no launch-time MCP, so no way to be handed it. */
  unsupported: string[];
}

/** The installed agents among `ids`, in order, split by whether they get `ask_human`. */
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
 * by hand has no pane to answer into.
 */
export function DecisionsAgentsSection() {
  const availability = useCliAvailabilityStore((state) => state.availability);
  const hasRealData = useCliAvailabilityStore((state) => state.hasRealData);
  // Both registries feed `getAgentIds`; read here so a change re-renders the list.
  useUserAgentRegistryStore((state) => state.registry);
  useSyncExternalStore(subscribeToPluginAgentRegistry, getPluginAgentRegistrySnapshot);

  const { supported, unsupported } = decisionsAgentSupport(getAgentIds(), availability);
  const none = supported.length === 0 && unsupported.length === 0;

  return (
    <SettingsSection
      title="Agents"
      id="decisions-agents"
      description="Agents launched while Decisions is on can ask you with ask_human. One already running gets it at its next launch."
    >
      {none ? (
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
            <SettingsGroup label="Get ask_human">
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
