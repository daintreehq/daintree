import type { HostBringBackArgs, HostBringBackResult } from "../../../shared/types/hostControl.js";
import type { HostBringBackAnswer, HostBringBackStatus } from "../../../shared/types/hostWake.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { isAppError } from "../../utils/errorTypes.js";

export interface HostBringBackToolDeps {
  /** The hosts this Shell knows, by id. */
  hostIds(): readonly HostId[];
  /** The person's "assistant control" switch for the host. */
  controlOn(hostId: HostId): boolean;
  /** The Shell's shared attempt (`HostBringBackService`); absent where Remote Hosts can't reach hosts. */
  bringBack?(hostId: HostId): Promise<HostBringBackAnswer>;
}

const LOCAL_DETAIL = "local is this machine, which is always here. Name a host from host.list.";
const NO_HOST_DETAIL = "No host has that id here. host.list names them.";
const CONTROL_OFF_DETAIL =
  "The person turned assistant control off for this host, so it isn't brought back for you.";
const UNSUPPORTED_DETAIL = "Hosts can't be brought back from this machine.";

/** What each answer means and what to do next; fixed text, never what a host said. */
export const HOST_BRING_BACK_DETAILS: Record<HostBringBackStatus, string> = {
  connected: "The link is up. Call the host.",
  woken: "A wake was sent, then the link came up. Call the host.",
  started: "Daintree was started there in Host mode, and the link is up. Call the host.",
  unreachable:
    "ssh couldn't log in, or this connection can't be used from here (observed has its words). Only the person can fix that; use another host meanwhile.",
  not_wakeable:
    "ssh didn't reach it, and no wake could be sent from here (see wake). Use another host, or ask the person to set up its wake in Settings > Hosts.",
  not_startable:
    "ssh reached it, but Daintree there wasn't started (observed says what was seen). Only the person can fix that there; use another host meanwhile.",
  version_mismatch:
    "It answered on another protocol version, so the link can't be used until one side is updated.",
  timed_out:
    "It wasn't back within the attempt's time and may still come up: host.watch tells you when it connects.",
  cancelled: "The host was disconnected, removed or changed while it was being brought back.",
};

function refusal(
  outcome: "not_found" | "opted_out" | "unsupported",
  detail: string
): HostBringBackResult {
  return { outcome, detail, retryAfterMs: null, answer: null };
}

/** `host.bringBack` for one of this machine's assistants (#16170): the Shell's own attempt, joined. */
export async function runHostBringBack(
  deps: HostBringBackToolDeps,
  args: HostBringBackArgs
): Promise<HostBringBackResult> {
  const { hostId } = args;
  if (hostId === LOCAL_HOST_ID) return refusal("unsupported", LOCAL_DETAIL);
  const bringBack = deps.bringBack;
  if (!bringBack) return refusal("unsupported", UNSUPPORTED_DETAIL);
  if (!deps.hostIds().includes(hostId)) return refusal("not_found", NO_HOST_DETAIL);
  if (!deps.controlOn(hostId)) return refusal("opted_out", CONTROL_OFF_DETAIL);
  let answer: HostBringBackAnswer;
  try {
    answer = await bringBack(hostId);
  } catch (error) {
    // Removed between the look above and the attempt.
    if (isAppError(error) && error.code === "NOT_FOUND") return refusal("not_found", NO_HOST_DETAIL);
    throw error;
  }
  return {
    outcome: "ok",
    detail: HOST_BRING_BACK_DETAILS[answer.status],
    retryAfterMs: null,
    answer,
  };
}
