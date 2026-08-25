import type {
  AssistantAccountStatus,
  AssistantAccountStatusResult,
  AssistantAccountUnavailableReason,
} from "@shared/types/ipc/assistantAccount";

/**
 * The account panel's state machine, as data.
 *
 * Kept out of the component because the interesting part is the MAPPING — which account
 * state offers which way out — and that is worth testing without a DOM. Rendering an
 * eleven-armed conditional inline would bury the rules that actually matter, and several
 * of them are rules rather than decoration:
 *
 *  - a subscription that exists but is not granting access must NOT be answered with
 *    "buy a plan", because the user has already paid once and a second checkout is not
 *    the fix;
 *  - an account we merely could not REACH must keep reading as signed in, because the
 *    session is still there and presenting it as signed out invites a pointless re-login;
 *  - credentials that cannot be stored are a working session with a caveat, not a
 *    failure, so the panel says what will happen rather than refusing;
 *  - an action that opens a URL is offered only when there IS one, because a button that
 *    silently does nothing is worse than an absent button.
 *
 * Copy convention, per the project's microcopy rule: `headline` and `detail` are titles
 * and single-clause subtitles, so neither carries a trailing period.
 */

/** Everything the panel can offer. Ordered by intent, not by state. */
export type AssistantAccountActionId =
  "signIn" | "cancelSignIn" | "signOut" | "manageAccount" | "viewPlans" | "retry";

export type AssistantAccountTone = "neutral" | "success" | "warning" | "danger";

export interface AssistantAccountView {
  tone: AssistantAccountTone;
  headline: string;
  detail?: string;
  /** Ordered; the first is the primary action. May be empty. */
  actions: AssistantAccountActionId[];
  /** Whether the panel should still present the person as signed in. */
  presentsSignedIn: boolean;
  /** Whether something is genuinely in flight, so the panel can show progress. */
  busy: boolean;
}

/**
 * Offers a link action only when the destination exists.
 *
 * Both URLs are optional in the contract — a deployment with no accounts configured
 * returns none — and the opener declines an absent one. Without this the panel would
 * render a button that looks live and does nothing when pressed.
 */
function linkAction(
  id: AssistantAccountActionId,
  url: string | undefined
): AssistantAccountActionId[] {
  return url ? [id] : [];
}

/** Copy for the cases where Daintree cannot talk to the engine at all. */
function unavailableView(
  reason: AssistantAccountUnavailableReason,
  message: string
): AssistantAccountView {
  switch (reason) {
    case "cli-missing":
      return {
        tone: "danger",
        headline: "The assistant engine is missing",
        detail: "Accounts need the bundled engine — reinstalling Daintree restores it",
        actions: ["retry"],
        presentsSignedIn: false,
        busy: false,
      };
    case "cli-too-old":
      // The ordinary case during a rollout: Daintree vendors the engine, so a build can
      // ship one that predates accounts entirely. Saying so is the difference between
      // "update Daintree" and debugging a sign-in the binary has never heard of. There is
      // deliberately no Retry — the answer will not change until the app is updated, and
      // a retry button here would loop someone forever.
      return {
        tone: "warning",
        headline: "This build's assistant engine doesn't support accounts yet",
        detail: "Updating Daintree brings an engine that does",
        actions: [],
        presentsSignedIn: false,
        busy: false,
      };
    case "timeout":
      return {
        tone: "warning",
        headline: "The assistant didn't answer in time",
        actions: ["retry"],
        presentsSignedIn: false,
        busy: false,
      };
    case "cli-failed":
      return {
        tone: "danger",
        headline: "Couldn't read your account",
        // Main-process copy, keyed to a stable code — never raw provider text.
        detail: message,
        actions: ["retry"],
        presentsSignedIn: false,
        busy: false,
      };
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      return {
        tone: "danger",
        headline: "Couldn't read your account",
        actions: ["retry"],
        presentsSignedIn: false,
        busy: false,
      };
    }
  }
}

/**
 * States in which a credential exists on this machine.
 *
 * Someone holding one needs to be told so, and given the way out — so these are never
 * replaced by the no-accounts notice.
 */
const STATES_WITH_A_CREDENTIAL = new Set<AssistantAccountStatus["state"]>([
  "signed_in_active",
  "signed_in_subscription_required",
  "signed_in_subscription_inactive",
  "signed_in_unverified",
  "refreshing",
  "temporarily_unavailable",
  "storage_unavailable",
  "revoked",
]);

