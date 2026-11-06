import type { HostAttentionEvent } from "@shared/types/ipc/hostMetrics";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";

const HOST_ATTENTION_TOAST_MS = 12_000;

/**
 * Present an opted-in host's "agent waiting" through the ordinary tiers:
 * toast when this window is focused, inbox otherwise. Main already judged it
 * by this machine's settings (off, quiet hours), checked the opt-in and chose
 * this view, so only its focus and session mute apply here; one main paged
 * for with a banner goes only to the inbox.
 */
export function presentHostAttention(event: HostAttentionEvent): void {
  const who = event.agentName ?? "An agent";
  const where = event.projectName ? ` in ${event.projectName}` : "";
  // The host's own ids, so the way there is a switch to that host rather than
  // this view's Go to source; a host that couldn't name the project offers none.
  const goTo =
    event.projectId === null
      ? null
      : { hostId: event.hostId, projectId: event.projectId, terminalId: event.terminalId };
  notify({
    type: "info",
    title: `${event.hostName}: agent waiting`,
    message: `${who}${where} is waiting for input`,
    correlationId: `host-attention:${event.hostId}:${event.terminalId}`,
    context: { eventKind: "waiting", hostName: event.hostName },
    sourceHostPolicy: { quiet: event.quiet },
    ...(event.pagedNatively ? { pagedNatively: true } : {}),
    ...(goTo
      ? {
          // Timed like a local agent's waiting toast; the inbox entry keeps the action.
          duration: HOST_ATTENTION_TOAST_MS,
          action: {
            label: "Go to terminal",
            actionId: "host.switch",
            actionArgs: goTo,
            onClick: () => void actionService.dispatch("host.switch", goTo, { source: "user" }),
          },
        }
      : // A repeat for the same terminal merges into a toast still showing, so
        // one with nowhere to go clears the action an earlier one gave it.
        { action: undefined }),
  });
}

let refs = 0;
let stop: (() => void) | null = null;

/**
 * Present opted-in hosts' attention events while anything in this view owns
 * them. Main sends each to one view; summaries on the same channel are left
 * to whatever shows host figures (`useHostFigures`).
 */
export function startHostAttentionFeed(): () => void {
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
  if (!isRemoteShellSupported()) return () => {};
  const api = window.electron?.hostMetrics;
  if (!api) return () => {};
  return api.onEvent((event) => {
    if (event.type === "attention") presentHostAttention(event);
  });
}

export function _resetHostAttentionFeedForTesting(): void {
  stop?.();
  stop = null;
  refs = 0;
}
