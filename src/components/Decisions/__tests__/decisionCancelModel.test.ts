import { describe, expect, it } from "vitest";
import type { DeclinePhase } from "@/store/decisionsAnswerStore";
import {
  cancelBody,
  cancelProblem,
  cancelTitle,
  dismissBody,
  dismissFallback,
  dismissProgressText,
  dismissTitle,
  dismissVerdict,
  noLongerWaiting,
  type DecisionCancelTarget,
} from "../decisionCancelModel";

const TARGET: DecisionCancelTarget = {
  question: { scope: "pane", terminalId: "t1", questionId: "q42" },
  label: "q-42",
  line: "Ship the migration?",
  revision: null,
};
const OTHER: DecisionCancelTarget = {
  ...TARGET,
  question: { scope: "pane", terminalId: "t1", questionId: "q7" },
  label: "q-7",
};

function settled(outcome: Extract<DeclinePhase, { kind: "settled" }>["outcome"]): DeclinePhase {
  return { kind: "settled", outcome };
}

describe("decisionCancelModel", () => {
  it("asks about the question it names, as a dismissal or, separately, a withdrawal", () => {
    expect(dismissTitle(TARGET)).toBe("Dismiss question q-42?");
    expect(dismissTitle(OTHER)).toBe("Dismiss question q-7?");
    expect(cancelTitle(TARGET)).toBe("Withdraw question q-42?");
    expect(cancelTitle(OTHER)).toBe("Withdraw question q-7?");
  });

  it("says a dismissal tells a listening agent and approves nothing (#17239)", () => {
    const body = dismissBody();
    expect(body).toMatch(/still listening, it's told you chose not to answer/);
    expect(body).toMatch(/nothing is decided or approved/);
    expect(body).toMatch(/declined on this computer/);
  });

  it("never promises typing into the terminal for a withdrawal, and waits on the relay only for a question it has", () => {
    for (const queued of [false, true]) {
      const body = cancelBody(queued);
      expect(body).toMatch(/Nothing is typed into this terminal/);
      expect(body).toMatch(/agent sees the question cancelled/);
    }
    expect(cancelBody(false)).toMatch(/once the relay confirms/);
    expect(cancelBody(true)).toMatch(/hasn't been sent/);
    expect(cancelBody(true)).not.toMatch(/relay confirms/);
  });

  it("reports no problem once main has withdrawn it or committed the withdrawal", () => {
    expect(cancelProblem(TARGET, { result: "cancelled" })).toBeNull();
    expect(cancelProblem(TARGET, { result: "cancelling" })).toBeNull();
  });

  it("says why each withdrawal refusal happened, about the question asked, with only a way out", () => {
    const cases = [
      ["answered", /^q-7 has been answered/],
      ["expired", /^q-7 has expired/],
      ["publish-failed", /^q-7 never reached the relay/],
      ["not-found", /^q-7 is no longer one of this terminal's questions/],
    ] as const;
    for (const [reason, message] of cases) {
      expect(cancelProblem(OTHER, { result: "refused", reason })).toEqual({
        severity: "info",
        message: expect.stringMatching(message),
        retry: false,
      });
    }
  });

  it("lets a question be tried again only when Decisions could still take it", () => {
    expect(cancelProblem(TARGET, { result: "not-running" })).toMatchObject({
      severity: "warning",
      retry: true,
    });
    expect(cancelProblem(TARGET, { result: "off" })).toMatchObject({
      severity: "info",
      retry: false,
    });
    // A Remote Host's question whose Host went away (#17230): it may or may not have been withdrawn.
    expect(cancelProblem(TARGET, { result: "host-not-connected" })).toMatchObject({
      severity: "warning",
      message: expect.stringMatching(/may not have been cancelled/),
      retry: true,
    });
    expect(noLongerWaiting(OTHER)).toEqual({
      severity: "info",
      message: expect.stringMatching(/^q-7 isn't waiting for an answer any more/),
      retry: false,
    });
    expect(noLongerWaiting(OTHER, "dismiss").message).toMatch(/nothing to dismiss/);
  });

  describe("a dismissal's outcome (#17239)", () => {
    it("is done once the relay took it or it's queued, under the key it's kept by", () => {
      for (const phase of [settled({ status: "declined" }), settled({ status: "queued" })]) {
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase })).toEqual({
          kind: "done",
          key: "k",
        });
      }
    });

    it("offers withdrawing, saying why, only where a dismissal can't be taken", () => {
      const fallbacks: Array<[DeclinePhase, RegExp]> = [
        [settled({ status: "unsupported", by: "relay" }), /^Your relay needs an update/],
        [
          settled({ status: "unsupported", by: "asking-desktop" }),
          /^Daintree on the computer that asked q-42 needs an update/,
        ],
        [settled({ status: "closed", reason: "not-found" }), /^The relay doesn't hold q-42 yet/],
        [{ kind: "refused", reason: "not-owner" }, /^This computer doesn't sign for you/],
      ];
      for (const [phase, reason] of fallbacks) {
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase })).toEqual({
          kind: "withdraw",
          message: expect.stringMatching(reason),
        });
        expect(dismissFallback("q-42", phase)).toMatch(reason);
      }
      // Anything else isn't a reason to withdraw instead.
      for (const phase of [
        settled({ status: "already-answered" }),
        settled({ status: "closed", reason: "expired" }),
        settled({ status: "closed", reason: "cancelled" }),
        settled({ status: "rejected", code: "conflict" }),
        { kind: "refused", reason: "not-found" } as const,
        { kind: "lost" } as const,
      ]) {
        expect(dismissFallback("q-42", phase)).toBeNull();
        expect(dismissVerdict(TARGET, { kind: "submitted", key: "k", phase }).kind).toBe("problem");
      }
    });

    it("lets a changed question be dismissed again from a row, but sends the view's reader back to review it", () => {
      const fromRow = dismissVerdict(TARGET, { kind: "changed" });
      const fromView = dismissVerdict({ ...TARGET, revision: 4 }, { kind: "changed" });
      expect(fromRow).toMatchObject({ kind: "problem", problem: { retry: true } });
      expect(fromView).toMatchObject({
        kind: "problem",
        problem: { retry: false, message: expect.stringMatching(/Review it/) },
      });
    });

    it("lets one whose standing is unknown, or that couldn't be read, be tried again", () => {
      expect(
        dismissVerdict(TARGET, { kind: "submitted", key: "k", phase: { kind: "lost" } })
      ).toMatchObject({
        kind: "problem",
        problem: { severity: "warning", retry: true },
      });
      expect(dismissVerdict(TARGET, { kind: "failed", reason: "not-running" })).toMatchObject({
        kind: "problem",
        problem: { retry: true },
      });
      expect(dismissVerdict(TARGET, { kind: "failed", reason: "off" })).toMatchObject({
        kind: "problem",
        problem: { retry: false },
      });
      expect(dismissVerdict(TARGET, { kind: "gone" })).toMatchObject({
        kind: "problem",
        problem: { message: expect.stringMatching(/nothing to dismiss/) },
      });
    });

    it("says how far one under way has got, and nothing for one that settled otherwise", () => {
      expect(dismissProgressText(settled({ status: "queued" }))).toMatch(/queued/);
      expect(dismissProgressText({ kind: "lost" })).toMatch(/^Couldn't confirm/);
      expect(dismissProgressText(settled({ status: "declined" }))).toMatch(/^Dismissed/);
      expect(dismissProgressText(settled({ status: "unsupported", by: "relay" }))).toBeNull();
      expect(dismissProgressText({ kind: "refused", reason: "not-owner" })).toBeNull();
    });
  });
});
