import { describe, expect, it } from "vitest";
import { parseAnswers } from "@daintreehq/decisions-client";
import { roundOf, verifiedPlan } from "../questionRound.js";
import { DECLINE, answers, row } from "./questionRows.js";

/** An envelope as the publisher stores it: only its clear AAD is read here. */
function sealed(aad: Record<string, unknown>): string {
  return JSON.stringify({ crypto_version: 1, aad, ciphertext: "x" });
}

const ADVISORY = sealed({ revision: 0, reply_mode: "advisory" });
const BLOCKING = sealed({ revision: 0 });

const EXPIRY = { entry_id: "expiry-1", kind: "expired" as const, action: "expire" as const };

describe("roundOf (#17943)", () => {
  it("reads a legacy question, and one whose envelope can't be parsed, as blocking", () => {
    for (const content_sealed of [BLOCKING, '{"reply_mode": broken', null]) {
      const question = row(1, { question_revision: 0, content_sealed });
      expect(roundOf(question)).toEqual({
        replyMode: "blocking",
        closedReason: null,
        closureNotice: null,
      });
    }
  });

  it("keeps an advisory round advisory once answered, and a reopened round blocking", () => {
    const open = row(1, { question_revision: 0, content_sealed: ADVISORY });
    expect(roundOf(open).replyMode).toBe("advisory");

    // Answered in the advisory round: the answer moved the revision on, and accounts for it.
    const answered = row(1, {
      question_revision: 1,
      content_sealed: ADVISORY,
      local_status: "human-answered",
      answers_json: answers({ revision: 0 }),
    });
    expect(roundOf(answered).replyMode).toBe("advisory");

    // Reopened after that answer: a revision no answer accounts for always waits.
    const reopened = row(1, {
      question_revision: 2,
      content_sealed: ADVISORY,
      answers_json: answers({ revision: 0 }),
    });
    expect(roundOf(reopened).replyMode).toBe("blocking");
  });

  it("tells each way a question closes without an answer apart", () => {
    const declined = row(1, {
      local_status: "cancelled",
      answers_json: answers({ ...DECLINE, revision: 1 }),
    });
    const withdrawn = row(2, { local_status: "cancelled" });
    const expired = row(3, { local_status: "expired", answers_json: answers(EXPIRY) });
    const neverPublished = row(4, {
      local_status: "publish-failed",
      answers_json: answers({ kind: "unpublished", action: "expire", source: "system" }),
    });
    const refused = row(5, { local_status: "publish-failed", error_code: "invalid_request" });

    expect(roundOf(declined)).toMatchObject({
      closedReason: "declined",
      closureNotice: { delivery: "pending", disposition: null },
    });
    // A withdrawal types nothing into the terminal.
    expect(roundOf(withdrawn)).toMatchObject({ closedReason: "withdrawn", closureNotice: null });
    expect(roundOf(expired)).toMatchObject({
      closedReason: "expired",
      closureNotice: { delivery: "pending", disposition: null },
    });
    expect(roundOf(neverPublished)).toMatchObject({
      closedReason: "never-published",
      closureNotice: { delivery: "pending", disposition: null },
    });
    expect(roundOf(refused)).toMatchObject({ closedReason: null, closureNotice: null });
  });

  it("says how far the closing notice got, from the entry first and the row after", () => {
    const expired = (entry: object, over: object = {}) =>
      roundOf(
        row(1, { local_status: "expired", answers_json: answers({ ...EXPIRY, ...entry }), ...over })
      ).closureNotice?.delivery;

    expect(expired({ delivered: true })).toBe("delivered");
    expect(expired({ uncertain_injection_id: "inj-1" })).toBe("uncertain");
    expect(expired({ deliver: false })).toBe("stopped");
    expect(expired({}, { delivery_status: "delivery-uncertain" })).toBe("uncertain");
    expect(expired({}, { delivery_status: "needs-attention" })).toBe("needs-attention");
    expect(expired({})).toBe("pending");
    // Delivered stays delivered whatever the row says since.
    expect(expired({ delivered: true }, { delivery_status: "needs-attention" })).toBe("delivered");
  });

  it("never takes an earlier round's notice for the current one's", () => {
    // Expired at revision 0, then reopened and expired again at 1: only the second is in force.
    const reexpired = row(1, {
      question_revision: 1,
      local_status: "expired",
      answers_json: answers(
        { ...EXPIRY, revision: 0, delivered: true },
        { ...EXPIRY, entry_id: "expiry-2", revision: 1 }
      ),
    });
    expect(roundOf(reexpired).closureNotice?.delivery).toBe("pending");

    // Reopened and open again: the old expiry describes nothing.
    const reopened = row(1, {
      question_revision: 1,
      local_status: "open",
      answers_json: answers({ ...EXPIRY, revision: 0 }),
    });
    expect(roundOf(reopened)).toMatchObject({ closedReason: null, closureNotice: null });
  });

  it("says what an advisory notice lets go ahead, never upgraded while untyped", () => {
    const advisoryExpiry = (entry: object) =>
      roundOf(
        row(1, {
          question_revision: 0,
          content_sealed: ADVISORY,
          local_status: "expired",
          answers_json: answers({ ...EXPIRY, revision: 0, ...entry }),
        })
      ).closureNotice;

    // Typed: it keeps what it said.
    expect(advisoryExpiry({ advisory_disposition: "fallback-due", delivered: true })).toEqual({
      delivery: "delivered",
      disposition: "fallback-due",
    });
    // Untyped: it follows this Daintree, which lets no plan go ahead yet.
    expect(advisoryExpiry({ advisory_disposition: "fallback-due" })).toEqual({
      delivery: "pending",
      disposition: "fallback-withheld",
    });
    // Recorded without one: typed as the ordinary expiry, which lets nothing go ahead.
    expect(advisoryExpiry({})).toEqual({ delivery: "pending", disposition: "fallback-withheld" });

    const unpublished = (entry: object) =>
      roundOf(
        row(1, {
          question_revision: 0,
          content_sealed: ADVISORY,
          local_status: "publish-failed",
          answers_json: answers({
            kind: "unpublished",
            action: "expire",
            source: "system",
            revision: 0,
            ...entry,
          }),
        })
      ).closureNotice?.disposition;
    expect(unpublished({ fallback_due: true, delivered: true })).toBe("fallback-due");
    expect(unpublished({ fallback_due: true })).toBe("fallback-withheld");
    expect(unpublished({})).toBe("fallback-withheld");
  });

  it("has no notice for imported history", () => {
    const imported = row(1, {
      local_status: "expired",
      history_only: true,
      answers_json: answers(EXPIRY),
    });
    expect(roundOf(imported).closureNotice).toBeNull();
  });
});

