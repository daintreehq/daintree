import { describe, expect, it } from "vitest";
import {
  deliveryAttentionText,
  deliveryReasonText,
  deliverySubject,
  deliverySubjectOf,
  deliverySubjectPlural,
  deliveryUncertainText,
  stallSubject,
} from "../decisionsDeliveryReasons.js";

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

  it("names a timeout notice in the answer's place, and what its own code stopped (#17944)", () => {
    expect(deliverySubject(true, 0, true)).toBe("timeout notice");
    expect(deliverySubject(true, 2, true)).toBe("timeout notice and follow-ups");
    // Only follow-ups held: the notice isn't part of it.
    expect(deliverySubject(false, 1, true)).toBe("follow-up");
    expect(deliverySubjectPlural("timeout notice")).toBe(false);
    expect(deliverySubjectPlural("timeout notice and follow-up")).toBe(true);
    expect(deliveryReasonText("inject_rejected", "timeout notice")).toBe(
      deliveryReasonText("inject_rejected")!.replace("the answer", "the timeout notice")
    );
    expect(deliveryReasonText("pane_gone", "timeout notice")).toBe(
      "The terminal that asked was closed."
    );
  });

  it("words a stopped delivery for the pane's own terminal without changing what it says (#18054)", () => {
    expect(deliveryReasonText("relaunched", "answer", "here")).toBe(
      "This terminal was relaunched after the question was asked."
    );
    expect(deliveryReasonText("inject_rejected", "follow-up", "here")).toBe(
      "This terminal refused the follow-up."
    );
    expect(deliveryReasonText("session_mismatch", "answer", "here")).toBe(
      "A different agent session is running here now."
    );
    // Words that name no terminal read the same from either side.
    expect(deliveryReasonText("resume_ended", "answer", "here")).toBe(
      deliveryReasonText("resume_ended")
    );
    expect(deliveryReasonText("message_unreadable", "follow-up", "here")).toBe(
      "The follow-up couldn't be decrypted on this computer."
    );
  });

  it("names what stopped as a status line, with its verb agreeing", () => {
    expect(deliveryAttentionText("answer")).toBe("Answer needs attention");
    expect(deliveryAttentionText("follow-ups")).toBe("Follow-ups need attention");
    expect(deliveryAttentionText("timeout notice and follow-up")).toBe(
      "Timeout notice and follow-up need attention"
    );
    expect(deliveryUncertainText("answer")).toBe("Answer may or may not have been delivered");
    expect(deliveryUncertainText("answer and follow-ups")).toBe(
      "Answer or its follow-ups may or may not have been delivered"
    );
    expect(deliveryUncertainText("follow-ups", true)).toBe(
      "These follow-ups may or may not have been delivered"
    );
    expect(deliveryUncertainText("timeout notice and follow-up", true)).toBe(
      "This timeout notice or its follow-up may or may not have been delivered"
    );
    expect(deliverySubjectOf("answer", "q-3")).toBe("Answer to q-3");
    expect(deliverySubjectOf("timeout notice", "q-3")).toBe("Timeout notice for q-3");
  });

  it("reads what a listed question's stall stopped on, the timeout notice in the answer's place (#18054)", () => {
    const stall = (answerRevision: number | null, followUpIds: string[] = []) => ({
      answerRevision,
      followUpIds,
      reason: "pane_gone",
    });
    const notice = (delivery: "needs-attention" | "uncertain" | "delivered") => ({
      closedReason: "expired" as const,
      closureNotice: { delivery, disposition: null },
    });
    expect(stallSubject({ stall: null })).toBeNull();
    expect(stallSubject({ stall: stall(1) })).toBe("answer");
    expect(stallSubject({ stall: stall(null, ["m1"]) })).toBe("follow-up");
    expect(stallSubject({ stall: stall(1, ["m1", "m2"]) })).toBe("answer and follow-ups");
    expect(stallSubject({ stall: stall(1), ...notice("needs-attention") })).toBe("timeout notice");
    expect(stallSubject({ stall: stall(1, ["m1"]), ...notice("uncertain") })).toBe(
      "timeout notice and follow-up"
    );
    // A notice that was typed isn't what stopped; a Host from before the round reports none.
    expect(stallSubject({ stall: stall(1), ...notice("delivered") })).toBe("answer");
    expect(stallSubject({ stall: stall(1), closedReason: "never-published" })).toBe("answer");
    expect(
      stallSubject({
        stall: stall(1),
        closedReason: "never-published",
        closureNotice: { delivery: "uncertain", disposition: null },
      })
    ).toBe("timeout notice");
    expect(stallSubject({ stall: stall(null, ["m1"]), ...notice("needs-attention") })).toBe(
      "follow-up"
    );
  });

  it("says each code that names the terminal the pane's own way", () => {
    expect(deliveryReasonText("generation_mismatch", "answer", "here")).toBe(
      "This terminal was restarted after the question was asked."
    );
    expect(deliveryReasonText("unavailable_unknown_reason", "timeout notice", "here")).toBe(
      "This terminal refused the timeout notice."
    );
    expect(deliveryReasonText("nothing_known", "answer", "here")).toBeNull();
    // Away from the terminal, the same codes still name the terminal that asked.
    expect(deliveryReasonText("generation_mismatch")).toBe(
      "The terminal that asked was restarted after the question was asked."
    );
  });
});
