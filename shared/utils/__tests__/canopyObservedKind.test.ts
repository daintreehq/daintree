import { describe, expect, it } from "vitest";
import { observedCanopyKind, observedCaughtUp } from "../canopyObservedKind.js";

const handBack = { stoppedAt: 1_000 };

describe("observedCanopyKind", () => {
  it("keeps a wait it has no word for yet as a question, hand-back or not", () => {
    expect(observedCanopyKind({ agentState: "waiting", waitingReason: "unheard-of" })).toBe(
      "question"
    );
    expect(
      observedCanopyKind({ agentState: "waiting", waitingReason: "unheard-of", handBack })
    ).toBe("question");
  });

  it("reads a null reason as a plain prompt", () => {
    expect(observedCanopyKind({ agentState: "waiting", waitingReason: null })).toBe("idle");
    expect(observedCanopyKind({ agentState: "waiting", waitingReason: null, handBack })).toBe(
      "finished"
    );
  });
});

describe("observedCaughtUp", () => {
  it("still sees a prompt with no record catching up with a reading of a stop", () => {
    // A then-state carries no hand-back; idle and question are both stopped,
    // so the busy-against-stopped comparison is untouched.
    expect(
      observedCaughtUp(
        "approval",
        { agentState: "working" },
        { agentState: "waiting", waitingReason: "prompt", since: 2_000 },
        1_000
      )
    ).toBe(true);
  });
});