describe("verifiedPlan (#17943)", () => {
  const content = (over: object = {}) => ({
    kind: "choice" as const,
    planned_fallback: "Use the existing fixture",
    ...over,
  });

  it("shows an advisory round's plan, and none for a blocking or reopened round", () => {
    const advisory = row(1, { question_revision: 0, content_sealed: ADVISORY });
    expect(verifiedPlan(advisory, [], content())).toBe("Use the existing fixture");

    // A blocking question's stray plan means nothing.
    const blocking = row(1, { question_revision: 0, content_sealed: BLOCKING });
    expect(verifiedPlan(blocking, [], content())).toBeNull();

    const reopened = row(1, { question_revision: 1, content_sealed: ADVISORY });
    expect(verifiedPlan(reopened, [], content())).toBeNull();

    // An envelope that claims advisory at another revision was never the advisory round.
    const later = row(1, {
      question_revision: 0,
      content_sealed: sealed({ revision: 1, reply_mode: "advisory" }),
    });
    expect(verifiedPlan(later, [], content())).toBeNull();
  });

  it("refuses advisory content the protocol refuses: an approval, or no plan", () => {
    const advisory = row(1, { question_revision: 0, content_sealed: ADVISORY });
    expect(verifiedPlan(advisory, [], content({ kind: "approval" }))).toBe("refused");
    expect(verifiedPlan(advisory, [], content({ planned_fallback: undefined }))).toBe("refused");
    // Refused in every round, so a reopen never reads it as ordinary.
    const answered = row(1, {
      question_revision: 2,
      content_sealed: ADVISORY,
      answers_json: answers({ revision: 0 }),
    });
    const entries = parseAnswers(answered.answers_json);
    expect(verifiedPlan(answered, entries, content({ kind: "approval" }))).toBe("refused");
  });
});