export function resolveAssistantAccountView(
  result: AssistantAccountStatusResult | null,
  opts: { loaded: boolean; loginInProgress: boolean; accountsUnavailable?: boolean }
): AssistantAccountView {
  if (opts.loginInProgress) {
    return {
      tone: "neutral",
      headline: "Finish signing in in your browser",
      detail: "Daintree is waiting for the browser to hand the sign-in back",
      actions: ["cancelSignIn"],
      presentsSignedIn: false,
      busy: true,
    };
  }

  if (!opts.loaded) {
    return {
      tone: "neutral",
      headline: "Checking your Daintree account…",
      actions: [],
      presentsSignedIn: false,
      busy: true,
    };
  }

  if (!result) {
    // Loaded, but nothing to show: the read threw. Reporting this as "checking" would
    // leave a spinner running over an operation that already gave up, with no way out.
    return {
      tone: "danger",
      headline: "Couldn't read your account",
      detail: "Something went wrong asking the assistant engine",
      actions: ["retry"],
      presentsSignedIn: false,
      busy: false,
    };
  }

  if (!result.available) return unavailableView(result.reason, result.message);

  const status = result.status;

  /**
   * The backend has no account layer, so there is nothing to sign in to.
   *
   * Its position is the design. It outranks the signed-OUT states, which report "signed
   * out" — true, useless, and an invitation to a sign-in that cannot succeed. It does
   * not outrank an engine we cannot reach, because that is a real fault and hiding it
   * behind "the assistant works" is the same lie pointing the other way. And it does not
   * outrank a credential that exists, whose owner still needs the way out.
   */
  if (opts.accountsUnavailable && !STATES_WITH_A_CREDENTIAL.has(status.state)) {
    return {
      tone: "neutral",
      headline: "This backend doesn't use accounts",
      detail: "The assistant works without signing in",
      actions: [],
      presentsSignedIn: false,
      busy: false,
    };
  }
  const account = status.links?.account;
  const subscribe = status.links?.subscribe;

  switch (status.state) {
    case "signed_in_active":
      return {
        tone: "success",
        headline: describeAccount(status),
        detail: describePlan(status),
        actions: [...linkAction("manageAccount", account), "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "signed_in_subscription_required":
      return {
        tone: "warning",
        headline: describeAccount(status),
        detail: subscribe
          ? "Choose a plan to use the assistant"
          : "This account has no plan yet, and this deployment offers no plans page",
        actions: [...linkAction("viewPlans", subscribe), "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "signed_in_subscription_inactive":
      return {
        tone: "warning",
        headline: describeAccount(status),
        // Deliberately NOT "choose a plan": this account has a subscription that is not
        // currently granting access, and sending someone to buy a second one is both
        // wrong and expensive.
        detail: "Your plan isn't granting access right now — check your billing details",
        actions: [...linkAction("manageAccount", account), "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "signed_in_unverified":
      return {
        tone: "neutral",
        headline: describeAccount(status),
        detail: "Signed in — your plan hasn't been confirmed yet",
        actions: ["retry", "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "refreshing":
      return {
        tone: "neutral",
        headline: describeAccount(status),
        detail: "Refreshing your session…",
        actions: [],
        presentsSignedIn: true,
        busy: true,
      };

    case "temporarily_unavailable":
      return {
        tone: "warning",
        headline: describeAccount(status),
        // Keeps the signed-in presentation on purpose. The credential is still here; only
        // the check failed, and showing "signed out" would push a re-login nobody needs.
        detail: lastVerifiedDetail(status),
        actions: ["retry", "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "storage_unavailable":
      return {
        tone: "warning",
        headline: describeAccount(status),
        detail: "Your login can't be saved on this machine, so it won't survive quitting",
        actions: ["retry", "signOut"],
        presentsSignedIn: true,
        busy: false,
      };

    case "revoked":
      return {
        tone: "danger",
        headline: "Your assistant access was disconnected",
        detail: "Sign in again to keep using the assistant",
        actions: ["signIn"],
        presentsSignedIn: false,
        busy: false,
      };

    case "authorizing":
      return {
        tone: "neutral",
        headline: "Finish signing in in your browser",
        actions: ["cancelSignIn"],
        presentsSignedIn: false,
        busy: true,
      };

    case "signed_out":
    case "unknown":
      return {
        tone: "neutral",
        headline: "Sign in to use the Daintree Assistant",
        actions: ["signIn"],
        presentsSignedIn: false,
        busy: false,
      };

    default: {
      // A new member of the union lands here as a TYPE error rather than silently
      // rendering as "signed out", which is the one wrong answer that looks plausible.
      const exhaustive: never = status.state;
      void exhaustive;
      return {
        tone: "neutral",
        headline: "Sign in to use the Daintree Assistant",
        actions: ["signIn"],
        presentsSignedIn: false,
        busy: false,
      };
    }
  }
}

/** The account's own line: an email when there is one, else something honest. */
function describeAccount(status: AssistantAccountStatus): string {
  return status.email ?? "Signed in to your Daintree account";
}

function describePlan(status: AssistantAccountStatus): string | undefined {
  const parts: string[] = [];
  if (status.planId) parts.push(`${status.planId} plan`);
  if (status.usageRemaining) parts.push(`${status.usageRemaining} left`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function lastVerifiedDetail(status: AssistantAccountStatus): string {
  // Names WHEN it was last confirmed rather than claiming a current verdict, so the
  // staleness is visible instead of implied.
  return status.lastVerifiedAt
    ? `Couldn't check your plan just now — last confirmed ${relativeTime(status.lastVerifiedAt)}`
    : "Couldn't check your plan just now";
}

/**
 * Local, dependency-free relative time.
 *
 * Kept here rather than reaching for the shared helper so the view model stays pure and
 * testable with an injected clock.
 */
function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
