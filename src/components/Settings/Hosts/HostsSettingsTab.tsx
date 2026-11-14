import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { LinkMark } from "@/components/Hosts/LinkMark";
import { hostLinkTone } from "@/components/Hosts/hostModel";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useNow } from "@/hooks/useNow";
import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { useRemoteHosts } from "@/hooks/useRemoteHosts";
import { remoteConnectionKind } from "@/lib/remoteHosts";
import { formatHostConnection, type HostConnection, type HostId } from "@shared/types/remoteHosts";
import HostModeGroup from "../HostModeGroup";
import DeviceAnswerGroup from "../DeviceAnswerGroup";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { AddHostDialog } from "./AddHostDialog";
import { HostDetail } from "./HostDetail";
import { HostsCopySettingsSection } from "./HostsCopySettingsSection";
import { CloudProvidersSection } from "./CloudProvidersSection";
import { AddCloudHostDialog } from "./AddCloudHostDialog";
import { RemoveCloudHostDialog } from "./RemoveCloudHostDialog";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { useCloudMachineActions } from "@/components/Hosts/cloud/useCloudMachineActions";
import { useCloudLifecycleNews } from "@/components/Hosts/cloud/useCloudLifecycleNews";
import {
  canCheckMachine,
  canStartMachine,
  canStopMachine,
  cloudCostFacts,
  cloudStatusLabel,
  isObservationStale,
  machineSpecLabel,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { connectionLabel, platformLabel, removeHostOutcome } from "./hostLabels";
import { bringBackMessage, canBringBack, useHostBringBacks, wakeLabel } from "./hostBringBack";
import {
  onHostSettingsRequest,
  takePendingHostSettings,
  type HostSettingsRequest,
} from "./hostSettingsRequests";
import { onHostUpdateRequest, takePendingHostUpdate } from "./hostUpdateRequests";
import {
  onHostPluginsRequest,
  takePendingHostPlugins,
  type HostPluginsRequest,
} from "./hostPluginRequests";
import { holdPluginViewRetries } from "./pluginViewConsentResets";
import { onHostCopySettingsRequest, takePendingHostCopySettings } from "./hostCopySettingsRequests";
import { clientErrorText } from "@/utils/clientAppError";

/** A to Z as people number machines (studio-2 before studio-10), like every other host list. */
const hostNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Settings → Hosts: the machines this one opens projects on, adding one, and
 * this machine's own Host mode. Device-owned: nothing here is per project.
 */
export default function HostsSettingsTab() {
  const { hosts, loaded, loadError, refresh } = useRemoteHosts();
  const [addOpen, setAddOpen] = useState(false);
  const [cloudAddOpen, setCloudAddOpen] = useState(false);
  /** A cloud host whose machine just came up: the usual check, install and Host mode steps follow. */
  const [cloudSetup, setCloudSetup] = useState<HostId | null>(null);
  const cloudSetupHost = cloudSetup
    ? (hosts.find((entry) => entry.descriptor.id === cloudSetup)?.descriptor ?? null)
    : null;
  const [detailHostId, setDetailHostId] = useState<HostId | null>(null);
  const [forgetTarget, setForgetTarget] = useState<{
    id: HostId;
    name: string;
    connection: HostConnection;
  } | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const bringBacks = useHostBringBacks();
  const cloudSnapshot = useCloudHosts().snapshot;
  const machines = useCloudMachineActions();
  const [removeCloud, setRemoveCloud] = useState<{ hostId: HostId; name: string } | null>(null);
  const providerName = (providerId: string) =>
    cloudSnapshot.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
  // Ages and staleness keep moving while no new reading arrives; only cloud hosts need it.
  const now = useNow(cloudSnapshot.hosts.length > 0);
  // One polite message for the list and a host's details alike, so a start or
  // stop finishing is heard whichever is showing, and never twice.
  const cloudNews = useCloudLifecycleNews(
    cloudSnapshot.hosts,
    (hostId) => hosts.find((entry) => entry.descriptor.id === hostId)?.descriptor.name ?? hostId
  );
  const cloudAnnouncer = (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {cloudNews}
    </div>
  );
  // Leaving a host's details puts focus back on the Details button it came
  // from (or, once removed, the list's Add host); entering from the keyboard
  // puts it on the header's way back.
  const returnFocusTo = useRef<{ hostId: HostId; visible: boolean } | null>(null);
  // Set when the details were opened from the keyboard; the detail page moves
  // focus to the header's way back once it has mounted, however late its host loads.
  const [focusBackFor, setFocusBackFor] = useState<HostId | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const confirmForget = () => {
    const target = forgetTarget;
    if (!target || forgetting) return;
    setForgetting(true);
    setForgetError(null);
    remoteHostsClient.forget(target.id).then(
      () => {
        setForgetting(false);
        // Only the dialog this answer belongs to closes.
        setForgetTarget((current) => (current?.id === target.id ? null : current));
      },
      (err: unknown) => {
        setForgetting(false);
        setForgetError(clientErrorText(err, "Couldn't remove the host"));
      }
    );
  };
  // Each "Update …" request remounts the detail so its update flow opens again.
  const [updateRequest, setUpdateRequest] = useState<{ hostId: HostId; seq: number } | null>(null);
  const [pluginsRequest, setPluginsRequest] = useState<
    (HostPluginsRequest & { seq: number }) | null
  >(null);
  const [copyRequest, setCopyRequest] = useState<{ hostId: HostId; seq: number } | null>(null);

  useEffect(() => {
    const open = (hostId: HostId) => {
      setDetailHostId(hostId);
      setUpdateRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostUpdate();
    if (pending) open(pending);
    return onHostUpdateRequest(open);
  }, []);

  useEffect(() => {
    const answer = (request: HostSettingsRequest) => {
      if (request.kind === "add") {
        setDetailHostId(null);
        setAddOpen(true);
      } else {
        setFocusBackFor(request.viaKeyboard === true ? request.hostId : null);
        setDetailHostId(request.hostId);
      }
    };
    const pending = takePendingHostSettings();
    if (pending) answer(pending);
    return onHostSettingsRequest(answer);
  }, []);

  useEffect(() => {
    if (detailHostId !== null) return undefined;
    const target = returnFocusTo.current;
    if (target === null) return undefined;
    returnFocusTo.current = null;
    const button =
      document.querySelector<HTMLElement>(`[data-host-details="${CSS.escape(target.hostId)}"]`) ??
      document.querySelector<HTMLElement>('[data-testid="hosts-add-host"]');
    button?.focus({ focusVisible: target.visible } as FocusOptions);
    return undefined;
  }, [detailHostId]);

  useEffect(() => {
    const open = (request: HostPluginsRequest) => {
      setDetailHostId(request.hostId);
      // The latest request decides what opens: an earlier update's would win otherwise.
      setUpdateRequest(null);
      setPluginsRequest((prev) => ({ ...request, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostPlugins();
    if (pending) open(pending);
    return onHostPluginsRequest(open);
  }, []);

  // A plugin view refused here and reset on this page asks again once Settings
  // has closed, not over it: this tab stays mounted until the dialog's exit ends.
  useEffect(() => holdPluginViewRetries(), []);

  useEffect(() => {
    const open = (hostId: HostId) => {
      setAddOpen(false);
      setDetailHostId(hostId);
      setUpdateRequest(null);
      setPluginsRequest(null);
      setCopyRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostCopySettings();
    if (pending) open(pending);
    return onHostCopySettingsRequest(open);
  }, []);

  const detail = detailHostId
    ? (hosts.find((entry) => entry.descriptor.id === detailHostId) ?? null)
    : null;
  if (detail) {
    const openUpdate = updateRequest?.hostId === detail.descriptor.id;
    const focusPlugins = !openUpdate && pluginsRequest?.hostId === detail.descriptor.id;
    const offerCopySettings =
      !openUpdate && !focusPlugins && copyRequest?.hostId === detail.descriptor.id;
    return (
      <>
        {cloudAnnouncer}
        <HostDetail
          key={
            openUpdate
              ? `update-${detail.descriptor.id}-${updateRequest.seq}`
              : focusPlugins
                ? `plugins-${detail.descriptor.id}-${pluginsRequest.seq}`
                : offerCopySettings
                  ? `copy-${detail.descriptor.id}-${copyRequest.seq}`
                  : `detail-${detail.descriptor.id}`
          }
          entry={detail}
          focusBackOnMount={focusBackFor === detail.descriptor.id}
          openUpdate={openUpdate}
          focusSection={focusPlugins ? pluginsRequest.sectionId : undefined}
          offerCopySettings={offerCopySettings}
          onBack={(viaKeyboard) => {
            returnFocusTo.current = { hostId: detail.descriptor.id, visible: viaKeyboard === true };
            setFocusBackFor(null);
            setDetailHostId(null);
            setUpdateRequest(null);
            setPluginsRequest(null);
            setCopyRequest(null);
          }}
        />
      </>
    );
  }

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      data-testid="hosts-add-host"
      onClick={() => setAddOpen(true)}
    >
      <Plus aria-hidden="true" />
      Add host
    </Button>
  );

  return (
    <div className="space-y-8">
      {cloudAnnouncer}
      <SettingsSection
        title="Remote hosts"
        description={
          remoteConnectionKind() === "wsl"
            ? "Linux distributions in WSL on this PC that Daintree opens projects in, with their own git, terminals and agents"
            : "Macs and Linux machines this one opens projects on, over your own SSH"
        }
        action={hosts.length > 0 ? addButton : undefined}
        id="hosts-list"
      >
        <SettingsGroup>
          {loadError ? (
            <SettingsEmptyRow
              action={
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Retry
                </Button>
              }
            >
              {loadError}
            </SettingsEmptyRow>
          ) : hosts.length === 0 ? (
            <SettingsEmptyRow action={addButton}>
              {!loaded
                ? "Loading hosts"
                : remoteConnectionKind() === "wsl"
                  ? "Add a WSL distribution to run projects and agents in it from here"
                  : "Add a Mac or Linux machine to run projects and agents on it from here"}
            </SettingsEmptyRow>
          ) : (
            [...hosts]
              .sort((a, b) => hostNameCollator.compare(a.descriptor.name, b.descriptor.name))
              .map(({ descriptor, connection }) => {
                const wake = wakeLabel(descriptor);
                const cloud = cloudStatusFor(cloudSnapshot, descriptor.id);
                // While its machine isn't running, that is the news, not the link.
                const machineDown =
                  cloud !== null && (cloud.machine !== "running" || cloud.operation !== null);
                const machineSaid = cloud ? machines.errorFor(descriptor.id) : null;
                const stale = cloud !== null && isObservationStale(cloud, now);
                const cloudSaid =
                  cloud && cloud.operation === null ? (cloud.lastError?.message ?? null) : null;
                const bringing = bringBacks.isPending(descriptor.id);
                const said = bringing
                  ? null
                  : bringBackMessage(bringBacks.outcomeFor(descriptor.id), descriptor, connection);
                return (
                  <SettingsRow
                    key={descriptor.id}
                    label={descriptor.name}
                    description={
                      <>
                        {cloud
                          ? `${providerName(cloud.providerId)} · ${cloud.accountName}`
                          : formatHostConnection(descriptor.connection)}{" "}
                        <FactSeparator />{" "}
                        {cloud
                          ? machineSpecLabel(cloud.vcpu, cloud.memoryGB)
                          : descriptor.platform
                            ? platformLabel(descriptor.platform, null)
                            : "Not seen yet"}
                        {/* The mark the host menus and sidebar draw beside the same state. */}
                        <span className="flex items-start gap-1.5">
                          <LinkMark
                            tone={hostLinkTone({
                              hostId: descriptor.id,
                              name: descriptor.name,
                              isLocal: false,
                              platform: descriptor.platform,
                              connection,
                              lastSeenAt: null,
                              summary: null,
                              isCurrent: false,
                            })}
                            className="h-4"
                          />
                          <span
                            className="min-w-0"
                            data-cloud-host-summary={cloud ? "" : undefined}
                          >
                            {cloud
                              ? // The machine first (what bills), then the link, then cost and stop time.
                                [
                                  cloudStatusLabel(cloud, stale),
                                  machineDown ? null : connectionLabel(connection),
                                  ...cloudCostFacts(cloud),
                                ]
                                  .filter((fact): fact is string => fact !== null)
                                  .map((fact, index) => (
                                    <span key={fact}>
                                      {index > 0 && (
                                        <>
                                          {" "}
                                          <FactSeparator />{" "}
                                        </>
                                      )}
                                      {fact}
                                    </span>
                                  ))
                              : connectionLabel(connection)}
                            {/* How old the reading is: a cached "stopped" never passes for now. */}
                            {cloud?.observedAt != null && (
                              <>
                                {" "}
                                <FactSeparator />{" "}
                                <TimeAgo prefix="checked " timestamp={cloud.observedAt} now={now} />
                              </>
                            )}
                            {wake && (
                              <>
                                {" "}
                                <FactSeparator /> {wake}
                              </>
                            )}
                          </span>
                        </span>
                      </>
                    }
                    error={
                      // The provider's last refusal stays until an operation succeeds, wherever it was asked
                      // from: a refused stop leaves a running machine, and this is where it says why.
                      machineSaid || said || cloudSaid ? (
                        <span role="alert">{machineSaid ?? said ?? cloudSaid}</span>
                      ) : undefined
                    }
                    control={
                      <div className="flex items-center gap-1.5">
                        {cloud && canCheckMachine(cloud, now) && (
                          <Button
                            variant="outline"
                            size="sm"
                            data-cloud-check={descriptor.id}
                            aria-label={`Check status of ${descriptor.name}'s machine`}
                            loading={machines.isPending(descriptor.id)}
                            onClick={() => machines.check(descriptor.id)}
                          >
                            Check status
                          </Button>
                        )}
                        {cloud && canStartMachine(cloud) && (
                          <Button
                            variant="outline"
                            size="sm"
                            data-cloud-start={descriptor.id}
                            aria-label={`Start ${descriptor.name}`}
                            loading={machines.isPending(descriptor.id)}
                            onClick={() => machines.start(descriptor.id)}
                          >
                            Start
                          </Button>
                        )}
                        {!cloud && (bringing || canBringBack(connection)) && (
                          // Wakes it where a wake is set up, then starts Daintree there if it can.
                          <Button
                            variant="outline"
                            size="sm"
                            data-host-bring-back={descriptor.id}
                            aria-label={`Bring back ${descriptor.name}`}
                            loading={bringing}
                            onClick={() => bringBacks.bringBack(descriptor.id)}
                          >
                            Bring back
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Details for ${descriptor.name}`}
                          data-host-details={descriptor.id}
                          onClick={(event) => {
                            setFocusBackFor(event.detail === 0 ? descriptor.id : null);
                            setDetailHostId(descriptor.id);
                          }}
                        >
                          Details
                        </Button>
                        {cloud && canStopMachine(cloud) && (
                          // Ends what runs there: the row's destructive action, before Remove.
                          <Button
                            variant="ghost-danger"
                            size="sm"
                            data-cloud-stop={descriptor.id}
                            aria-label={`Stop ${descriptor.name}`}
                            loading={machines.isPending(descriptor.id)}
                            onClick={() => machines.requestStop(descriptor.id, descriptor.name)}
                          >
                            Stop
                          </Button>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost-danger"
                              size="icon-sm"
                              aria-label={`Remove ${descriptor.name} from this device`}
                              onClick={() => {
                                // By its kind, not its status: a cloud host is never plainly forgotten.
                                if (descriptor.connection.kind === "cloud") {
                                  setRemoveCloud({ hostId: descriptor.id, name: descriptor.name });
                                  return;
                                }
                                setForgetError(null);
                                setForgetTarget({
                                  id: descriptor.id,
                                  name: descriptor.name,
                                  connection: descriptor.connection,
                                });
                              }}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          {/* The same words as its name: what a voice user says is what they see. */}
                          <TooltipContent side="bottom">{`Remove ${descriptor.name} from this device`}</TooltipContent>
                        </Tooltip>
                      </div>
                    }
                  />
                );
              })
          )}
        </SettingsGroup>
      </SettingsSection>

      <CloudProvidersSection />

      <HostsCopySettingsSection
        hosts={[...hosts]
          .sort((a, b) => hostNameCollator.compare(a.descriptor.name, b.descriptor.name))
          .map(({ descriptor, connection }) => ({
            id: descriptor.id,
            name: descriptor.name,
            connected: connection.status === "connected",
          }))}
        onOpenHost={setDetailHostId}
      />

      <HostModeGroup />

      <DeviceAnswerGroup />

      {addOpen && (
        <AddHostDialog
          isOpen
          onClose={() => setAddOpen(false)}
          onChooseCloud={() => {
            setAddOpen(false);
            setCloudAddOpen(true);
          }}
        />
      )}
      {machines.dialogs}
      {removeCloud && (
        <RemoveCloudHostDialog
          hostId={removeCloud.hostId}
          name={removeCloud.name}
          status={cloudStatusFor(cloudSnapshot, removeCloud.hostId)}
          providerName={providerName(
            cloudStatusFor(cloudSnapshot, removeCloud.hostId)?.providerId ?? "boat"
          )}
          onClose={() => setRemoveCloud(null)}
        />
      )}
      {cloudAddOpen && (
        <AddCloudHostDialog
          isOpen
          onClose={() => setCloudAddOpen(false)}
          onReady={({ hostId }) => {
            setCloudAddOpen(false);
            setCloudSetup(hostId);
          }}
        />
      )}
      {cloudSetupHost && (
        <AddHostDialog
          isOpen
          onClose={() => setCloudSetup(null)}
          existing={{
            hostId: cloudSetupHost.id,
            name: cloudSetupHost.name,
            connection: cloudSetupHost.connection,
            intent: "setup",
          }}
          connectWhenDone
        />
      )}
      <ConfirmDialog
        isOpen={forgetTarget !== null}
        onClose={() => setForgetTarget(null)}
        variant="destructive"
        title={`Remove '${forgetTarget?.name ?? "host"}' from this device?`}
        description={`Its connection here closes, windows attached to it return to this machine, and its plugin permissions, history and browser data on this device are cleared. ${removeHostOutcome(forgetTarget?.connection, forgetTarget?.name ?? "the host").sentence}`}
        confirmLabel="Remove host"
        onConfirm={confirmForget}
        isConfirmLoading={forgetting}
      >
        {forgetError && <InlineError role="alert">{forgetError}</InlineError>}
      </ConfirmDialog>
    </div>
  );
}
