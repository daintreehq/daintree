import { beforeEach, describe, expect, it } from "vitest";
import {
  answerKey,
  isInFlight,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerRecord,
} from "../decisionsAnswerStore";

const PAYLOAD = {
  reference: { hostId: "h", projectId: "p", terminalId: "t", questionId: "q" },
  answerId: "answer-1",
  expectedRevision: 1,
  selectedOptionIds: ["a"],
  reviewedAttachmentDigests: [],
};

function drafted(record: AnswerRecord): AnswerRecord {
  return { ...record, draft: { revision: 1, selected: "a", text: "" } };
}

function queued(record: AnswerRecord): AnswerRecord {
  return {
    ...record,
    submission: {
      answerId: "answer-1",
      payload: PAYLOAD,
      target: { scope: "pane", terminalId: "t", questionId: "q" },
      phase: { kind: "settled", outcome: { status: "queued" } },
      resubmitted: false,
    },
  };
}

beforeEach(() => {
  useDecisionsAnswerStore.getState().clear();
});

describe("decisionsAnswerStore", () => {
  it("keys a question by where it was asked, whichever way it was read", () => {
    const reference = { hostId: "h", projectId: "p", terminalId: "t", questionId: "q" };
    expect(answerKey({ ...reference })).toBe(answerKey(reference));
    // The same question id on another machine is another question.
    expect(answerKey({ ...reference, hostId: "h2" })).not.toBe(answerKey(reference));
  });

  it("lets the oldest idle record go past the cap, never one whose answer is in flight", () => {
    const { update } = useDecisionsAnswerStore.getState();
    update("pending", queued);
    for (let i = 0; i < 70; i += 1) update(`q${i}`, drafted);
    const keys = Object.keys(useDecisionsAnswerStore.getState().records);
    expect(keys).toHaveLength(64);
    expect(keys).toContain("pending");
    expect(keys).toContain("q69");
    expect(keys).not.toContain("q0");
  });

  it("counts an answer as in flight until its fate is known", () => {
    const record = readAnswerRecord("none");
    expect(isInFlight(record)).toBe(false);
    expect(isInFlight({ ...record, preparing: true })).toBe(true);
    expect(isInFlight(queued(record))).toBe(true);
    const sent = queued(record);
    sent.submission!.phase = { kind: "settled", outcome: { status: "sent" } };
    expect(isInFlight(sent)).toBe(false);
    sent.submission!.phase = { kind: "lost" };
    expect(isInFlight(sent)).toBe(true);
  });

  it("clears everything and moves its generation on", () => {
    const { update } = useDecisionsAnswerStore.getState();
    update("q", drafted);
    const before = useDecisionsAnswerStore.getState().generation;
    useDecisionsAnswerStore.getState().clear();
    expect(useDecisionsAnswerStore.getState().records).toEqual({});
    expect(useDecisionsAnswerStore.getState().generation).toBeGreaterThan(before);
  });
});
