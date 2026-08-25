import { describe, expect, it } from "vitest";
import type {
  AssistantAccountState,
  AssistantAccountStatusResult,
  AssistantAccountUnavailableReason,
} from "@shared/types/ipc/assistantAccount";

import { resolveAssistantLaunchGate } from "../assistantLaunchGate";

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
      links: LINKS,
      ...extra,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/** Adding a state to the union must force a launch decision here, not inherit one. */
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

describe("resolveAssistantLaunchGate", () => {
  /**
   * THE most important behaviour in this file.
   *
   * Today's backend has no account system: discovery reports `configured: false`, the CLI
   * runs anonymously, and every turn works. A gate that blocked on "no account" would
   * break the assistant for every current user to enforce a policy that is not switched
   * on. Being signed out only counts when the backend actually REFUSES anonymous callers.
   */
  it("launches for a signed-out install when the engine did not say auth is required", () => {
    expect(resolveAssistantLaunchGate(statusOf("signed_out")).gated).toBe(false);
  });

  /**
   * The trap this replaced: gating on the presence of account links.
   *
   * Links prove only that discovery SUCCEEDED — that the deployment has accounts. The
   * manifest tracks "has accounts" (`configured`) and "refuses anonymous callers"
   * (`required`) separately, and part way through a staged rollout a backend is
   * configured but not required. Links are present there, and gating on them would stop
   * every signed-out user of a backend that would have served them fine.
   */
  it("launches for a signed-out install that has accounts but does not require them", () => {
    const gate = resolveAssistantLaunchGate(
      statusOf("signed_out", { links: LINKS, authRequired: false })
    );
    expect(gate.gated).toBe(false);
  });

  it("holds back a signed-out install whose backend refuses anonymous callers", () => {
    const gate = resolveAssistantLaunchGate(statusOf("signed_out", { authRequired: true }));
    expect(gate.gated).toBe(true);
    expect(gate.gated && gate.reason).toBe("signed-out");
  });

  it("treats the zero-value links object as no links at all", () => {
    expect(resolveAssistantLaunchGate(statusOf("signed_out", { links: {} })).gated).toBe(false);
    expect(
      resolveAssistantLaunchGate(statusOf("signed_in_subscription_required", { links: {} })).gated
    ).toBe(false);
  });

  it("launches when nothing is known yet", () => {
    expect(resolveAssistantLaunchGate(null).gated).toBe(false);
  });

  it("launches when the engine could not answer at all", () => {
    const reasons: AssistantAccountUnavailableReason[] = [
      "cli-missing",
      "cli-too-old",
      "cli-failed",
      "timeout",
    ];
    for (const reason of reasons) {
      const gate = resolveAssistantLaunchGate({ available: false, reason, message: "x" });
      expect(gate.gated, `${reason} blocked the assistant`).toBe(false);
    }
  });

  /**
   * The gate's actual job: never spawn a paid engine that could only collect 402s.
   */
  it("holds back the states that can only produce a billing failure", () => {
    expect(resolveAssistantLaunchGate(statusOf("signed_in_subscription_required"))).toEqual({
      gated: true,
      reason: "subscription-required",
    });
    expect(resolveAssistantLaunchGate(statusOf("signed_in_subscription_inactive"))).toEqual({
      gated: true,
      reason: "subscription-inactive",
    });
  });

  /**
   * A gate whose only action does nothing is worse than no gate: it replaces a panel that
   * would at least show the backend's own 402 and its recovery with a dead screen.
   */
  it("does not gate a billing state it has no way to resolve", () => {
    expect(
      resolveAssistantLaunchGate(
        statusOf("signed_in_subscription_required", { links: { account: LINKS.account } })
      ).gated
    ).toBe(false);
    expect(
      resolveAssistantLaunchGate(
        statusOf("signed_in_subscription_inactive", { links: { subscribe: LINKS.subscribe } })
      ).gated
    ).toBe(false);
  });

  it("holds back a revoked account", () => {
    expect(resolveAssistantLaunchGate(statusOf("revoked"))).toEqual({
      gated: true,
      reason: "revoked",
    });
  });

  /**
   * An unconfirmed plan is not a refusal. The CLI cannot currently report entitlement at
   * all, so treating "unverified" as "blocked" would gate every signed-in user.
   */
  it("launches for a session it merely could not verify", () => {
    for (const state of [
      "signed_in_active",
      "signed_in_unverified",
      "refreshing",
      "temporarily_unavailable",
      "storage_unavailable",
      "authorizing",
      "unknown",
    ] as const) {
      expect(resolveAssistantLaunchGate(statusOf(state)).gated, `${state} blocked`).toBe(false);
    }
  });

  it("blocks only the states that name a user action, given everything it needs", () => {
    const blocked = ALL_STATES.filter(
      (s) => resolveAssistantLaunchGate(statusOf(s, { authRequired: true })).gated
    );
    expect(blocked.sort()).toEqual(
      [
        "revoked",
        "signed_in_subscription_inactive",
        "signed_in_subscription_required",
        "signed_out",
      ].sort()
    );
  });
});
