import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";
import { SettingsSwitchCard } from "../SettingsSwitchCard";
import { AddHostDialog } from "./AddHostDialog";
import { HostClipboardGrants } from "./HostClipboardGrants";
import { buildLabel, connectionLabel, platformLabel } from "./hostLabels";

interface HostDetailProps {
  entry: HostListEntry;
  onBack: () => void;
  /** Open straight into this host's update flow (the host chip's "Update …"). */
  openUpdate?: boolean;
}

function useCommittedField(initial: string, commit: (value: string) => Promise<unknown>) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = () => {
    if (draft.trim() === initial) return;
    commit(draft.trim()).then(
      () => setError(undefined),
      (err: unknown) => setError(formatErrorMessage(err, "Couldn't save"))
    );
  };
  return { draft, setDraft, error, save };
}

/** One host: its name and SSH target, what its connection reports, and forgetting it. */
export function HostDetail({ entry, onBack, openUpdate = false }: HostDetailProps) {
  const { descriptor, connection, summary } = entry;
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(openUpdate);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const name = useCommittedField(descriptor.name, (value) =>
    remoteHostsClient.update({ hostId: descriptor.id, name: value })
  );
  const target = useCommittedField(descriptor.sshTarget, (value) =>
    remoteHostsClient.update({ hostId: descriptor.id, sshTarget: value })
  );
  const agentClis = summary?.agentClis ?? [];
  const [notifyDraft, setNotifyDraft] = useState<boolean | null>(null);
  const notificationsEnabled = notifyDraft ?? descriptor.notificationsEnabled;
  const toggleNotifications = () => {
    const next = !notificationsEnabled;
    setNotifyDraft(next);
    remoteHostsClient.update({ hostId: descriptor.id, notificationsEnabled: next }).then(
      () => setNotifyDraft(null),
      () => setNotifyDraft(null)
    );
  };

  const connect = () => {
    setConnecting(true);
    setConnectError(null);
    remoteHostsClient.connect(descriptor.id).then(
      () => setConnecting(false),
      (err: unknown) => {
        setConnecting(false);
        setConnectError(formatErrorMessage(err, "Couldn't connect"));
      }
    );
  };

  const forget = () => {
    remoteHostsClient.forget(descriptor.id).then(
      () => {
        setConfirmForget(false);
        onBack();
      },
      (err: unknown) => {
        setConfirmForget(false);
        setForgetError(formatErrorMessage(err, "Couldn't forget the host"));
      }
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          All hosts
        </Button>
      </div>

      <SettingsSection title={descriptor.name}>
        <SettingsGroup>
          <SettingsInput
            label="Name"
            layout="inline"
            value={name.draft}
            error={name.error}
            onChange={(e) => name.setDraft(e.target.value)}
            onBlur={name.save}
            onKeyDown={(e) => e.key === "Enter" && name.save()}
          />
          <SettingsInput
            label="SSH target"
            description="What `ssh` is given: user@host, a tailnet name, or an ~/.ssh/config alias"
            layout="inline"
            spellCheck={false}
            value={target.draft}
            error={target.error}
            onChange={(e) => target.setDraft(e.target.value)}
            onBlur={target.save}
            onKeyDown={(e) => e.key === "Enter" && target.save()}
          />
          <SettingsRow
            label="Connection"
            description={
              connectError ? (
                <>
                  {connectionLabel(connection)}
                  <br />
                  <span role="alert" className="text-status-error select-text">
                    Couldn&apos;t connect: {connectError}
                  </span>
                </>
              ) : (
                connectionLabel(connection)
              )
            }
            control={
              connection.status !== "connected" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={connect}
                  disabled={connecting}
                  aria-busy={connecting || undefined}
                >
                  {connectError ? "Retry" : "Connect"}
                </Button>
              ) : undefined
            }
          />
          <SettingsRow
            label="Build"
            description={`${buildLabel(descriptor)} · ${platformLabel(descriptor.platform, descriptor.arch)}`}
            control={
              <Button variant="outline" size="sm" onClick={() => setUpdateOpen(true)}>
                Check for update
              </Button>
            }
          />
          <SettingsSwitchCard
            title="Notify me about this host"
            subtitle="Agents waiting on this host notify you here even while your windows show another machine. Off by default"
            isEnabled={notificationsEnabled}
            onChange={toggleNotifications}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Agent CLIs"
        description="Installed and signed in per host. This is what the host's own detection reports"
      >
        <SettingsGroup>
          {agentClis.length === 0 ? (
            <SettingsEmptyRow>
              Connect to this host to see the agent CLIs it reports
            </SettingsEmptyRow>
          ) : (
            agentClis.map((cli) => (
              <SettingsRow
                key={cli.agentId}
                label={cli.agentId}
                description={cli.version ?? "Version not reported"}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Accounts and plugins"
        description="Credentials aren't copied between machines: each host signs in for itself"
      >
        <SettingsGroup>
          <SettingsRow
            label="Forge connection"
            description="Not reported by this host yet. Open a project on it to see its forge status"
          />
          <SettingsRow
            label="Plugin parity"
            description="Which plugins are only here, only on the host, or on different versions"
          />
        </SettingsGroup>
      </SettingsSection>

      <HostClipboardGrants hostId={descriptor.id} hostName={descriptor.name} />

      <SettingsSection title="Forget host">
        <SettingsGroup>
          <SettingsRow
            label="Remove from this machine"
            description={
              forgetError ??
              "Closes its connection and deletes its SSH control socket and cached builds. Nothing on the host changes"
            }
            control={
              <Button variant="ghost-danger" size="sm" onClick={() => setConfirmForget(true)}>
                Forget host
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        isOpen={confirmForget}
        onClose={() => setConfirmForget(false)}
        variant="destructive"
        title={`Forget '${descriptor.name}'?`}
        description="It leaves your host list, its connection closes, and windows attached to it return to this machine. Daintree on the host keeps running."
        confirmLabel="Forget host"
        onConfirm={forget}
      />
      {updateOpen && (
        <AddHostDialog
          isOpen
          onClose={() => setUpdateOpen(false)}
          existing={{
            hostId: descriptor.id,
            name: descriptor.name,
            sshTarget: descriptor.sshTarget,
          }}
        />
      )}
    </div>
  );
}
