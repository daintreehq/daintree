// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionDeclineResultRead,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionDeclineResult,
  DeclineDecisionQuestionPayload,
} from "@shared/types/decisionsQuestion";
import { answerKey, readAnswerRecord, useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { QUEUED_DECLINE_READ_MS, dismissQuestion, followDecline } from "../decisionDeclineSend";
import { paneQuestion, referencedQuestion } from "../decisionQuestionTarget";

const getQuestionContent =
  vi.fn<
    (payload: { terminalId: string; questionId: string }) => Promise<DecisionQuestionContentResult>
  >();
const declineQuestion =
  vi.fn<(payload: DeclineDecisionQuestionPayload) => Promise<DecisionQuestionDeclineResult>>();
const getDeclineResult =
  vi.fn<(payload: { declineId: string }) => Promise<DecisionDeclineResultRead>>();

const TARGET = paneQuestion("t1", "q42");

function question(over: Partial<DecisionQuestionContent> = {}): DecisionQuestionContent {
  return {
    questionId: "q42",
    alias: 42,
    terminalId: "t1",
    reference: { hostId: "host_studio", projectId: "p1", terminalId: "t1", questionId: "q42" },
    revision: 3,
    question: "Merge the release branch?",
    context: null,
    kind: "approval",
    options: [],
    allowText: false,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "open",
    closedReason: null,
    deliveryStatus: "not-sent",
    attachments: [],
    thread: [],
    ...over,
  };
}

const KEY = answerKey(question().reference);

function submitted(
  outcome: Extract<DecisionQuestionDeclineResult, { result: "submitted" }>["outcome"]
) {
  return async ({
    declineId,
  }: DeclineDecisionQuestionPayload): Promise<DecisionQuestionDeclineResult> => ({
    result: "submitted",
    declineId,
    outcome,
  });
}

function read(
  outcome: Extract<DecisionDeclineResultRead, { result: "read" }>["outcome"]
): DecisionDeclineResultRead {
  return { result: "read", questionId: "q42", expectedRevision: 3, outcome };
}

beforeEach(() => {
  useDecisionsAnswerStore.getState().clear();
  getQuestionContent.mockReset().mockResolvedValue({ result: "read", question: question() });
  declineQuestion.mockReset().mockImplementation(submitted({ status: "declined" }));
  getDeclineResult.mockReset().mockResolvedValue({ result: "not-found" });
  Reflect.set(window, "electron", {
    decisions: { getQuestionContent, declineQuestion, getDeclineResult },
  });
});

afterEach(() => {
  vi.useRealTimers();
  useDecisionsAnswerStore.getState().clear();
  Reflect.deleteProperty(window, "electron");
});

describe("dismissing a question from this computer (#17239)", () => {
  it("signs at the revision it's open at, under one id, with the reference it was read by", async () => {
    await expect(dismissQuestion(TARGET, null)).resolves.toEqual({
      kind: "submitted",
      key: KEY,
      phase: { kind: "settled", outcome: { status: "declined" } },
    });
    expect(declineQuestion).toHaveBeenCalledExactlyOnceWith({
      reference: question().reference,
      declineId: expect.any(String),
      expectedRevision: 3,
    });
  });

  it("sends one whose reply was lost again under the same id once on its own, and again only on Retry", async () => {
    declineQuestion.mockRejectedValue(new Error("main didn't answer"));

    await expect(dismissQuestion(TARGET, null)).resolves.toMatchObject({
      kind: "submitted",
      phase: { kind: "lost" },
    });
    expect(declineQuestion).toHaveBeenCalledTimes(2);
    const [first, second] = declineQuestion.mock.calls.map(([payload]) => payload);
    expect(second).toEqual(first);

    // Read again on its own: never sent a third time.
    await followDecline(KEY);
    expect(getDeclineResult).toHaveBeenLastCalledWith({ declineId: first!.declineId });
    expect(declineQuestion).toHaveBeenCalledTimes(2);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({ kind: "lost" });

    // The person's Retry sends it again, still the same decline.
    declineQuestion.mockImplementationOnce(submitted({ status: "declined" }));
    await followDecline(KEY, true);
    expect(declineQuestion).toHaveBeenCalledTimes(3);
    expect(declineQuestion.mock.calls[2]![0]).toEqual(first);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({
      kind: "settled",
      outcome: { status: "declined" },
    });
  });

  it("reads a lost one back by its id first, without reading the question from a computer that may be out of reach", async () => {
    declineQuestion.mockRejectedValue(new Error("main didn't answer"));
    await dismissQuestion(TARGET, null);
    getQuestionContent.mockClear().mockRejectedValue(new Error("the host is away"));
    getDeclineResult.mockResolvedValue(read({ status: "declined" }));

    await expect(dismissQuestion(TARGET, null, KEY)).resolves.toMatchObject({
      kind: "submitted",
      phase: { kind: "settled", outcome: { status: "declined" } },
    });
    expect(getQuestionContent).not.toHaveBeenCalled();
    expect(declineQuestion).toHaveBeenCalledTimes(2);
  });

  it("makes a second Dismiss while the first is with main wait for it, never sending again", async () => {
    let finish!: (result: DecisionQuestionDeclineResult) => void;
    declineQuestion.mockImplementationOnce(
      () => new Promise<DecisionQuestionDeclineResult>((resolve) => (finish = resolve))
    );

    const first = dismissQuestion(TARGET, null);
    await vi.waitFor(() => expect(declineQuestion).toHaveBeenCalledOnce());
    const second = dismissQuestion(TARGET, null);
    await vi.waitFor(() => expect(getQuestionContent).toHaveBeenCalledTimes(2));
    finish({
      result: "submitted",
      declineId: declineQuestion.mock.calls[0]![0].declineId,
      outcome: { status: "unsupported", by: "relay" },
    });

    const settled = { kind: "settled", outcome: { status: "unsupported", by: "relay" } };
    await expect(first).resolves.toMatchObject({ phase: settled });
    await expect(second).resolves.toMatchObject({ phase: settled });
    expect(declineQuestion).toHaveBeenCalledOnce();
    expect(getDeclineResult).not.toHaveBeenCalled();
  });

  it("signs nothing while an answer from here is under way", async () => {
    useDecisionsAnswerStore.getState().update(KEY, (record) => ({ ...record, preparing: true }));

    await expect(dismissQuestion(TARGET, null)).resolves.toEqual({ kind: "busy" });
    expect(declineQuestion).not.toHaveBeenCalled();
  });

  it("signs nothing for a question no longer waiting, or moved on from the revision read", async () => {
    getQuestionContent.mockResolvedValueOnce({
      result: "read",
      question: question({ status: "human-answered" }),
    });
    await expect(dismissQuestion(TARGET, null)).resolves.toEqual({ kind: "gone" });
    await expect(dismissQuestion(TARGET, 2)).resolves.toEqual({ kind: "changed" });
    expect(declineQuestion).not.toHaveBeenCalled();
  });

  it("reads a queued one again on its own until it settles, wherever it was asked from", async () => {
    vi.useFakeTimers();
    declineQuestion.mockImplementation(submitted({ status: "queued" }));
    await dismissQuestion(TARGET, null);
    getDeclineResult.mockResolvedValue(read({ status: "queued" }));

    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(getDeclineResult).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(getDeclineResult).toHaveBeenCalledTimes(2);

    getDeclineResult.mockResolvedValue(read({ status: "unsupported", by: "asking-desktop" }));
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({
      kind: "settled",
      outcome: { status: "unsupported", by: "asking-desktop" },
    });
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS * 3);
    expect(getDeclineResult).toHaveBeenCalledTimes(3);
  });

  it("keeps reading a queued one through a read main couldn't answer, less often, until it settles", async () => {
    vi.useFakeTimers();
    declineQuestion.mockImplementation(submitted({ status: "queued" }));
    await dismissQuestion(TARGET, null);
    getDeclineResult.mockRejectedValueOnce(new Error("main didn't answer"));

    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({ kind: "lost" });
    getDeclineResult.mockResolvedValue(read({ status: "declined" }));
    // Backed off: not read again at the queued pace.
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(getDeclineResult).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(getDeclineResult).toHaveBeenCalledTimes(2);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({
      kind: "settled",
      outcome: { status: "declined" },
    });
    // Never sent again: it was committed.
    expect(declineQuestion).toHaveBeenCalledOnce();
  });

  it("never reads on its own one main didn't acknowledge, leaving it to Retry", async () => {
    vi.useFakeTimers();
    declineQuestion.mockRejectedValue(new Error("main didn't answer"));
    await dismissQuestion(TARGET, null);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({ kind: "lost" });
    const reads = getDeclineResult.mock.calls.length;

    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS * 30);
    expect(getDeclineResult).toHaveBeenCalledTimes(reads);
  });

  it("gives a Retry that joins a read already under way its own resend", async () => {
    declineQuestion.mockRejectedValue(new Error("main didn't answer"));
    await dismissQuestion(TARGET, null);
    expect(declineQuestion).toHaveBeenCalledTimes(2);
    let answer!: (read: DecisionDeclineResultRead) => void;
    getDeclineResult.mockImplementationOnce(
      () => new Promise<DecisionDeclineResultRead>((resolve) => (answer = resolve))
    );
    declineQuestion.mockImplementation(submitted({ status: "declined" }));

    // A read on its own, which may not resend, is under way when the person presses Retry.
    const background = followDecline(KEY);
    const retry = followDecline(KEY, true);
    answer({ result: "not-found" });
    await Promise.all([background, retry]);

    expect(declineQuestion).toHaveBeenCalledTimes(3);
    expect(readAnswerRecord(KEY).decline?.phase).toEqual({
      kind: "settled",
      outcome: { status: "declined" },
    });
  });

  it("stops reading a queued one once Decisions is turned off", async () => {
    vi.useFakeTimers();
    declineQuestion.mockImplementation(submitted({ status: "queued" }));
    await dismissQuestion(TARGET, null);
    getDeclineResult.mockResolvedValue(read({ status: "queued" }));
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS);
    expect(getDeclineResult).toHaveBeenCalledTimes(1);

    useDecisionsAnswerStore.getState().clear();
    await vi.advanceTimersByTimeAsync(QUEUED_DECLINE_READ_MS * 3);
    expect(getDeclineResult).toHaveBeenCalledTimes(1);
    expect(readAnswerRecord(KEY).decline).toBeNull();
  });
});

