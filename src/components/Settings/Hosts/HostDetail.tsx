import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getAgentConfig } from "@shared/config/agentRegistry";
import {
  formatHostConnection,
  sshConnection,
  sshTargetOf,
  type HostListEntry,
} from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";
import { SettingsSwitch } from "../SettingsSwitch";
import { useSettingsSubpage } from "../SettingsSubpage";
import { AddHostDialog } from "./AddHostDialog";
import { HostPluginsSection } from "./HostPluginsSection";
import { HostClipboardGrants } from "./HostClipboardGrants";
import { buildLabel, connectionLabel, describeBuildDifference, platformLabel } from "./hostLabels";
import { describeHostForge } from "@/components/Hosts/hostForges";

interface HostDetailProps {
  entry: HostListEntry;
  /** Back to the list; `viaKeyboard` decides whether focus lands visibly there. */
  onBack: (viaKeyboard?: boolean) => void;
  /** Open straight into this host's update flow (the host chip's "Update …"). */
  openUpdate?: boolean;
  /** Scroll to this host's plugins (the switch notice's "Review"). */
  focusPlugins?: boolean;
  /** Opened from the keyboard: focus the header's way back once it is there. */
  focusBackOnMount?: boolean;
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

const nameCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * One host, under Settings → Hosts: its name and address, what its link and
 * build report, what it reports having installed, and removing it from this
 * device. The settings header names it and carries the way back.
 */
export function HostDetail({
  entry,
  onBack,
  openUpdate = false,
  focusPlugins = false,
  focusBackOnMount = false,
}: HostDetailProps) {
  const { descriptor, connection, summary } = entry;
  const hostName = descriptor.name;
  const headerOwnsBack = useSettingsSubpage({ title: hostName, parentLabel: "Hosts", onBack });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(openUpdate);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const name = useCommittedField(descriptor.name, (value) =>
    remoteHostsClient.update({ hostId: descriptor.id, name: value })
  );
  // Only an ssh target is typed; another kind of connection is shown as it is.
  const sshTarget = sshTargetOf(descriptor.connection);
  const target = useCommittedField(sshTarget ?? "", (value) =>
    remoteHostsClient.update({ hostId: descriptor.id, connection: sshConnection(value) })
  );
  const connected = connection.status === "connected";
  const buildMismatch = connected ? (connection.buildMismatch ?? null) : null;
  const agentClis = [...(summary?.agentClis ?? [])]
    .map((cli) => ({ ...cli, name: getAgentConfig(cli.agentId)?.name ?? cli.agentId }))
    .sort((a, b) => nameCollator.compare(a.name, b.name));
  const forges = summary?.forges
    ? [...summary.forges].sort((a, b) => nameCollator.compare(a.name, b.name))
    : summary?.forges;
  const [notifyDraft, setNotifyDraft] = useState<boolean | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const notificationsEnabled = notifyDraft ?? descriptor.notificationsEnabled;
  const setNotifications = (next: boolean) => {
    setNotifyDraft(next);
    setNotifyError(null);
    remoteHostsClient.update({ hostId: descriptor.id, notificationsEnabled: next }).then(
      () => setNotifyDraft(null),
      (err: unknown) => {
        setNotifyDraft(null);
        setNotifyError(formatErrorMessage(err, "Couldn't save this setting"));
      }
    );
  };

  useEffect(() => {
    if (!focusBackOnMount) return undefined;
    // The header draws the back control from this page's own effect, and the
    // settings dialog may still be settling its opening focus: wait for both.
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const back = document.querySelector<HTMLElement>('[data-testid="settings-subpage-back"]');
      if (back && document.activeElement !== back) back.focus();
      if ((!back || document.activeElement !== back) && tries++ < 30) {
        frame = requestAnimationFrame(attempt);
      }
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusBackOnMount]);

  useEffect(() => {
    if (focusPlugins) document.getElementById("host-plugins")?.scrollIntoView({ block: "start" });
  }, [focusPlugins]);

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

  const remove = () => {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    remoteHostsClient.forget(descriptor.id).then(
      () => {
        setRemoving(false);
        setConfirmRemove(false);
        onBack();
      },
      (err: unknown) => {
        setRemoving(false);
        setRemoveError(formatErrorMessage(err, "Couldn't remove the host"));
      }
    );
  };

  return (
    <div className="space-y-8">
      {!headerOwnsBack && (
        <div>
          <Button variant="ghost" size="sm" onClick={(event) => onBack(event.detail === 0)}>
            <ChevronLeft aria-hidden="true" />
            All hosts
          </Button>
        </div>
      )}

      <SettingsSection title="Connection">
        <SettingsGroup>
          <SettingsInput
            label="Name"
            description="What this device calls it. The host's own name doesn't change"
            layout="inline"
            value={name.draft}
            error={name.error}
            onChange={(e) => name.setDraft(e.target.value)}
            onBlur={name.save}
            onKeyDown={(e) => e.key === "Enter" && name.save()}
          />
          {sshTarget !== null ? (
            <SettingsInput
              label="SSH target"
              description="user@host, a .local or tailnet name, or an ~/.ssh/config alias"
              layout="inline"
              spellCheck={false}
              value={target.draft}
              error={target.error}
              onChange={(e) => target.setDraft(e.target.value)}
              onBlur={target.save}
              onKeyDown={(e) => e.key === "Enter" && target.save()}
            />
          ) : (
            <SettingsRow
              label="Address"
              description={formatHostConnection(descriptor.connection)}
            />
          )}
          <SettingsRow
            label="Status"
            description={connectionLabel(connection)}
            error={
              // Announced: it answers one press of Connect.
              connectError ? (
                <span role="alert">{`Couldn't connect: ${connectError}`}</span>
              ) : undefined
            }
            control={
              connected ? undefined : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={connect}
                  disabled={connecting}
                  aria-busy={connecting || undefined}
                >
                  {connectError ? "Retry" : "Connect"}
                </Button>
              )
            }
          />
          <SettingsRow
            label="Daintree build"
            description={
              <>
                {buildLabel(descriptor)} · {platformLabel(descriptor.platform, descriptor.arch)}
                {buildMismatch && (
                  <>
                    <br />
                    {describeBuildDifference(buildMismatch)}
                  </>
                )}
              </>
            }
            control={
              <Button variant="outline" size="sm" onClick={() => setUpdateOpen(true)}>
                Check for update
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsGroup>
          <SettingsRow
            label="Notify me about this host"
            description="Agents observed waiting on it notify you here, even while your windows show another machine. Off by default"
            error={notifyError ?? undefined}
            control={({ labelId, descriptionId, disabled }) => (
              <SettingsSwitch
                checked={notificationsEnabled}
                onCheckedChange={setNotifications}
                disabled={disabled}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              />
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Agent CLIs"
        description={`What ${hostName} reports having installed. Each machine signs in to its agents itself`}
      >
        <SettingsGroup>
          {summary === null || summary === undefined ? (
            <SettingsEmptyRow>
              {connected
                ? `Waiting for ${hostName} to report its agent CLIs`
                : `Connect to ${hostName} to see its agent CLIs`}
            </SettingsEmptyRow>
          ) : agentClis.length === 0 ? (
            <SettingsEmptyRow>{hostName} reports no agent CLIs installed</SettingsEmptyRow>
          ) : (
            agentClis.map((cli) => (
              <SettingsRow
                key={cli.agentId}
                label={cli.name}
                control={
                  <span className="text-xs tabular-nums text-text-secondary">
                    {cli.version ?? "Version not reported"}
                  </span>
                }
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Accounts"
        description="Credentials aren't copied between machines: each host signs in for itself"
      >
        <SettingsGroup>
          {forges === undefined || forges === null ? (
            <SettingsEmptyRow>
              {connected
                ? `${hostName} hasn't reported its forge connections`
                : `Connect to ${hostName} to see its forge connections`}
            </SettingsEmptyRow>
          ) : forges.length === 0 ? (
            <SettingsEmptyRow>No forge providers are enabled on {hostName}</SettingsEmptyRow>
          ) : (
            forges.map((forge) => (
              <SettingsRow
                key={forge.providerId}
                label={forge.name}
                description={describeHostForge(forge, hostName)}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <HostPluginsSection hostId={descriptor.id} hostName={hostName} connected={connected} />
      <HostClipboardGrants hostId={descriptor.id} hostName={hostName} />

      <SettingsSection title="Remove host">
        <SettingsGroup>
          <SettingsRow
            label={`Projects and Daintree on ${hostName} keep running`}
            description="Its connection here closes, windows attached to it return to this machine, and it leaves your host list"
            error={removeError ?? undefined}
            control={
              <Button variant="ghost-danger" size="sm" onClick={() => setConfirmRemove(true)}>
                Remove host
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        variant="destructive"
        title={`Remove '${hostName}' from this device?`}
        description={`Its connection here closes and windows attached to it return to this machine. Projects and Daintree on ${hostName} keep running.`}
        confirmLabel="Remove host"
        onConfirm={remove}
        isConfirmLoading={removing}
      >
        {removeError && (
          <p role="alert" className="text-xs text-status-error select-text">
            {removeError}
          </p>
        )}
      </ConfirmDialog>
      {updateOpen && (
        <AddHostDialog
          isOpen
          onClose={() => setUpdateOpen(false)}
          existing={{
            hostId: descriptor.id,
            name: descriptor.name,
            connection: descriptor.connection,
          }}
        />
      )}
    </div>
  );
}
