import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { SeverityMark } from "@/lib/statusSeverity";
import { clientErrorText } from "@/utils/clientAppError";
import type { HostAgentForwardingCheck } from "@shared/types/ipc/remoteHosts";
import type { HostDescriptor } from "@shared/types/remoteHosts";
import { SettingsRow } from "../SettingsGroup";
import { SettingsSwitch } from "../SettingsSwitch";

/** An IdentityAgent the host's terminals would use in place of the forwarded socket. */
function overridesForwarding(identityAgent: string | null | undefined): boolean {
  return (
    typeof identityAgent === "string" &&
    identityAgent !== "SSH_AUTH_SOCK" &&
    identityAgent !== "$SSH_AUTH_SOCK"
  );
}

/** What stands between the switch and a working agent on the host, as observed. */
export function agentForwardingNotes(check: HostAgentForwardingCheck, hostName: string): string[] {
  const notes: string[] = [];
  if (!check.localAgent) {
    notes.push("No ssh-agent is running on this computer for this host, so requests are refused");
  }
  if (overridesForwarding(check.hostIdentityAgent)) {
    notes.push(
      `${hostName}'s ssh config sets IdentityAgent for github.com, which its terminals use instead of this one`
    );
  }
  return notes;
}

/**
 * Settings → Hosts: whether new terminals in this host's projects reach this
 * computer's ssh-agent while it drives them (#17432). Saved on this computer;
 * off by default.
 */
export function HostAgentForwardingRow({
  descriptor,
  hostName,
  connected,
}: {
  descriptor: HostDescriptor;
  hostName: string;
  connected: boolean;
}) {
  const [draft, setDraft] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<HostAgentForwardingCheck | null>(null);
  const enabled = draft ?? descriptor.forwardSshAgent === true;
  const hostId = descriptor.id;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    remoteHostsClient.checkAgentForwarding(hostId).then(
      (result) => {
        if (live) setCheck(result);
      },
      () => {
        if (live) setCheck(null);
      }
    );
    return () => {
      live = false;
    };
  }, [hostId, enabled, connected]);

  const setEnabled = (next: boolean) => {
    setDraft(next);
    setError(null);
    remoteHostsClient.update({ hostId, forwardSshAgent: next }).then(
      () => setDraft(null),
      (err: unknown) => {
        setDraft(null);
        setError(clientErrorText(err, "Couldn't save this setting"));
      }
    );
  };

  const notes = enabled && check ? agentForwardingNotes(check, hostName) : [];

  return (
    <SettingsRow
      label="Forward this computer's ssh-agent to terminals"
      accessory={<Badge size="xs">New terminals</Badge>}
      description={
        <>
          {`Terminals in projects you drive on ${hostName} can push and sign commits with this computer's keys, which never leave it. Anything running as your user there can use them while you drive. Off by default.`}
          {notes.map((note) => (
            <span key={note} className="mt-1 flex items-start gap-1.5">
              <SeverityMark severity="warning" label="Warning" className="mt-0.5 size-3" />
              <span>{note}</span>
            </span>
          ))}
        </>
      }
      error={error ?? undefined}
      control={({ labelId, descriptionId, disabled }) => (
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    />
  );
}
