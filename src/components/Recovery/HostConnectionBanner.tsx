import { useEffect, useState } from "react";
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
  const everConnected = useHostConnectionStore((s) => s.everConnected);
  const dropped =
    everConnected &&
    (variant === "reconnecting" || variant === "unreachable" || variant === "restarting");
  const transient =
    !dropped && (variant === "connecting" || variant === "checking" || variant === "restarting");
  const droppedShown = useDeferredLoading(dropped, HOST_LINK_SETTLE_MS);
  const transientShown = useDohertyGate(transient);
  const now = useNow(variant === "unreachable" || variant === "host-mode-off");

  if (variant === null) return null;
  if (dropped && !droppedShown) return null;
  if (transient && !transientShown) return null;

  const { title, description } = getHostConnectionBannerCopy(
    variant,
    hostName,
    lastSeenAt,
    now,
    detail
  );

  if (variant === "reconnecting" || variant === "restarting" || transient) {
    // Still retrying by itself, so calm; but a drop shown at all has stalled
    // past the settle window, and Retry doesn't wait for the next dial.
    return (
      <InlineStatusBanner
        icon={Spinner}
        title={title}
        description={description}
        severity="warning"
        role="status"
        ariaLive="off"
        animated={false}
        {...(dropped
          ? {
              action: {
                id: "reconnect",
                label: "Retry",
                variant: "primary" as const,
                onClick: reconnectHost,
              },
            }
          : { actions: [] })}
      />
    );
  }

  if (variant === "version-mismatch") {
    return (
      <InlineStatusBanner
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
        action={{ id: "reconnect", label: "Retry", variant: "primary", onClick: reconnectHost }}
        trailingSlot={
          <Button variant="ghost" size="sm" onClick={() => runHostUpdate("host", hostId)}>
            Set up…
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
        severity="error"
        role="status"
        ariaLive="off"
        animated={false}
        action={{ id: "reconnect", label: "Retry", variant: "primary", onClick: reconnectHost }}
        trailingSlot={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              requestHostSettings({ kind: "detail", hostId });
              openHostsSettingsTab();
            }}
          >
            Settings…
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
        variant: "primary",
        onClick: reconnectHost,
      }}
    />
  );
}
