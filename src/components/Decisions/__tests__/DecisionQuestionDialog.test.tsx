// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionList,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
} from "@shared/types/decisionsQuestion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

let decisionsOn = true;
const onListeners = new Set<() => void>();
vi.mock("@/hooks/useDecisionsOn", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useDecisionsOn: () =>
      useSyncExternalStore(
        (listener) => {
          onListeners.add(listener);
          return () => onListeners.delete(listener);
        },
        () => decisionsOn
      ),
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
    deliveryStatus: "terminal-delivered",
    attachments: [],
    thread: [
      {
        type: "answer",
        entryId: "a1",
        revision: 1,
        from: "person",
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

function openView(ids: string[], id: string) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, id));
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
  });
  for (const listener of [...listListeners]) {
    listener({
      revision,
      questions: [
        item(OTHER_PROJECT, 7, kinds.qa),
        item({ ...OTHER_PROJECT, questionId: "qz" }, 9, kinds.qz),
      ],
    });
  }
}

beforeEach(() => {
  decisionsOn = true;
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
  Reflect.set(window, "electron", {
    decisions: {
      getQuestionContent,
      getQuestionContentByReference,
      getQuestionSummaries,
      getQuestionSummariesByReference,
      cancelQuestion,
      cancelQuestionByReference,
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
    expect(screen.getByTestId("decision-question-requirement").textContent).not.toBe("");
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
    const requirementA = screen.getByTestId("decision-question-requirement").textContent;

    fireEvent.click(screen.getByTestId("decision-question-next"));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-8"));
    expect(screen.getByTestId("decision-question-position").textContent).toBe("2 of 2");
    expect(screen.getByTestId("decision-question-requirement").textContent).not.toBe(requirementA);
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

  it("keeps the newest of two overlapping reads of one question", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    const pending: Array<(result: DecisionQuestionContentResult) => void> = [];
    getQuestionContent.mockImplementation(
      () => new Promise<DecisionQuestionContentResult>((resolve) => pending.push(resolve))
    );
    act(() => pushPane("t1"));
    act(() => pushPane("t1"));
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () =>
      pending[1]!({ result: "read", question: content("qa", 7, { context: "Newer notes" }) })
    );
    await act(async () =>
      pending[0]!({ result: "read", question: content("qa", 7, { context: "Older notes" }) })
    );
    const body = screen.getByTestId("decision-question-content");
    expect(body.textContent).toContain("Newer notes");
    expect(body.textContent).not.toContain("Older notes");
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

    it("withdraws a waiting question by its reference, after a confirmation naming it", async () => {
      QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
      const waiting = { ...OTHER_PROJECT, questionId: "qw" };
      getQuestionSummariesByReference.mockResolvedValue({
        result: "read",
        summaries: [{ questionId: "qw", result: "read", line: "Ship the migration?" }],
      });
      try {
        openReference([waiting]);
        fireEvent.click(await screen.findByTestId("decision-question-cancel"));
        const confirm = await screen.findByRole("alertdialog");
        expect(confirm.textContent).toContain("q-11");
        await waitFor(() => expect(confirm.textContent).toContain("Ship the migration?"));
        expect(getQuestionSummariesByReference).toHaveBeenCalledWith({ references: [waiting] });

        await act(async () => {
          fireEvent.click(within(confirm).getByRole("button", { name: "Cancel question" }));
        });
        expect(cancelQuestionByReference).toHaveBeenCalledExactlyOnceWith({ reference: waiting });
        expect(cancelQuestion).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        // Read again at once, to show it withdrawn once the relay confirms.
        await waitFor(() => expect(getQuestionContentByReference).toHaveBeenCalledTimes(2));
      } finally {
        delete QUESTIONS.qw;
      }
    });
  });

  it("offers a withdrawal only while the question waits, and sends a pane's through its pane", async () => {
    openView(["qa"], "qa");
    await screen.findByTestId("decision-question-content");
    expect(screen.queryByTestId("decision-question-cancel")).toBeNull();

    QUESTIONS.qw = content("qw", 11, { status: "queued", thread: [] });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-cancel"));
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm.textContent).toMatch(/hasn't been sent to your phones yet/);
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Cancel question" }));
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

  it.each([
    ["queued", true],
    ["open", true],
    ["human-answered", false],
    ["proxy-answered", false],
    ["cancelled", false],
    ["expired", false],
    ["publish-failed", false],
  ] as const)("offers a withdrawal for a %s question: %s", async (status, offered) => {
    QUESTIONS.qw = content("qw", 11, { status, thread: [] });
    try {
      openView(["qw"], "qw");
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decision-question-cancel") !== null).toBe(offered);
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("sends nothing once the question stops waiting under the confirmation", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw"], "qw");
      fireEvent.click(await screen.findByTestId("decision-question-cancel"));
      const confirm = await screen.findByRole("alertdialog");

      QUESTIONS.qw = content("qw", 11, { status: "human-answered" });
      act(() => pushPane("t1"));
      await waitFor(() => expect(confirm.textContent).toMatch(/isn't waiting for an answer/));
      const send = within(confirm).getByRole("button", { name: "Cancel question" });
      expect(send.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        fireEvent.click(send);
      });
      expect(cancelQuestion).not.toHaveBeenCalled();
    } finally {
      delete QUESTIONS.qw;
    }
  });

  it("keeps focus in the view when stepping away from the withdrawal button by arrow key", async () => {
    QUESTIONS.qw = content("qw", 11, { status: "open", thread: [] });
    try {
      openView(["qw", "qa"], "qw");
      const cancel = await screen.findByTestId("decision-question-cancel");
      act(() => cancel.focus());
      fireEvent.keyDown(cancel, { key: "ArrowRight" });
      await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("q-7"));
      expect(document.activeElement).toBe(screen.getByTestId("decision-question-next"));
      expect(screen.queryByTestId("decision-question-cancel")).toBeNull();

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
      fireEvent.click(await screen.findByTestId("decision-question-cancel"));
      await screen.findByRole("alertdialog");

      act(() => useDecisionsQuestionViewStore.getState().close());
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      openView(["qw"], "qw");
      await screen.findByTestId("decision-question-cancel");
      await act(async () => {});

      expect(screen.queryByRole("alertdialog")).toBeNull();
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
