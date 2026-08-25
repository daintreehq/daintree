import type { AssistantAccountStatusResult } from "@shared/types/ipc/assistantAccount";

/**
 * Whether the assistant may boot, given what is known about the account.
 *
 * The point of the gate is narrow: do not spawn a paid engine that can only receive
 * 401s and 402s. It is NOT a general availability check — doc-level rule and repo
 * convention agree that CLI availability and account state are separate questions, so a
 * present-but-signed-out engine is still `ready` and still launchable in principle. Only
 * the account decides whether launching would achieve anything.
 *
 * It FAILS OPEN, deliberately and importantly. Today's backend has no account system at
 * all: discovery reports `configured: false`, the CLI carries on anonymously, and every
 * turn works. A gate that treated "no account" as "cannot run" would break the assistant
 * for every current user in order to enforce a policy that is not switched on yet. So
 * anything ambiguous — a read that failed, an engine too old to answer, a session that
 * could not be checked — launches. Only an unambiguous "you must act first" holds it
 * back, and in that case the panel says so instead of booting.
 */

export type AssistantLaunchGateReason =
  "signed-out" | "subscription-required" | "subscription-inactive" | "revoked";

export type AssistantLaunchGate =
  { gated: false } | { gated: true; reason: AssistantLaunchGateReason };

const OPEN: AssistantLaunchGate = { gated: false };

export function resolveAssistantLaunchGate(
  result: AssistantAccountStatusResult | null
): AssistantLaunchGate {
  // Nothing known yet, or the engine could not answer. Both launch: see the fail-open
  // rule above. A wrong "no" here is a broken product; a wrong "yes" is one clear error
  // message in a panel that is already built to show them.
  if (!result || !result.available) return OPEN;

  const status = result.status;

  switch (status.state) {
    /**
     * The billing states, gated only when there is somewhere to send the user.
     *
     * A gate whose single action does nothing is worse than no gate: it replaces a panel
     * that would at least show the backend's own 402 — with its own recovery — with a
     * dead screen and a button that silently returns. Both URLs are optional in the
     * manifest and both vanish when the manifest lookup fails, so absent is a real case.
     */
    case "signed_in_subscription_required":
      return status.links?.subscribe ? { gated: true, reason: "subscription-required" } : OPEN;
    case "signed_in_subscription_inactive":
      return status.links?.account ? { gated: true, reason: "subscription-inactive" } : OPEN;

    case "revoked":
      return { gated: true, reason: "revoked" };

    case "signed_out":
      /**
       * The case that needs a second signal, and the signal is NOT the links.
       *
       * Links only prove that account discovery succeeded — that this deployment HAS
       * accounts. They say nothing about whether it refuses anonymous callers, and the
       * manifest tracks those separately: `configured` and `required`. A backend part way
       * through a staged rollout is `configured: true, required: false` — accounts exist,
       * anonymous work still succeeds — and gating on links there would stop the
       * assistant for every signed-out user of a backend that would have served them
       * perfectly well.
       *
       * So this gates on `authRequired`, which is that second flag, and only on an
       * explicit `true`. Absent means the engine did not say — the current case, since
       * the CLI does not surface it yet — and unknown must never become a refusal.
       */
      return status.authRequired === true ? { gated: true, reason: "signed-out" } : OPEN;

    // Signed in and working, in flight, or merely unverifiable — all launch. An
    // unverified plan is not a refusal: the backend answers 401/402 if it disagrees, and
    // that answer arrives in the panel with its own recovery.
    case "signed_in_active":
    case "signed_in_unverified":
    case "refreshing":
    case "authorizing":
    case "temporarily_unavailable":
    case "storage_unavailable":
    case "unknown":
      return OPEN;

    default: {
      // A new account state launches rather than blocking, and fails to COMPILE here so
      // the decision is made deliberately rather than inherited.
      const exhaustive: never = status.state;
      void exhaustive;
      return OPEN;
    }
  }
}
