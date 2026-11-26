import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { getAgentConfig } from "@shared/config/agentRegistry";
import {
  formatHostConnection,
  sshTargetOf,
  wslDistroOf,
  type HostListEntry,
} from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";
import { SettingsSwitch } from "../SettingsSwitch";
import { useSettingsSubpage } from "../SettingsSubpage";
import { AddHostDialog } from "./AddHostDialog";
import { ChangeHostTargetDialog } from "./ChangeHostTargetDialog";
import { HostPluginsSection } from "./HostPluginsSection";
import { HostSessionsSection } from "./HostSessionsSection";
import { HostCopySettingsSection } from "./HostCopySettingsSection";
import { takeFirstConnect } from "./hostCopySettingsRequests";
import type { HostUpdateIntent } from "./hostUpdateRequests";
import type { HostPluginsSectionId } from "./hostPluginRequests";
import { HostClipboardGrants } from "./HostClipboardGrants";
import { HostPluginViewConsents } from "./HostPluginViewConsents";
import { CloudMachineSection } from "./CloudMachineSection";
import { RemoveCloudHostDialog } from "./RemoveCloudHostDialog";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import {
  canDeleteMachines,
  cloudProviderFor,
  cloudProviderName,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { HostWakeSetup } from "./HostWakeSetup";
import { HostAgentForwardingRow } from "./HostAgentForwardingRow";
import { HostRootCommand } from "./HostCommand";
import { splitHostFix } from "@/components/Hosts/hostFixCommands";
import {
  bringBackMessage,
  canBringBack,
  useHostBringBacks,
  type HostBringBacks,
} from "./hostBringBack";
import {
  buildLabel,
  connectionLabel,
  describeBuildDifference,
  platformLabel,
  isLoginRefused,
  removeHostOutcome,
  sshKeyTrustText,
  STARTS_ON_CONNECT_COVERAGE,
} from "./hostLabels";
import { HostSshKeysSection } from "./HostSshKeysSection";
import { SshSignInDialog } from "./SshSignInDialog";
import { HostAgentSignInDialog } from "./HostAgentSignInDialog";
import { useSshSignIn } from "./useSshSignIn";
import { describeHostForge } from "@/components/Hosts/hostForges";
import { cancelPlacement, isSwitchFailure, placeAgain } from "@/components/Hosts/pendingPlacement";
import { CancelCloudPlacementDialog } from "@/components/Hosts/CancelCloudPlacementDialog";
import { isMadeForPlacement } from "@/components/Hosts/cloudWorktreePlacement";
import { clientErrorText } from "@/utils/clientAppError";
import { isWindows } from "@/lib/platform";
import { currentHostId } from "@/hooks/useHostPlatform";
import { useSettingsTargetStore } from "@/store/settingsTargetStore";

interface HostDetailProps {
  entry: HostListEntry;
  /** Back to the list; `viaKeyboard` decides whether focus lands visibly there. */
  onBack: (viaKeyboard?: boolean) => void;
  /**
   * Open straight into this host's update flow (the host chip's "Update …"),
   * or its setup (a worktree to open there once Daintree runs on it).
   */
  openUpdate?: boolean | HostUpdateIntent;
  /** Scroll to this section: its plugins (the switch notice's "Review") or their views (a blocked view's way here). */
  focusSection?: HostPluginsSectionId;
  /** Just added and connected: scroll to Copy settings and offer it. */
  offerCopySettings?: boolean;
  /** Opened from the keyboard: focus the header's way back once it is there. */
  focusBackOnMount?: boolean;
  /** The host list's presses of Bring back, so one pressed there is followed here. */
  bringBacks?: HostBringBacks;
}

/**
 * A field saved on blur or Enter, against the value it was started from: a
 * change made elsewhere (another window's rename) replaces a draft nobody
 * touched, and an edit begun before it is never written over it silently.
 */
function useCommittedField(current: string, commit: (value: string) => Promise<unknown>) {
  const [draft, setDraft] = useState(current);
  /** The value the draft was started from. */
  const [base, setBase] = useState(current);
  /** A save in flight: its value arriving from the store is no change made elsewhere. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  if (pending !== null && current === pending) {
    setPending(null);
    setBase(current);
  } else if (pending === null && current !== base && draft === base) {
    setBase(current);
    setDraft(current);
  }
  const save = () => {
    const next = draft.trim();
    if (next === current) {
      setBase(current);
      return;
    }
    // Only the value being saved here is exempt: any other change arriving is someone else's.
    if (base !== current && current !== pending) {
      // Asked once: saving again keeps the edit, now made against the new value.
      setBase(current);
      setError(`Renamed to "${current}" in another window. Save again to use "${next}" instead`);
      return;
    }
    setPending(next);
    // An older save settling never clears a newer one's pending value.
    const settle = () => setPending((value) => (value === next ? null : value));
    commit(next).then(
      () => {
        settle();
        setBase(next);
        setError(undefined);
      },
      (err: unknown) => {
        settle();
        setError(clientErrorText(err, "Couldn't save"));
      }
    );
  };
  return { draft, setDraft, error, save };
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * One host, under Settings → Hosts: its name and address, what its link and
 * build report, who drives it and what happened to its links, what it reports
 * having installed, and removing it from this device. The settings header
 * names it and carries the way back.
 */
export function HostDetail({
  entry,
  onBack,
  openUpdate = false,
  focusSection,
  offerCopySettings = false,
  focusBackOnMount = false,
  bringBacks: sharedBringBacks,
}: HostDetailProps) {
  const { descriptor, connection, summary } = entry;
  const hostName = descriptor.name;
  const headerOwnsBack = useSettingsSubpage({ title: hostName, parentLabel: "Hosts", onBack });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const cloudSnapshot = useCloudHosts().snapshot;
  const cloud = cloudStatusFor(cloudSnapshot, entry.descriptor.id);
  const cloudProvider = cloudProviderFor(cloudSnapshot.providers, cloud);
  const isCloud = entry.descriptor.connection.kind === "cloud";
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Why the update dialog is open, which names it: "Set up…" or "Check for update".
  const [updateOpen, setUpdateOpen] = useState<HostUpdateIntent | null>(
    openUpdate === "setup" ? "setup" : openUpdate ? "update" : null
  );
  const [connecting, setConnecting] = useState(false);
  // What a press of Connect or Disconnect said, kept with the connection it was pressed for:
  // a host pointed elsewhere since, or a reply that lands after, says nothing about this one.
  const connectionNow = JSON.stringify(descriptor.connection);
  const [connectSaid, setConnectSaid] = useState<{ text: string; connection: string } | null>(null);
  const connectError = connectSaid?.connection === connectionNow ? connectSaid.text : null;
  const setConnectError = (text: string | null, connection = connectionNow) =>
    setConnectSaid(text === null ? null : { text, connection });
  // A worktree waiting for this host's setup to finish before it opens here.
  const placement = descriptor.pendingPlacement ?? null;
  const [placementError, setPlacementError] = useState<string | null>(null);
  // A machine made for the worktree: cancelling asks what becomes of it.
  const [cancellingPlacement, setCancellingPlacement] = useState(false);
  const cancelWaiting = () => {
    setPlacementError(null);
    if (placement?.createdMachine) {
      setCancellingPlacement(true);
      return;
    }
    cancelPlacement(descriptor.id).catch((err: unknown) =>
      setPlacementError(clientErrorText(err, "Couldn't cancel"))
    );
  };
  // A switch that already ran is asked for again; anything else goes through setup.
  const retryWaiting = () => {
    setPlacementError(null);
    if (placement && isSwitchFailure(placement)) {
      placeAgain(descriptor.id, placement).catch((err: unknown) =>
        setPlacementError(clientErrorText(err, "Couldn't retry"))
      );
      return;
    }
    setUpdateOpen("setup");
  };
  const ownBringBacks = useHostBringBacks();
  const bringBacks = sharedBringBacks ?? ownBringBacks;
  const bringing = bringBacks.isPending(descriptor.id);
  const bringBackSaid = bringing
    ? null
    : bringBackMessage(bringBacks.outcomeFor(descriptor), descriptor, connection);
  // A refused start's package install, wherever it shows here, is offered once as its own command.
  const statusFix = splitHostFix(connectionLabel(connection));
  const statusError = connectError ?? bringBackSaid;
  const statusErrorFix = statusError ? splitHostFix(statusError) : null;
  const placementFix = placement?.failure ? splitHostFix(placement.failure.message) : null;
  const rootCommand =
    statusErrorFix?.rootCommand ?? statusFix.rootCommand ?? placementFix?.rootCommand ?? null;
  const name = useCommittedField(descriptor.name, (value) =>
    remoteHostsClient.update({ hostId: descriptor.id, name: value })
  );
  // Only an ssh target can be changed here; another kind of connection is shown as it is.
  const sshTarget = sshTargetOf(descriptor.connection);
  const wslDistro = wslDistroOf(descriptor.connection);
  const removeOutcome = removeHostOutcome(
    descriptor.connection,
    hostName,
    descriptor.startsOnConnect === true
  );
  const [changeTargetOpen, setChangeTargetOpen] = useState(false);
  const changeTargetButtonRef = useRef<HTMLButtonElement | null>(null);
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
  const loginRefused = sshTarget !== null && isLoginRefused(connection);
  // Signed in, ssh's master is up: the link dials again in batch mode and rides it.
  const signIn = useSshSignIn(() => connect());
  const buildMismatch = connected ? (connection.buildMismatch ?? null) : null;
  const agentClis = [...(liveSummary?.agentClis ?? [])]
    .map((cli) => ({ ...cli, name: getAgentConfig(cli.agentId)?.name ?? cli.agentId }))
    .sort((a, b) => nameCollator.compare(a.name, b.name));
  // The CLI whose own sign-in runs in a terminal on the host (#18196). A
  // dropped link ends it there, so it is put away rather than reopened later.
  const [agentSignIn, setAgentSignIn] = useState<{ agentId: string; name: string } | null>(null);
  if (!connected && agentSignIn !== null) setAgentSignIn(null);
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

  const [controlDraft, setControlDraft] = useState<boolean | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const controlEnabled = controlDraft ?? descriptor.assistantControlEnabled;
  const setControl = (next: boolean) => {
    setControlDraft(next);
    setControlError(null);
    remoteHostsClient.update({ hostId: descriptor.id, assistantControlEnabled: next }).then(
      () => setControlDraft(null),
      (err: unknown) => {
        setControlDraft(null);
        setControlError(clientErrorText(err, "Couldn't save this setting"));
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
    if (focusSection) document.getElementById(focusSection)?.scrollIntoView({ block: "start" });
  }, [focusSection]);

  // A host added here that first connects after the add flow closed still
  // gets the one offer, the first time it is seen connected.
  const [offered, setOffered] = useState(offerCopySettings);
  useEffect(() => {
    if (connected && takeFirstConnect(descriptor.id)) setOffered(true);
  }, [connected, descriptor.id]);
  // An imported machine may have settings of its own. Until its cloud status says
  // Daintree made it, the offer doesn't claim the host starts from defaults.
  const mayHaveSettings = isCloud && cloud?.ownership !== "created-by-daintree";

  useEffect(() => {
    if (offered) {
      document.getElementById("host-copy-settings")?.scrollIntoView({ block: "start" });
    }
  }, [offered]);

  const connect = () => {
    const pressedFor = connectionNow;
    setConnecting(true);
    setConnectError(null);
    // Settled on what the link reports: dialling alone answers at once, so a
    // failure never rejected and "Couldn't connect" never showed.
    remoteHostsClient.connectAndSettle(descriptor.id, { restart: true }).then(
      (state) => {
        setConnecting(false);
        // Host mode off and a mismatched build have their own words and actions above.
        if (state.status === "unreachable" && !state.hostModeOff) {
          setConnectError(
            `Couldn't connect: ${state.detail ?? "the host didn't answer"}`,
            pressedFor
          );
        }
      },
      (err: unknown) => {
        setConnecting(false);
        setConnectError(`Couldn't connect: ${clientErrorText(err, "unknown error")}`, pressedFor);
      }
    );
  };

  // Closes the link; nothing on the host stops, and Connect brings it back.
  const disconnect = () => {
    const pressedFor = connectionNow;
    setConnecting(true);
    setConnectError(null);
    remoteHostsClient.disconnect(descriptor.id).then(
      () => setConnecting(false),
      (err: unknown) => {
        setConnecting(false);
        setConnectError(
          `Couldn't disconnect: ${clientErrorText(err, "unknown error")}`,
          pressedFor
        );
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

      {/* The machine first: what it is doing and what it costs decide everything below. */}
      {isCloud && (
        <CloudMachineSection
          hostId={descriptor.id}
          hostName={hostName}
          connected={connected}
          liveSummary={liveSummary ?? null}
        />
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
                <Button
                  ref={changeTargetButtonRef}
                  variant="outline"
                  size="sm"
                  onClick={() => setChangeTargetOpen(true)}
                >
                  Change target…
                </Button>
              }
            />
          ) : wslDistro !== null ? (
            <SettingsRow label="WSL distribution" description={wslDistro} />
          ) : isCloud ? null : (
            <SettingsRow
              label="Address"
              description={formatHostConnection(descriptor.connection)}
            />
          )}
          <SettingsRow
            label="Status"
            description={statusFix.text}
            error={
              // Announced: it answers one press of Connect, Disconnect or Bring back.
              statusErrorFix ? <span role="alert">{statusErrorFix.text}</span> : undefined
            }
            control={
              <div className="flex gap-2">
                {!isCloud && (bringing || canBringBack(connection)) && (
                  // Wakes it where a wake is set up below, then starts Daintree there if it can.
                  <Button
                    variant="outline"
                    size="sm"
                    loading={bringing}
                    onClick={() => {
                      setConnectError(null);
                      bringBacks.bringBack(descriptor);
                    }}
                  >
                    Bring back
                  </Button>
                )}
                {loginRefused && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => signIn.start(descriptor.connection)}
                  >
                    Sign in…
                  </Button>
                )}
                {hostModeOff && !placement && (
                  // Setting up turns Host mode on there; Retry checks again as it is.
                  <Button variant="outline" size="sm" onClick={() => setUpdateOpen("setup")}>
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
          {rootCommand && (
            <SettingsRow
              label="Install the missing libraries"
              layout="stacked"
              control={<HostRootCommand host={hostName} command={rootCommand} />}
            />
          )}
          {placement && (
            <SettingsRow
              label="Waiting to open"
              description={`${placement.label} opens here once setup finishes`}
              error={
                placementError ??
                (placementFix
                  ? isSwitchFailure(placement)
                    ? placementFix.text
                    : `Setup failed: ${placementFix.text}`
                  : undefined)
              }
              control={
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={retryWaiting}>
                    {placement.failure ? "Retry" : "Set up…"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={cancelWaiting}>
                    Cancel
                  </Button>
                </div>
              }
            />
          )}
          {descriptor.startsOnConnect === true && (
            <SettingsRow
              label="Kept running"
              description={`${hostName} has no systemd for a Host mode service, so Host mode runs in the background once started. ${STARTS_ON_CONNECT_COVERAGE}`}
            />
          )}
          <SettingsRow
            label="Daintree build"
            description={
              <>
                {buildLabel(descriptor)} <FactSeparator />{" "}
                {platformLabel(descriptor.platform, descriptor.arch)}
                {buildMismatch && (
                  <>
                    <br />
                    {describeBuildDifference(buildMismatch)}
                  </>
                )}
              </>
            }
            control={
              <Button variant="outline" size="sm" onClick={() => setUpdateOpen("update")}>
                Check for update
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {sshTarget !== null && <HostWakeSetup descriptor={descriptor} />}

      <HostSshKeysSection
        hostId={descriptor.id}
        hostName={hostName}
        connected={connected}
        connectionKey={connectionNow}
        pinnedFingerprint={cloud?.hostKeyFingerprint ?? null}
        trust={sshKeyTrustText({
          connectionKind: descriptor.connection.kind,
          providerName: cloud ? cloudProviderName(cloudProvider, cloud) : null,
          sshTrust: cloudProvider?.capabilities.sshTrust ?? null,
          pinnedFingerprint: cloud?.hostKeyFingerprint ?? null,
        })}
      />

      <HostSessionsSection
        hostId={descriptor.id}
        hostName={hostName}
        connected={connected}
        sampledAt={liveSummary?.sampledAt ?? null}
      />

      <SettingsSection title="Communication">
        <SettingsGroup>
          <SettingsRow
            label="Notify me about this host"
            description="Agents observed waiting on it notify you here, even while your windows show another machine. Off by default."
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
          {/* Not offered on Windows. */}
          {!isWindows() && (
            <SettingsRow
              label="Let the assistant work on this host"
              description={`Your assistant can run ${hostName}'s Daintree tools and find, start and message the assistants there. On by default.`}
              error={controlError ?? undefined}
              control={({ labelId, descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={controlEnabled}
                  onCheckedChange={setControl}
                  disabled={disabled}
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                />
              )}
            />
          )}
          {/* macOS and Linux Shells only for now (#17432). */}
          {!isWindows() && (
            <HostAgentForwardingRow
              descriptor={descriptor}
              hostName={hostName}
              connected={connected}
            />
          )}
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
                  <div className="flex items-center gap-3">
                    <span className="text-xs tabular-nums text-text-secondary">
                      {cli.version ?? "Version not reported"}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Sign in to ${cli.name} on ${hostName}`}
                      onClick={() => setAgentSignIn({ agentId: cli.agentId, name: cli.name })}
                    >
                      Sign in
                    </Button>
                  </div>
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

      <SettingsSection title="Work settings">
        <SettingsGroup>
          {descriptor.id === currentHostId() ? (
            <SettingsRow
              label={`Settings on ${hostName}`}
              description={`This window works on ${hostName}, so its Settings pages already change it`}
            />
          ) : (
            <SettingsRow
              label={`Settings on ${hostName}`}
              description={`Agents, environment, terminals and Canopy, changed on ${hostName} itself`}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => useSettingsTargetStore.getState().setHostId(descriptor.id)}
                >
                  Edit work settings
                </Button>
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>
      <HostCopySettingsSection
        hostId={descriptor.id}
        hostName={hostName}
        connected={connected}
        offered={offered}
        mayHaveSettings={mayHaveSettings}
      />
      <HostPluginsSection hostId={descriptor.id} hostName={hostName} connected={connected} />
      <HostPluginViewConsents hostId={descriptor.id} hostName={hostName} />
      <HostClipboardGrants hostId={descriptor.id} hostName={hostName} />

      <SettingsSection title="Remove host">
        <SettingsGroup>
          <SettingsRow
            label={isCloud ? "Remove host" : removeOutcome.label}
            description={
              isCloud
                ? cloudProvider && !canDeleteMachines(cloudProvider)
                  ? `Its machine stays in your ${cloudProvider.name} account until you delete it in ${cloudProvider.name}'s console`
                  : "Choose whether its machine stays in your cloud account or is deleted with it"
                : "Its connection here closes, windows attached to it return to this machine, and it leaves your host list"
            }
            error={removeError ?? undefined}
            control={
              <Button variant="ghost-danger" size="sm" onClick={() => setConfirmRemove(true)}>
                Remove host
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {agentSignIn && (
        <HostAgentSignInDialog
          hostId={descriptor.id}
          hostName={hostName}
          agentId={agentSignIn.agentId}
          agentName={agentSignIn.name}
          onClose={() => setAgentSignIn(null)}
        />
      )}
      {cancellingPlacement && placement && (
        <CancelCloudPlacementDialog
          hostId={descriptor.id}
          hostName={hostName}
          label={placement.label}
          status={cloud}
          provider={cloudProvider}
          initialChoice="keep"
          madeForIt={isMadeForPlacement(cloud, placement)}
          onClose={() => setCancellingPlacement(false)}
          onDeleted={() => onBack(false)}
        />
      )}
      {confirmRemove && isCloud && (
        <RemoveCloudHostDialog
          hostId={descriptor.id}
          name={hostName}
          status={cloud}
          providerName={cloudProvider?.name ?? "the provider"}
          provider={cloudProvider}
          startsOnConnect={descriptor.startsOnConnect === true}
          onClose={() => setConfirmRemove(false)}
          onRemoved={() => onBack(false)}
        />
      )}
      <ConfirmDialog
        isOpen={confirmRemove && !isCloud}
        onClose={() => setConfirmRemove(false)}
        variant="destructive"
        title={`Remove '${hostName}' from this device?`}
        description={`Its connection here closes, windows attached to it return to this machine, and its plugin permissions, history and browser data on this device are cleared. ${removeOutcome.sentence}`}
        confirmLabel="Remove host"
        onConfirm={remove}
        isConfirmLoading={removing}
      >
        {removeError && <InlineError role="alert">{removeError}</InlineError>}
      </ConfirmDialog>
      <SshSignInDialog
        hostLabel={hostName}
        state={signIn.state}
        onAnswer={signIn.answer}
        // The host's address now: it may have been changed since the last try.
        onRetry={() => signIn.start(descriptor.connection)}
        onClose={signIn.close}
      />
      {changeTargetOpen && sshTarget !== null && (
        <ChangeHostTargetDialog
          isOpen
          onClose={() => setChangeTargetOpen(false)}
          restoreFocusTo={changeTargetButtonRef}
          hostId={descriptor.id}
          hostName={hostName}
          currentTarget={sshTarget}
        />
      )}
      {updateOpen && (
        <AddHostDialog
          isOpen
          onClose={() => setUpdateOpen(null)}
          existing={{
            hostId: descriptor.id,
            name: descriptor.name,
            connection: descriptor.connection,
            intent: updateOpen,
          }}
        />
      )}
    </div>
  );
}
