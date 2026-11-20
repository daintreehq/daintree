import { describe, expect, it } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { NOTICE_TRAIL_EVENT, noticeTrailOf, noticeUntypedOf } from "../noticeTrail.js";
import { SECRET, answers, entry, row } from "./questionRows.js";

const AT = "2026-11-01T10:00:00.000Z";
const DEADLINE = "2026-11-01T09:45:00.000Z";
const ADVISORY = JSON.stringify({
  aad: { revision: 0, reply_mode: "advisory" },
  ciphertext: SECRET,
});

const EXPIRY = {
  entry_id: "expired-ev-1",
  kind: "expired" as const,
  action: "expire" as const,
  source: "system" as const,
  revision: 0,
  sealed: null,
  created_at: DEADLINE,
  advisory_disposition: "fallback-due" as const,
};

/** An advisory question in its round, still open. */
function open(over: Partial<QuestionRow> = {}): QuestionRow {
  return row(1, {
    question_revision: 0,
    content_sealed: ADVISORY,
    expires_at: DEADLINE,
    local_status: "open",
    delivery_status: "not-sent",
    ...over,
  });
}

/** The same question once its deadline closed it, its notice received and not yet typed. */
function expired(notice: object = {}, over: Partial<QuestionRow> = {}): QuestionRow {
  return open({
    local_status: "expired",
    delivery_status: "desktop-received",
    answers_json: answers({ ...EXPIRY, ...notice }),
    ...over,
  });
}

const steps = (entries: ReturnType<typeof noticeTrailOf>) => entries.map((e) => e.result);

const patch = (base: QuestionRow, over: Partial<QuestionRow>): QuestionRow => ({
  ...base,
  ...over,
});