describe("dismissing a Remote Host's question while its Host is away (#17946)", () => {
  const ON_HOST = { hostId: "qhost_studio", projectId: "p1", terminalId: "t1", questionId: "q42" };
  const AWAY = referencedQuestion(ON_HOST);
  const AWAY_KEY = answerKey(ON_HOST);
  const getQuestionContentByReference =
    vi.fn<(payload: { reference: typeof ON_HOST }) => Promise<DecisionQuestionContentResult>>();

  beforeEach(() => {
    getQuestionContentByReference.mockReset().mockResolvedValue({
      result: "host-not-connected",
      lastRead: { result: "read", revision: 3, alias: 42, readAt: 1_000 },
    });
    Reflect.set(window, "electron", {
      decisions: { getQuestionContentByReference, declineQuestion, getDeclineResult },
    });
  });

  it("signs at the revision this computer last read it open at, by the reference it was read by", async () => {
    declineQuestion.mockImplementation(submitted({ status: "queued" }));
    await expect(dismissQuestion(AWAY, 3)).resolves.toEqual({
      kind: "submitted",
      key: AWAY_KEY,
      phase: { kind: "settled", outcome: { status: "queued" } },
    });
    expect(declineQuestion).toHaveBeenCalledExactlyOnceWith({
      reference: ON_HOST,
      declineId: expect.any(String),
      expectedRevision: 3,
    });
  });

  it("signs nothing when the last read isn't the revision the person saw", async () => {
    await expect(dismissQuestion(AWAY, 2)).resolves.toEqual({ kind: "changed" });
    expect(declineQuestion).not.toHaveBeenCalled();
  });

  it("signs nothing when nothing read here says which revision it waits at, or the relay can't hold it yet", async () => {
    for (const lastRead of [undefined, { result: "not-read" }, { result: "not-sent" }] as const) {
      getQuestionContentByReference.mockResolvedValue(
        lastRead === undefined
          ? { result: "host-not-connected" }
          : { result: "host-not-connected", lastRead }
      );
      await expect(dismissQuestion(AWAY, null)).resolves.toEqual({
        kind: "failed",
        reason: "host-not-connected",
      });
    }
    expect(declineQuestion).not.toHaveBeenCalled();
  });
});
