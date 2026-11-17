// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnswerDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionContentResult,
} from "@shared/types/decisionsQuestion";
import {
  answerKey,
  readAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerPhase,
} from "@/store/decisionsAnswerStore";
import { followAnswer } from "../decisionAnswerSend";

const REFERENCE = { hostId: "h", projectId: "p", terminalId: "t1", questionId: "q1" };
const KEY = answerKey(REFERENCE);

const getAnswerResult =
  vi.fn<(payload: { answerId: string }) => Promise<DecisionAnswerResultRead>>();
const answerQuestion =
  vi.fn<(payload: AnswerDecisionQuestionPayload) => Promise<DecisionQuestionAnswerResult>>();
const getQuestionContent =
  vi.fn<
    (payload: { terminalId: string; questionId: string }) => Promise<DecisionQuestionContentResult>
  >();

function payload(answerId: string): AnswerDecisionQuestionPayload {
  return {
    reference: REFERENCE,
    answerId,
    expectedRevision: 1,
    selectedOptionIds: ["yes"],
    reviewedAttachmentDigests: [],
  };
}

/** A submission for `answerId` in `phase`, as a Send would have left it. */
function place(answerId: string, phase: AnswerPhase) {
  useDecisionsAnswerStore.getState().update(KEY, (record) => ({
    ...record,
    draft: { revision: 1, selected: "yes", text: "" },
    submission: {
      answerId,
      payload: payload(answerId),
      target: { scope: "pane", terminalId: "t1", questionId: "q1" },
      phase,
      resubmitted: false,
    },
  }));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useDecisionsAnswerStore.getState().clear();
  getAnswerResult.mockReset();
  answerQuestion.mockReset();
  getQuestionContent.mockReset();
  Reflect.set(window, "electron", {
    decisions: { getAnswerResult, answerQuestion, getQuestionContent },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("following an answer by its id (#17102)", () => {
  it("reads a lost answer once however many times Retry is pressed", async () => {
    place("answer-a", { kind: "lost" });
    const read = deferred<DecisionAnswerResultRead>();
    getAnswerResult.mockReturnValue(read.promise);

    const first = followAnswer(KEY);
    // Retry goes as it starts.
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("checking");
    const second = followAnswer(KEY);
    read.resolve({
      result: "read",
      questionId: "q1",
      expectedRevision: 1,
      outcome: { status: "sent" },
    });
    await Promise.all([first, second]);

    expect(getAnswerResult).toHaveBeenCalledOnce();
    expect(readAnswerRecord(KEY).submission?.phase).toEqual({
      kind: "settled",
      outcome: { status: "sent" },
    });
  });

  it("never sends a newer answer in place of one cleared while its standing was read", async () => {
    place("answer-a", { kind: "lost" });
    const read = deferred<DecisionAnswerResultRead>();
    getAnswerResult.mockReturnValue(read.promise);
    const following = followAnswer(KEY);

    // Decisions off and on again, and a new answer under way for the same question.
    useDecisionsAnswerStore.getState().clear();
    place("answer-b", { kind: "sending" });
    read.resolve({ result: "not-found" });
    await following;

    expect(getQuestionContent).not.toHaveBeenCalled();
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(readAnswerRecord(KEY).submission).toMatchObject({
      answerId: "answer-b",
      phase: { kind: "sending" },
    });
  });

  it("leaves a newer answer alone when an older one's read lands after it replaced it", async () => {
    place("answer-a", { kind: "lost" });
    const read = deferred<DecisionAnswerResultRead>();
    getAnswerResult.mockReturnValue(read.promise);
    const following = followAnswer(KEY);

    place("answer-b", { kind: "sending" });
    read.resolve({
      result: "read",
      questionId: "q1",
      expectedRevision: 1,
      outcome: { status: "already-answered" },
    });
    await following;

    expect(readAnswerRecord(KEY).submission).toMatchObject({
      answerId: "answer-b",
      phase: { kind: "sending" },
    });
  });

  it("gives Retry back when main never replies to a read", async () => {
    vi.useFakeTimers();
    place("answer-a", { kind: "lost" });
    getAnswerResult.mockReturnValue(new Promise(() => {}));
    const following = followAnswer(KEY);
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("checking");

    await vi.advanceTimersByTimeAsync(60_000);
    await following;
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("lost");

    // And Retry reads it again.
    getAnswerResult.mockResolvedValue({
      result: "read",
      questionId: "q1",
      expectedRevision: 1,
      outcome: { status: "sent" },
    });
    await followAnswer(KEY);
    expect(getAnswerResult).toHaveBeenCalledTimes(2);
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("settled");
  });

  it("lets go of an answer never committed whose question is gone, keeping the draft", async () => {
    place("answer-a", { kind: "lost" });
    getAnswerResult.mockResolvedValue({ result: "not-found" });
    getQuestionContent.mockResolvedValue({ result: "not-found" });
    await followAnswer(KEY);

    const record = readAnswerRecord(KEY);
    expect(record.submission).toBeNull();
    expect(record.hold).toBe("closed");
    expect(record.draft?.selected).toBe("yes");
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("keeps Retry for an answer never committed while its question can't be read just now", async () => {
    place("answer-a", { kind: "lost" });
    getAnswerResult.mockResolvedValue({ result: "not-found" });
    getQuestionContent.mockResolvedValue({ result: "not-running" });
    await followAnswer(KEY);

    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("lost");
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