describe("a timeout notice's trail (#17944)", () => {
  it("records the closing as observed, with the round, its deadline and the pane it is for", () => {
    const [observed, ...rest] = noticeTrailOf(open(), expired(), AT);
    expect(rest).toEqual([]);
    expect(observed).toEqual({
      at: AT,
      event: NOTICE_TRAIL_EVENT,
      question_id: open().question_id,
      requirement: "human-required",
      result: "observed",
      detail: {
        kind: "expired",
        revision: 0,
        deadline: DEADLINE,
        plan: "fallback-due",
        pane: "pane-a",
      },
    });
  });

  it("follows each attempt and what became of it, and nothing a write didn't change", () => {
    const pending = expired();
    const attempted = patch(pending, { last_injection_id: "inj-1" });
    expect(noticeTrailOf(pending, attempted, AT)).toMatchObject([
      { result: "attempted", detail: { attempt: "inj-1" } },
    ]);
    expect(noticeTrailOf(attempted, patch(attempted, { last_attempt_at: AT }), AT)).toEqual([]);

    const stopped = patch(attempted, {
      delivery_status: "needs-attention",
      error_code: "pane_gone",
    });
    const [stop] = noticeTrailOf(attempted, stopped, AT);
    expect(stop).toMatchObject({ result: "needs-attention", detail: { reason: "pane_gone" } });
    // The row's latest attempt isn't evidence of what stopped it.
    expect(stop!.detail).not.toHaveProperty("attempt");

    // A person tries it again: it waits to be typed once more.
    const retried = patch(stopped, { delivery_status: "desktop-received", error_code: null });
    expect(steps(noticeTrailOf(stopped, retried, AT))).toEqual(["pending"]);

    const typed = patch(retried, {
      last_injection_id: "inj-2",
      delivery_status: "terminal-delivered",
      answers_json: answers({ ...EXPIRY, delivered: true, injection_id: "inj-2" }),
    });
    expect(noticeTrailOf(retried, typed, AT)).toMatchObject([
      { result: "delivered", detail: { attempt: "inj-2" } },
    ]);
  });

  it("records a write that may or may not have reached the terminal, and a handled notice", () => {
    const pending = expired({}, { last_injection_id: "inj-1" });
    const uncertain = patch(pending, {
      delivery_status: "delivery-uncertain",
      error_code: "crash_unreconciled",
      answers_json: answers({ ...EXPIRY, uncertain_injection_id: "inj-1" }),
    });
    expect(noticeTrailOf(pending, uncertain, AT)).toMatchObject([
      { result: "uncertain", detail: { reason: "crash_unreconciled", attempt: "inj-1" } },
    ]);

    const refused = patch(pending, {
      delivery_status: "needs-attention",
      error_code: "relaunched",
    });
    const handled = patch(refused, { answers_json: answers({ ...EXPIRY, deliver: false }) });
    expect(steps(noticeTrailOf(refused, handled, AT))).toEqual(["stopped"]);
  });

  it("tells an attempt held before typing, then a pane that went, from an admitted write the sink refused", () => {
    const pending = expired({}, { last_injection_id: "inj-1" });
    const intent = {
      injection_id: "inj-1",
      message_id: null,
      answer_revision: 0,
      pane_id: "pane-a",
    };
    // Held behind a draft: nothing typed. Later the pane is gone before any new attempt.
    const gone = patch(pending, { delivery_status: "needs-attention", error_code: "pane_gone" });
    const heldThenGone = [
      noticeUntypedOf(pending, intent, AT),
      ...noticeTrailOf(pending, gone, AT),
    ];
    // Admitted, then refused: the notice's own entry carries the refusal.
    const refused = patch(pending, {
      delivery_status: "needs-attention",
      error_code: "generation_mismatch",
      answers_json: answers({ ...EXPIRY, write_refused: true }),
    });
    const refusedTrail = [
      noticeUntypedOf(pending, intent, AT),
      ...noticeTrailOf(pending, refused, AT),
    ];

    expect(heldThenGone.map((e) => e?.result)).toEqual(["untyped", "needs-attention"]);
    expect(heldThenGone[1]!.detail).not.toHaveProperty("refused");
    expect(heldThenGone[1]!.detail).not.toHaveProperty("attempt");
    expect(refusedTrail[1]).toMatchObject({
      result: "needs-attention",
      detail: { reason: "generation_mismatch", refused: "admitted-write" },
    });
  });

  it("records a notice a reopen replaced before it was typed, and nothing for one already typed", () => {
    const pending = expired();
    const reopened = patch(pending, { question_revision: 1, local_status: "open" });
    expect(steps(noticeTrailOf(pending, reopened, AT))).toEqual(["superseded"]);

    const typed = expired({ delivered: true });
    expect(
      noticeTrailOf(typed, patch(typed, { question_revision: 1, local_status: "open" }), AT)
    ).toEqual([]);
  });

  it("trails a blocking question's expiry too, with no plan, and nothing for an answer or a decline", () => {
    const blocking = expired({ advisory_disposition: undefined }, { content_sealed: null });
    expect(noticeTrailOf(open({ content_sealed: null }), blocking, AT)).toMatchObject([
      { result: "observed", detail: { plan: null } },
    ]);
    const answered = open({
      local_status: "human-answered",
      answers_json: answers(entry({ revision: 0 })),
    });
    expect(noticeTrailOf(open(), answered, AT)).toEqual([]);
    const declined = open({
      local_status: "cancelled",
      answers_json: answers({ entry_id: "d", kind: "declined", action: "cancel", revision: 0 }),
    });
    expect(noticeTrailOf(open(), declined, AT)).toEqual([]);
  });

  it("records an attempt that ended before anything was typed, for the notice's own round only", () => {
    const pending = expired({}, { last_injection_id: "inj-1" });
    const intent = {
      injection_id: "inj-1",
      message_id: null,
      answer_revision: 0,
      pane_id: "pane-a",
    };
    expect(noticeUntypedOf(pending, intent, AT)).toMatchObject({
      result: "untyped",
      detail: { attempt: "inj-1", pane: "pane-a", revision: 0 },
    });
    expect(noticeUntypedOf(pending, { ...intent, message_id: "m-1" }, AT)).toBeNull();
    expect(noticeUntypedOf(pending, { ...intent, answer_revision: 1 }, AT)).toBeNull();
    expect(noticeUntypedOf(expired({ delivered: true }), intent, AT)).toBeNull();
    expect(noticeUntypedOf(null, intent, AT)).toBeNull();
  });

  it("never carries the question's words, an answer, or anything sealed", () => {
    const pending = expired({}, { last_injection_id: "inj-1" });
    const trail = [
      ...noticeTrailOf(open(), expired(), AT),
      ...noticeTrailOf(pending, patch(pending, { delivery_status: "needs-attention" }), AT),
      noticeUntypedOf(
        pending,
        { injection_id: "inj-1", message_id: null, answer_revision: 0, pane_id: "pane-a" },
        AT
      ),
    ];
    expect(trail).toHaveLength(3);
    expect(JSON.stringify(trail)).not.toContain(SECRET);
  });
});
