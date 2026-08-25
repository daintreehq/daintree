import { describe, expect, it } from "vitest";
import type {
  AssistantAccountState,
  AssistantAccountStatusResult,
} from "@shared/types/ipc/assistantAccount";

import { resolveAssistantAccountView } from "../assistantAccountView";

const LOADED = { loaded: true, loginInProgress: false };

const LINKS = {
  account: "https://daintree.org/account",
  subscribe: "https://daintree.org/subscribe",
};

function statusOf(
  state: AssistantAccountState,
  extra: Record<string, unknown> = {}
): AssistantAccountStatusResult {
  return {
    available: true,
    status: {
      state,
      authenticated: state.startsWith("signed_in"),
      storageTier: "keychain",
      // Links present by default: the interesting cases are the ones that OMIT them, and
      // a fixture that never supplies any would quietly assert the no-link behaviour
      // everywhere while claiming to test the normal path.
      links: LINKS,
      ...extra,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/**
 * Every state the CLI can report.
 *
 * Declared as a `Record` keyed by the union rather than an array, so adding a member to
 * `AssistantAccountState` fails to COMPILE here until it is listed. An array would accept
 * a stale list forever and the exhaustiveness this file claims would quietly rot.
 */
const STATE_PRESENCE: Record<AssistantAccountState, true> = {
  unknown: true,
  signed_out: true,
  authorizing: true,
  signed_in_unverified: true,
  signed_in_active: true,
  signed_in_subscription_required: true,
  signed_in_subscription_inactive: true,
  refreshing: true,
  temporarily_unavailable: true,
  revoked: true,
  storage_unavailable: true,
};
const ALL_STATES = Object.keys(STATE_PRESENCE) as AssistantAccountState[];

describe("resolveAssistantAccountView", () => {
  it("gives every account state a headline and a defined shape", () => {
    for (const state of ALL_STATES) {
      const view = resolveAssistantAccountView(statusOf(state), LOADED);
      expect(view.headline, `${state} has no headline`).toBeTruthy();
      expect(Array.isArray(view.actions), `${state} has no actions array`).toBe(true);
    }
  });

  it("offers a way forward from every state that is not simply working", () => {
    for (const state of ALL_STATES) {
      const view = resolveAssistantAccountView(statusOf(state), LOADED);
      // A dead end is the one thing the panel must never be: if the account is not
      // usable and nothing is in flight, there has to be something to press.
      if (!view.busy && state !== "signed_in_active") {
        expect(view.actions.length, `${state} is a dead end`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The same rule for the engine-side failures, with ONE deliberate exception:
   * `cli-too-old` has no action because the answer cannot change until Daintree is
   * updated, and a Retry there would loop someone against a binary that will never
   * respond differently.
   */
  it("offers a way forward from every unavailable reason except an engine that is too old", () => {
    const reasons = ["cli-missing", "cli-failed", "timeout"] as const;
    for (const reason of reasons) {
      const view = resolveAssistantAccountView({ available: false, reason, message: "x" }, LOADED);
      expect(view.actions.length, `${reason} is a dead end`).toBeGreaterThan(0);
    }
    const tooOld = resolveAssistantAccountView(
      { available: false, reason: "cli-too-old", message: "x" },
      LOADED
    );
    expect(tooOld.actions).toHaveLength(0);
    // It must still explain what to do, even though there is nothing to press.
    expect(tooOld.detail).toBeTruthy();
  });

  /**
   * The rule that costs money if it is wrong: an account whose subscription exists but
   * is not currently granting access must not be answered with "buy a plan".
   */
  it("does not suggest a second purchase for an inactive subscription", () => {
    const view = resolveAssistantAccountView(statusOf("signed_in_subscription_inactive"), LOADED);
    expect(view.actions).not.toContain("viewPlans");
    expect(view.actions).toContain("manageAccount");
  });

  it("does send an account with no plan at all to the plans page", () => {
    const view = resolveAssistantAccountView(statusOf("signed_in_subscription_required"), LOADED);
    expect(view.actions).toContain("viewPlans");
  });

  /**
   * A button whose destination does not exist is worse than an absent one: it looks live,
   * and pressing it does nothing at all. Both links are optional in the contract — a
   * deployment with no accounts configured returns neither.
   */
  it("offers no link action when the backend supplied no link", () => {
    const noLinks = { links: undefined };
    expect(
      resolveAssistantAccountView(statusOf("signed_in_subscription_required", noLinks), LOADED)
        .actions
    ).not.toContain("viewPlans");
    expect(
      resolveAssistantAccountView(statusOf("signed_in_active", noLinks), LOADED).actions
    ).not.toContain("manageAccount");
    expect(
      resolveAssistantAccountView(statusOf("signed_in_subscription_inactive", noLinks), LOADED)
        .actions
    ).not.toContain("manageAccount");
  });

  it("says why there is nowhere to go when the plans page is missing", () => {
    const withLink = resolveAssistantAccountView(
      statusOf("signed_in_subscription_required"),
      LOADED
    );
    const without = resolveAssistantAccountView(
      statusOf("signed_in_subscription_required", { links: undefined }),
      LOADED
    );
    expect(without.detail).not.toEqual(withLink.detail);
    expect(without.detail).toBeTruthy();
  });

  /**
   * A read that threw leaves `loaded` true with nothing to show. Reporting that as
   * "checking" would spin forever over an operation that already gave up.
   */
  it("reports a thrown read as a failure with a way out, not as still checking", () => {
    const view = resolveAssistantAccountView(null, LOADED);
    expect(view.busy).toBe(false);
    expect(view.actions).toContain("retry");
  });

  /**
   * A check that failed is not a sign-out. The credential is still there, so presenting
   * the person as signed out would push a re-login nobody needs.
   */
  it("keeps a signed-in presentation when the account merely could not be reached", () => {
    const view = resolveAssistantAccountView(statusOf("temporarily_unavailable"), LOADED);
    expect(view.presentsSignedIn).toBe(true);
    expect(view.actions).toContain("retry");
    expect(view.actions).not.toContain("signIn");
  });

  it("names when the plan was last confirmed, so staleness is visible", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const withTime = resolveAssistantAccountView(
      statusOf("temporarily_unavailable", { lastVerifiedAt: iso }),
      LOADED
    );
    const without = resolveAssistantAccountView(statusOf("temporarily_unavailable"), LOADED);
    expect(withTime.detail).not.toEqual(without.detail);
    expect(withTime.detail).toContain("3h ago");
  });

  it("treats unstorable credentials as a working session with a caveat", () => {
    const view = resolveAssistantAccountView(statusOf("storage_unavailable"), LOADED);
    expect(view.presentsSignedIn).toBe(true);
    // The consequence has to be stated — the session works now and vanishes on quit.
    expect(view.detail).toBeTruthy();
  });

  it("asks a revoked account to sign in again rather than offering a retry", () => {
    const view = resolveAssistantAccountView(statusOf("revoked"), LOADED);
    expect(view.actions).toContain("signIn");
    expect(view.presentsSignedIn).toBe(false);
  });

  it("shows a cancel, and only a cancel, while a sign-in is running", () => {
    const view = resolveAssistantAccountView(null, { loaded: true, loginInProgress: true });
    expect(view.actions).toEqual(["cancelSignIn"]);
    expect(view.busy).toBe(true);
  });

  it("reports checking before the first read resolves", () => {
    const view = resolveAssistantAccountView(null, { loaded: false, loginInProgress: false });
    expect(view.busy).toBe(true);
    expect(view.actions).toHaveLength(0);
  });

  /**
   * An engine that predates accounts is a build problem, not a sign-in problem. Offering
   * "Retry" there would loop someone forever against a binary that will never answer.
   */
  it("distinguishes an engine too old from an engine that failed", () => {
    const tooOld = resolveAssistantAccountView(
      { available: false, reason: "cli-too-old", message: "x" },
      LOADED
    );
    const failed = resolveAssistantAccountView(
      { available: false, reason: "cli-failed", message: "x" },
      LOADED
    );
    expect(tooOld.actions).toHaveLength(0);
    expect(failed.actions).toContain("retry");
    expect(tooOld.headline).not.toEqual(failed.headline);
  });

  it("renders each unavailable reason distinctly", () => {
    const reasons = ["cli-missing", "cli-too-old", "cli-failed", "timeout"] as const;
    const headlines = reasons.map(
      (reason) =>
        resolveAssistantAccountView({ available: false, reason, message: "detail" }, LOADED)
          .headline
    );
    expect(new Set(headlines).size).toBe(reasons.length);
  });

  it("shows the plan and remaining usage when there is one", () => {
    const view = resolveAssistantAccountView(
      statusOf("signed_in_active", {
        email: "person@example.com",
        planId: "standard",
        usageRemaining: "12,000 credits",
      }),
      LOADED
    );
    expect(view.headline).toContain("person@example.com");
    expect(view.detail).toContain("standard");
    expect(view.detail).toContain("12,000 credits");
  });

  it("still identifies the account when the backend supplied no email", () => {
    const view = resolveAssistantAccountView(statusOf("signed_in_active"), LOADED);
    expect(view.headline).toBeTruthy();
    expect(view.presentsSignedIn).toBe(true);
  });

  /** Microcopy rule: a headline is a title, so it carries no trailing full stop. */
  it("writes headlines as titles, without a trailing period", () => {
    for (const state of ALL_STATES) {
      const view = resolveAssistantAccountView(statusOf(state), LOADED);
      expect(view.headline.endsWith("."), `${state}: "${view.headline}"`).toBe(false);
    }
  });

  /**
   * A backend with no account layer.
   *
   * It reports "signed out", which is true and useless: the panel offered a Sign in
   * that could not succeed, and taking the offer produced "Sign-in did not complete" —
   * a fault, where the deployment was working exactly as designed and serving the
   * assistant anonymously.
   */
  describe("when the backend has no accounts", () => {
    const NO_ACCOUNTS = { ...LOADED, accountsUnavailable: true };

    it("offers nothing to do, because there is nothing to do", () => {
      const view = resolveAssistantAccountView(statusOf("signed_out"), NO_ACCOUNTS);
      expect(view.actions).toEqual([]);
      expect(view.presentsSignedIn).toBe(false);
    });

    it("reads as a plain fact rather than a problem", () => {
      const view = resolveAssistantAccountView(statusOf("signed_out"), NO_ACCOUNTS);
      // Neutral: nothing is wrong. `warning` or `danger` would put a coloured dot next
      // to a working backend.
      expect(view.tone).toBe("neutral");
      expect(view.busy).toBe(false);
      expect(view.headline.endsWith(".")).toBe(false);
    });

    it("outranks the signed-out states, which have nothing useful to say", () => {
      // "Signed out" against a backend with no accounts is true and useless: it invites
      // a sign-in that cannot succeed. Those are the states this replaces.
      for (const state of ["signed_out", "unknown"] as const) {
        const view = resolveAssistantAccountView(statusOf(state), NO_ACCOUNTS);
        expect(view.actions, state).toEqual([]);
        expect(view.tone, state).toBe("neutral");
      }
    });

    it("does not hide a credential that exists", () => {
      // Someone holding a credential still needs to be told they hold it. Replacing that
      // with "nothing to sign in to" would strand them: no account named, and no way out
      // offered for the one they can see is there.
      //
      // Asserted as "the view is not replaced" rather than "Sign out is offered": a
      // refresh in flight legitimately offers nothing while it runs, and that is a
      // different rule from this one.
      const replaced = resolveAssistantAccountView(statusOf("signed_out"), NO_ACCOUNTS).headline;
      for (const state of ALL_STATES) {
        // The three that describe no credential: two the notice is FOR, and `authorizing`
        // — a sign-in still in flight, which the loginInProgress branch above answers
        // first and which carries nothing to preserve if it is merely a stale status.
        if (state === "signed_out" || state === "unknown" || state === "authorizing") continue;
        const view = resolveAssistantAccountView(statusOf(state), NO_ACCOUNTS);
        expect(view.headline, state).not.toBe(replaced);
      }
    });

    it("does not hide an engine it cannot reach", () => {
      // A real fault, and "the assistant works without signing in" is the same lie as
      // the one this whole state exists to correct, only pointing the other way.
      const view = resolveAssistantAccountView(
        { available: false, reason: "cli-missing", message: "gone" },
        NO_ACCOUNTS
      );
      expect(view.tone).toBe("danger");
      expect(view.actions).toContain("retry");
    });

    it("still yields to an in-flight sign-in", () => {
      // Ordering guard: a login in progress is the more immediate truth, and this state
      // is only ever set by one of those coming back.
      const view = resolveAssistantAccountView(statusOf("signed_out"), {
        ...NO_ACCOUNTS,
        loginInProgress: true,
      });
      expect(view.busy).toBe(true);
      expect(view.actions).toContain("cancelSignIn");
    });
  });
});
