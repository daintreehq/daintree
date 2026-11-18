// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnswerDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionThreadAnswer,
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

const OPEN: DecisionQuestionContent = {
  questionId: "q1",
  alias: 1,
  terminalId: "t1",
  reference: REFERENCE,
  revision: 1,
  question: "Ship it?",
  context: null,
  kind: "choice",
  options: [{ id: "yes", label: "Yes", description: null }],
  allowText: false,
  requirement: "human-required",
  askedAt: "2026-11-02T10:00:00.000Z",
  expiresAt: null,
  status: "open",
  closedReason: null,
  deliveryStatus: "relay-queued",
  attachments: [],
  thread: [],
};

const ANSWER: DecisionThreadAnswer = {
  type: "answer",
  entryId: "",
  revision: 2,
  from: "person",
  onComputer: true,
  correction: false,
  confirmsModel: false,
  choices: [{ id: "yes", label: "Yes" }],
  text: null,
  reason: null,
  images: [],
  sentAt: "2026-11-02T10:05:00.000Z",
  unreadable: false,
};

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

  it("sends an answer main hasn't committed again under its id on Retry, however often", async () => {
    place("answer-a", { kind: "lost" });
    useDecisionsAnswerStore.getState().update(KEY, (record) => ({
      ...record,
      submission: record.submission && { ...record.submission, resubmitted: true },
    }));
    getAnswerResult.mockResolvedValue({ result: "not-found" });
    getQuestionContent.mockResolvedValue({ result: "read", question: OPEN });
    answerQuestion.mockRejectedValue(new Error("lost"));

    // On its own, a second time: never; it waits for the person.
    await followAnswer(KEY);
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("lost");

    // Each Retry gives Retry back when its send is lost again.
    await followAnswer(KEY, true);
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("lost");
    await followAnswer(KEY, true);
    expect(readAnswerRecord(KEY).submission?.phase.kind).toBe("lost");
    expect(answerQuestion).toHaveBeenCalledTimes(2);
    for (const [sent] of answerQuestion.mock.calls) expect(sent).toEqual(payload("answer-a"));
    expect(readAnswerRecord(KEY).submission?.answerId).toBe("answer-a");
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

  it.each(["not-running", "off", "unreadable"] as const)(
    "keeps Retry, and the id, while the question reads %s",
    async (result) => {
      place("answer-a", { kind: "lost" });
      getAnswerResult.mockResolvedValue({ result: "not-found" });
      getQuestionContent.mockResolvedValue({ result });
      await followAnswer(KEY);

      expect(readAnswerRecord(KEY).submission).toMatchObject({
        answerId: "answer-a",
        phase: { kind: "lost" },
      });
      expect(answerQuestion).not.toHaveBeenCalled();
    }
  );

  it("counts the answer sent once the question's thread holds it, though its standing read missed it", async () => {
    place("answer-a", { kind: "lost" });
    getAnswerResult.mockResolvedValue({ result: "not-found" });
    getQuestionContent.mockResolvedValue({
      result: "read",
      question: { ...OPEN, status: "human-answered", thread: [{ ...ANSWER, entryId: "answer-a" }] },
    });
    await followAnswer(KEY, true);

    expect(readAnswerRecord(KEY).submission?.phase).toEqual({
      kind: "settled",
      outcome: { status: "sent" },
    });
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
