import { describe, expect, it } from "vitest";
import {
  DECISIONS_SETUP_CHECK_STEPS,
  type DecisionsSetupCheckObservations,
  type DecisionsSetupCheckStep,
} from "@shared/types/decisions";
import { SETUP_STEP_LABEL, describeSetupStep, unfinishedReason } from "../setupCheckCopy";

const ORIGIN = "https://decisions.example.workers.dev";

/** Every observation each step can report, so none goes without words. */
const OBSERVATIONS: { [S in DecisionsSetupCheckStep]: DecisionsSetupCheckObservations[S][] } = {
  relay: [
    {
      result: "claimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
        diverges: false,
      },
    },
    { result: "unreachable", origin: ORIGIN, endpoint: "health", reason: "dns" },
    { result: "unexpected" },
  ],
  claim: [
    { result: "recognised" },
    { result: "not-recognised" },
    { result: "not-set-up" },
    { result: "refused", origin: ORIGIN, reason: "rate-limited" },
    { result: "unexpected" },
  ],
  socket: [
    { result: "connected" },
    { result: "no-hello" },
    { result: "replaced" },
    { result: "revoked" },
    { result: "not-connected" },
    { result: "not-connected", problem: "keys" },
    { result: "unexpected" },
  ],
  push: [
    { result: "configured", phones: 2, pushEnabled: 1 },
    { result: "no-push-key" },
    { result: "no-phone" },
    { result: "push-off", phones: 1 },
    { result: "unreachable", origin: ORIGIN, reason: "timeout" },
    { result: "unexpected" },
  ],
  attachment: [
    { result: "matched", bytes: 93 },
    { result: "not-asked" },
    { result: "not-published" },
    { result: "publish-failed" },
    { result: "mismatch" },
    { result: "key-storage", kind: "locked", reason: "The keychain is locked." },
    { result: "unexpected" },
  ],
  question: [
    { result: "typed", text: "[DAINTREE DECISION ANSWER]" },
    { result: "not-answered" },
    { result: "expired" },
    { result: "cancelled" },
    { result: "not-typed" },
    { result: "unexpected" },
  ],
};

/** Each observation as a passed and as a failed step shows it. */
function views<S extends DecisionsSetupCheckStep>(
  step: S,
  observations: readonly DecisionsSetupCheckObservations[S][]
) {
  return observations.map((observation) => ({
    observation,
    passed: describeSetupStep(step, { state: "passed", observation }, { state: "passed" }),
    failed: describeSetupStep(step, { state: "failed", observation }, { state: "failed" }),
  }));
}

describe("describeSetupStep", () => {
  it("puts every observation of every step into its own words, marked by how the step ended", () => {
    for (const step of DECISIONS_SETUP_CHECK_STEPS) {
      const details = new Set<string>();
      for (const { observation, passed, failed } of views(step, OBSERVATIONS[step])) {
        expect(passed.label).toBe(SETUP_STEP_LABEL[step]);
        expect(passed.severity).toBe("success");
        expect(failed.severity).toBe("error");
        expect(passed.detail.length, `${step} ${JSON.stringify(observation)}`).toBeGreaterThan(0);
        expect(passed.detail).toBe(failed.detail);
        details.add(passed.detail);
      }
      // Distinct observations read differently.
      expect(details.size, step).toBe(OBSERVATIONS[step].length);
    }
  });

  it("says what each outcome means, not just that it differs", () => {
    const detail = <S extends DecisionsSetupCheckStep>(
      step: S,
      observation: DecisionsSetupCheckObservations[S]
    ) => describeSetupStep(step, { state: "failed", observation }, { state: "failed" }).detail;
    expect(detail("claim", { result: "not-recognised" })).toMatch(/another owner/);
    expect(detail("socket", { result: "replaced" })).toMatch(/Another connection/);
    expect(detail("socket", { result: "not-connected", problem: "storage" })).toMatch(/database/);
    expect(detail("push", { result: "no-phone" })).toMatch(/No phone is paired/);
    expect(detail("push", { result: "push-off", phones: 1 })).toMatch(/^1 phone is paired/);
    expect(detail("attachment", { result: "mismatch" })).toMatch(/didn't decrypt/);
    expect(detail("question", { result: "not-answered" })).toMatch(/No answer came/);
    expect(detail("question", { result: "not-typed" })).toMatch(/wasn't typed/);
  });

  it("names the counts the push step saw", () => {
    const view = describeSetupStep(
      "push",
      { state: "passed", observation: { result: "configured", phones: 2, pushEnabled: 1 } },
      { state: "passed" }
    );
    expect(view.detail).toContain("1 of 2 paired phones");
  });

  it("says why a step didn't run, and marks a step still going with nothing", () => {
    expect(describeSetupStep("push", { state: "skipped" }, { state: "failed" }).detail).toMatch(
      /earlier step/
    );
    expect(describeSetupStep("push", { state: "skipped" }, { state: "cancelled" }).detail).toMatch(
      /cancelled/
    );
    const running = describeSetupStep("question", { state: "running" }, { state: "running" });
    expect(running.severity).toBeUndefined();
    expect(running.detail).toMatch(/phones/);
  });
});

describe("unfinishedReason", () => {
  it("asks for the kit first, then a check, then a check that passes", () => {
    expect(unfinishedReason({})).toBeNull();
    expect(unfinishedReason({ relayOrigin: ORIGIN })).toBe("kit");
    expect(
      unfinishedReason({
        relayOrigin: ORIGIN,
        setupCheck: { checkedAt: 1, failedStep: null },
      })
    ).toBe("kit");
    expect(unfinishedReason({ relayOrigin: ORIGIN, recoveryKitVerifiedAt: 1 })).toBe("check");
    expect(
      unfinishedReason({
        relayOrigin: ORIGIN,
        recoveryKitVerifiedAt: 1,
        setupCheck: { checkedAt: 2, failedStep: "socket" },
      })
    ).toEqual({ failedStep: "socket" });
    expect(
      unfinishedReason({
        relayOrigin: ORIGIN,
        recoveryKitVerifiedAt: 1,
        setupCheck: { checkedAt: 2, failedStep: null },
      })
    ).toBeNull();
  });
});
