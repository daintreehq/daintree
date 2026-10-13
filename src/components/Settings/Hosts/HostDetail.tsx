import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { formatHostConnection, sshTargetOf, type HostListEntry } from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";
import { SettingsSwitch } from "../SettingsSwitch";
import { useSettingsSubpage } from "../SettingsSubpage";
import { AddHostDialog } from "./AddHostDialog";
import { ChangeHostTargetDialog } from "./ChangeHostTargetDialog";
import { HostPluginsSection } from "./HostPluginsSection";
import { HostClipboardGrants } from "./HostClipboardGrants";
import { HostPluginViewConsents } from "./HostPluginViewConsents";
import { buildLabel, connectionLabel, describeBuildDifference, platformLabel } from "./hostLabels";
import { describeHostForge } from "@/components/Hosts/hostForges";
import { clientErrorText } from "@/utils/clientAppError";

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

/**
 * A field saved on blur or Enter, against the value it was started from: a
 * change made elsewhere (another window's rename) replaces a draft nobody
 * touched, and an edit begun before it is never written over it silently.
 */
function useCommittedField(current: string, commit: (value: string) => Promise<unknown>) {
  const [draft, setDraft] = useState(current);
  const [base, setBase] = useState(current);
  const [error, setError] = useState<string | undefined>(undefined);
  if (current !== base && draft === base) {
    setBase(current);
    setDraft(current);
  }
  const save = () => {
    const next = draft.trim();
    if (next === current) {
      setBase(current);
      return;
    }
    if (base !== current) {
      // Asked once: saving again keeps the edit, now made against the new value.
      setBase(current);
      setError(`Renamed to "${current}" in another window. Save again to use "${next}" instead`);
      return;
    }
    commit(next).then(
      () => {
        setBase(next);
        setError(undefined);
      },
      (err: unknown) => setError(clientErrorText(err, "Couldn't save"))
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
  // Only an ssh target can be changed here; another kind of connection is shown as it is.
  const sshTarget = sshTargetOf(descriptor.connection);
  const [changeTargetOpen, setChangeTargetOpen] = useState(false);
  const connected = connection.status === "connected";
  // What a host reports is about it now only while it is connected: kept from
  // before a drop, it would read as current. The overview's history keeps it.
  const liveSummary = connected ? summary : null;
  // Up, or trying to be: Disconnect stops it. A link that gave up offers Retry instead.
  const linked =
    connected ||
    connection.status === "connecting" ||
    connection.status === "driven-elsewhere" ||
    (connection.status === "unreachable" && connection.stoppedRetrying !== true);
  const hostModeOff = connection.status === "unreachable" && connection.hostModeOff === true;
  const buildMismatch = connected ? (connection.buildMismatch ?? null) : null;
  const agentClis = [...(liveSummary?.agentClis ?? [])]
    .map((cli) => ({ ...cli, name: getAgentConfig(cli.agentId)?.name ?? cli.agentId }))
    .sort((a, b) => nameCollator.compare(a.name, b.name));
  const forges = liveSummary?.forges
    ? [...liveSummary.forges].sort((a, b) => nameCollator.compare(a.name, b.name))
    : liveSummary?.forges;
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
        setNotifyError(clientErrorText(err, "Couldn't save this setting"));
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
    // Settled on what the link reports: dialling alone answers at once, so a
    // failure never rejected and "Couldn't connect" never showed.
    remoteHostsClient.connectAndSettle(descriptor.id).then(
      (state) => {
        setConnecting(false);
        // Host mode off and a mismatched build have their own words and actions above.
        if (state.status === "unreachable" && !state.hostModeOff) {
          setConnectError(`Couldn't connect: ${state.detail ?? "the host didn't answer"}`);
        }
      },
      (err: unknown) => {
        setConnecting(false);
        setConnectError(`Couldn't connect: ${clientErrorText(err, "unknown error")}`);
      }
    );
  };

  // Closes the link; nothing on the host stops, and Connect brings it back.
  const disconnect = () => {
    setConnecting(true);
    setConnectError(null);
    remoteHostsClient.disconnect(descriptor.id).then(
      () => setConnecting(false),
      (err: unknown) => {
        setConnecting(false);
        setConnectError(`Couldn't disconnect: ${clientErrorText(err, "unknown error")}`);
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
        setRemoveError(clientErrorText(err, "Couldn't remove the host"));
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
            <SettingsRow
              label="SSH target"
              description={sshTarget}
              control={
                <Button variant="outline" size="sm" onClick={() => setChangeTargetOpen(true)}>
                  Change target…
                </Button>
              }
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
              // Announced: it answers one press of Connect or Disconnect.
              connectError ? <span role="alert">{connectError}</span> : undefined
            }
            control={
              <div className="flex gap-2">
                {hostModeOff && (
                  // Setting up turns Host mode on there; Retry checks again as it is.
                  <Button variant="outline" size="sm" onClick={() => setUpdateOpen(true)}>
                    Set up…
                  </Button>
                )}
                {linked ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={disconnect}
                    disabled={connecting}
                    aria-busy={connecting || undefined}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={connect}
                    disabled={connecting}
                    aria-busy={connecting || undefined}
                  >
                    {connectError || connection.status === "unreachable" ? "Retry" : "Connect"}
                  </Button>
                )}
              </div>
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
          {liveSummary === null || liveSummary === undefined ? (
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
      <HostPluginViewConsents hostId={descriptor.id} hostName={hostName} />
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
        description={`Its connection here closes, windows attached to it return to this machine, and its plugin permissions, history and browser data on this device are cleared. Projects and Daintree on ${hostName} keep running.`}
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
      {changeTargetOpen && sshTarget !== null && (
        <ChangeHostTargetDialog
          isOpen
          onClose={() => setChangeTargetOpen(false)}
          hostId={descriptor.id}
          hostName={hostName}
          currentTarget={sshTarget}
        />
      )}
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
