// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PaneDecisionState } from "@shared/types/decisions";
import type {
  AnswerDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionAttachment,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
} from "@shared/types/decisionsQuestion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsImageReviewStore } from "@/store/decisionsImageReviewStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

let decisionsOn = true;
const onListeners = new Set<() => void>();
vi.mock("@/hooks/useDecisionsOn", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    onListeners.add(listener);
    return () => onListeners.delete(listener);
  };
  const snapshot = () => (decisionsOn ? "on" : "off");
  return {
    useDecisionsSwitch: () => useSyncExternalStore(subscribe, snapshot),
    useDecisionsOn: () => useSyncExternalStore(subscribe, () => snapshot() === "on"),
  };
});

import { DecisionQuestionDialog } from "../DecisionQuestionDialog";

type Payload = { terminalId: string; questionId: string };
const getQuestionContent = vi.fn<(payload: Payload) => Promise<DecisionQuestionContentResult>>();
const answerQuestion =
  vi.fn<(payload: AnswerDecisionQuestionPayload) => Promise<DecisionQuestionAnswerResult>>();
const getAnswerResult =
  vi.fn<(payload: { answerId: string }) => Promise<DecisionAnswerResultRead>>();
let paneListeners: Array<(state: PaneDecisionState) => void> = [];

const REFERENCE = { hostId: "host_1", projectId: "project-1", terminalId: "t1" };

function question(
  questionId: string,
  over: Partial<DecisionQuestionContent> = {}
): DecisionQuestionContent {
  return {
    questionId,
    alias: 7,
    terminalId: "t1",
    reference: { ...REFERENCE, questionId },
    revision: 1,
    question: "Ship the migration?",
    context: null,
    kind: "choice",
    options: [
      { id: "yes", label: "Ship it", description: "Merge *today*" },
      { id: "no", label: "Hold", description: null },
    ],
    allowText: false,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "open",
    deliveryStatus: "relay-queued",
    attachments: [],
    thread: [],
    ...over,
  };
}

function image(id: string): DecisionQuestionAttachment {
  return {
    attachmentId: id,
    role: "after",
    alt: null,
    mime: "image/png",
    size: 10,
    sha256: id.repeat(64).slice(0, 64),
  };
}

/** What the next read of each question returns. */
let questions: Record<string, DecisionQuestionContent> = {};

function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 4000 });
}

function pushPane() {
  for (const listener of [...paneListeners]) {
    listener({
      terminalId: "t1",
      openQuestions: [],
      waitingAnswers: [],
      needsAttention: [],
      revision: 2,
    });
  }
}

/** Puts `next` in place of the question and tells the view its pane moved. */
async function move(next: DecisionQuestionContent) {
  questions[next.questionId] = next;
  await act(async () => pushPane());
}

async function openOn(...ids: string[]) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, ids[0]!));
  return screen.findByTestId("decision-answer-composer");
}

function send() {
  return screen.getByTestId("decision-answer-send");
}

function option(label: string): HTMLInputElement {
  return screen.getByRole("radio", { name: label }) as HTMLInputElement;
}

function status() {
  return screen.getByTestId("decision-answer-status").textContent ?? "";
}

