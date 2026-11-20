// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionFollowUpResultRead,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionFollowUpResult,
  DecisionQuestionList,
  DecisionQuestionStanding,
  DecisionThreadMessage,
  SendDecisionFollowUpPayload,
} from "@shared/types/decisionsQuestion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsFollowUpStore } from "@/store/decisionsFollowUpStore";
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
const sendFollowUp =
  vi.fn<(payload: SendDecisionFollowUpPayload) => Promise<DecisionQuestionFollowUpResult>>();
const getFollowUpResult =
  vi.fn<(payload: { messageId: string }) => Promise<DecisionFollowUpResultRead>>();
const answerQuestion = vi.fn();
const listQuestions = vi.fn<() => Promise<DecisionQuestionList>>();
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
let listListeners: Array<(list: DecisionQuestionList) => void> = [];

/** A question a Remote Host asked: the reference names that Host, and a follow-up names it so. */
const REFERENCE = { hostId: "host_studio", projectId: "project-1", terminalId: "t1" };

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
      { id: "yes", label: "Ship it", description: null },
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

function personMessage(
  messageId: string,
  over: Partial<DecisionThreadMessage> = {}
): DecisionThreadMessage {
  return {
    type: "message",
    messageId,
    from: "person",
    text: "Keep the old icons.",
    images: [],
    expectsReply: false,
    onComputer: true,
    sentAt: "2026-11-02T10:05:00.000Z",
    deliveryStatus: "received",
    unreadable: false,
    ...over,
  };
}

/** Long enough for a Send that wasn't held back to have reached main. */
const SETTLE_MS = 50;

/** Past one queued read's wait, so a read that would follow it has had its chance. */
const PAST_ONE_QUEUED_READ_MS = 2_300;

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

/** Delivery stopped on q1's answer and nobody has resolved it. */
const STALLED: DecisionQuestionStanding = {
  kind: "needs-attention",
  deliveryStatus: "needs-attention",
};

/** The same answer once the person marked it handled: its own delivery status stays as it was. */
const HANDLED: DecisionQuestionStanding = { kind: "settled", outcome: "answered", handled: true };

function listRow(
  reference: DecisionQuestionList["questions"][number]["reference"],
  standing: DecisionQuestionStanding
): DecisionQuestionList["questions"][number] {
  return {
    reference,
    alias: 7,
    agentKind: "claude",
    projectLabel: null,
    worktreeId: "w1",
    worktreeRoot: "/repos/alpha",
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall:
      standing.kind === "needs-attention"
        ? { answerRevision: 1, followUpIds: [], reason: "pane_gone" }
        : null,
  };
}

/**
 * This computer's list, holding q1 as `standing` says, beside two stalled
 * questions that aren't it: the same id on another machine, and another
 * question on the same one.
 */
function listOf(standing: DecisionQuestionStanding, revision: number): DecisionQuestionList {
  return {
    revision,
    questions: [
      listRow({ ...REFERENCE, hostId: "host_other", questionId: "q1" }, STALLED),
      listRow({ ...REFERENCE, questionId: "q2" }, STALLED),
      listRow({ ...REFERENCE, questionId: "q1" }, standing),
    ],
  };
}

async function pushList(list: DecisionQuestionList) {
  listQuestions.mockResolvedValue(list);
  await act(async () => {
    for (const listener of [...listListeners]) listener(list);
  });
}

async function openOn(...ids: string[]) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, ids[0]!));
  const composer = await screen.findByTestId("decision-follow-up-composer");
  await act(async () => {});
  return composer;
}

function box(): HTMLTextAreaElement {
  return screen.getByTestId("decision-follow-up-text") as HTMLTextAreaElement;
}

function sendButton() {
  return screen.getByTestId("decision-follow-up-send");
}

