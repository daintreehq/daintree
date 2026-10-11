import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PluginViewConsentEntry } from "@shared/types/ipc/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";

interface HostPluginViewConsentsProps {
  hostId: string;
  hostName: string;
}

/** The plugin's name without the project prefix a project plugin's instance id carries. */
function pluginLabel(pluginId: string): string {
  const parts = pluginId.split("__");
  return parts[parts.length - 1] ?? pluginId;
}

/**
 * The host plugins this computer was asked about running the view code of:
 * the ones allowed, and the ones refused this run. Resetting forgets the
 * answer, so the plugin asks again before its view next loads.
 */
export function HostPluginViewConsents({ hostId, hostName }: HostPluginViewConsentsProps) {
  const [plugins, setPlugins] = useState<PluginViewConsentEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    remoteHostsClient.listPluginViewConsents(hostId).then(
      (next) => {
        setPlugins(next);
        setError(null);
      },
      (err: unknown) => setError(formatErrorMessage(err, "Couldn't load plugin views"))
    );
  }, [hostId]);

  useEffect(() => {
    load();
  }, [load]);

  const reset = (pluginId: string) => {
    remoteHostsClient
      .resetPluginViewConsent(hostId, pluginId)
      .then(load, (err: unknown) =>
        setError(formatErrorMessage(err, "Couldn't reset the plugin view"))
      );
  };

  return (
    <SettingsSection
      title="Plugin views"
      description={`Plugins from ${hostName} you were asked about running on this computer. A view already open keeps running until its window reloads.`}
    >
      <SettingsGroup>
        {error !== null && (
          <SettingsRow
            label="Couldn't load plugin views"
            description={<span role="alert">{error}</span>}
            control={
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            }
          />
        )}
        {plugins.length === 0 ? (
          <SettingsEmptyRow>
            No plugin from {hostName} has asked to run its view here
          </SettingsEmptyRow>
        ) : (
          plugins.map(({ pluginId, state }) => (
            <SettingsRow
              key={pluginId}
              label={pluginLabel(pluginId)}
              description={
                state === "allowed"
                  ? "Allowed. A changed plugin asks again."
                  : "Blocked until Daintree restarts here"
              }
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reset(pluginId)}
                  aria-label={`Reset the plugin view for ${pluginLabel(pluginId)}`}
                >
                  Reset
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
