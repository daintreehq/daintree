import { useEffect, useState } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { reconnectHost } from "@/hooks/useHostConnection";
import { selectHostBannerVariant, useHostConnectionStore } from "@/store/hostConnectionStore";
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
 */
export function HostConnectionBanner() {
  const variant = useHostConnectionStore(selectHostBannerVariant);
  const hostName = useHostConnectionStore((s) => s.hostName ?? s.hostId ?? "");
  const lastSeenAt = useHostConnectionStore((s) => s.lastSeenAt);
  const transient =
    variant === "reconnecting" || variant === "connecting" || variant === "checking";
  const transientShown = useDohertyGate(transient);
  const now = useNow(variant === "unreachable");

  if (variant === null) return null;
  if (transient && !transientShown) return null;

  const { title, description } = getHostConnectionBannerCopy(variant, hostName, lastSeenAt, now);

  if (transient) {
    return (
      <InlineStatusBanner
        icon={Spinner}
        title={title}
        description={description}
        severity="warning"
        role="status"
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
        animated={false}
        actions={[]}
      />
    );
  }

  return (
    <InlineStatusBanner
      title={title}
      description={description}
      severity="error"
      role="alert"
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