function write(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

function status() {
  return screen.getByTestId("decision-follow-up-status").textContent ?? "";
}

function notice() {
  return screen.getByTestId("decision-follow-up-notice").textContent ?? "";
}

/** The composer's promise that a follow-up is typed into the asking terminal. */
function promised() {
  return screen.queryByText(/Typed into the terminal that asked/) !== null;
}

function paused() {
  return screen.queryByTestId("decision-follow-up-paused")?.textContent ?? null;
}

/** Every announcement, in order, while the test runs. */
function recordAnnouncements(): string[] {
  const said: string[] = [];
  const original = useAnnouncerStore.getState().announce;
  useAnnouncerStore.setState({ announce: (message: string) => said.push(message) });
  onTestFinished(() => useAnnouncerStore.setState({ announce: original }));
  return said;
}

/** How many announcements said the paused note. */
function pausedSaid(said: readonly string[]): number {
  return said.filter((message) => message.includes("You can't send a new follow-up")).length;
}

const SEND_CHORD = () => (isMac() ? { metaKey: true } : { ctrlKey: true });

beforeEach(() => {
  decisionsOn = true;
  paneListeners = [];
  listListeners = [];
  questions = { q1: question("q1") };
  listQuestions.mockReset().mockResolvedValue({ revision: 1, questions: [] });
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  useDecisionsAnswerStore.getState().clear();
  useDecisionsFollowUpStore.getState().clear();
  useDecisionsImageReviewStore.getState().clear();
  getQuestionContent.mockReset().mockImplementation(async ({ questionId }) => {
    const found = questions[questionId];
    return found ? { result: "read", question: found } : { result: "not-found" };
  });
  sendFollowUp.mockReset().mockImplementation(async (payload) => ({
    result: "submitted",
    messageId: payload.messageId,
    outcome: { status: "sent" },
  }));
  getFollowUpResult.mockReset().mockResolvedValue({ result: "not-found" });
  answerQuestion.mockReset();
  Reflect.set(window, "electron", {
    decisions: {
      getQuestionContent,
      sendFollowUp,
      getFollowUpResult,
      answerQuestion,
      getAnswerResult: async () => ({ result: "not-found" }),
      getQuestionImage: () => new Promise(() => {}),
      getQuestionSummaries: async () => ({ result: "not-running" }),
      listQuestions,
      markQuestions: async () => ({ result: "marked", marked: 0 }),
    },
    events: {
      on: (name: string, callback: (list: DecisionQuestionList) => void) => {
        if (name !== "decisions:questions-changed") return () => {};
        listListeners.push(callback);
        return () => {
          listListeners = listListeners.filter((listener) => listener !== callback);
        };
      },
    },
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

describe("following up a question from the view (#17238)", () => {
  it("sends the person's words before the answer, after reading the question again, and leaves the answer to its own composer", async () => {
    await openOn("q1");
    // Nothing to send yet.
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sendButton());
    expect(sendFollowUp).not.toHaveBeenCalled();

    write("Before you merge: is the backfill done?");
    // The read at Send is held: nothing is signed until it says the question still takes one.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    getQuestionContent.mockImplementationOnce(async ({ questionId }) => {
      await held;
      return { result: "read", question: questions[questionId]! };
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendButton().getAttribute("aria-disabled")).toBe("true"));
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(sendFollowUp).not.toHaveBeenCalled();
    release();

    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(1));
    const [sent] = sendFollowUp.mock.calls[0]!;
    // Named by the reference the Host served, with an id minted for this message alone.
    expect(sent).toEqual({
      reference: { ...REFERENCE, questionId: "q1" },
      messageId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      text: "Before you merge: is the backfill done?",
    });
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    // Taken, so the box is empty for the next one; the answer's composer is untouched.
    expect(box().value).toBe("");
    expect(screen.getByTestId("decision-answer-composer")).toBeTruthy();
    expect(answerQuestion).not.toHaveBeenCalled();

    // Once the thread holds it, the view follows it into the terminal.
    await move(
      question("q1", {
        thread: [personMessage(sent.messageId, { deliveryStatus: "terminal-delivered" })],
      })
    );
    await waitFor(() => expect(status()).toBe("Follow-up sent and typed into the terminal"));
    expect(screen.getByText("Follow-up from your computer")).toBeTruthy();
  });

  it("sends after the answer too, and a second follow-up goes under its own id", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    await openOn("q1");
    // Nothing else on the view takes an answer now.
    expect(screen.queryByTestId("decision-answer-composer")).toBeNull();

    write("Thanks. Keep the old lexer behind a flag.");
    fireEvent.click(sendButton());
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    write("And tell me when it lands.");
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(2));

    const [first, second] = sendFollowUp.mock.calls.map(([payload]) => payload);
    expect(first!.text).toBe("Thanks. Keep the old lexer behind a flag.");
    expect(second!.text).toBe("And tell me when it lands.");
    expect(second!.messageId).not.toBe(first!.messageId);
  });

  it("sends from the keyboard with the platform's modifier and Enter, and nothing else", async () => {
    await openOn("q1");
    write("Line one");
    const mod = isMac() ? { metaKey: true } : { ctrlKey: true };

    const reads = getQuestionContent.mock.calls.length;
    for (const key of [
      { key: "Enter" },
      { key: "Enter", ...mod, shiftKey: true },
      { key: "Enter", ...mod, altKey: true },
      { key: "Enter", ...mod, repeat: true },
      { key: "Enter", ctrlKey: true, metaKey: true },
      { key: "a", ...mod },
    ]) {
      fireEvent.keyDown(box(), key);
    }
    // None of them so much as started a Send.
    await act(async () => {});
    expect(getQuestionContent.mock.calls.length).toBe(reads);
    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(box().getAttribute("aria-keyshortcuts")).toBe(isMac() ? "Meta+Enter" : "Control+Enter");

    fireEvent.keyDown(box(), { key: "Enter", ...mod });
    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
  });

  it("asks for a reply when the agent's latest message wants one", async () => {
    questions = {
      q1: question("q1", {
        status: "human-answered",
        thread: [
          {
            ...personMessage("m_agent_1"),
            from: "agent",
            text: "Which region?",
            expectsReply: true,
            onComputer: false,
            deliveryStatus: null,
          },
        ],
      }),
    };
    await openOn("q1");

    expect(screen.getByRole("heading", { name: "Reply to the agent" })).toBeTruthy();
    expect(sendButton().textContent).toContain("Send reply");
    expect(screen.getByText("Follow-up from the agent, asking for a reply")).toBeTruthy();
  });

  it("sends nothing once the question closed, says so, and keeps the words", async () => {
    await openOn("q1");
    write("Hold off on this.");
    questions = { q1: question("q1", { status: "cancelled" }) };
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(notice()).toBe("This question no longer takes follow-ups, so nothing was sent.")
    );
    expect(sendFollowUp).not.toHaveBeenCalled();
    // The view now shows it closed: no box, but the words aren't dropped unseen.
    expect(screen.queryByTestId("decision-follow-up-text")).toBeNull();
    expect(useDecisionsFollowUpStore.getState().records[recordKey("q1")]?.draft).toBe(
      "Hold off on this."
    );
  });

  it("offers nothing on a question that takes no follow-ups and was never written to", async () => {
    questions = { q1: question("q1", { status: "expired" }) };
    act(() => useDecisionsQuestionViewStore.getState().open("t1", ["q1"], "q1"));
    await screen.findByTestId("decision-question-content");
    expect(screen.queryByTestId("decision-follow-up-composer")).toBeNull();
  });

  it.each([
    [
      { status: "unsupported", by: "relay" },
      "Your relay needs an update before it takes follow-ups from this computer, so nothing was sent.",
    ],
    [
      { status: "unsupported", by: "asking-desktop" },
      "Daintree on the computer that asked needs an update before it takes follow-ups from this computer, so nothing was sent.",
    ],
    [
      { status: "closed", reason: "expired" },
      "This question expired before your follow-up reached it, so it wasn't sent.",
    ],
  ] as const)("says what %o means, and keeps the words to send again", async (outcome, said) => {
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome,
    }));
    await openOn("q1");
    write("Still deciding?");
    fireEvent.click(sendButton());

    await waitFor(() => expect(notice()).toBe(said));
    expect(box().value).toBe("Still deciding?");
    expect(screen.queryByTestId("decision-follow-up-status")).toBeNull();
  });

  it("follows a queued follow-up until the relay takes it", async () => {
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "queued" },
    }));
    getFollowUpResult
      .mockResolvedValueOnce({ result: "read", questionId: "q1", outcome: { status: "queued" } })
      .mockResolvedValue({ result: "read", questionId: "q1", outcome: { status: "sent" } });
    await openOn("q1");
    write("Ping me when it's done.");
    fireEvent.click(sendButton());

    // Queued: its words stay, as the relay may still turn it away.
    await waitFor(() =>
      expect(status()).toBe("Follow-up queued. It's sent once the relay can be reached.")
    );
    expect(box().value).toBe("Ping me when it's done.");
    // Read again after the first read still found it queued.
    await waitFor(() => expect(getFollowUpResult).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    const [sent] = sendFollowUp.mock.calls[0]!;
    for (const [read] of getFollowUpResult.mock.calls) {
      expect(read).toEqual({ messageId: sent.messageId });
    }
    expect(box().value).toBe("");
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("keeps the words of a queued follow-up the relay later turns away", async () => {
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "queued" },
    }));
    getFollowUpResult.mockResolvedValue({
      result: "read",
      questionId: "q1",
      outcome: { status: "unsupported", by: "asking-desktop" },
    });
    await openOn("q1");
    write("Ping me when it's done.");
    fireEvent.click(sendButton());

    await waitFor(() => expect(notice()).toContain("computer that asked needs an update"));
    expect(box().value).toBe("Ping me when it's done.");
    expect(box().readOnly).toBe(false);
  });

  it("reads a lost reply back by its id, and sends it again only under the same id", async () => {
    sendFollowUp.mockRejectedValueOnce(new Error("link dropped"));
    await openOn("q1");
    write("Is the backfill done?");
    fireEvent.click(sendButton());

    // Nothing committed under that id, and the question still takes it: the same message again.
    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(2));
    const [first, second] = sendFollowUp.mock.calls.map(([payload]) => payload);
    expect(second).toEqual(first);
    expect(getFollowUpResult).toHaveBeenCalledWith({ messageId: first!.messageId });
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
  });

  it("offers Retry once a follow-up's fate can't be confirmed, and never a second message", async () => {
    sendFollowUp.mockRejectedValue(new Error("link dropped"));
    await openOn("q1");
    write("Is the backfill done?");
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(status()).toContain("Couldn't confirm whether your follow-up was sent.")
    );
    // Its words can't change, and no new one starts, while its fate is unknown.
    expect(box().readOnly).toBe(true);
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    const ids = new Set(sendFollowUp.mock.calls.map(([payload]) => payload.messageId));
    expect(ids.size).toBe(1);

    // Main never committed it: Retry sends it again, the same message under the same id, once.
    const before = sendFollowUp.mock.calls.length;
    sendFollowUp.mockReset().mockImplementation(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "sent" },
    }));
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    expect(before).toBeGreaterThan(0);
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
    expect(sendFollowUp.mock.calls[0]![0]).toEqual({
      reference: { ...REFERENCE, questionId: "q1" },
      messageId: [...ids][0],
      text: "Is the backfill done?",
    });
  });

  it("settles a follow-up it couldn't confirm once the question's thread shows it", async () => {
    sendFollowUp.mockRejectedValue(new Error("link dropped"));
    getFollowUpResult.mockRejectedValue(new Error("link dropped"));
    await openOn("q1");
    write("Is the backfill done?");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(status()).toContain("Couldn't confirm whether your follow-up was sent.")
    );
    const [sent] = sendFollowUp.mock.calls[0]!;

    await move(question("q1", { thread: [personMessage(sent.messageId)] }));

    await waitFor(() =>
      expect(status()).toBe("Follow-up sent. Waiting for it to be typed into the terminal…")
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(box().value).toBe("");
    expect(box().readOnly).toBe(false);
  });

  it("settles a queued follow-up the thread already shows, and a late queued read never undoes it", async () => {
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "queued" },
    }));
    // The owner computer missed the relay's receipt: its outbox still says queued, and says it late.
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => (releaseRead = resolve));
    getFollowUpResult.mockImplementation(async () => {
      await heldRead;
      return { result: "read", questionId: "q1", outcome: { status: "queued" } };
    });
    await openOn("q1");
    write("Ping me when it's done.");
    fireEvent.click(sendButton());
    await waitFor(() => expect(status()).toContain("queued"));
    await waitFor(() => expect(getFollowUpResult).toHaveBeenCalledTimes(1));
    const [sent] = sendFollowUp.mock.calls[0]!;

    await move(question("q1", { thread: [personMessage(sent.messageId)] }));
    await waitFor(() => expect(box().readOnly).toBe(false));
    expect(box().value).toBe("");

    await act(async () => releaseRead());
    await new Promise((resolve) => setTimeout(resolve, PAST_ONE_QUEUED_READ_MS));
    expect(
      useDecisionsFollowUpStore.getState().records[recordKey("q1")]?.submission?.phase
    ).toEqual({ kind: "settled", outcome: { status: "sent" } });
    expect(status()).toBe("Follow-up sent. Waiting for it to be typed into the terminal…");
    expect(getFollowUpResult).toHaveBeenCalledTimes(1);
  });

  it("never sends a lost follow-up again when a second read names the question on another machine", async () => {
    sendFollowUp.mockRejectedValueOnce(new Error("link dropped"));
    await openOn("q1");
    write("Is the backfill done?");
    // The read after the lost reply, and only it, names the same question id asked on another machine.
    let other = true;
    getQuestionContent.mockImplementation(async ({ questionId }) => {
      const found = questions[questionId]!;
      if (sendFollowUp.mock.calls.length === 0 || !other)
        return { result: "read", question: found };
      other = false;
      return {
        result: "read",
        question: { ...found, reference: { ...found.reference, hostId: "host_other" } },
      };
    });
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(status()).toContain("Couldn't confirm whether your follow-up was sent.")
    );
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("says why the latest Send stopped, never the one before it", async () => {
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "unsupported", by: "relay" },
    }));
    await openOn("q1");
    write("Still deciding?");
    fireEvent.click(sendButton());
    await waitFor(() => expect(notice()).toContain("relay needs an update"));

    // Sent again as it was; the read at Send finds it closed this time.
    questions = { q1: question("q1", { status: "cancelled" }) };
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(notice()).toBe("This question no longer takes follow-ups, so nothing was sent.")
    );
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("says a follow-up in the thread won't be typed once its question was withdrawn", async () => {
    await openOn("q1");
    write("Hold off.");
    fireEvent.click(sendButton());
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    const [sent] = sendFollowUp.mock.calls[0]!;

    await move(
      question("q1", {
        status: "cancelled",
        thread: [personMessage(sent.messageId, { deliveryStopped: true })],
      })
    );

    await waitFor(() => expect(status()).toContain("It won't be typed into the terminal"));
  });

  it("sends only to the question the person was looking at, whatever a second read names", async () => {
    await openOn("q1");
    write("Hold off on this one.");
    // The machine serving the read answers with another question this time.
    getQuestionContent.mockImplementationOnce(async () => ({
      result: "read",
      question: question("q2"),
    }));
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(notice()).toBe(
        "This question couldn't be read again before sending, so nothing was sent."
      )
    );
    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(box().value).toBe("Hold off on this one.");
  });

  it("keeps saying the question closed, and keeps focus in the view, when it closes under the person", async () => {
    await openOn("q1");
    act(() => box().focus());
    expect(document.activeElement).toBe(box());

    await move(question("q1", { status: "expired" }));

    await waitFor(() => expect(notice()).toBe("This question no longer takes follow-ups."));
    expect(screen.queryByTestId("decision-follow-up-text")).toBeNull();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(screen.getByTestId("decision-follow-up-composer").contains(document.activeElement)).toBe(
      true
    );
  });

  it("keeps the focused words in place, unsendable, as an open question's deadline passes (#17943)", async () => {
    questions = {
      q1: question("q1", { expiresAt: new Date(Date.now() + 500).toISOString() }),
    };
    await openOn("q1");
    act(() => box().focus());
    write("Hold off on this one.");
    const field = box();

    await waitFor(() => expect(notice()).toMatch(/deadline has passed/));
    // Only the clock says it passed: the words, and focus, stay where they were.
    expect(screen.getByTestId("decision-follow-up-text")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Hold off on this one.");
    expect(field.readOnly).toBe(true);
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sendButton());
    expect(sendFollowUp).not.toHaveBeenCalled();

    // Once the store says it expired, it says so as before.
    await move(question("q1", { status: "expired" }));
    await waitFor(() => expect(notice()).toBe("This question no longer takes follow-ups."));
  });

  it("says why main refused it before anything was signed", async () => {
    sendFollowUp.mockResolvedValueOnce({ result: "refused", reason: "not-owner" });
    await openOn("q1");
    write("Hold off.");
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(notice()).toBe("This computer doesn't sign follow-ups for you, so nothing was sent.")
    );
    expect(box().value).toBe("Hold off.");
  });

  it("holds words past the protocol's bound, saying by how much", async () => {
    await openOn("q1");
    write("é".repeat(8 * 1024 + 1));

    expect(screen.getByText("Shorten your follow-up by 2 bytes")).toBeTruthy();
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sendButton());
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("forgets drafts and follow-ups once Decisions is off", async () => {
    await openOn("q1");
    write("Draft words.");
    expect(Object.keys(useDecisionsFollowUpStore.getState().records)).toHaveLength(1);

    decisionsOn = false;
    act(() => {
      for (const listener of onListeners) listener();
    });

    await waitFor(() => expect(useDecisionsFollowUpStore.getState().records).toEqual({}));
  });

  it("signs nothing for a Send whose read lands after Decisions was turned off", async () => {
    await openOn("q1");
    write("Draft words.");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    getQuestionContent.mockImplementationOnce(async ({ questionId }) => {
      await held;
      return { result: "read", question: questions[questionId]! };
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(getQuestionContent).toHaveBeenCalled());

    decisionsOn = false;
    act(() => {
      for (const listener of onListeners) listener();
    });
    await waitFor(() => expect(useDecisionsFollowUpStore.getState().records).toEqual({}));
    release();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(useDecisionsFollowUpStore.getState().records).toEqual({});
  });
});

