// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionDeclineResultRead,
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionList,
  DecisionQuestionReference,
  DecisionQuestionDeclineResult,
  DecisionQuestionSummariesResult,
  DeclineDecisionQuestionPayload,
} from "@shared/types/decisionsQuestion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

let decisionsOn = true;
/** False until main has answered whether Decisions is on. */
let decisionsKnown = true;
const onListeners = new Set<() => void>();
vi.mock("@/hooks/useDecisionsOn", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    onListeners.add(listener);
    return () => onListeners.delete(listener);
  };
  const snapshot = () => (!decisionsKnown ? "unknown" : decisionsOn ? "on" : "off");
  return {
    useDecisionsSwitch: () => useSyncExternalStore(subscribe, snapshot),
    useDecisionsOn: () => useSyncExternalStore(subscribe, () => snapshot() === "on"),
  };
});

import { DecisionQuestionDialog } from "../DecisionQuestionDialog";

type Payload = { terminalId: string; questionId: string };
type ByReference = { reference: DecisionQuestionReference };
const getQuestionContent = vi.fn<(payload: Payload) => Promise<DecisionQuestionContentResult>>();
const getQuestionContentByReference =
  vi.fn<(payload: ByReference) => Promise<DecisionQuestionContentResult>>();
const getQuestionSummaries =
  vi.fn<(payload: unknown) => Promise<DecisionQuestionSummariesResult>>();
const getQuestionSummariesByReference =
  vi.fn<(payload: unknown) => Promise<DecisionQuestionSummariesResult>>();
const cancelQuestion = vi.fn<(payload: Payload) => Promise<DecisionQuestionCancelResult>>();
const cancelQuestionByReference =
  vi.fn<(payload: ByReference) => Promise<DecisionQuestionCancelResult>>();
const declineQuestion =
  vi.fn<(payload: DeclineDecisionQuestionPayload) => Promise<DecisionQuestionDeclineResult>>();
const getDeclineResult =
  vi.fn<(payload: { declineId: string }) => Promise<DecisionDeclineResultRead>>();
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
let listListeners: Array<(list: DecisionQuestionList) => void> = [];

/** A question of project B's, read from a window showing another project (#17229). */
const OTHER_PROJECT: DecisionQuestionReference = {
  hostId: "host_1",
  projectId: "project-b",
  terminalId: "t9",
  questionId: "qa",
};

function content(
  questionId: string,
  alias: number,
  over: Partial<DecisionQuestionContent> = {}
): DecisionQuestionContent {
  return {
    questionId,
    alias,
    terminalId: "t1",
    reference: { hostId: "host_1", projectId: "project-1", terminalId: "t1", questionId },
    revision: 1,
    question: `Question **${alias}** body`,
    context: "Some notes",
    kind: "choice",
    options: [
      { id: "yes", label: "Ship it", description: "Merge *today*" },
      { id: "no", label: "Hold", description: null },
    ],
    allowText: false,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "human-answered",
    closedReason: null,
    deliveryStatus: "terminal-delivered",
    attachments: [],
    thread: [
      {
        type: "answer",
        entryId: "a1",
        revision: 1,
        from: "person",
        onComputer: false,
        correction: false,
        confirmsModel: false,
        choices: [{ id: "yes", label: null }],
        text: "Go ahead",
        reason: null,
        images: [],
        sentAt: "2026-11-02T10:05:00.000Z",
        unreadable: false,
      },
      {
        type: "message",
        messageId: "m1",
        from: "agent",
        text: "Merged",
        images: [],
        expectsReply: false,
        sentAt: "2026-11-02T10:06:00.000Z",
        deliveryStatus: null,
        unreadable: false,
      },
    ],
    ...over,
  };
}

const QUESTIONS: Record<string, DecisionQuestionContent> = {
  qa: content("qa", 7),
  qb: content("qb", 8, { requirement: "proxy-ok", thread: [], expiresAt: null }),
};

function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 4000 });
}

function pushPane(terminalId: string) {
  for (const listener of [...paneListeners]) {
    listener({
      terminalId,
      openQuestions: [],
      waitingAnswers: [],
      needsAttention: [],
      revision: 2,
    });
  }
}

/** Main's answer to the next dismissal: `outcome`, under the id it was sent with. */
function declinedOnce(
  outcome: Extract<DecisionQuestionDeclineResult, { result: "submitted" }>["outcome"]
) {
  declineQuestion.mockImplementationOnce(async ({ declineId }) => ({
    result: "submitted",
    declineId,
    outcome,
  }));
}

function openView(ids: string[], id: string) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, id));
}

/**
 * The withdrawal the shown question's footer offers once its dismissal can't
 * be taken, opened from there: the confirmation, ready to withdraw.
 */
