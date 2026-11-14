import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading, useDohertyGate } from "@/hooks/useDeferredLoading";
import { useNow } from "@/hooks/useNow";
import { reconnectHost } from "@/hooks/useHostConnection";
import {
  HOST_LINK_SETTLE_MS,
  selectHostBannerVariant,
  useHostConnectionStore,
} from "@/store/hostConnectionStore";
import { runHostUpdate } from "@/components/Hosts/hostUpdate";
import { olderBuildSide, updateActionLabel, updateTargetFor } from "@/components/Hosts/hostModel";
import {
  openHostsSettingsTab,
  requestHostSettings,
} from "@/components/Settings/Hosts/hostSettingsRequests";
import { getHostConnectionBannerCopy } from "./recoveryCopy";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import {
  canStartMachine,
  clockTime,
  isObservationStale,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";

/**
 * The window's link to its host, in the recovery banner family. A link that
 * was up and is retrying on its own (reconnecting, unreachable, restarting)
 * shows nothing until the drop has lasted the settle window: the panes are
 * already read-only, and most drops come back inside it. The window stays
 * one drop across back-off swaps between those variants, so they never
 * restart it. Other transient states (a first connect, checking an
 * unanswered mutation) sit behind the 400ms gate.
 *
 * Never a live region: a link retrying on back-off swaps between these
 * variants every few seconds, and each swap would be read out again. The
 * window says each change of the link once (hostConnectionAnnouncements).
 */
export function HostConnectionBanner() {
  const variant = useHostConnectionStore(selectHostBannerVariant);
  const cloudSnapshot = useCloudHosts().snapshot;
  const [startingMachine, setStartingMachine] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [checkingMachine, setCheckingMachine] = useState(false);
  const hostId = useHostConnectionStore((s) => s.hostId);
  const cloudMachine = cloudStatusFor(cloudSnapshot, hostId)?.machine ?? null;
  // A start this banner asked for is done once the provider reports the machine
  // running (or the link is already back): from there the link's own banner
  // says how the reconnect goes, and offers its own way out if ssh fails.
  useEffect(() => {
    if (startingMachine && (variant === null || cloudMachine === "running")) {
      setStartingMachine(false);
    }
  }, [startingMachine, variant, cloudMachine]);
  // Started from elsewhere (the host menu, Settings) while this window waits: dial it now.
  const lastMachine = useRef(cloudMachine);
  useEffect(() => {
    const before = lastMachine.current;
    lastMachine.current = cloudMachine;
    if (cloudMachine === "running" && before !== null && before !== "running" && variant !== null) {
      reconnectHost();
    }
  }, [cloudMachine, variant]);
  const hostName = useHostConnectionStore((s) => s.hostName ?? s.hostId ?? "");
  const lastSeenAt = useHostConnectionStore((s) => s.lastSeenAt);
  const detail = useHostConnectionStore((s) =>
    s.connection?.status === "unreachable" ? s.connection.detail : null
  );
  const mismatch = useHostConnectionStore((s) =>
    s.connection?.status === "version-mismatch" ? s.connection.mismatch : null
  );
  const everConnected = useHostConnectionStore((s) => s.everConnected);
  const dropped =
    everConnected &&
    (variant === "reconnecting" || variant === "unreachable" || variant === "restarting");
  const transient =
    !dropped && (variant === "connecting" || variant === "checking" || variant === "restarting");
  const droppedShown = useDeferredLoading(dropped, HOST_LINK_SETTLE_MS);
  const transientShown = useDohertyGate(transient);
  const now = useNow(
    variant === "unreachable" ||
      variant === "host-mode-off" ||
      variant === "reconnecting" ||
      cloudMachine !== null
  );

  if (variant === null) return null;
  if (dropped && !droppedShown) return null;
  if (transient && !transientShown) return null;

  const { title, description, contextLine } = getHostConnectionBannerCopy(
    variant,
    hostName,
    lastSeenAt,
    now,
    detail,
    mismatch === null ? null : olderBuildSide(mismatch)
  );

  // A cloud host whose machine isn't running: the way back is starting it, on
  // a press that says what it costs, never on its own.
  const cloud = cloudStatusFor(cloudSnapshot, hostId);
  const machineStarting = cloud?.operation?.kind === "starting" || startingMachine;
  const machineUnknown = cloud?.machine === "unknown" && cloud.operation === null;
  if (
    cloud &&
    hostId !== null &&
    variant !== null &&
    (machineStarting || canStartMachine(cloud) || machineUnknown)
  ) {
    const startAndReconnect = () => {
      setStartingMachine(true);
      setStartError(null);
      cloudHostsClient.startHost(hostId).then(
        // Stays "starting" until the link is back (the effect above lets go of it).
        () => reconnectHost(),
        (err: unknown) => {
          setStartingMachine(false);
          setStartError(
            isClientAppError(err) && err.userMessage
              ? err.userMessage
              : clientErrorText(err, "Couldn't start the machine")
          );
        }
      );
    };
    const checkMachine = () => {
      setCheckingMachine(true);
      setStartError(null);
      cloudHostsClient.refreshHost(hostId).then(
        () => setCheckingMachine(false),
        (err: unknown) => {
          setCheckingMachine(false);
          setStartError(
            isClientAppError(err) && err.userMessage
              ? err.userMessage
              : clientErrorText(err, "Couldn't ask about the machine")
          );
        }
      );
    };
    // An old reading says when it was made, as a clock time: an age would tick
    // inside a live region and be announced again every time it did.
    const stale = !machineStarting && isObservationStale(cloud, now);
    const checkedAt =
      cloud.observedAt !== null ? clockTime(new Date(cloud.observedAt).toISOString()) : null;
    const stateWords =
      cloud.machine === "error"
        ? stale
          ? "last reported an error"
          : "reported an error"
        : stale
          ? "last reported stopped"
          : "is stopped";
    const unknownReason = cloud.lastError?.message.replace(/\.$/, "") ?? null;
    const checkAction = {
      id: "check-machine",
      label: "Check status",
      icon: RefreshCw,
      loading: checkingMachine,
      onClick: checkMachine,
    };
    return (
      <InlineStatusBanner
        icon={machineStarting ? Spinner : undefined}
        title={
          machineStarting
            ? `Starting ${hostName}'s machine`
            : machineUnknown
              ? `Couldn't check ${hostName}'s machine`
              : `${hostName}'s machine ${stateWords}`
        }
        description={
          startError ??
          (machineStarting
            ? "This window reconnects once it's running."
            : machineUnknown
              ? // Not proof it stopped: a refused key reads the same as a deleted machine.
                `${unknownReason ? `${unknownReason}. ` : ""}It may still be running and billing ${cloud.accountName}${checkedAt ? `; last asked ${checkedAt}` : ""}.`
              : `${stale && checkedAt ? `Last checked ${checkedAt}. ` : ""}Start it to work here again. It bills ${cloud.accountName}${cloud.hourlyDollars !== null ? ` about $${cloud.hourlyDollars.toFixed(3)} an hour` : ""} while it runs.`)
        }
        severity="warning"
        role="status"
        // Shown once per stop, not on a timer: what stopped and the way back are announced.
        ariaLive="polite"
        animated={false}
        actions={
          machineStarting
            ? []
            : machineUnknown
              ? [{ ...checkAction, variant: "primary" as const }]
              : [
                  {
                    id: "start-machine",
                    label: "Start and reconnect",
                    variant: "primary",
                    onClick: startAndReconnect,
                  },
                  ...(stale ? [checkAction] : []),
                ]
        }
        trailingSlot={
          machineUnknown ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                requestHostSettings({ kind: "detail", hostId });
                openHostsSettingsTab();
              }}
            >
              Host details…
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (variant === "restarting") {
    // The host's own word that it is coming back: calm for as long as that
    // holds, and Retry doesn't wait for the next dial.
    return (
      <InlineStatusBanner
        icon={Spinner}
        title={title}
        description={description}
        severity="warning"
        role="status"
        ariaLive="off"
        animated={false}
        action={{
          id: "reconnect",
          label: "Retry",
          icon: RefreshCw,
          variant: "primary",
          onClick: reconnectHost,
        }}
      />
    );
  }

  if (transient) {
    return (
      <InlineStatusBanner
        icon={Spinner}
        title={title}
        description={description}
        severity="warning"
        role="status"
        ariaLive="off"
        animated={false}
        actions={[]}
      />
    );
  }

  if (variant === "version-mismatch") {
    // The way out is the update the host chip and Settings → Hosts offer, of
    // whichever side is behind.
    return (
      <InlineStatusBanner
        title={title}
        description={description}
        severity="warning"
        role="status"
        ariaLive="off"
        animated={false}
        actions={
          mismatch === null || hostId === null
            ? []
            : [
                {
                  id: "update",
                  label: updateActionLabel(mismatch, hostName),
                  variant: "primary",
                  onClick: () => runHostUpdate(updateTargetFor(mismatch), hostId),
                },
              ]
        }
      />
    );
  }

  if (variant === "host-mode-off" && hostId !== null) {
    // A host that is set up checks back by itself and comes back once its
    // Daintree does; Retry doesn't wait for the next check. Setting Host mode
    // up is for one that never had it.
    return (
      <InlineStatusBanner
        title={title}
        description={description}
        severity="error"
        role="status"
        ariaLive="off"
        animated={false}
        action={{
          id: "reconnect",
          label: "Retry",
          icon: RefreshCw,
          variant: "primary",
          onClick: reconnectHost,
        }}
        trailingSlot={
          // Opens the host's own set-up flow in Settings → Hosts, which turns
          // Host mode on there.
          <Button variant="ghost" size="sm" onClick={() => runHostUpdate("host", hostId)}>
            Set up Host mode…
          </Button>
        }
      />
    );
  }

  if (variant === "access-denied" && hostId !== null) {
    // Fixed outside Daintree (a key, known_hosts), then tried again; the
    // host's details show the whole of what ssh said.
    return (
      <InlineStatusBanner
        title={title}
        description={description}
        contextLine={contextLine}
        severity="error"
        role="status"
        ariaLive="off"
        animated={false}
        action={{
          id: "reconnect",
          label: "Retry",
          icon: RefreshCw,
          variant: "primary",
          onClick: reconnectHost,
        }}
        trailingSlot={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              requestHostSettings({ kind: "detail", hostId });
              openHostsSettingsTab();
            }}
          >
            Host details…
          </Button>
        }
      />
    );
  }

  return (
    <InlineStatusBanner
      title={title}
      description={description}
      severity="error"
      role="status"
      ariaLive="off"
      animated={false}
      action={{
        id: "reconnect",
        label: variant === "disconnected" ? "Connect" : "Retry",
        ...(variant !== "disconnected" && { icon: RefreshCw }),
        variant: "primary",
        onClick: reconnectHost,
      }}
    />
  );
}
