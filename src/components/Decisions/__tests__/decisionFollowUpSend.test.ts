// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionFollowUpResultRead,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionFollowUpResult,
  DecisionThreadMessage,
  SendDecisionFollowUpPayload,
} from "@shared/types/decisionsQuestion";
import { answerKey } from "@/store/decisionsAnswerStore";
import { readFollowUpRecord, useDecisionsFollowUpStore } from "@/store/decisionsFollowUpStore";
import { declineReply, followFollowUp } from "../decisionFollowUpSend";

const REFERENCE = { hostId: "h", projectId: "p", terminalId: "t1", questionId: "q1" };
const KEY = answerKey(REFERENCE);
const TARGET = { scope: "pane", terminalId: "t1", questionId: "q1" } as const;

const sendFollowUp =
  vi.fn<(payload: SendDecisionFollowUpPayload) => Promise<DecisionQuestionFollowUpResult>>();
const getFollowUpResult =
  vi.fn<(payload: { messageId: string }) => Promise<DecisionFollowUpResultRead>>();
const getQuestionContent =
  vi.fn<
    (payload: { terminalId: string; questionId: string }) => Promise<DecisionQuestionContentResult>
  >();

function agentAsks(messageId: string): DecisionThreadMessage {
  return {
    type: "message",
    messageId,
    from: "agent",
    text: "Which region?",
    images: [],
    expectsReply: true,
    sentAt: "2026-11-02T10:05:00.000Z",
    deliveryStatus: null,
    unreadable: false,
  };
}

function answered(...thread: DecisionThreadMessage[]): DecisionQuestionContent {
  return {
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
    status: "human-answered",
    closedReason: null,
    deliveryStatus: "terminal-delivered",
    attachments: [],
    thread,
  };
}

let shown: DecisionQuestionContent;

beforeEach(() => {
  useDecisionsFollowUpStore.getState().clear();
  shown = answered(agentAsks("m_a"));
  getQuestionContent.mockReset().mockImplementation(async () => ({
    result: "read",
    question: shown,
  }));
  getFollowUpResult.mockReset().mockResolvedValue({ result: "not-found" });
  sendFollowUp.mockReset();
  Reflect.set(window, "electron", {
    decisions: { sendFollowUp, getFollowUpResult, getQuestionContent },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("declineReply past main's deadline (#18030)", () => {
  it("keeps the id of a decline whose send is still out once its request moved, and lets it go only once that send settled", async () => {
    vi.useFakeTimers();
    let settle!: (error: Error) => void;
    sendFollowUp.mockImplementationOnce(() => new Promise((_resolve, reject) => (settle = reject)));
    const declining = declineReply(KEY, TARGET, "m_a");
    await vi.waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(1));
    // The agent asks again while main still holds the send.
    shown = answered(agentAsks("m_a"), agentAsks("m_b"));
    await vi.advanceTimersByTimeAsync(60_000);
    await declining;

    const kept = readFollowUpRecord(KEY);
    expect(kept.submission?.phase).toEqual({ kind: "lost" });
    expect(kept.hold).toBeNull();
    const id = kept.submission!.messageId;
    expect(getFollowUpResult).toHaveBeenCalledWith({ messageId: id });

    // Main gives up on it: nothing of it can land now, so Retry lets it go and says why.
    settle(new Error("link dropped"));
    await vi.advanceTimersByTimeAsync(0);
    await followFollowUp(KEY, true);
    const after = readFollowUpRecord(KEY);
    expect(after.submission).toBeNull();
    expect(after.hold).toBe("request-moved");
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });
});
