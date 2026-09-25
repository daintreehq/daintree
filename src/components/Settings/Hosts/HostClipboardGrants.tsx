import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HostPluginClipboardGrant } from "@shared/types/ipc/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";

interface HostClipboardGrantsProps {
  hostId: string;
  hostName: string;
}

function answerLabel(decision: "allow" | "deny" | undefined): string {
  if (decision === "allow") return "allowed";
  if (decision === "deny") return "denied";
  return "not asked";
}

/** The plugin's name without the project prefix a project plugin's instance id carries. */
function pluginLabel(pluginId: string): string {
  const parts = pluginId.split("__");
  return parts[parts.length - 1] ?? pluginId;
}

/**
 * What this computer answered when a plugin on the host asked for its
 * clipboard. Resetting forgets the answer, so the plugin asks again.
 */
export function HostClipboardGrants({ hostId, hostName }: HostClipboardGrantsProps) {
  const [grants, setGrants] = useState<HostPluginClipboardGrant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    remoteHostsClient.listClipboardGrants(hostId).then(
      (next) => {
        setGrants(next);
        setError(null);
      },
      (err: unknown) => setError(formatErrorMessage(err, "Couldn't load clipboard access"))
    );
  }, [hostId]);

  useEffect(() => {
    load();
  }, [load]);

  const reset = (pluginId: string) => {
    remoteHostsClient
      .resetClipboardGrants(hostId, pluginId)
      .then(load, (err: unknown) =>
        setError(formatErrorMessage(err, "Couldn't reset clipboard access"))
      );
  };

  return (
    <SettingsSection
      title="Clipboard access"
      description={`What you answered when a plugin on ${hostName} asked to use this computer's clipboard`}
    >
      <SettingsGroup>
        {error !== null && (
          <SettingsRow
            label="Couldn't load clipboard access"
            description={<span role="alert">{error}</span>}
            control={
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            }
          />
        )}
        {grants.length === 0 ? (
          <SettingsEmptyRow>
            No plugin on {hostName} has asked for this computer&apos;s clipboard
          </SettingsEmptyRow>
        ) : (
          grants.map((grant) => (
            <SettingsRow
              key={grant.pluginId}
              label={pluginLabel(grant.pluginId)}
              description={`Read ${answerLabel(grant.read)} · Write ${answerLabel(grant.write)}`}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reset(grant.pluginId)}
                  aria-label={`Reset clipboard access for ${pluginLabel(grant.pluginId)}`}
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
