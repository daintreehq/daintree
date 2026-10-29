import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading, useDohertyGate } from "@/hooks/useDeferredLoading";
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

const LAST_SEEN_TICK_MS = 30_000;

/** Re-render on a slow tick so "last seen" keeps counting while nothing else changes. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), LAST_SEEN_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

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
  const hostId = useHostConnectionStore((s) => s.hostId);
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
    variant === "unreachable" || variant === "host-mode-off" || variant === "reconnecting"
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
