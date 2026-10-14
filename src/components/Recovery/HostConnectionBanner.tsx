import { useEffect, useState } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { reconnectHost } from "@/hooks/useHostConnection";
import { selectHostBannerVariant, useHostConnectionStore } from "@/store/hostConnectionStore";
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
 * The window's link to its host, in the recovery banner family. Transient
 * states (reconnecting, checking an unanswered mutation) sit behind the 400ms
 * gate so a blip that recovers on its own never flashes a banner.
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
  const transient =
    variant === "reconnecting" || variant === "connecting" || variant === "checking";
  const transientShown = useDohertyGate(transient);
  const now = useNow(variant === "unreachable");

  if (variant === null) return null;
  if (transient && !transientShown) return null;

  const { title, description } = getHostConnectionBannerCopy(
    variant,
    hostName,
    lastSeenAt,
    now,
    detail
  );

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
    // Trying again finds the same: setting Host mode up there is what helps.
    return (
      <InlineStatusBanner
        title={title}
        description={description}
        severity="error"
        role="status"
        ariaLive="off"
        animated={false}
        action={{
          id: "set-up",
          label: "Set up…",
          variant: "primary",
          onClick: () => runHostUpdate("host", hostId),
        }}
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
