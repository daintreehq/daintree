import { describe, expect, it } from "vitest";
import {
  cancelBody,
  cancelProblem,
  cancelTitle,
  noLongerWaiting,
  type DecisionCancelTarget,
} from "../decisionCancelModel";

const TARGET: DecisionCancelTarget = {
  terminalId: "t1",
  questionId: "q42",
  label: "q-42",
  line: "Ship the migration?",
};
const OTHER: DecisionCancelTarget = { ...TARGET, questionId: "q7", label: "q-7" };

describe("decisionCancelModel", () => {
  it("asks about the question it names", () => {
    expect(cancelTitle(TARGET)).toBe("Cancel question q-42?");
    expect(cancelTitle(OTHER)).toBe("Cancel question q-7?");
  });

  it("never promises typing into the terminal, and waits on the relay only for a question it has", () => {
    for (const queued of [false, true]) {
      const body = cancelBody(queued);
      expect(body).toMatch(/Nothing is typed into this terminal/);
      expect(body).toMatch(/agent sees the question cancelled/);
    }
    expect(cancelBody(false)).toMatch(/once the relay confirms/);
    expect(cancelBody(true)).toMatch(/hasn't been sent/);
    expect(cancelBody(true)).not.toMatch(/relay confirms/);
  });

  it("reports no problem once main has cancelled it or committed the withdrawal", () => {
    expect(cancelProblem(TARGET, { result: "cancelled" })).toBeNull();
    expect(cancelProblem(TARGET, { result: "cancelling" })).toBeNull();
  });

  it("says why each refusal happened, about the question asked, with only a way out", () => {
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
    expect(noLongerWaiting(OTHER)).toEqual({
      severity: "info",
      message: expect.stringMatching(/^q-7 isn't waiting for an answer any more/),
      retry: false,
    });
  });
});
