import type {
  HostControlOutcomeCode,
  HostStartAgentSignInArgs,
  HostStartAgentSignInResult,
} from "../../../shared/types/hostControl.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import type { SignInOfferAnswer } from "../canopy/client.js";

/** One of this Shell's hosts, as `host.startAgentSignIn` needs it. */
export interface SignInHost {
  connected: boolean;
  /**
   * The CLIs it reports installed on the link open now, as Settings → Hosts
   * lists them; null when it has reported none on this link yet.
   */
  agentIds: readonly string[] | null;
}

export interface HostAgentSignInToolDeps {
  host(hostId: HostId): SignInHost | null;
  /** The person's "assistant control" switch for the host. */
  controlOn(hostId: HostId): boolean;
  /**
   * Starts it in the window showing the caller and waits until that window
   * opens it; absent where this Shell can't start sign-ins on hosts.
   */
  offer?(hostId: HostId, agentId: string, signal?: AbortSignal): Promise<SignInOfferAnswer>;
}

const LOCAL_DETAIL =
  "local is this machine, whose CLIs sign in from its own terminals. Name a host from host.list.";
const UNAVAILABLE_DETAIL = "Sign-ins can't be started on hosts from this machine.";
const NO_HOST_DETAIL = "No host has that id here. host.list names them.";
const CONTROL_OFF_DETAIL =
  "The person turned assistant control off for this host, so no sign-in was started there.";
const DISCONNECTED_DETAIL =
  "The host isn't connected, so no sign-in was started. host.bringBack can try to bring it back.";
const UNREPORTED_DETAIL =
  "The host hasn't reported its installed CLIs on this link yet, so no sign-in was started. List hosts again shortly.";
const NOT_INSTALLED_DETAIL =
  "The host doesn't report that CLI installed, so no sign-in was started. host.list names its installed CLIs by agentId.";

/** What each answer means and what to do next; fixed text, never anything the host or window said. */
const ANSWERS: Record<
  SignInOfferAnswer,
  { outcome: HostControlOutcomeCode; detail: string }
> = {
  shown: {
    outcome: "ok",
    detail:
      "A terminal on the host is running that CLI's own sign-in, open in the window showing you. The person finishes it there, the browser approval and any code included. Nothing here says whether it worked: ask them.",
  },
  withdrawn: {
    outcome: "conflict",
    detail:
      "It ended before the window opened it: closed there, refused over another sign-in open there, or its link or window went. Nothing is left running.",
  },
  busy: {
    outcome: "conflict",
    detail:
      "A sign-in is already open in the window showing you, so no other was started. Ask the person to finish or close it first.",
  },
  expired: {
    outcome: "expired",
    detail:
      "The window didn't open it in time, so it was ended on the host. Ask the person to bring up the window showing you, then call again.",
  },
  cancelled: {
    outcome: "expired",
    detail: "The call was cancelled before the window opened it, so it was ended on the host.",
  },
  no_window: {
    outcome: "policy_rejected",
    detail:
      "No window on screen shows you, so no sign-in was started. Ask the person to bring up the window showing you, then call again.",
  },
  unsupported: {
    outcome: "unsupported",
    detail: "That host's Daintree is too old to start sign-ins from here. It needs a newer Daintree.",
  },
  disconnected: { outcome: "disconnected", detail: DISCONNECTED_DETAIL },
  rate_limited: {
    outcome: "rate_limited",
    detail:
      "That host already runs as many sign-ins as it allows. Ask the person to finish or close one first.",
  },
  failed: {
    outcome: "conflict",
    detail:
      "The host couldn't start that CLI's sign-in. The person can try it from the CLI's row in Settings > Hosts.",
  },
};

function answer(outcome: HostControlOutcomeCode, detail: string): HostStartAgentSignInResult {
  return { outcome, detail, retryAfterMs: null };
}

/**
 * `host.startAgentSignIn` for one of this machine's assistants (#18197): the
 * same sign-in the CLI's row in Settings → Hosts opens, and only for a CLI
 * that row lists, so the host's own registry names what runs. It answers with
 * what was observed, never whether the person is signed in.
 */
export async function runHostAgentSignIn(
  deps: HostAgentSignInToolDeps,
  args: HostStartAgentSignInArgs,
  signal?: AbortSignal
): Promise<HostStartAgentSignInResult> {
  const { hostId, agentId } = args;
  if (hostId === LOCAL_HOST_ID) return answer("unsupported", LOCAL_DETAIL);
  const offer = deps.offer;
  if (!offer) return answer("unsupported", UNAVAILABLE_DETAIL);
  const host = deps.host(hostId);
  if (host === null) return answer("not_found", NO_HOST_DETAIL);
  if (!deps.controlOn(hostId)) return answer("opted_out", CONTROL_OFF_DETAIL);
  if (!host.connected) return answer("disconnected", DISCONNECTED_DETAIL);
  if (host.agentIds === null) return answer("not_found", UNREPORTED_DETAIL);
  if (!host.agentIds.includes(agentId)) return answer("not_found", NOT_INSTALLED_DETAIL);
  const { outcome, detail } = ANSWERS[await offer(hostId, agentId, signal)];
  return { outcome, detail, retryAfterMs: null };
}
