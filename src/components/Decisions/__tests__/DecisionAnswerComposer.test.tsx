// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { isMac } from "@/lib/platform";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
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
/** The view's bridge to main, as each test sets it up. */
let decisionsBridge: Record<string, unknown> = {};

/** Past one queued read's wait, so a read that would follow it has had its chance. */
const PAST_ONE_QUEUED_READ_MS = 2_300;

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
    closedReason: null,
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

/**
 * The composer mounts from a read that lands outside `act`, so it shows before
 * its store subscriptions start; a click before then would go unrendered.
 */
async function settle() {
  await act(async () => {});
}

async function openOn(...ids: string[]) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, ids[0]!));
  const composer = await screen.findByTestId("decision-answer-composer");
  await settle();
  return composer;
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

/**
 * The deadline line runs on its own clock, so it can still read the time left
 * for a moment after the composer's notice has appeared: wait for it rather
 * than read it beside the notice.
 */
async function passedDeadline() {
  await waitFor(() =>
    expect(screen.getByTestId("decision-question-deadline").textContent).toMatch(/Deadline passed/)
  );
  return screen.getByTestId("decision-question-deadline").textContent ?? "";
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
  decisionsBridge = {
    getQuestionContent,
    answerQuestion,
    getAnswerResult,
    getQuestionImage: () => new Promise(() => {}),
    getQuestionSummaries: async () => ({ result: "not-running" }),
  };
  Reflect.set(window, "electron", {
    decisions: decisionsBridge,
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
    // A choice question's answer takes no words; the box below the thread is a follow-up's (#17238).
    expect(
      within(screen.getByTestId("decision-answer-composer")).queryByRole("textbox")
    ).toBeNull();
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

    act(() =>
      useDecisionsImageReviewStore.getState().markShown("t1", "q1", "x", images[0]!.sha256)
    );
    expect(option("Approve").disabled).toBe(true);
    expect(screen.getByTestId("decision-answer-composer").textContent).not.toBe(hintBefore);

    act(() =>
      useDecisionsImageReviewStore.getState().markShown("t1", "q1", "y", images[1]!.sha256)
    );
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

  it("keeps a draft, locked, past the question's deadline, and sends nothing before the store records it (#17943)", async () => {
    questions.q1 = question("q1", { expiresAt: new Date(Date.now() + 300).toISOString() });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    const notice = await screen.findByTestId("decision-answer-notice", {}, { timeout: 2_000 });
    // Only the clock says it passed: the draft stays where it was written, unsendable.
    expect(notice.textContent).toMatch(/deadline has passed/);
    expect(screen.queryByTestId("decision-answer-composer")).not.toBeNull();
    expect(option("Ship it").checked).toBe(true);
    expect(send().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send());
    // The platform's own shortcut, from the form: the keyboard can't send it either.
    const mac = isMac();
    fireEvent.keyDown(option("Ship it"), { key: "Enter", metaKey: mac, ctrlKey: !mac });
    // A choice can't be changed past the deadline, though the options stay focusable.
    expect(option("Hold").disabled).toBe(false);
    fireEvent.click(option("Hold"));
    expect(option("Ship it").checked).toBe(true);
    expect(answerQuestion).not.toHaveBeenCalled();

    // Once the store records the expiry, the form goes and says so.
    await move(question("q1", { status: "expired", expiresAt: questions.q1.expiresAt }));
    await waitFor(() => expect(screen.queryByTestId("decision-answer-composer")).toBeNull());
    expect(status()).toMatch(/expired/);
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
    expect(notice.textContent).toMatch(/relay needs an update/);
    expect(notice.textContent).not.toMatch(/computer that asked/);
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
    expect(notice.textContent).toMatch(/computer that asked needs an update/);
    expect(notice.textContent).not.toMatch(/relay/);
    expect(notice.textContent).toMatch(/phone can still answer/);
  });

  it("follows a queued answer until the relay takes it, then until it is typed in", async () => {
    answerQuestion.mockImplementation(async (payload) => ({
      result: "submitted",
      answerId: payload.answerId,
      outcome: { status: "queued" },
    }));
    // Still queued at the first read, taken at the second.
    getAnswerResult
      .mockResolvedValueOnce({
        result: "read",
        questionId: "q1",
        expectedRevision: 1,
        outcome: { status: "queued" },
      })
      .mockResolvedValue({
        result: "read",
        questionId: "q1",
        expectedRevision: 1,
        outcome: { status: "sent" },
      });
    // Not yet sent to the relay itself: it takes an answer all the same.
    questions.q1 = question("q1", { status: "queued" });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    const answerId = answerQuestion.mock.calls[0]![0].answerId;
    await waitFor(() => expect(status()).toMatch(/queued/));
    await waitFor(() => expect(getAnswerResult).toHaveBeenCalledTimes(2));
    expect(getAnswerResult).toHaveBeenLastCalledWith({ answerId });
    await waitFor(() => expect(status()).toMatch(/^Answer sent$/));
    // Taken: no more reads of its standing.
    const reads = getAnswerResult.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, PAST_ONE_QUEUED_READ_MS));
    expect(getAnswerResult).toHaveBeenCalledTimes(reads);

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

  it.each([
    ["not-owner", { result: "refused", reason: "not-owner" }, /doesn't sign answers/],
    ["invalid", { result: "refused", reason: "invalid", detail: "x" }, /doesn't fit/],
    ["unreadable", { result: "refused", reason: "unreadable" }, /couldn't be opened/],
    [
      "not-found",
      { result: "refused", reason: "not-found" },
      /can't be answered from this computer/,
    ],
  ] as const)("says nothing was sent when main refuses it: %s", async (_name, refusal, words) => {
    answerQuestion.mockResolvedValue(refusal as DecisionQuestionAnswerResult);
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    const notice = await screen.findByTestId("decision-answer-notice");
    expect(notice.textContent).toMatch(words);
    expect(notice.textContent).toMatch(/nothing was sent/);
    expect(screen.queryByTestId("decision-answer-status")).toBeNull();
    expect(option("Ship it").checked).toBe(true);
  });

  it("names a question opened by reference as its content does, whichever machine asked", async () => {
    const remote = {
      hostId: "host_2",
      projectId: "project-b",
      terminalId: "t9",
      questionId: "qr",
    };
    const getQuestionContentByReference = vi.fn(async () => ({
      result: "read" as const,
      question: question("qr", { terminalId: "t9", reference: remote }),
    }));
    decisionsBridge.getQuestionContentByReference = getQuestionContentByReference;
    act(() => useDecisionsQuestionViewStore.getState().openReference([remote], remote));
    await screen.findByTestId("decision-answer-composer");
    await settle();
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    expect(getQuestionContent).not.toHaveBeenCalled();
    expect(answerQuestion.mock.calls[0]![0].reference).toEqual(remote);
  });

  it("sends on Cmd+Enter on a Mac, and never mid-composition or on a held key", async () => {
    const platform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      questions.q1 = question("q1", { kind: "text", options: [], allowText: true });
      await openOn("q1");
      const field = screen.getByTestId("decision-answer-text");
      expect(field.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
      fireEvent.change(field, { target: { value: "Yes" } });
      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(field, { key: "Enter", metaKey: true, isComposing: true });
      fireEvent.keyDown(field, { key: "Enter", metaKey: true, repeat: true });
      await act(async () => {});
      expect(answerQuestion).not.toHaveBeenCalled();
      await act(async () => fireEvent.keyDown(field, { key: "Enter", metaKey: true }));
      await waitFor(() => expect(answerQuestion).toHaveBeenCalledOnce());
    } finally {
      if (platform) Object.defineProperty(window.navigator, "platform", platform);
      else Reflect.deleteProperty(window.navigator, "platform");
    }
  });

  it("describes an unavailable Send by what it waits for", async () => {
    await openOn("q1");
    const describedBy = send().getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const hint = document.getElementById(describedBy!);
    expect(hint?.textContent).toBe("Choose an option");
    fireEvent.click(option("Ship it"));
    expect(send().getAttribute("aria-describedby")).toBeNull();
  });

  it("moves focus from Send to where the answer stands once it goes", async () => {
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    send().focus();
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(status()).toMatch(/sent/i));
    expect(document.activeElement).toBe(screen.getByTestId("decision-answer-status"));
  });

  it("moves focus to the words when a mixed question's choice is cleared", async () => {
    questions.q1 = question("q1", { kind: "mixed", allowText: true });
    await openOn("q1");
    fireEvent.click(option("Hold"));
    const clear = screen.getByRole("button", { name: "Clear choice" });
    clear.focus();
    fireEvent.click(clear);
    expect(option("Hold").checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Clear choice" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("decision-answer-text"));
  });

  it("sends nothing from a Send whose read lands after Decisions was turned off", async () => {
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    let finish: (() => void) | undefined;
    getQuestionContent.mockImplementation(
      ({ questionId }) =>
        new Promise((resolve) => {
          finish = () => resolve({ result: "read", question: questions[questionId]! });
        })
    );
    fireEvent.click(send());
    await waitFor(() => expect(finish).toBeDefined());
    act(() => {
      decisionsOn = false;
      for (const listener of onListeners) listener();
    });
    await act(async () => finish?.());
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(useDecisionsAnswerStore.getState().records).toEqual({});
  });

  it("sends an unconfirmed answer again only under its own id: once on its own, then on Retry", async () => {
    answerQuestion.mockRejectedValue(new Error("lost"));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    // Lost, not found under its id, sent again under it, and lost again.
    await waitFor(() => expect(status()).toMatch(/Couldn't confirm/));
    expect(answerQuestion).toHaveBeenCalledTimes(2);
    // Its fate unknown, it is never offered for a fresh Send.
    expect(screen.queryByTestId("decision-answer-composer")).toBeNull();

    answerQuestion.mockImplementation(async (sent) => ({
      result: "submitted",
      answerId: sent.answerId,
      outcome: { status: "sent" },
    }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(status()).toBe("Answer sent"));
    expect(answerQuestion).toHaveBeenCalledTimes(3);
    const [first, second, third] = answerQuestion.mock.calls.map(([sent]) => sent);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("shows the question as it is now when Retry finds it closed", async () => {
    answerQuestion.mockRejectedValue(new Error("lost"));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(status()).toMatch(/Couldn't confirm/));

    // Cancelled since, with nothing yet telling the view.
    questions.q1 = question("q1", { status: "cancelled" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(status()).toMatch(/was cancelled, so your answer wasn't sent/));
    expect(answerQuestion).toHaveBeenCalledTimes(2);
  });

  it("keeps following an answer when main's connection ends under it, since it may be committed", async () => {
    answerQuestion.mockResolvedValue({ result: "not-running" });
    getAnswerResult.mockImplementation(async () => ({
      result: "read",
      questionId: "q1",
      expectedRevision: 1,
      outcome: { status: "sent" },
    }));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(status()).toMatch(/^Answer sent$/));
    expect(answerQuestion).toHaveBeenCalledOnce();
    expect(getAnswerResult).toHaveBeenCalledWith({
      answerId: answerQuestion.mock.calls[0]![0].answerId,
    });
  });

  it("doesn't send a lost answer again once the question has closed", async () => {
    answerQuestion.mockRejectedValueOnce(new Error("lost"));
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    getQuestionContent.mockImplementation(async ({ questionId }) => ({
      result: "read",
      question: questions[questionId]!,
    }));
    getAnswerResult.mockImplementation(async () => {
      // Cancelled while main's reply was lost, and nothing was committed.
      questions.q1 = question("q1", { status: "cancelled" });
      return { result: "not-found" };
    });
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(status()).toMatch(/cancelled/));
    expect(answerQuestion).toHaveBeenCalledOnce();
  });

  it("offers no dismissal while Send reads the question again", async () => {
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    getQuestionContent.mockImplementation(() => new Promise(() => {}));
    expect(screen.queryByTestId("decision-question-dismiss")).not.toBeNull();
    await act(async () => fireEvent.click(send()));
    expect(screen.queryByTestId("decision-question-dismiss")).toBeNull();
  });

  it("offers no dismissal while an answer from here is on its way", async () => {
    answerQuestion.mockImplementation(() => new Promise(() => {}));
    await openOn("q1");
    expect(screen.queryByTestId("decision-question-dismiss")).not.toBeNull();
    fireEvent.click(option("Ship it"));
    await act(async () => fireEvent.click(send()));
    await waitFor(() => expect(screen.queryByTestId("decision-question-dismiss")).toBeNull());
    expect(status()).toMatch(/Sending/);
  });
});

/** Long enough after a deadline crossing for any re-render or re-read it starts to land. */
const SETTLE_AFTER_CROSSING_MS = 200;

describe("a timed question in the view (#17943)", () => {
  const PHONE_ANSWER = {
    type: "answer" as const,
    entryId: "a-phone",
    revision: 1,
    from: "person" as const,
    onComputer: false,
    correction: false,
    confirmsModel: false,
    choices: [{ id: "no", label: "Hold" }],
    text: null,
    reason: null,
    images: [],
    sentAt: "2026-11-02T10:04:00.000Z",
    unreadable: false,
  };

  it("names the mode, when to reply by, the time left and the agent's plan, and what declining means", async () => {
    questions.q1 = question("q1", {
      expiresAt: new Date(Date.now() + 8 * 60_000 + 30_000).toISOString(),
      replyMode: "advisory",
      plannedFallback: "use the existing fixture",
    });
    await openOn("q1");
    const deadline = screen.getByTestId("decision-question-deadline").textContent ?? "";
    expect(deadline).toMatch(/^Advisory/);
    expect(deadline).toMatch(/Reply by .+/);
    expect(deadline).toMatch(/8 minutes left/);
    const plan = screen.getByTestId("decision-question-plan").textContent ?? "";
    expect(plan).toMatch(/If unanswered, the agent plans to/);
    expect(plan).toMatch(/use the existing fixture/);

    // The consequence is said before anything is signed.
    fireEvent.click(screen.getByTestId("decision-question-dismiss"));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toMatch(/doesn't let the agent go ahead with any plan it stated/);
  });

  it("lists the options, with no form, for a question opened untouched after its deadline", async () => {
    questions.q1 = question("q1", {
      replyMode: "blocking",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    act(() => useDecisionsQuestionViewStore.getState().open("t1", ["q1"], "q1"));
    await screen.findByTestId("decision-question-content");
    await settle();
    expect(screen.queryByTestId("decision-answer-composer")).toBeNull();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("keeps the form, and then where the answer stands, for someone in it with nothing written", async () => {
    questions.q1 = question("q1", {
      kind: "text",
      options: [],
      allowText: true,
      replyMode: "blocking",
      expiresAt: new Date(Date.now() + 500).toISOString(),
    });
    await openOn("q1");
    const text = screen.getByTestId("decision-answer-text") as HTMLTextAreaElement;
    act(() => text.focus());
    await screen.findByTestId("decision-answer-notice", {}, { timeout: 2_000 });
    expect(document.activeElement).toBe(text);
    expect(text.readOnly).toBe(true);

    // Confirmed closed: the form goes, and focus stays with where the answer stands.
    await move(question("q1", { kind: "text", options: [], allowText: true, status: "expired" }));
    await waitFor(() => expect(screen.queryByTestId("decision-answer-composer")).toBeNull());
    expect(status()).toMatch(/expired/);
    await waitFor(() =>
      expect(
        screen.getByTestId("decision-answer-status").contains(document.activeElement) ||
          document.activeElement === screen.getByTestId("decision-answer-status")
      ).toBe(true)
    );
  });

  it("keeps the form for a question whose deadline passed with a choice made, and hides Clear choice once locked", async () => {
    questions.q1 = question("q1", {
      kind: "mixed",
      allowText: true,
      replyMode: "blocking",
      expiresAt: new Date(Date.now() + 400).toISOString(),
    });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    expect(screen.queryByRole("button", { name: "Clear choice" })).not.toBeNull();
    await screen.findByTestId("decision-answer-notice", {}, { timeout: 2_000 });
    expect(screen.queryByRole("button", { name: "Clear choice" })).toBeNull();
    expect(option("Ship it").checked).toBe(true);
  });

  it("names no mode or plan for a question that never expires", async () => {
    questions.q1 = question("q1", {
      replyMode: "blocking",
      // A blocking question's stray plan is never one.
      plannedFallback: "use the existing fixture",
    });
    await openOn("q1");
    expect(screen.queryByTestId("decision-question-deadline")).toBeNull();
    expect(screen.queryByTestId("decision-question-plan")).toBeNull();
  });

  it("keeps the focused draft and says so once as the deadline passes with the view open", async () => {
    const announce = vi.fn();
    const original = useAnnouncerStore.getState().announce;
    useAnnouncerStore.setState({ announce });
    onTestFinished(() => useAnnouncerStore.setState({ announce: original }));
    questions.q1 = question("q1", {
      kind: "text",
      options: [],
      allowText: true,
      replyMode: "blocking",
      expiresAt: new Date(Date.now() + 600).toISOString(),
    });
    await openOn("q1");
    const text = screen.getByTestId("decision-answer-text") as HTMLTextAreaElement;
    text.focus();
    fireEvent.change(text, { target: { value: "Use the fixture" } });

    await screen.findByTestId("decision-answer-notice", {}, { timeout: 2_000 });
    expect(document.activeElement).toBe(text);
    expect(text.value).toBe("Use the fixture");
    expect(text.readOnly).toBe(true);
    expect(await passedDeadline()).toMatch(/Awaiting an update/);
    // Said once as it changes, never again while nothing does: past one more read of the question.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_CROSSING_MS));
    });
    const said = announce.mock.calls.filter(([words]) => /deadline has passed/.test(String(words)));
    expect(said).toHaveLength(1);
  });

  it("shows a phone's answer that came in time once it's read, in place of the passed deadline", async () => {
    questions.q1 = question("q1", {
      replyMode: "blocking",
      expiresAt: new Date(Date.now() + 300).toISOString(),
    });
    await openOn("q1");
    fireEvent.click(option("Ship it"));
    await screen.findByTestId("decision-answer-notice", {}, { timeout: 2_000 });
    await passedDeadline();

    // Reconnected: the phone's answer committed before the deadline, so it never expired.
    await move(
      question("q1", {
        status: "human-answered",
        replyMode: "blocking",
        expiresAt: questions.q1!.expiresAt,
        thread: [PHONE_ANSWER],
      })
    );
    await waitFor(() => expect(screen.queryByTestId("decision-answer-composer")).toBeNull());
    expect(status()).toMatch(/answered elsewhere/);
    expect(screen.queryByTestId("decision-question-deadline")).toBeNull();
    expect(screen.getByTestId("decision-question-thread").textContent).toMatch(
      /Answer from your phone/
    );
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
