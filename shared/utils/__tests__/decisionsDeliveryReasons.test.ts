import { describe, expect, it } from "vitest";
import { deliveryReasonText, deliverySubject } from "../decisionsDeliveryReasons.js";

describe("decisionsDeliveryReasons", () => {
  it("names what of a question is held, in agreement with how many follow-ups", () => {
    expect(deliverySubject(true, 0)).toBe("answer");
    expect(deliverySubject(false, 1)).toBe("follow-up");
    expect(deliverySubject(false, 2)).toBe("follow-ups");
    expect(deliverySubject(true, 1)).toBe("answer and follow-up");
    expect(deliverySubject(true, 3)).toBe("answer and follow-ups");
  });

  it("has no words for a code it doesn't know, including one shaped like an object's own key", () => {
    expect(deliveryReasonText("not_a_code")).toBeNull();
    expect(deliveryReasonText("constructor")).toBeNull();
    expect(deliveryReasonText("__proto__", "follow-ups")).toBeNull();
  });

  it("names the follow-up a follow-up's own code stopped, and the answer otherwise", () => {
    const answer = deliveryReasonText("inject_rejected");
    expect(answer).toMatch(/the answer/);
    expect(deliveryReasonText("inject_rejected", "follow-up")).toBe(
      answer!.replace("the answer", "the follow-up")
    );
    expect(deliveryReasonText("inject_rejected", "answer and follow-ups")).toBe(answer);
    expect(deliveryReasonText("resume_exited", "follow-ups")).toBe(
      "The resumed agent exited before the follow-ups were typed in."
    );
    expect(deliveryReasonText("pane_gone")).toBe("The terminal that asked was closed.");
  });
});