async function reachWithdrawal(): Promise<HTMLElement> {
  declinedOnce({ status: "unsupported", by: "relay" });
  fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
  const asked = await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(within(asked).getByRole("button", { name: "Dismiss question" }));
  });
  fireEvent.click(within(asked).getByRole("button", { name: "Keep question" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(await screen.findByTestId("decision-question-withdraw"));
  return screen.findByRole("alertdialog");
}

function openReference(references: DecisionQuestionReference[], reference = references[0]!) {
  act(() => useDecisionsQuestionViewStore.getState().openReference(references, reference));
}

type Kind = "waiting" | "to-type";

/** This computer's list: `qa` (the question opened) and one other question, `qz`, each standing as given. */
function pushList(revision: number, kinds: { qa: Kind; qz: Kind }) {
  const item = (reference: DecisionQuestionReference, alias: number, kind: Kind) => ({
    reference,
    alias,
    agentKind: "claude",
    projectLabel: null,
    worktreeId: "w1",
    worktreeRoot: "/repo",
    requirement: "human-required" as const,
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing: kind === "waiting" ? { kind, reason: "open" as const } : { kind },
    replyRequest: null,
    stall: null,
  });
  for (const listener of [...listListeners]) {
    listener({
      revision,
      questions: [
        // The same question id on another machine is another question.
        item({ ...OTHER_PROJECT, hostId: "host_2" }, 8, kinds.qz),
        item(OTHER_PROJECT, 7, kinds.qa),
        item({ ...OTHER_PROJECT, questionId: "qz" }, 9, kinds.qz),
      ],
    });
  }
}

beforeEach(() => {
  decisionsOn = true;
  decisionsKnown = true;
  paneListeners = [];
  listListeners = [];
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  getQuestionContent.mockReset().mockImplementation(async ({ questionId }) => {
    const question = QUESTIONS[questionId];
    return question ? { result: "read", question } : { result: "not-found" };
  });
  getQuestionContentByReference.mockReset().mockImplementation(async ({ reference }) => {
    const question = QUESTIONS[reference.questionId];
    return question ? { result: "read", question } : { result: "not-found" };
  });
  getQuestionSummaries.mockReset().mockResolvedValue({ result: "not-running" });
  getQuestionSummariesByReference.mockReset().mockResolvedValue({
    result: "read",
    summaries: [{ questionId: "qa", result: "read", line: "Ship the migration?" }],
  });
  cancelQuestion.mockReset().mockResolvedValue({ result: "cancelling" });
  cancelQuestionByReference.mockReset().mockResolvedValue({ result: "cancelling" });
  declineQuestion.mockReset().mockImplementation(async ({ declineId }) => ({
    result: "submitted",
    declineId,
    outcome: { status: "declined" },
  }));
  getDeclineResult.mockReset().mockResolvedValue({ result: "not-found" });
  useDecisionsAnswerStore.getState().clear();
  Reflect.set(window, "electron", {
    decisions: {
      getQuestionContent,
      getQuestionContentByReference,
      getQuestionSummaries,
      getQuestionSummariesByReference,
      cancelQuestion,
      cancelQuestionByReference,
      declineQuestion,
      getDeclineResult,
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

describe("DecisionQuestionDialog seen on this computer (#17895)", () => {
  /** This computer's list of `qa`, asked in pane t1 and listed under the reference its read names. */
  const LISTED = { hostId: "host_1", projectId: "project-1", terminalId: "t1", questionId: "qa" };
  function listing(inbox: { ask: string | null; seen: boolean; cleared: boolean }) {
    return {
      revision: 1,
      questions: [
        {
          reference: LISTED,
          alias: 7,
          agentKind: "claude",
          projectLabel: null,
          worktreeId: "w1",
          worktreeRoot: "/repo",
          requirement: "human-required" as const,
          askedAt: "2026-11-02T10:00:00.000Z",
          expiresAt: null,
          settledAt: null,
          standing: { kind: "waiting" as const, reason: "open" as const },
          replyRequest: null,
          stall: null,
          inbox,
        },
      ],
    };
  }
  let markQuestions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    markQuestions = vi.fn(async ({ questions }: { questions: unknown[] }) => ({
      result: "marked",
      marked: questions.length,
    }));
    const decisions = Reflect.get(window, "electron").decisions as Record<string, unknown>;
    decisions.markQuestions = markQuestions;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a pane's question seen once read, at the ask this computer's list names", async () => {
    const decisions = Reflect.get(window, "electron").decisions as Record<string, unknown>;
    // Still open, the agent's follow-up in its thread, `m1`, is what it asks now.
    const open = content("qa", 7, { status: "open" });
    getQuestionContent.mockResolvedValue({
      result: "read",
      question: { ...open, thread: open.thread.filter((entry) => entry.type === "message") },
    });
    decisions.listQuestions = vi.fn(async () =>
      listing({ ask: "m1", seen: false, cleared: false })
    );
    openView(["qa"], "qa");
    await waitFor(() =>
      expect(markQuestions).toHaveBeenCalledWith({
        action: "seen",
        questions: [{ reference: LISTED, ask: "m1" }],
      })
    );
  });

  it("reads a question opened by reference again when its ask moves, never for a mark alone", async () => {
    const at = (revision: number, inbox: { ask: string | null; seen: boolean; cleared: boolean }) =>
      act(() => {
        const listed = listing(inbox);
        for (const listener of [...listListeners]) {
          listener({
            revision,
            questions: [{ ...listed.questions[0]!, reference: OTHER_PROJECT }],
          });
        }
      });
    openReference([OTHER_PROJECT]);
    await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(1));
    at(1, { ask: null, seen: false, cleared: false });
    await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(2));

    at(2, { ask: null, seen: true, cleared: true });
    await act(async () => {});
    expect(getQuestionContentByReference).toHaveBeenCalledTimes(2);

    at(3, { ask: "m2", seen: false, cleared: false });
    await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(3));
  });

  it("marks nothing for a question the list doesn't hold, or one already seen", async () => {
    const decisions = Reflect.get(window, "electron").decisions as Record<string, unknown>;
    decisions.listQuestions = vi.fn(async () => listing({ ask: "m1", seen: true, cleared: false }));
    openView(["qa", "qb"], "qa");
    await waitFor(() =>
      expect(screen.getByTestId("decision-question-body").textContent).toContain("Merged")
    );
    // qb isn't on this computer's list at all.
    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-question-body").textContent).toContain("Question 8")
    );
    await act(async () => {});
    expect(markQuestions).not.toHaveBeenCalled();
  });
});

describe("DecisionQuestionDialog", () => {
  it("shows the whole question: text, notes, options, requirement, times and thread", async () => {
    openView(["qa"], "qa");
    const body = await screen.findByTestId("decision-question-content");
    expect(getQuestionContent).toHaveBeenCalledWith({ terminalId: "t1", questionId: "qa" });

    expect(body.querySelector("strong")?.textContent).toBe("7");
    expect(body.textContent).toContain("Some notes");
    expect(body.textContent).toContain("Ship it");
    expect(body.querySelector("em")?.textContent).toBe("today");
    expect(body.textContent).toContain("Hold");
    // A person's answer is what every question needs, so only another requirement is said.
    expect(screen.queryByTestId("decision-question-requirement")).toBeNull();
    expect(body.querySelector("time[datetime='2099-01-01T00:00:00.000Z']")).not.toBeNull();

    const entries = screen.getAllByTestId("decision-thread-entry");
    expect(entries).toHaveLength(2);
    // The answer's choice is named by the question's own label.
    expect(entries[0]!.textContent).toContain("Ship it");
    expect(entries[0]!.textContent).toContain("Go ahead");
    expect(entries[1]!.textContent).toContain("Merged");
    expect(screen.getByRole("dialog").textContent).toContain("q-7");
    expect(screen.queryByTestId("decision-question-position")).toBeNull();
  });

  it("steps between the listed questions without closing, by button and arrow key", async () => {
    openView(["qa", "qb"], "qa");
    await screen.findByText("Some notes", { exact: false });
    expect(screen.getByTestId("decision-question-position").textContent).toBe("1 of 2");
    expect(screen.queryByTestId("decision-question-requirement")).toBeNull();

    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-8"));
    expect(screen.getByTestId("decision-question-position").textContent).toBe("2 of 2");
    expect(screen.getByTestId("decision-question-requirement").textContent).toBe(
      "The decision model may answer"
    );
    expect(screen.getByTestId("decision-question-next").getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("decision-question-next"), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-7"));
    expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(true);
  });

  it("leaves arrow keys alone outside the dialog, in code, and with a modifier", async () => {
    openView(["qa", "qb"], "qa");
    await screen.findByTestId("decision-question-content");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    screen.getByTestId("decision-question-body").appendChild(pre);
    const inside = screen.getByTestId("decision-question-next");

    fireEvent.keyDown(outside, { key: "ArrowRight" });
    fireEvent.keyDown(pre, { key: "ArrowRight" });
    fireEvent.keyDown(inside, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(inside, { key: "ArrowRight", isComposing: true });
    expect(useDecisionsQuestionViewStore.getState().request?.index).toBe(0);

    fireEvent.keyDown(inside, { key: "ArrowRight" });
    expect(useDecisionsQuestionViewStore.getState().request?.index).toBe(1);
    outside.remove();
  });

  it("takes a loaded question off screen as soon as it steps away", async () => {
    openView(["qa", "qb"], "qa");
    await screen.findByTestId("decision-question-content");
    getQuestionContent.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() => expect(getQuestionContent).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("decision-question-content")).toBeNull();
  });

  it("never shows a read that lands after stepping away", async () => {
    const pending: Array<(result: DecisionQuestionContentResult) => void> = [];
    getQuestionContent.mockImplementation(
      () => new Promise<DecisionQuestionContentResult>((resolve) => pending.push(resolve))
    );
    openView(["qa", "qb"], "qa");
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.click(screen.getByTestId("decision-question-previous"));
    await waitFor(() => expect(pending).toHaveLength(3));

    // The first read of q-7 lands last, with an older thread than the fresh one.
    await act(async () =>
      pending[2]!({ result: "read", question: content("qa", 7, { context: "Fresh notes" }) })
    );
    await act(async () => pending[1]!({ result: "read", question: QUESTIONS.qb! }));
    await act(async () =>
      pending[0]!({ result: "read", question: content("qa", 7, { context: "Stale notes" }) })
    );
    const body = screen.getByTestId("decision-question-content");
    expect(body.textContent).toContain("Fresh notes");
    expect(body.textContent).not.toContain("Stale notes");
  });

  it("reads again when the pane's state moves, so a new answer shows", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    expect(getQuestionContent).toHaveBeenCalledTimes(1);
    act(() => pushPane("t2"));
    expect(getQuestionContent).toHaveBeenCalledTimes(1);

    getQuestionContent.mockResolvedValue({
      result: "read",
      question: content("qa", 7, { context: "After the answer" }),
    });
    act(() => pushPane("t1"));
    await screen.findByText("After the answer");
  });

  it("reads again while open, for follow-ups the pane's state doesn't show", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      openView(["qa"], "qa");
      await screen.findByTestId("decision-question-content");
      getQuestionContent.mockResolvedValue({
        result: "read",
        question: content("qa", 7, { context: "With a follow-up" }),
      });
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      await screen.findByText("With a follow-up");

      act(() => useDecisionsQuestionViewStore.getState().close());
      const calls = getQuestionContent.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(getQuestionContent.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("one read at a time (#17564)", () => {
    let pending: Array<(result: DecisionQuestionContentResult) => void>;
    let failing: Array<(error: Error) => void>;

    function holdReads() {
      pending = [];
      failing = [];
      getQuestionContent.mockImplementation(
        () =>
          new Promise<DecisionQuestionContentResult>((resolve, reject) => {
            pending.push(resolve);
            failing.push(reject);
          })
      );
    }

    async function advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }

    async function land(which: number, notes: string) {
      await act(async () =>
        pending[which]!({ result: "read", question: content("qa", 7, { context: notes }) })
      );
    }

    function shownNotes(): string | undefined {
      return screen.queryByTestId("decision-question-content")?.textContent ?? undefined;
    }

    describe("on a clock", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        // Unmount on the clock that armed the timers.
        cleanup();
        vi.useRealTimers();
      });

      it("shows a read slower than one poll, rather than starting another over it", async () => {
        holdReads();
        openView(["qa"], "qa");
        expect(pending).toHaveLength(1);
        await advance(40_000);
        expect(pending).toHaveLength(1);

        await land(0, "Slow read");
        expect(shownNotes()).toContain("Slow read");
        // Nothing moved while it was out, so the next read waits a whole poll from its landing.
        await advance(14_000);
        expect(pending).toHaveLength(1);
        await advance(2_000);
        expect(pending).toHaveLength(2);
      });

      it("never lets a poll due before a move fire under the read the move queued", async () => {
        openView(["qa"], "qa");
        await act(async () => {});
        expect(getQuestionContent).toHaveBeenCalledTimes(1);
        await advance(14_000);
        holdReads();
        act(() => pushPane("t1"));
        act(() => pushPane("t1"));
        expect(pending).toHaveLength(1);
        await land(0, "First notes");
        expect(pending).toHaveLength(2);
        // Past the first read's poll, while the follow-up is out.
        await advance(2_000);
        await land(1, "Follow-up notes");
        expect(pending).toHaveLength(2);
        // One poll, measured from the follow-up's landing.
        await advance(14_000);
        expect(pending).toHaveLength(2);
        await advance(1_000);
        expect(pending).toHaveLength(3);
      });

      it("keeps the newest when the read started beside a stalled one lands first", async () => {
        holdReads();
        openView(["qa"], "qa");
        await advance(59_000);
        expect(pending).toHaveLength(1);
        await advance(2_000);
        expect(pending).toHaveLength(2);

        await land(1, "Fresh notes");
        expect(shownNotes()).toContain("Fresh notes");
        await land(0, "Stalled notes");
        expect(shownNotes()).toContain("Fresh notes");
        expect(pending).toHaveLength(2);
      });

      it("paints a stalled read that lands first, and leaves what follows to the newer read", async () => {
        holdReads();
        openView(["qa"], "qa");
        await advance(61_000);
        expect(pending).toHaveLength(2);

        await land(0, "Stalled notes");
        expect(shownNotes()).toContain("Stalled notes");
        // The newer read is still out, so a move waits for it.
        act(() => pushPane("t1"));
        expect(pending).toHaveLength(2);
        await land(1, "Fresh notes");
        expect(shownNotes()).toContain("Fresh notes");
        expect(pending).toHaveLength(3);
      });

      it("never starts a third read beside two stalled ones until one lands", async () => {
        holdReads();
        openView(["qa"], "qa");
        await advance(61_000);
        await advance(120_000);
        expect(pending).toHaveLength(2);

        await land(0, "Stalled notes");
        expect(pending).toHaveLength(3);
        await land(2, "Fresh notes");
        await land(1, "Second stalled notes");
        expect(shownNotes()).toContain("Fresh notes");
        expect(pending).toHaveLength(3);
      });

      it("keeps the newer read's deadline when a stalled read lands first", async () => {
        holdReads();
        openView(["qa"], "qa");
        await advance(61_000);
        await land(0, "Stalled notes");
        expect(pending).toHaveLength(2);
        // The newer read started at 60s, so its own deadline is at 120s.
        await advance(58_000);
        expect(pending).toHaveLength(2);
        await advance(1_000);
        expect(pending).toHaveLength(3);
      });

      it("starts nothing when a stalled read lands after the newer one failed, and polls on from there", async () => {
        holdReads();
        openView(["qa"], "qa");
        await advance(181_000);
        expect(pending).toHaveLength(2);

        await act(async () => failing[1]!(new Error("unreachable")));
        expect(screen.getByTestId("decision-question-unavailable")).toBeTruthy();
        await advance(1_000);
        await land(0, "Stalled notes");
        // Older than the failure on screen, and the newer read already armed the poll.
        expect(screen.queryByTestId("decision-question-content")).toBeNull();
        expect(pending).toHaveLength(2);
        await advance(13_999);
        expect(pending).toHaveLength(2);
        await advance(1);
        expect(pending).toHaveLength(3);
        // Both earlier reads have landed, so a stall of this one has room beside it.
        await advance(61_000);
        expect(pending).toHaveLength(4);
      });

      it("starts nothing more for a read still out when it closed", async () => {
        holdReads();
        openView(["qa"], "qa");
        act(() => useDecisionsQuestionViewStore.getState().close());
        await advance(180_000);
        expect(getQuestionContent).toHaveBeenCalledTimes(1);
      });

      it("starts nothing for a move delivered to a listener already removed", async () => {
        openView(["qa"], "qa");
        await act(async () => {});
        // The event bus calls the listeners it snapshotted, even one removed mid-dispatch.
        const removed = [...paneListeners];
        expect(removed).toHaveLength(1);
        act(() => useDecisionsQuestionViewStore.getState().close());
        expect(paneListeners).toHaveLength(0);
        act(() => {
          for (const listener of removed) {
            listener({
              terminalId: "t1",
              openQuestions: [],
              waitingAnswers: [],
              needsAttention: [],
              revision: 3,
            });
          }
        });
        await advance(180_000);
        expect(getQuestionContent).toHaveBeenCalledTimes(1);
      });
    });

    it("folds moves while a read is out into one read after it, and paints both", async () => {
      openView(["qa"], "qa");
      await screen.findByTestId("decision-question-content");
      holdReads();
      act(() => pushPane("t1"));
      act(() => pushPane("t1"));
      act(() => pushPane("t1"));
      expect(pending).toHaveLength(1);

      await land(0, "First notes");
      expect(shownNotes()).toContain("First notes");
      expect(pending).toHaveLength(2);
      await land(1, "Follow-up notes");
      expect(shownNotes()).toContain("Follow-up notes");
      expect(pending).toHaveLength(2);
    });

    it("folds a Retry into the read still out", async () => {
      getQuestionContent.mockRejectedValueOnce(new Error("unreachable"));
      openView(["qa"], "qa");
      await screen.findByTestId("decision-question-unavailable");
      holdReads();
      act(() => pushPane("t1"));
      expect(pending).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(pending).toHaveLength(1);
      await land(0, "First notes");
      expect(shownNotes()).toContain("First notes");
      expect(pending).toHaveLength(2);
    });
  });

  it("says why a question can't be read, and offers a retry when it may come back", async () => {
    getQuestionContent.mockRejectedValueOnce(new Error("secret question text"));
    openView(["qa"], "qa");
    const notice = await screen.findByTestId("decision-question-unavailable");
    expect(notice.textContent).not.toContain("secret");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("decision-question-content");
  });

  it.each([
    ["not-running", true],
    ["host-not-connected", true],
    ["off", false],
    ["not-found", false],
    ["unreadable", false],
  ] as const)(
    "a %s read shows a notice, with Retry only when it can recover",
    async (result, retry) => {
      getQuestionContent.mockResolvedValueOnce({ result });
      openView(["qa"], "qa");
      await screen.findByTestId("decision-question-unavailable");
      expect(screen.queryByTestId("decision-question-content")).toBeNull();
      const button = screen.queryByRole("button", { name: "Retry" });
      expect(button !== null).toBe(retry);
      if (button !== null) {
        fireEvent.click(button);
        await screen.findByTestId("decision-question-content");
      }
    }
  );

  it("drops a read still out when it closes, and opens again on a fresh one", async () => {
    let resolveOld: (result: DecisionQuestionContentResult) => void = () => {};
    getQuestionContent.mockImplementationOnce(
      () => new Promise<DecisionQuestionContentResult>((resolve) => (resolveOld = resolve))
    );
    openView(["qa"], "qa");
    await waitFor(() => expect(getQuestionContent).toHaveBeenCalledTimes(1));
    act(() => useDecisionsQuestionViewStore.getState().close());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(paneListeners).toHaveLength(0);

    getQuestionContent.mockImplementationOnce(() => new Promise(() => {}));
    openView(["qa"], "qa");
    await waitFor(() => expect(getQuestionContent).toHaveBeenCalledTimes(2));
    await act(async () =>
      resolveOld({ result: "read", question: content("qa", 7, { context: "Old read" }) })
    );
    expect(screen.queryByText("Old read")).toBeNull();
  });

  describe("opened by reference (#17229)", () => {
    describe("at a follow-up (#17235)", () => {
      const asks = (messageId: string) => ({
        type: "message" as const,
        messageId,
        from: "agent" as const,
        text: `Asking ${messageId}`,
        images: [],
        expectsReply: true,
        sentAt: "2026-11-02T10:07:00.000Z",
        deliveryStatus: null,
        unreadable: false,
      });
      const withThread = (...extra: ReturnType<typeof asks>[]) =>
        content("qa", 7, { thread: [...QUESTIONS.qa!.thread, ...extra] });
      const openAt = (messageId: string) =>
        act(() =>
          useDecisionsQuestionViewStore
            .getState()
            .openReference([OTHER_PROJECT], OTHER_PROJECT, messageId)
        );
      let scrolled: Element[];
      let scrollSpy: { mockRestore: () => void };

      beforeEach(() => {
        scrolled = [];
        // The setup's stub stays for every other test: spied on, never replaced.
        scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
          this: Element
        ) {
          scrolled.push(this);
        });
      });

      afterEach(() => scrollSpy.mockRestore());

      it("scrolls to that follow-up once, and a read again keeps the person's place", async () => {
        getQuestionContentByReference.mockImplementation(async () => ({
          result: "read",
          question: withThread(asks("m2")),
        }));
        openAt("m2");
        await waitFor(() => expect(scrolled).toHaveLength(1));
        expect(scrolled[0]!.getAttribute("data-message-id")).toBe("m2");

        getQuestionContentByReference.mockImplementation(async () => ({
          result: "read",
          question: withThread(asks("m2"), asks("m3")),
        }));
        pushList(2, { qa: "to-type", qz: "waiting" });
        await screen.findByText("Asking m3");
        expect(scrolled).toHaveLength(1);
      });

      it("waits for a read made for this opening when the one on screen predates the follow-up", async () => {
        openReference([OTHER_PROJECT]);
        await screen.findByText("Merged");
        expect(scrolled).toHaveLength(0);

        let land!: () => void;
        getQuestionContentByReference.mockImplementation(
          () =>
            new Promise((resolve) => {
              land = () => resolve({ result: "read", question: withThread(asks("m2")) });
            })
        );
        openAt("m2");
        await waitFor(() => expect(land).toBeTypeOf("function"));
        expect(scrolled).toHaveLength(0);

        await act(async () => land());
        await waitFor(() => expect(scrolled).toHaveLength(1));
        expect(scrolled[0]!.getAttribute("data-message-id")).toBe("m2");
      });

      it("shows the thread when a read for this opening doesn't have the follow-up yet", async () => {
        openAt("not-yet-read");
        await waitFor(() => expect(scrolled).toHaveLength(1));
        expect(scrolled[0]!.getAttribute("data-testid")).toBe("decision-question-thread");
      });
    });

    it("reads a question from another project's window by its reference, never through a pane", async () => {
      openReference([OTHER_PROJECT]);
      const body = await screen.findByTestId("decision-question-content");
      expect(getQuestionContentByReference).toHaveBeenCalledWith({ reference: OTHER_PROJECT });
      expect(getQuestionContent).not.toHaveBeenCalled();
      expect(body.textContent).toContain("Some notes");
      expect(screen.getByRole("dialog").textContent).toContain("q-7");
      // Nothing listens on a pane for it: its terminal may be in another project, or gone.
      expect(paneListeners).toHaveLength(0);
    });

    it("steps between referenced questions from different projects", async () => {
      const elsewhere = { ...OTHER_PROJECT, projectId: "project-c", questionId: "qb" };
      openReference([OTHER_PROJECT, elsewhere]);
      await screen.findByTestId("decision-question-content");
      fireEvent.click(screen.getByTestId("decision-question-next"));
      await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-8"));
      expect(getQuestionContentByReference).toHaveBeenLastCalledWith({ reference: elsewhere });
    });

    it("reads again when its place in the list moves, and not for another question's", async () => {
      openReference([OTHER_PROJECT]);
      await screen.findByTestId("decision-question-content");
      act(() => pushList(1, { qa: "waiting", qz: "waiting" }));
      await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(2));
      // Only the other question moves: nothing new to read for this one.
      act(() => pushList(2, { qa: "waiting", qz: "to-type" }));
      await act(async () => {});
      expect(getQuestionContentByReference).toHaveBeenCalledTimes(2);
      act(() => pushList(3, { qa: "to-type", qz: "to-type" }));
      await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(3));
      expect(paneListeners).toHaveLength(0);
    });

    it("dismisses a waiting question by its reference, after a confirmation naming it, at the revision read (#17239)", async () => {
      const waiting = { ...OTHER_PROJECT, questionId: "qw" };
      QUESTIONS.qw = content("qw", 11, {
        status: "open",
        thread: [],
        revision: 4,
        reference: waiting,
      });
      getQuestionSummariesByReference.mockResolvedValue({
        result: "read",
        summaries: [{ questionId: "qw", result: "read", line: "Ship the migration?" }],
      });
      try {
        openReference([waiting]);
        fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
        const confirm = await screen.findByRole("alertdialog");
        expect(confirm.textContent).toContain("Dismiss question q-11?");
        await waitFor(() => expect(confirm.textContent).toContain("Ship the migration?"));
        expect(getQuestionSummariesByReference).toHaveBeenCalledWith({ references: [waiting] });
        const reads = getQuestionContentByReference.mock.calls.length;

        await act(async () => {
          fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
        });
        expect(declineQuestion).toHaveBeenCalledExactlyOnceWith({
          reference: waiting,
          declineId: expect.any(String),
          expectedRevision: 4,
        });
        expect(cancelQuestionByReference).not.toHaveBeenCalled();
        expect(cancelQuestion).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        // Read again first, and again once taken, to show it declined once it's recorded.
        await waitFor(() =>
          expect(getQuestionContentByReference.mock.calls.length).toBeGreaterThanOrEqual(reads + 2)
        );
        expect(screen.getByTestId("decision-question-dismiss-status").textContent).toMatch(
          /^Dismissed/
        );
      } finally {
        delete QUESTIONS.qw;
      }
    });

    it("signs nothing for a question that moved on since the view read it, sending the person back to it", async () => {
      const waiting = { ...OTHER_PROJECT, questionId: "qw" };
      QUESTIONS.qw = content("qw", 11, {
        status: "open",
        thread: [],
        revision: 4,
        reference: waiting,
      });
      try {
        openReference([waiting]);
        fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
        const confirm = await screen.findByRole("alertdialog");
        // Reopened on the relay since: the view still shows revision 4.
        QUESTIONS.qw = { ...QUESTIONS.qw!, revision: 5 };
        await act(async () => {
          fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
        });

        expect(declineQuestion).not.toHaveBeenCalled();
        expect(confirm.textContent).toContain("q-11 changed since you opened it");
        expect(
          within(confirm)
            .getByRole("button", { name: "Dismiss question" })
            .getAttribute("aria-disabled")
        ).toBe("true");
      } finally {
        delete QUESTIONS.qw;
      }
    });

    it("withdraws one by its reference only after a second confirmation, once the relay can't take a dismissal", async () => {
      QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
      const waiting = { ...OTHER_PROJECT, questionId: "qw" };
      declinedOnce({ status: "unsupported", by: "relay" });
      try {
        openReference([waiting]);
        fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
        const confirm = await screen.findByRole("alertdialog");
        await act(async () => {
          fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
        });
        expect(confirm.textContent).toContain("Withdraw question q-11?");
        expect(confirm.textContent).toContain("Your relay needs an update");
        expect(cancelQuestionByReference).not.toHaveBeenCalled();

        const withdraw = within(confirm).getByRole("button", { name: "Withdraw question" });
        await waitFor(() => expect(withdraw.hasAttribute("aria-disabled")).toBe(false));
        await act(async () => {
          fireEvent.click(withdraw);
        });
        expect(cancelQuestionByReference).toHaveBeenCalledExactlyOnceWith({ reference: waiting });
        expect(cancelQuestion).not.toHaveBeenCalled();
        expect(declineQuestion).toHaveBeenCalledOnce();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      } finally {
        delete QUESTIONS.qw;
      }
    });
  });

  it("shows a question the person declined from their phone as declined, apart from a withdrawal (#17234)", async () => {
    const EXPIRY = "time[datetime='2099-01-01T00:00:00.000Z']";
    const statusOf = (body: HTMLElement) =>
      body.querySelector("[data-testid='decision-question-status']")?.textContent ?? "";
    QUESTIONS.qd = content("qd", 12, { status: "open", thread: [] });
    try {
      openView(["qd"], "qd");
      let body = await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decision-question-dismiss")).not.toBeNull();
      expect(body.querySelector(EXPIRY)).not.toBeNull();
      const waiting = statusOf(body);

      // The person dismisses it on their phone while the view is open.
      QUESTIONS.qd = content("qd", 12, {
        status: "cancelled",
        closedReason: "declined",
        thread: [{ type: "declined", entryId: "d1", sentAt: "2026-11-02T10:07:00.000Z" }],
      });
      act(() => pushPane("t1"));
      await waitFor(() => expect(screen.queryByTestId("decision-question-dismiss")).toBeNull());
      body = screen.getByTestId("decision-question-content");
      const declined = statusOf(body);
      expect(declined).not.toBe(waiting);
      // The person's own decline, never the model's or the desktop's.
      expect(declined).toMatch(/declined/i);
      expect(declined).toMatch(/\byou\b/i);
      const [entry, ...rest] = screen.getAllByTestId("decision-thread-entry");
      expect(rest).toEqual([]);
      expect(entry!.textContent).toMatch(/declined/i);
      expect(entry!.textContent).toMatch(/\byou\b/i);
      // It answers nothing, and says nothing is missing from it.
      expect(entry!.querySelectorAll("p")).toHaveLength(1);
      // Over, whatever its deadline would have said.
      expect(body.querySelector(EXPIRY)).toBeNull();

      QUESTIONS.qd = content("qd", 12, {
        status: "cancelled",
        closedReason: "withdrawn",
        thread: [],
      });
      act(() => pushPane("t1"));
      await waitFor(() =>
        expect(statusOf(screen.getByTestId("decision-question-content"))).not.toBe(declined)
      );
      const withdrawn = statusOf(screen.getByTestId("decision-question-content"));
      expect(withdrawn).not.toBe("");
      expect(withdrawn).not.toMatch(/declined/i);
    } finally {
      delete QUESTIONS.qd;
    }
  });

  it("offers Dismiss only while the question waits, and withdraws a pane's through its pane when it can't be dismissed", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    expect(screen.queryByTestId("decision-question-dismiss")).toBeNull();

    QUESTIONS.qw = content("qw", 11, { status: "queued", thread: [] });
    declinedOnce({ status: "unsupported", by: "asking-desktop" });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
      });
      expect(confirm.textContent).toMatch(/hasn't been sent to your phones yet/);
      const withdraw = within(confirm).getByRole("button", { name: "Withdraw question" });
      await waitFor(() => expect(withdraw.hasAttribute("aria-disabled")).toBe(false));
      await act(async () => {
        fireEvent.click(withdraw);
      });
      expect(cancelQuestion).toHaveBeenCalledExactlyOnceWith({
        terminalId: "t1",
        questionId: "qw",
      });
      expect(cancelQuestionByReference).not.toHaveBeenCalled();
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("follows a queued dismissal by its id on its own, offering no answer meanwhile, and offers withdrawing once it can't be taken (#17239)", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    declinedOnce({ status: "queued" });
    try {
      openView(["qw"], "qw");
      await screen.findByTestId("decision-question-content");
      // It takes an answer here.
      expect(screen.queryByTestId("decision-answer-send")).not.toBeNull();
      fireEvent.click(screen.getByTestId("decision-question-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
      });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      const status = screen.getByTestId("decision-question-dismiss-status");
      expect(status.textContent).toMatch(/Dismissal queued/);
      expect(screen.queryByTestId("decision-question-dismiss")).toBeNull();
      // Nothing is answered from here while it's being dismissed.
      expect(screen.queryByTestId("decision-answer-send")).toBeNull();

      const declineId = declineQuestion.mock.calls[0]![0].declineId;
      getDeclineResult.mockResolvedValue({
        result: "read",
        questionId: "qw",
        expectedRevision: 1,
        outcome: { status: "unsupported", by: "relay" },
      });
      await vi.waitFor(() => expect(getDeclineResult).toHaveBeenCalledWith({ declineId }), {
        timeout: 9000,
      });
      const fallback = await screen.findByTestId("decision-question-dismiss-fallback");
      expect(fallback.textContent).toContain("Your relay needs an update");
      expect(declineQuestion).toHaveBeenCalledOnce();
      // Not taken: it can be answered here again.
      expect(screen.queryByTestId("decision-answer-send")).not.toBeNull();

      fireEvent.click(screen.getByTestId("decision-question-withdraw"));
      const asked = await screen.findByRole("alertdialog");
      expect(asked.textContent).toContain("Withdraw question q-11?");
      expect(asked.textContent).toContain("Your relay needs an update");
      await act(async () => {
        fireEvent.click(within(asked).getByRole("button", { name: "Withdraw question" }));
      });
      expect(cancelQuestion).toHaveBeenCalledExactlyOnceWith({
        terminalId: "t1",
        questionId: "qw",
      });
    } finally {
      delete QUESTIONS.qw;
    }
  }, 20_000);

  it("reads the question again once a queued dismissal is taken, and says why one wasn't (#17239)", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    declinedOnce({ status: "queued" });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
      });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      const reads = getQuestionContent.mock.calls.length;

      getDeclineResult.mockResolvedValue({
        result: "read",
        questionId: "qw",
        expectedRevision: 1,
        outcome: { status: "rejected", code: "conflict" },
      });
      const outcome = await vi.waitFor(
        () => screen.getByTestId("decision-question-dismiss-outcome"),
        { timeout: 9000 }
      );
      expect(outcome.textContent).toContain("The relay refused the dismissal of q-11 (conflict)");
      expect(getQuestionContent.mock.calls.length).toBeGreaterThan(reads);
      // Dismiss is offered again, under a new id.
      expect(screen.queryByTestId("decision-question-dismiss")).not.toBeNull();
    } finally {
      delete QUESTIONS.qw;
    }
  }, 20_000);

  it.each([
    ["queued", true],
    ["open", true],
    ["human-answered", false],
    ["proxy-answered", false],
    ["cancelled", false],
    ["expired", false],
    ["publish-failed", false],
  ] as const)("offers Dismiss for a %s question: %s", async (status, offered) => {
    QUESTIONS.qw = content("qw", 11, { status, thread: [] });
    try {
      openView(["qw"], "qw");
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decision-question-dismiss") !== null).toBe(offered);
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("sends nothing once the question stops waiting under the confirmation", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
      const confirm = await screen.findByRole("alertdialog");

      QUESTIONS.qw = content("qw", 11, { status: "human-answered" });
      act(() => pushPane("t1"));
      await waitFor(() => expect(confirm.textContent).toMatch(/isn't waiting for an answer/));
      const send = within(confirm).getByRole("button", { name: "Dismiss question" });
      expect(send.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        fireEvent.click(send);
      });
      expect(declineQuestion).not.toHaveBeenCalled();
      expect(cancelQuestion).not.toHaveBeenCalled();
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("reads once more after a withdrawal, never over a read still out", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw"], "qw");
      const confirm = await reachWithdrawal();
      const pending: Array<(result: DecisionQuestionContentResult) => void> = [];
      getQuestionContent.mockImplementation(
        () => new Promise<DecisionQuestionContentResult>((resolve) => pending.push(resolve))
      );
      act(() => pushPane("t1"));
      expect(pending).toHaveLength(1);

      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Withdraw question" }));
      });
      expect(cancelQuestion).toHaveBeenCalledOnce();
      expect(pending).toHaveLength(1);
      await act(async () => pending[0]!({ result: "read", question: QUESTIONS.qw! }));
      expect(pending).toHaveLength(2);
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("never reads another question again for a withdrawal that lands after stepping away", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    let finish: (result: DecisionQuestionCancelResult) => void = () => {};
    cancelQuestion.mockImplementation(
      () => new Promise<DecisionQuestionCancelResult>((resolve) => (finish = resolve))
    );
    try {
      openView(["qw", "qa"], "qw");
      const confirm = await reachWithdrawal();
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Withdraw question" }));
      });
      expect(cancelQuestion).toHaveBeenCalledOnce();

      act(() => useDecisionsQuestionViewStore.getState().step(1));
      await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-7"));
      const calls = getQuestionContent.mock.calls.length;
      await act(async () => finish({ result: "cancelling" }));
      expect(getQuestionContent.mock.calls.length).toBe(calls);
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("keeps focus in the view when stepping away from the dismissal button by arrow key", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw", "qa"], "qw");
      const cancel = await screen.findByTestId("decision-question-dismiss");
      act(() => cancel.focus());
      fireEvent.keyDown(cancel, { key: "ArrowRight" });
      await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-7"));
      expect(document.activeElement).toBe(screen.getByTestId("decision-question-next"));
      expect(screen.queryByTestId("decision-question-dismiss")).toBeNull();

      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(useDecisionsQuestionViewStore.getState().request?.index).toBe(0);
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("never brings a confirmation back after the view closed under it", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
      await screen.findByRole("alertdialog");

      act(() => useDecisionsQuestionViewStore.getState().close());
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      openView(["qw"], "qw");
      await screen.findByTestId("decision-question-dismiss");
      await act(async () => {});

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(declineQuestion).not.toHaveBeenCalled();
      expect(cancelQuestion).not.toHaveBeenCalled();
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("never brings a confirmation back after the view stepped away and back", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw", "qa"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-dismiss"));
      await screen.findByRole("alertdialog");

      act(() => useDecisionsQuestionViewStore.getState().step(1));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      act(() => useDecisionsQuestionViewStore.getState().step(-1));
      await screen.findByTestId("decision-question-dismiss");
      await act(async () => {});

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(declineQuestion).not.toHaveBeenCalled();
      expect(cancelQuestion).not.toHaveBeenCalled();
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("closes on Escape", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false));
  });

  it("waits for main to say whether Decisions is on before reading, rather than closing (#17232)", async () => {
    act(() => {
      decisionsKnown = false;
      for (const listener of onListeners) listener();
    });
    openReference([OTHER_PROJECT]);
    await act(async () => {});
    expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(true);
    expect(getQuestionContentByReference).not.toHaveBeenCalled();

    act(() => {
      decisionsKnown = true;
      for (const listener of onListeners) listener();
    });

    await screen.findByTestId("decision-question-content");
    expect(getQuestionContentByReference).toHaveBeenCalledWith({ reference: OTHER_PROJECT });
  });

  it("closes as soon as Decisions turns off", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    act(() => {
      decisionsOn = false;
      for (const listener of onListeners) listener();
    });
    await waitFor(() => expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false));
  });
});