describe("following up while the answer's delivery is stopped (#18028)", () => {
  const ANSWERED_STALLED = () =>
    question("q1", { status: "human-answered", deliveryStatus: "needs-attention" });
  /** Answered, its answer still waiting to be typed in: listed, not stalled. */
  const TO_TYPE: DecisionQuestionStanding = { kind: "to-type" };

  it("offers no new follow-up while the stall is unresolved, and offers it again once it's marked handled", async () => {
    questions = { q1: ANSWERED_STALLED() };
    listQuestions.mockResolvedValue(listOf(STALLED, 1));
    act(() => useDecisionsQuestionViewStore.getState().open("t1", ["q1"], "q1"));
    await screen.findByTestId("decision-question-content");

    // Nothing written here yet: no box and no Send, only why.
    await waitFor(() => expect(paused()).toMatch(/can't send a new follow-up until it's resolved/));
    expect(screen.queryByTestId("decision-follow-up-text")).toBeNull();
    expect(screen.queryByTestId("decision-follow-up-send")).toBeNull();
    expect(promised()).toBe(false);

    // Marked handled: the question's own delivery status still says it stopped, the list doesn't.
    await pushList(listOf(HANDLED, 2));
    await waitFor(() => expect(screen.queryByTestId("decision-follow-up-text")).not.toBeNull());
    expect(paused()).toBeNull();
    expect(promised()).toBe(true);
    write("Carry on without it.");
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
  });

  it("keeps a draft in progress when the stall arrives, sends nothing while it stands, and sends it once resolved", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    listQuestions.mockResolvedValue(listOf(TO_TYPE, 1));
    await openOn("q1");
    await act(async () => {});
    act(() => box().focus());
    write("Use the staging bucket.");
    const field = box();
    // Listed and unresolved, but nothing stopped: Send is the view's main action.
    expect(paused()).toBeNull();
    expect(sendButton().getAttribute("data-variant")).toBe("contrast");
    const said = recordAnnouncements();

    // The list says so before any read of the question does.
    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    expect(promised()).toBe(false);
    expect(sendButton().getAttribute("data-variant")).toBe("outline");
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    // The disabled Send says why.
    const describedBy = sendButton().getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toContain(screen.getByTestId("decision-follow-up-paused").id);
    const reads = getQuestionContent.mock.calls.length;
    fireEvent.click(sendButton());
    fireEvent.keyDown(box(), { key: "Enter", ...SEND_CHORD() });
    await act(async () => {});
    // Not so much as the read a Send starts with.
    expect(getQuestionContent.mock.calls.length).toBe(reads);
    expect(sendFollowUp).not.toHaveBeenCalled();

    questions = { q1: ANSWERED_STALLED() };
    await move(ANSWERED_STALLED());
    // The words, and focus, stay where they were, still the person's to change.
    expect(screen.getByTestId("decision-follow-up-text")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Use the staging bucket.");
    expect(field.readOnly).toBe(false);
    write("Use the staging bucket, please.");
    expect(box().value).toBe("Use the staging bucket, please.");

    await pushList(listOf(HANDLED, 3));
    await waitFor(() => expect(sendButton().getAttribute("aria-disabled")).toBeNull());
    expect(promised()).toBe(true);
    expect(sendButton().getAttribute("data-variant")).toBe("contrast");
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendFollowUp).toHaveBeenCalledTimes(1));
    expect(sendFollowUp.mock.calls[0]![0].text).toBe("Use the staging bucket, please.");
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    // Said once as it arrived, never again as the follow-up moved on.
    expect(pausedSaid(said)).toBe(1);
  });

  it("keeps an empty field the person is in, and focus on it, when the stall arrives", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    await openOn("q1");
    act(() => box().focus());
    const field = box();

    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    expect(screen.getByTestId("decision-follow-up-text")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("");
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("starts nothing as the view closes over a stalled draft, though the list stops saying so", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    await openOn("q1");
    act(() => box().focus());
    write("Use the staging bucket.");
    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    const field = box();
    const reads = getQuestionContent.mock.calls.length;

    act(() => useDecisionsQuestionViewStore.getState().close());
    // Still on screen as it animates away, and still holding the keyboard.
    expect(field.isConnected).toBe(true);
    fireEvent.keyDown(field, { key: "Enter", ...SEND_CHORD() });
    await act(async () => {});
    expect(getQuestionContent.mock.calls.length).toBe(reads);
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("never promises typing in as a stalled open question's deadline passes under a draft", async () => {
    questions = {
      q1: question("q1", { expiresAt: new Date(Date.now() + 1_500).toISOString() }),
    };
    await openOn("q1");
    act(() => box().focus());
    write("Hold off on this one.");
    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());

    // Only the clock says it passed: no longer paused, as it takes nothing at all, and still stalled.
    await waitFor(() => expect(notice()).toMatch(/deadline has passed/));
    expect(paused()).toBeNull();
    expect(box().value).toBe("Hold off on this one.");
    expect(promised()).toBe(false);
  });

  it("follows a queued follow-up on to the relay when the stall arrives while it waits", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    sendFollowUp.mockImplementationOnce(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "queued" },
    }));
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => (releaseRead = resolve));
    getFollowUpResult
      .mockImplementationOnce(async () => {
        await heldRead;
        return { result: "read", questionId: "q1", outcome: { status: "queued" } };
      })
      .mockResolvedValue({ result: "read", questionId: "q1", outcome: { status: "sent" } });
    await openOn("q1");
    write("Ping me when it's done.");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(status()).toBe("Follow-up queued. It's sent once the relay can be reached.")
    );

    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    releaseRead();

    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    const [sent] = sendFollowUp.mock.calls[0]!;
    for (const [read] of getFollowUpResult.mock.calls) {
      expect(read).toEqual({ messageId: sent.messageId });
    }
    expect(getFollowUpResult.mock.calls.length).toBeGreaterThan(1);
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("never lets go of a follow-up whose fate is unknown when the stall arrives, and its Retry still sends it", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    sendFollowUp.mockRejectedValue(new Error("link dropped"));
    await openOn("q1");
    write("Is the backfill done?");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(status()).toContain("Couldn't confirm whether your follow-up was sent.")
    );
    const [lost] = sendFollowUp.mock.calls.map(([payload]) => payload);
    const said = recordAnnouncements();

    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    questions = { q1: ANSWERED_STALLED() };
    await move(ANSWERED_STALLED());
    expect(box().value).toBe("Is the backfill done?");
    expect(status()).toContain("Couldn't confirm whether your follow-up was sent.");

    sendFollowUp.mockReset().mockImplementation(async (payload) => ({
      result: "submitted",
      messageId: payload.messageId,
      outcome: { status: "sent" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(status()).toBe("Follow-up sent"));
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
    expect(sendFollowUp.mock.calls[0]![0]).toEqual(lost);
    expect(pausedSaid(said)).toBe(1);
  });

  it("still says a failed attempt sent nothing when the stall arrives over it", async () => {
    questions = { q1: question("q1", { status: "human-answered" }) };
    sendFollowUp.mockResolvedValueOnce({ result: "refused", reason: "not-owner" });
    await openOn("q1");
    write("Hold off.");
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(notice()).toBe("This computer doesn't sign follow-ups for you, so nothing was sent.")
    );

    await pushList(listOf(STALLED, 2));
    await waitFor(() => expect(paused()).not.toBeNull());
    expect(notice()).toBe("This computer doesn't sign follow-ups for you, so nothing was sent.");
    expect(box().value).toBe("Hold off.");
  });

  it("follows the list's stall, not the question's delivery status, which Mark handled leaves as it was", async () => {
    questions = { q1: ANSWERED_STALLED() };
    listQuestions.mockResolvedValue(listOf(HANDLED, 1));
    await openOn("q1");
    await act(async () => {});

    expect(screen.getByTestId("decision-follow-up-text")).toBeTruthy();
    expect(paused()).toBeNull();
    expect(promised()).toBe(true);
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    write("Carry on.");
    expect(sendButton().getAttribute("aria-disabled")).toBeNull();
  });
});

function recordKey(questionId: string): string {
  return [REFERENCE.hostId, REFERENCE.projectId, REFERENCE.terminalId, questionId].join("\u0000");
}
