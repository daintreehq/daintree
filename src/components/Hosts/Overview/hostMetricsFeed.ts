import type { HostAttentionEvent, HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { notify } from "@/lib/notify";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { logWarn } from "@/utils/logger";

/**
 * Present an opted-in host's "agent waiting" through the ordinary tiers:
 * toast when this window is focused, inbox otherwise. The source host already
 * applied its own policy (off, quiet hours); this window's settings may be a
 * third host's, so only its focus and session mute apply here. Main already
 * checked the opt-in and chose this view.
 */
export function presentHostAttention(event: HostAttentionEvent): void {
  const who = event.agentName ?? "An agent";
  const where = event.projectName ? ` in ${event.projectName}` : "";
  notify({
    type: "info",
    title: `${event.hostName}: agent waiting`,
    message: `${who}${where} is waiting for input`,
    correlationId: `host-attention:${event.hostId}:${event.terminalId}`,
    context: { eventKind: "waiting", hostName: event.hostName },
    sourceHostPolicy: { quiet: event.quiet },
  });
}

function handle(event: HostMetricsEvent): void {
  if (event.type === "summary") {
    useHostMetricsStore.getState().apply(event.summary);
    return;
  }
  if (event.type === "attention") presentHostAttention(event);
}

let refs = 0;
let stop: (() => void) | null = null;

/**
 * Follow host summaries (and attention events) while anything in this view
 * needs them. Makes no calls where Remote Hosts can't exist, and seeds only
 * once remote hosts are actually in use.
 */
export function startHostMetricsFeed(): () => void {
  refs += 1;
  if (refs === 1) stop = subscribe();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs -= 1;
    if (refs === 0) {
      stop?.();
      stop = null;
    }
  };
}

function subscribe(): () => void {
  if (!isRemoteHostsSupported()) return () => {};
  const api = window.electron?.hostMetrics;
  if (!api) return () => {};
  let live = true;
  const off = api.onEvent(handle);
  const inUse = window.electron?.remoteHosts?.isInUse;
  const seed = () =>
    api
      .getSnapshots()
      .then((snapshots) => {
        if (live) useHostMetricsStore.getState().seed(snapshots);
      })
      .catch((error: unknown) => logWarn("[Hosts] Couldn't read host summaries", { error }));
  if (typeof inUse === "function") {
    void inUse()
      .then((used) => (used && live ? seed() : undefined))
      .catch(() => {});
  } else {
    void seed();
  }
  return () => {
    live = false;
    off();
  };
}

export function _resetHostMetricsFeedForTesting(): void {
  stop?.();
  stop = null;
  refs = 0;
}