beforeEach(() => {
  decisionsOn = true;
  paneListeners = [];
  questions = { q1: question("q1") };
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  useDecisionsAnswerStore.getState().clear();
  useDecisionsImageReviewStore.getState().clear();
  getQuestionContent.mockReset().mockImplementation(async ({ questionId }) => {
    const found = questions[questionId];
    return found ? { result: "read", question: found } : { result: "not-found" };
  });
  answerQuestion.mockReset().mockImplementation(async (payload) => ({
    result: "submitted",
    answerId: payload.answerId,
    outcome: { status: "sent" },
  }));
  getAnswerResult.mockReset().mockResolvedValue({ result: "not-found" });
  Reflect.set(window, "electron", {
    decisions: {
      getQuestionContent,
      answerQuestion,
      getAnswerResult,
      getQuestionImage: () => new Promise(() => {}),
      getQuestionSummaries: async () => ({ result: "not-running" }),
    },
    events: { on: () => () => {} },
    terminal: {
      onDecisionState: (callback: (state: PaneDecisionState) => void) => {
        paneListeners.push(callback);
        return () => {
          paneListeners = paneListeners.filter((listener) => listener !== callback);
        };
      },
    },
  });
  render(
    <TooltipProvider>
      <DecisionQuestionDialog />
    </TooltipProvider>
  );
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("answering a question from the view (#17102)", () => {
  it("offers a choice question's options, and sends the chosen one after reading it again", async () => {
    await openOn("q1");
    expect(screen.queryByRole("textbox")).toBeNull();
    // The options are offered in the composer, not listed a second time.
    expect(screen.getAllByText("Ship it")).toHaveLength(1);
    expect(send().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send());
    expect(answerQuestion).not.toHaveBeenCalled();

    fireEvent.click(option("Ship it"));
    expect(send().getAttribute("aria-disabled")).toBeNull();
    const reads = getQuestionContent.mock.calls.length;
    await act(async () => fireEvent.click(send()));

    expect(getQuestionContent.mock.calls.length).toBeGreaterThan(reads);
    expect(answerQuestion).toHaveBeenCalledOnce();
    const payload = answerQuestion.mock.calls[0]![0];
    expect(payload).toEqual({
      reference: questions.q1!.reference,
      answerId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      expectedRevision: 1,
      selectedOptionIds: ["yes"],
      reviewedAttachmentDigests: [],
    });
    await waitFor(() => expect(status()).toMatch(/sent/i));
    expect(screen.queryByTestId("decision-answer-composer")).toBeNull();
  });

  it("offers a text field for a text question, sending on Ctrl+Enter but not on Enter", async () => {
    questions.q1 = question("q1", { kind: "text", options: [], allowText: true });
    await openOn("q1");
    expect(screen.queryByRole("radio")).toBeNull();
    const field = screen.getByTestId("decision-answer-text");

    fireEvent.change(field, { target: { value: "   " } });
    expect(send().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(field, { target: { value: "Use the old schema" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(answerQuestion).not.toHaveBeenCalled();

    await act(async () => fireEvent.keyDown(field, { key: "Enter", ctrlKey: true }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledOnce());
    expect(answerQuestion.mock.calls[0]![0]).toMatchObject({
      selectedOptionIds: [],
      text: "Use the old schema",
    });
  });

  it("puts a note beside the choice where the question takes words too", async () => {
    questions.q1 = question("q1", { allowText: true });
    await openOn("q1");
    const note = screen.getByLabelText("Note (optional)");
    fireEvent.change(note, { target: { value: "after lunch" } });
    // A note alone doesn't answer a choice.
    expect(send().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(option("Hold"));
    await act(async () => fireEvent.click(send()));
    expect(answerQuestion.mock.calls[0]![0]).toMatchObject({
      selectedOptionIds: ["no"],
      text: "after lunch",
    });
  });

  it("keeps an approval's choices unavailable until every image has been opened", async () => {
    const images = [image("x"), image("y")];
    questions.q1 = question("q1", {
      kind: "approval",
      options: [
        { id: "approve", label: "Approve", description: null },
        { id: "reject", label: "Reject", description: null },
      ],
      attachments: images,
    });
    await openOn("q1");
    expect(option("Approve").disabled).toBe(true);
    expect(option("Reject").disabled).toBe(true);
    const hintBefore = screen.getByTestId("decision-answer-composer").textContent;

    act(() => useDecisionsImageReviewStore.getState().markShown("t1", "q1", "x", images[0]!.sha256));
    expect(option("Approve").disabled).toBe(true);
    expect(screen.getByTestId("decision-answer-composer").textContent).not.toBe(hintBefore);

    act(() => useDecisionsImageReviewStore.getState().markShown("t1", "q1", "y", images[1]!.sha256));
    expect(option("Approve").disabled).toBe(false);
    fireEvent.click(option("Reject"));
    await act(async () => fireEvent.click(send()));
    expect(answerQuestion.mock.calls[0]![0]).toMatchObject({
      selectedOptionIds: ["reject"],
      explicitApproval: true,
      reviewedAttachmentDigests: [images[0]!.sha256, images[1]!.sha256],
    });
  });

  it.each([
    ["human-answered", /answered elsewhere/],
    ["cancelled", /cancelled/],
    ["expired", /expired/],
  ] as const)(
    "says a question %s while composing has nothing sent",
    async (closedStatus, words) => {
      await openOn("q1");
      fireEvent.click(option("Ship it"));
      await move(question("q1", { status: closedStatus }));
      await waitFor(() => expect(screen.queryByTestId("decision-answer-composer")).toBeNull());
      expect(status()).toMatch(words);
      expect(status()).toMatch(/wasn't sent/);
      expect(answerQuestion).not.toHaveBeenCalled();
    }
  );

  it("sends nothing when the read at Send finds the question closed", async () => {
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    // Cancelled since the last read, with nothing yet telling the view.
    questions.q1 = question("q1", { status: "cancelled" });
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(status()).toMatch(/cancelled/));
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("sends nothing past the question's expiry, even before the store records it", async () => {
    questions.q1 = question("q1", { expiresAt: new Date(Date.now() + 300).toISOString() });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await waitFor(() => expect(screen.queryByTestId("decision-answer-composer")).toBeNull());
    expect(status()).toMatch(/expired/);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("asks for the changed question to be reviewed before an answer goes", async () => {
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await move(question("q1", { revision: 2 }));
    await screen.findByTestId("decision-answer-stale");
    expect(send().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send());
    expect(answerQuestion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Review update" }));
    expect(screen.queryByTestId("decision-answer-stale")).toBeNull();
    // The choice was made on the old question; it is made again.
    expect(option("Ship it").checked).toBe(false);
    fireEvent.click(option("Hold"));
    await act(async () => fireEvent.click(send()));
    expect(answerQuestion.mock.calls[0]![0].expectedRevision).toBe(2);
  });

  it("says an update is needed, and that the phone can still answer, when the relay can't take it", async () => {
    answerQuestion.mockResolvedValue({
      result: "submitted",
      answerId: "x",
      outcome: { status: "unsupported", by: "relay" },
    });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    const notice = await screen.findByTestId("decision-answer-notice");
    expect(notice.textContent).toMatch(/update/);
    expect(notice.textContent).toMatch(/phone can still answer/);
    // The draft stays for when it can be sent.
    expect(option("Ship it").checked).toBe(true);
  });

  it("names the asking computer when it is the one that needs the update", async () => {
    answerQuestion.mockResolvedValue({
      result: "submitted",
      answerId: "x",
      outcome: { status: "unsupported", by: "asking-desktop" },
    });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    const notice = await screen.findByTestId("decision-answer-notice");
    expect(notice.textContent).toMatch(/computer that asked/);
    expect(notice.textContent).toMatch(/phone can still answer/);
  });

  it("follows a queued answer until the relay takes it, then until it is typed in", async () => {
    answerQuestion.mockImplementation(async (payload) => ({
      result: "submitted",
      answerId: payload.answerId,
      outcome: { status: "queued" },
    }));
    getAnswerResult.mockImplementation(async () => ({
      result: "read",
      questionId: "q1",
      expectedRevision: 1,
      outcome: { status: "sent" },
    }));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    const answerId = answerQuestion.mock.calls[0]![0].answerId;
    await waitFor(() => expect(getAnswerResult).toHaveBeenCalledWith({ answerId }));
    await waitFor(() => expect(status()).toMatch(/^Answer sent$/));

    const answered = {
      status: "human-answered" as const,
      thread: [
        {
          type: "answer" as const,
          entryId: answerId,
          revision: 2,
          from: "person" as const,
          onComputer: true,
          correction: false,
          confirmsModel: false,
          choices: [{ id: "yes", label: "Ship it" }],
          text: null,
          reason: null,
          images: [],
          sentAt: "2026-11-02T10:05:00.000Z",
          unreadable: false,
        },
      ],
    };
    await move(question("q1", { ...answered, deliveryStatus: "desktop-received" }));
    await waitFor(() => expect(status()).toMatch(/Waiting for it to be typed/));
    expect(screen.getAllByTestId("decision-thread-entry")[0]!.textContent).toMatch(
      /from your computer/
    );
    await move(question("q1", { ...answered, deliveryStatus: "terminal-delivered" }));
    await waitFor(() => expect(status()).toMatch(/typed into the terminal/));
  });

  it("sends the same answer under the same id when main's reply is lost and it never got there", async () => {
    answerQuestion.mockRejectedValueOnce(new Error("lost"));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(2));
    const [first, second] = answerQuestion.mock.calls.map(([payload]) => payload);
    expect(second).toEqual(first);
    expect(getAnswerResult).toHaveBeenCalledWith({ answerId: first!.answerId });
    await waitFor(() => expect(status()).toMatch(/sent/i));
  });

  it("sends one answer however many times Send is pressed", async () => {
    let finish: (() => void) | undefined;
    getQuestionContent.mockImplementation(async ({ questionId }) => ({
      result: "read",
      question: questions[questionId]!,
    }));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    getQuestionContent.mockImplementation(
      ({ questionId }) =>
        new Promise((resolve) => {
          finish = () => resolve({ result: "read", question: questions[questionId]! });
        })
    );
    fireEvent.click(send());
    fireEvent.click(send());
    fireEvent.click(send());
    await act(async () => finish?.());
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledOnce());
  });

  it("keeps the arrow keys on an option's choice rather than stepping questions", async () => {
    questions.q2 = question("q2", { alias: 8 });
    await openOn("q1", "q2");
    const yes = option("Ship it");
    fireEvent.keyDown(yes, { key: "ArrowRight" });
    expect(useDecisionsQuestionViewStore.getState().request?.index).toBe(0);
  });

  it("keeps a draft across stepping away and back, and forgets it once Decisions is off", async () => {
    questions.q2 = question("q2", { alias: 8 });
    await openOn("q1", "q2");
    fireEvent.click(option("Hold"));
    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-8"));
    expect(option("Hold").checked).toBe(false);
    fireEvent.click(screen.getByTestId("decision-question-previous"));
    await waitFor(() => expect(option("Hold").checked).toBe(true));

    act(() => {
      decisionsOn = false;
      for (const listener of onListeners) listener();
    });
    expect(useDecisionsAnswerStore.getState().records).toEqual({});
  });

  it("offers no withdrawal while an answer from here is on its way", async () => {
    answerQuestion.mockImplementation(() => new Promise(() => {}));
    await openOn("q1");
    expect(screen.queryByTestId("decision-question-cancel")).not.toBeNull();
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(screen.queryByTestId("decision-question-cancel")).toBeNull());
    expect(status()).toMatch(/Sending/);
  });
});
