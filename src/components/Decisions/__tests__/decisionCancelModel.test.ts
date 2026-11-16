import { describe, expect, it } from "vitest";
import type { DecisionQuestionCancelResult } from "@shared/types/decisionsQuestion";
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
  queued: false,
};

describe("decisionCancelModel", () => {
  it("asks about the question by name and never promises typing into the terminal", () => {
    expect(cancelTitle(TARGET)).toBe("Cancel question q-42?");
    for (const queued of [false, true]) {
      const body = cancelBody({ ...TARGET, queued });
      expect(body).toMatch(/Nothing is typed into this terminal/);
      expect(body).toMatch(/agent sees the question cancelled/);
    }
    // Only a question on the relay waits for it to confirm the withdrawal.
    expect(cancelBody(TARGET)).toMatch(/once the relay confirms/);
    expect(cancelBody({ ...TARGET, queued: true })).not.toMatch(/relay confirms/);
  });

  it("reports no problem once main has cancelled it or committed the withdrawal", () => {
    expect(cancelProblem(TARGET, { result: "cancelled" })).toBeNull();
    expect(cancelProblem(TARGET, { result: "cancelling" })).toBeNull();
  });

  it("names the question in every refusal, and offers a retry only where one could help", () => {
    const outcomes: DecisionQuestionCancelResult[] = [
      { result: "refused", reason: "answered" },
      { result: "refused", reason: "expired" },
      { result: "refused", reason: "publish-failed" },
      { result: "refused", reason: "not-found" },
    ];
    const messages = outcomes.map((outcome) => {
      const problem = cancelProblem(TARGET, outcome);
      expect(problem?.retry).toBe(false);
      expect(problem?.message).toMatch(/^q-42 /);
      return problem?.message;
    });
    expect(new Set(messages).size).toBe(outcomes.length);
    expect(messages[0]).toMatch(/answered/);

    expect(cancelProblem(TARGET, { result: "off" })?.retry).toBe(false);
    expect(cancelProblem(TARGET, { result: "not-running" })?.retry).toBe(true);
    expect(noLongerWaiting(TARGET).retry).toBe(false);
  });
});
