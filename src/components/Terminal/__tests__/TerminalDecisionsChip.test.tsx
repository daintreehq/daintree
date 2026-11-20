// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The real popover lazy-loads Radix and renders nothing until primed. This
// one keeps its open state, so what loads only while it is open can be seen.
vi.mock("@/components/ui/popover", async () => {
  const { createContext, useContext } = await import("react");
  const PopoverState = createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({
    open: false,
    onOpenChange: () => {},
  });
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => (
      <PopoverState.Provider value={{ open, onOpenChange }}>
        <div>{children}</div>
      </PopoverState.Provider>
    ),
    PopoverTrigger: function Trigger({ children }: { children: React.ReactNode }) {
      const { open, onOpenChange } = useContext(PopoverState);
      return <span onClickCapture={() => onOpenChange(!open)}>{children}</span>;
    },
    PopoverContent: function Content({ children }: { children: React.ReactNode }) {
      const { open } = useContext(PopoverState);
      return open ? <div data-testid="popover-content">{children}</div> : null;
    },
  };
});

import { TerminalDecisionsChip } from "../TerminalDecisionsChip";
import {
  OverlayFocusRestoreContext,
  type OverlayFocusRestore,
} from "@/components/ui/overlay-focus-restore";
import {
  answerKey,
  useDecisionsAnswerStore,
  type DeclinePhase,
} from "@/store/decisionsAnswerStore";
import { dismissingQuestionIds } from "@/components/Decisions/decisionDeclineSend";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDecisionsWaitingCount } from "@/hooks/useDecisionsWaitingCount";
import type {
  DecisionDeclineResultRead,
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionSummariesResult,
  DeclineDecisionQuestionPayload,
  DecisionQuestionList,
  DecisionQuestionListItem,
} from "@shared/types/decisionsQuestion";

let statusListeners: Array<(status: DecisionsStatus) => void> = [];
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
let listListeners: Array<(list: DecisionQuestionList) => void> = [];
const listQuestions = vi.fn<() => Promise<DecisionQuestionList>>();
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const getPaneState = vi.fn<(id: string) => Promise<PaneDecisionState | null>>();
const getQuestionSummaries =
  vi.fn<
    (payload: {
      terminalId: string;
      questionIds: string[];
    }) => Promise<DecisionQuestionSummariesResult>
  >();
const cancelQuestion =
  vi.fn<
    (payload: { terminalId: string; questionId: string }) => Promise<DecisionQuestionCancelResult>
  >();
const getQuestionContent =
  vi.fn<
    (payload: { terminalId: string; questionId: string }) => Promise<DecisionQuestionContentResult>
  >();
const declineQuestion =
  vi.fn<(payload: DeclineDecisionQuestionPayload) => Promise<DecisionQuestionDeclineResult>>();
const getDeclineResult =
  vi.fn<(payload: { declineId: string }) => Promise<DecisionDeclineResultRead>>();
const onDecisionState = vi.fn((callback: (state: PaneDecisionState) => void) => {
  paneListeners.push(callback);
  return () => {
    paneListeners = paneListeners.filter((listener) => listener !== callback);
  };
});

function pushStatus(state: DecisionsStatus["state"], revision: number): void {
  for (const listener of [...statusListeners]) listener({ state, revision });
}

function paneState(overrides: Partial<PaneDecisionState> = {}): PaneDecisionState {
  return {
    terminalId: "t1",
    openQuestions: [
      {
        questionId: "q42",
        alias: 42,
        status: "open",
        askedAt: "2026-11-02T10:00:00.000Z",
        expiresAt: null,
      },
    ],
    waitingAnswers: [],
    needsAttention: [],
    revision: 1,
    ...overrides,
  };
}

/** `q42` as the machine that owns the pane reads it: still open, at revision 3. */
function q42Content(over: Partial<DecisionQuestionContent> = {}): DecisionQuestionContent {
  return {
    questionId: "q42",
    alias: 42,
    terminalId: "t1",
    reference: {
      hostId: "host_studio",
      projectId: "project-1",
      terminalId: "t1",
      questionId: "q42",
    },
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

/** Drafts that count every read of them, as the selector of a pane header would make one. */
class CountingDrafts extends Map<string, string> {
  reads = 0;
  override get(key: string) {
    this.reads++;
    return super.get(key);
  }
  override has(key: string) {
    this.reads++;
    return super.has(key);
  }
  override forEach(...args: Parameters<Map<string, string>["forEach"]>) {
    this.reads++;
    super.forEach(...args);
  }
  override entries() {
    this.reads++;
    return super.entries();
  }
  override keys() {
    this.reads++;
    return super.keys();
  }
  override values() {
    this.reads++;
    return super.values();
  }
  override [Symbol.iterator]() {
    this.reads++;
    return super[Symbol.iterator]();
  }
}

/** A keystroke in some composer: the store swaps in a fresh drafts map. */
function typeInAComposer(entries: Array<[string, string]>): CountingDrafts {
  const drafts = new CountingDrafts(entries);
  drafts.reads = 0;
  act(() => useTerminalInputStore.setState({ draftInputs: drafts }));
  return drafts;
}

beforeEach(() => {
  statusListeners = [];
  paneListeners = [];
  listListeners = [];
  listQuestions.mockReset().mockResolvedValue({ revision: 1, questions: [] });
  getStatus.mockReset().mockResolvedValue({ state: "off" });
  getPaneState.mockReset().mockResolvedValue(paneState());
  getQuestionSummaries.mockReset().mockImplementation(async ({ questionIds }) => ({
    result: "read",
    summaries: questionIds.map((questionId) => ({
      questionId,
      result: "read" as const,
      line: `Opening line of ${questionId}`,
    })),
  }));
  cancelQuestion.mockReset().mockResolvedValue({ result: "cancelling" });
  getQuestionContent.mockReset().mockResolvedValue({ result: "read", question: q42Content() });
  declineQuestion.mockReset().mockImplementation(async ({ declineId }) => ({
    result: "submitted",
    declineId,
    outcome: { status: "declined" },
  }));
  getDeclineResult.mockReset().mockResolvedValue({ result: "not-found" });
  useDecisionsAnswerStore.getState().clear();
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  useTerminalInputStore.setState({ draftInputs: new Map() });
  onDecisionState.mockClear();
  Reflect.set(window, "electron", {
    events: {
      on: (name: string, callback: (payload: never) => void) => {
        if (name === "decisions:questions-changed") {
          const onList = callback as (list: DecisionQuestionList) => void;
          listListeners.push(onList);
          return () => {
            listListeners = listListeners.filter((listener) => listener !== onList);
          };
        }
        if (name !== "decisions:status-changed") return () => {};
        const onStatus = callback as (status: DecisionsStatus) => void;
        statusListeners.push(onStatus);
        return () => {
          statusListeners = statusListeners.filter((listener) => listener !== onStatus);
        };
      },
    },
    decisions: {
      listQuestions,
      getStatus,
      getPaneState,
      getQuestionSummaries,
      cancelQuestion,
      getQuestionContent,
      declineQuestion,
      getDeclineResult,
    },
    terminal: { onDecisionState },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

function makePolicy(expectHandoff: () => void): OverlayFocusRestore {
  return {
    setRestoreTarget: vi.fn(),
    resetForOpen: vi.fn(),
    deferToRadix: vi.fn(),
    restoreIfStranded: vi.fn(),
    expectHandoff,
    onContentPointerDown: vi.fn(),
    onContentPointerDownOutside: vi.fn(),
    onContentInteractOutside: vi.fn(),
    onContentKeyDown: vi.fn(),
    onContentClick: vi.fn(),
    onContentCloseAutoFocus: vi.fn(),
  };
}

describe("TerminalDecisionsChip", () => {
  it("with Decisions off, reads and watches no pane and shows nothing", async () => {
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await act(async () => {});

    expect(getPaneState).not.toHaveBeenCalled();
    expect(onDecisionState).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
  });

  it("with Decisions off, reads no drafts when someone types in a composer", async () => {
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await act(async () => {});

    const drafts = typeInAComposer([
      ["project-a:t1", "a draft here"],
      ["project-a:t2", "typing elsewhere"],
    ]);
    expect(drafts.reads).toBe(0);
  });

  it("with nothing outstanding for the pane, reads no drafts when someone types", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(null);
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(paneListeners).toHaveLength(1));
    await act(async () => {});

    const drafts = typeInAComposer([["project-a:t1", "a draft here"]]);
    expect(drafts.reads).toBe(0);
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
  });

  it("holds an answer for the pane's own draft, never another host's for the same id", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(
      paneState({
        openQuestions: [],
        waitingAnswers: [
          { questionId: "q42", alias: 42, kind: "answer", deliveryStatus: "desktop-received" },
        ],
      })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    const chip = await screen.findByTestId("terminal-decisions-chip");
    const label = () => chip.getAttribute("aria-label");
    const noDraft = label();

    const remoteReply: [string, string] = ["isolated-composer:host-b:t1", "a reply over there"];
    typeInAComposer([remoteReply]);
    expect(label()).toBe(noDraft);

    const drafts = typeInAComposer([remoteReply, ["project-a:t1", "a draft here"]]);
    expect(drafts.reads).toBeGreaterThan(0);
    expect(label()).not.toBe(noDraft);

    typeInAComposer([remoteReply, ["project-a:t1", "  "]]);
    expect(label()).toBe(noDraft);

    // Once the answer is typed in, nothing the pane shows waits on a draft.
    act(() => paneListeners[0]!(paneState({ openQuestions: [], revision: 2 })));
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
    expect(typeInAComposer([["project-a:t1", "a longer draft"]]).reads).toBe(0);
  });

  it("says an open question waits on a draft written before it was asked", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(null);
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(paneListeners).toHaveLength(1));
    await act(async () => {});
    const draft: [string, string] = ["project-a:t1", "written before the question"];
    expect(typeInAComposer([draft]).reads).toBe(0);

    // The question arrives with no keystroke after it: the drafts are read as it does.
    act(() => paneListeners[0]!(paneState({ revision: 2 })));
    fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
    await waitFor(() =>
      expect(screen.getAllByTestId("terminal-decisions-row-line")).toHaveLength(1)
    );
    // The delivery notes alone: a row's relative time could tick between reads.
    const notes = () =>
      [...screen.getByTestId("popover-content").querySelectorAll("p")]
        .map((note) => note.textContent)
        .join("\n");
    const withDraft = notes();
    expect(withDraft).not.toBe("");

    typeInAComposer([]);
    expect(notes()).not.toBe(withDraft);
    typeInAComposer([draft]);
    expect(notes()).toBe(withDraft);
  });

  it("reads no drafts for a pane whose only answers need a person", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(
      paneState({
        openQuestions: [],
        needsAttention: [
          {
            questionId: "q41",
            alias: 41,
            deliveryStatus: "needs-attention",
            reason: "relaunched",
          },
        ],
      })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    await screen.findByTestId("terminal-decisions-chip");

    expect(typeInAComposer([["project-a:t1", "a draft here"]]).reads).toBe(0);
  });

  it("shares one status watch between every pane in the view", async () => {
    render(
      <>
        <TerminalDecisionsChip terminalId="t1" />
        <TerminalDecisionsChip terminalId="t2" />
      </>
    );
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(statusListeners).toHaveLength(1);
  });

  it("starts watching once Decisions turns on, and stops when it turns off", async () => {
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());

    act(() => pushStatus("connected", 1));
    const chip = await screen.findByTestId("terminal-decisions-chip");
    expect(getPaneState).toHaveBeenCalledWith("t1");
    expect(chip.getAttribute("aria-label")).toContain("q-42");

    act(() => pushStatus("off", 2));
    await waitFor(() => expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull());
    expect(paneListeners).toHaveLength(0);
  });

  it("follows the pane's pushes, and goes when nothing is outstanding", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(null);
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(paneListeners).toHaveLength(1));
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();

    act(() => paneListeners[0]!(paneState({ revision: 2 })));
    await screen.findByTestId("terminal-decisions-chip");

    act(() => paneListeners[0]!(paneState({ openQuestions: [], revision: 3 })));
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
  });

  it("keeps the pane's selection when the chip is pressed", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    const paneClick = vi.fn((event: React.MouseEvent) => event.defaultPrevented);
    render(
      <div onClick={paneClick}>
        <TerminalDecisionsChip terminalId="t1" />
      </div>
    );
    fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
    expect(paneClick).toHaveReturnedWith(true);
  });

  it("hands focus to the attention dialog before Review answers closes the popover", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(
      paneState({
        needsAttention: [
          { questionId: "q43", alias: 43, deliveryStatus: "needs-attention", reason: "pane_gone" },
        ],
      })
    );
    const calls: string[] = [];
    const policy = makePolicy(() => calls.push("handoff"));
    const original = useDecisionsAttentionStore.getState().open;
    useDecisionsAttentionStore.setState({ open: (terminalId) => calls.push(`open ${terminalId}`) });
    try {
      render(
        <OverlayFocusRestoreContext.Provider value={policy}>
          <TerminalDecisionsChip terminalId="t1" />
        </OverlayFocusRestoreContext.Provider>
      );
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      expect(calls).toEqual([]);
      fireEvent.click(await screen.findByTestId("terminal-decisions-review"));

      expect(calls).toEqual(["handoff", "open t1"]);
      expect(screen.queryByTestId("popover-content")).toBeNull();
    } finally {
      useDecisionsAttentionStore.setState({ open: original });
    }
  });

  it("opens the inbox at this pane from the footer, handing it focus, with nothing needing attention (#17231)", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(paneState());
    const calls: string[] = [];
    const policy = makePolicy(() => calls.push("handoff"));
    const original = useDecisionsInboxStore.getState().open;
    useDecisionsInboxStore.setState({
      open: (options) => calls.push(`open ${options?.terminalId ?? "none"}`),
    });
    try {
      render(
        <OverlayFocusRestoreContext.Provider value={policy}>
          <TerminalDecisionsChip terminalId="t1" />
        </OverlayFocusRestoreContext.Provider>
      );
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      expect(screen.queryByTestId("terminal-decisions-review")).toBeNull();
      fireEvent.click(await screen.findByTestId("terminal-decisions-inbox"));

      expect(calls).toEqual(["handoff", "open t1"]);
      expect(screen.queryByTestId("popover-content")).toBeNull();
    } finally {
      useDecisionsInboxStore.setState({ open: original });
    }
  });

  it("offers no inbox in a Remote Host's window, whose questions this computer doesn't list", async () => {
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
    getPaneState.mockResolvedValue(paneState());
    window.__DAINTREE_HOST_ID__ = { id: "build-box" };
    try {
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      await screen.findByTestId("popover-content");
      expect(screen.queryByTestId("terminal-decisions-inbox")).toBeNull();
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("stays out of the way when the bridge is missing", () => {
    Reflect.deleteProperty(window, "electron");
    expect(() => render(<TerminalDecisionsChip terminalId="t1" />)).not.toThrow();
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
  });

  describe("rows", () => {
    const twoQuestions = paneState({
      openQuestions: [
        {
          questionId: "q42",
          alias: 42,
          status: "open",
          askedAt: "2026-11-02T10:00:00.000Z",
          expiresAt: null,
        },
        {
          questionId: "q43",
          alias: 43,
          status: "open",
          askedAt: "2026-11-02T10:05:00.000Z",
          expiresAt: null,
        },
      ],
    });

    it("reads the opening lines only while the dropdown is open, and names each row by its own", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getPaneState.mockResolvedValue(twoQuestions);
      render(<TerminalDecisionsChip terminalId="t1" />);
      const chip = await screen.findByTestId("terminal-decisions-chip");
      expect(getQuestionSummaries).not.toHaveBeenCalled();

      fireEvent.click(chip);
      await waitFor(() =>
        expect(screen.getAllByTestId("terminal-decisions-row-line")).toHaveLength(2)
      );
      expect(getQuestionSummaries).toHaveBeenCalledWith({
        terminalId: "t1",
        questionIds: ["q42", "q43"],
      });
      for (const row of screen.getAllByTestId("terminal-decisions-row")) {
        const id = row.getAttribute("data-question-id");
        expect(row.textContent).toContain(`Opening line of ${id}`);
      }
    });

    it("keeps a row named by alias when its line can't be read", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getQuestionSummaries.mockResolvedValue({
        result: "read",
        summaries: [{ questionId: "q42", result: "unreadable" }],
      });
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      const row = await screen.findByTestId("terminal-decisions-row");
      await act(async () => {});
      expect(row.textContent).toContain("q-42");
      expect(screen.queryByTestId("terminal-decisions-row-line")).toBeNull();
    });

    it("never shows a line that arrives after the dropdown closed", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      let resolve: (value: DecisionQuestionSummariesResult) => void = () => {};
      getQuestionSummaries.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      render(<TerminalDecisionsChip terminalId="t1" />);
      const chip = await screen.findByTestId("terminal-decisions-chip");
      fireEvent.click(chip);
      await waitFor(() => expect(getQuestionSummaries).toHaveBeenCalledTimes(1));
      fireEvent.click(chip);
      expect(screen.queryByTestId("popover-content")).toBeNull();

      getQuestionSummaries.mockReturnValueOnce(new Promise(() => {}));
      fireEvent.click(chip);
      await waitFor(() => expect(getQuestionSummaries).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolve({
          result: "read",
          summaries: [{ questionId: "q42", result: "read", line: "Late line" }],
        });
      });
      expect(screen.getByTestId("popover-content")).toBeTruthy();
      expect(screen.queryByText("Late line")).toBeNull();
    });

    it("reads a long list in batches the bridge accepts, and names rows from every batch", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      const many = Array.from({ length: 70 }, (_, i) => ({
        questionId: `q${i + 1}`,
        alias: i + 1,
        status: "open" as const,
        askedAt: "2026-11-02T10:00:00.000Z",
        expiresAt: null,
      }));
      getPaneState.mockResolvedValue(paneState({ openQuestions: many }));
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      await waitFor(() =>
        expect(screen.getAllByTestId("terminal-decisions-row-line")).toHaveLength(70)
      );
      const asked = getQuestionSummaries.mock.calls.map(([payload]) => payload.questionIds);
      expect(asked.every((ids) => ids.length <= 64)).toBe(true);
      expect(asked.flat().sort()).toEqual(many.map((q) => q.questionId).sort());
    });

    const unnamed: Array<[string, DecisionQuestionSummariesResult]> = [
      [
        "a line-less summary",
        { result: "read", summaries: [{ questionId: "q42", result: "read", line: null }] },
      ],
      ["Decisions not running", { result: "not-running" }],
      ["Decisions off", { result: "off" }],
    ];
    it.each(unnamed)("keeps rows openable by alias with %s", async (_name, result) => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getQuestionSummaries.mockResolvedValue(result);
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      const row = await screen.findByTestId("terminal-decisions-row");
      await act(async () => {});
      expect(screen.queryByTestId("terminal-decisions-row-line")).toBeNull();
      fireEvent.click(row);
      expect(useDecisionsQuestionViewStore.getState().request?.questions).toEqual([
        { scope: "pane", terminalId: "t1", questionId: "q42" },
      ]);
    });

    it("keeps rows openable when the read fails", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getQuestionSummaries.mockRejectedValue(new Error("bridge gone"));
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      const row = await screen.findByTestId("terminal-decisions-row");
      await act(async () => {});
      fireEvent.click(row);
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(true);
    });

    it("opens the chosen question with every listed question to step through", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getPaneState.mockResolvedValue(twoQuestions);
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      const rows = await screen.findAllByTestId("terminal-decisions-row");
      fireEvent.click(rows[1]!);

      expect(useDecisionsQuestionViewStore.getState()).toMatchObject({
        isOpen: true,
        request: {
          questions: [
            { scope: "pane", terminalId: "t1", questionId: "q42" },
            { scope: "pane", terminalId: "t1", questionId: "q43" },
          ],
          index: 1,
        },
      });
      expect(screen.queryByTestId("popover-content")).toBeNull();
    });
  });

  describe("dismissing a question (#17239)", () => {
    const openAndAnswered = paneState({
      waitingAnswers: [
        { questionId: "q41", alias: 41, kind: "answer", deliveryStatus: "desktop-received" },
      ],
    });

    async function askToDismiss(): Promise<void> {
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      await waitFor(() =>
        expect(screen.getAllByTestId("terminal-decisions-row-line").length).toBeGreaterThan(0)
      );
      fireEvent.click(screen.getByRole("button", { name: "Dismiss question q-42…" }));
    }

    function dialogButton(name: string): HTMLElement {
      return screen.getByRole("button", { name });
    }

    async function confirm(name: string): Promise<void> {
      await act(async () => {
        fireEvent.click(dialogButton(name));
      });
    }

    function declinedOnce(
      outcome: Extract<DecisionQuestionDeclineResult, { result: "submitted" }>["outcome"]
    ) {
      declineQuestion.mockImplementationOnce(async ({ declineId }) => ({
        result: "submitted",
        declineId,
        outcome,
      }));
    }

    it("offers Dismiss only on a waiting question, and says why an answered one has none", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getPaneState.mockResolvedValue(openAndAnswered);
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      await screen.findAllByTestId("terminal-decisions-row");

      const dismisses = screen.getAllByTestId("terminal-decisions-dismiss");
      expect(dismisses.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Dismiss question q-42…",
      ]);
      expect(screen.getByTestId("popover-content").textContent).toContain(
        "Answered questions can't be dismissed"
      );
    });

    it("asks first, naming the question by alias and opening line, and Keep question asks main for nothing", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();

      expect(screen.queryByTestId("popover-content")).toBeNull();
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("Dismiss question q-42?");
      expect(dialog.textContent).toContain("Opening line of q42");
      expect(dialog.textContent).toContain("it's told you chose not to answer");
      expect(dialog.textContent).toContain("nothing is decided or approved");

      fireEvent.click(dialogButton("Keep question"));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(declineQuestion).not.toHaveBeenCalled();
      expect(cancelQuestion).not.toHaveBeenCalled();
    });

    it("declines it on confirm at the revision it's open at, never withdrawing it, and shows it dismissing until the pane's state drops it", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");
      expect(getQuestionContent).toHaveBeenCalledWith({ terminalId: "t1", questionId: "q42" });
      expect(declineQuestion).toHaveBeenCalledOnce();
      const payload = declineQuestion.mock.calls[0]![0];
      expect(payload).toEqual({
        reference: q42Content().reference,
        declineId: expect.any(String),
        expectedRevision: 3,
      });
      expect(cancelQuestion).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      const chip = screen.getByTestId("terminal-decisions-chip");
      expect(chip.textContent).toContain("q-42 dismissing");
      fireEvent.click(chip);
      await screen.findAllByTestId("terminal-decisions-row");
      expect(screen.queryByTestId("terminal-decisions-dismiss")).toBeNull();
      expect(screen.getByTestId("popover-content").textContent).toContain(
        "Dismissed here, waiting for it to close"
      );

      // The asking computer records the decline, and the question goes.
      act(() => paneListeners[0]!(paneState({ openQuestions: [], revision: 2 })));
      expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
    });

    it("says a relay too old for it can't take a dismissal, and withdraws only after a second confirmation", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declinedOnce({ status: "unsupported", by: "relay" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");
      // The person pressed Dismiss itself, so focus was on it.
      await waitFor(() => expect(document.activeElement).toBe(dialogButton("Keep question")));
      act(() => dialogButton("Dismiss question").focus());

      await confirm("Dismiss question");
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Withdraw question q-42?");
      expect(dialog.textContent).toContain(
        "Your relay needs an update before it takes a dismissal from this computer, so q-42 wasn't dismissed."
      );
      expect(dialog.textContent).toContain("Nothing is typed into this terminal");
      // The press that got the refusal never withdraws: focus moves to Keep question, and a
      // second press where Dismiss was does nothing yet.
      await waitFor(() => expect(document.activeElement).toBe(dialogButton("Keep question")));
      await confirm("Withdraw question");
      expect(cancelQuestion).not.toHaveBeenCalled();
      // Not dismissing: the chip still shows it waiting.
      expect(screen.getByTestId("terminal-decisions-chip").textContent).not.toContain("dismissing");

      await waitFor(() =>
        expect(dialogButton("Withdraw question").hasAttribute("aria-disabled")).toBe(false)
      );
      await confirm("Withdraw question");
      expect(cancelQuestion).toHaveBeenCalledExactlyOnceWith({
        terminalId: "t1",
        questionId: "q42",
      });
      expect(declineQuestion).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByTestId("terminal-decisions-chip").textContent).toContain(
        "q-42 cancelling"
      );
    });

    it("says Daintree on the computer that asked needs updating, and offers withdrawing", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declinedOnce({ status: "unsupported", by: "asking-desktop" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Withdraw question q-42?");
      expect(dialog.textContent).toContain(
        "Daintree on the computer that asked q-42 needs an update"
      );
      expect(cancelQuestion).not.toHaveBeenCalled();
    });

    it("stops offering withdrawal once a question the relay didn't hold yet has been sent, asking to dismiss it again", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      const unsent = paneState({
        openQuestions: [{ ...paneState().openQuestions[0]!, status: "queued" }],
      });
      getPaneState.mockResolvedValue(unsent);
      getQuestionContent.mockResolvedValue({
        result: "read",
        question: q42Content({ status: "queued" }),
      });
      declinedOnce({ status: "closed", reason: "not-found" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");
      await confirm("Dismiss question");
      expect(screen.getByRole("alertdialog").textContent).toContain("Withdraw question q-42?");

      // The Host sends it: the relay holds it now, so it can be dismissed after all.
      act(() => paneListeners[0]!(paneState({ revision: 2 })));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Dismiss question q-42?");
      expect(dialog.textContent).not.toContain("doesn't hold");
      expect(screen.queryByRole("button", { name: "Withdraw question" })).toBeNull();
      expect(cancelQuestion).not.toHaveBeenCalled();
    });

    it("never shows a withdrawal's refusal under the Dismiss it gives way to", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getPaneState.mockResolvedValue(
        paneState({ openQuestions: [{ ...paneState().openQuestions[0]!, status: "queued" }] })
      );
      getQuestionContent.mockResolvedValue({
        result: "read",
        question: q42Content({ status: "queued" }),
      });
      declinedOnce({ status: "closed", reason: "not-found" });
      cancelQuestion.mockResolvedValue({ result: "refused", reason: "not-found" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");
      await confirm("Dismiss question");
      await waitFor(() =>
        expect(dialogButton("Withdraw question").hasAttribute("aria-disabled")).toBe(false)
      );
      await confirm("Withdraw question");
      expect(screen.getByRole("alertdialog").textContent).toContain(
        "q-42 is no longer one of this terminal's questions."
      );

      // Sent meanwhile: Dismiss again, free of the withdrawal's refusal.
      act(() => paneListeners[0]!(paneState({ revision: 2 })));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Dismiss question q-42?");
      expect(dialog.textContent).not.toContain("no longer one of this terminal's questions");
      expect(dialogButton("Dismiss question").hasAttribute("aria-disabled")).toBe(false);
    });

    it("offers withdrawing when this computer doesn't sign for the person, as on a Remote Host", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declineQuestion.mockResolvedValueOnce({ result: "refused", reason: "not-owner" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Withdraw question q-42?");
      expect(dialog.textContent).toContain("This computer doesn't sign for you");
    });

    it("shows a dismissal from the question view as dismissing too, and waiting again once it can't be taken", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      render(<TerminalDecisionsChip terminalId="t1" />);
      const chip = await screen.findByTestId("terminal-decisions-chip");
      const key = answerKey(q42Content().reference);
      const queued = (outcome: Extract<DeclinePhase, { kind: "settled" }>["outcome"]) =>
        act(() =>
          useDecisionsAnswerStore.getState().update(key, (record) => ({
            ...record,
            decline: {
              declineId: "0190f0aa-1111-4222-8333-44445555dddd",
              payload: {
                reference: q42Content().reference,
                declineId: "0190f0aa-1111-4222-8333-44445555dddd",
                expectedRevision: 3,
              },
              phase: { kind: "settled", outcome },
              resubmitted: false,
            },
          }))
        );

      queued({ status: "queued" });
      expect(chip.textContent).toContain("q-42 dismissing");
      // Another pane's chip isn't told about it.
      expect(dismissingQuestionIds(useDecisionsAnswerStore.getState().records, "t2")).toBe("");

      queued({ status: "unsupported", by: "relay" });
      expect(chip.textContent).not.toContain("dismissing");
      fireEvent.click(chip);
      await screen.findAllByTestId("terminal-decisions-row");
      expect(screen.getAllByTestId("terminal-decisions-dismiss")).toHaveLength(1);
    });

    it("keeps a withdrawal's refusal in the dialog, naming the question, with only a way out", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declinedOnce({ status: "unsupported", by: "relay" });
      cancelQuestion.mockResolvedValue({ result: "refused", reason: "answered" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");
      await confirm("Dismiss question");
      await waitFor(() =>
        expect(dialogButton("Withdraw question").hasAttribute("aria-disabled")).toBe(false)
      );

      await confirm("Withdraw question");

      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("q-42 has been answered, so it can't be withdrawn.");
      expect(dialogButton("Withdraw question").getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(dialogButton("Close"));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });

    it("keeps a refusal in the dialog, naming the question, with only a way out", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declinedOnce({ status: "already-answered" });
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");

      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("q-42 was answered first, so it wasn't dismissed.");
      expect(dialogButton("Dismiss question").getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(dialogButton("Close"));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });

    it("sends a decline whose reply was lost again under the same id, never a second decline", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declineQuestion.mockRejectedValueOnce(new Error("The link to main dropped"));
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");

      expect(getDeclineResult).toHaveBeenCalledOnce();
      expect(declineQuestion).toHaveBeenCalledTimes(2);
      const [first, second] = declineQuestion.mock.calls.map(([payload]) => payload);
      expect(second).toEqual(first);
      expect(getDeclineResult).toHaveBeenCalledWith({ declineId: first!.declineId });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });

    it("lets a dismissal whose standing couldn't be confirmed be checked again, by its id", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      declineQuestion.mockRejectedValue(new Error("The link to main dropped"));
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      await confirm("Dismiss question");
      expect(screen.getByRole("alertdialog").textContent).toContain(
        "Couldn't confirm whether q-42 was dismissed."
      );
      expect(dialogButton("Dismiss question").hasAttribute("aria-disabled")).toBe(false);
      const declineId = declineQuestion.mock.calls[0]![0].declineId;

      getDeclineResult.mockResolvedValueOnce({
        result: "read",
        questionId: "q42",
        expectedRevision: 3,
        outcome: { status: "declined" },
      });
      await confirm("Dismiss question");
      expect(getDeclineResult).toHaveBeenLastCalledWith({ declineId });
      expect(declineQuestion).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByTestId("terminal-decisions-chip").textContent).toContain(
        "q-42 dismissing"
      );
    });

    it("gives a failed call's retry way to an answer that arrived meanwhile, leaving only Close", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getQuestionContent.mockRejectedValueOnce(new Error("The link to the host dropped"));
      const another = {
        questionId: "q43",
        alias: 43,
        status: "open" as const,
        askedAt: "2026-11-02T10:05:00.000Z",
        expiresAt: null,
      };
      getPaneState.mockResolvedValue(
        paneState({ openQuestions: [...paneState().openQuestions, another] })
      );
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");
      await confirm("Dismiss question");
      expect(screen.getByRole("alertdialog").textContent).toContain(
        "q-42 couldn't be read again, so it wasn't dismissed."
      );

      // Answered on a phone while the dialog stayed open; the other question keeps the chip.
      act(() =>
        paneListeners[0]!(
          paneState({
            openQuestions: [another],
            waitingAnswers: [
              { questionId: "q42", alias: 42, kind: "answer", deliveryStatus: "desktop-received" },
            ],
            revision: 2,
          })
        )
      );
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain(
        "q-42 isn't waiting for an answer any more, so there's nothing to dismiss."
      );
      expect(dialog.textContent).not.toContain("couldn't be read again");
      expect(dialogButton("Dismiss question").getAttribute("aria-disabled")).toBe("true");
      expect(dialogButton("Close")).toBeTruthy();
      expect(declineQuestion).not.toHaveBeenCalled();
    });

    it("stays open and locked while main answers, even when the last question goes meanwhile", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      let resolve!: (result: DecisionQuestionDeclineResult) => void;
      declineQuestion.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      act(() => {
        fireEvent.click(dialogButton("Dismiss question"));
      });
      act(() => {
        fireEvent.click(dialogButton("Dismiss question"));
      });
      await waitFor(() => expect(declineQuestion).toHaveBeenCalledOnce());
      // The asking computer can record the decline before main's answer reaches the dialog.
      act(() => paneListeners[0]!(paneState({ openQuestions: [], revision: 2 })));
      expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
      expect(dialogButton("Keep question").getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("alertdialog").textContent).not.toContain("isn't waiting");
      fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
      expect(screen.getByRole("alertdialog")).toBeTruthy();

      await act(async () => {
        resolve({
          result: "submitted",
          declineId: declineQuestion.mock.calls[0]![0].declineId,
          outcome: { status: "declined" },
        });
      });
      expect(declineQuestion).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });

    it("keeps main's reason for a refusal over the question having stopped waiting", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      let resolve!: (result: DecisionQuestionDeclineResult) => void;
      declineQuestion.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      render(<TerminalDecisionsChip terminalId="t1" />);
      await askToDismiss();
      await screen.findByRole("alertdialog");

      act(() => {
        fireEvent.click(dialogButton("Dismiss question"));
      });
      await waitFor(() => expect(declineQuestion).toHaveBeenCalledOnce());
      // Answered on a phone: the pane drops it before main's refusal arrives.
      act(() => paneListeners[0]!(paneState({ openQuestions: [], revision: 2 })));
      await act(async () => {
        resolve({
          result: "submitted",
          declineId: declineQuestion.mock.calls[0]![0].declineId,
          outcome: { status: "already-answered" },
        });
      });

      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("q-42 was answered first, so it wasn't dismissed.");
      expect(dialog.textContent).not.toContain("isn't waiting");
      expect(dialogButton("Close")).toBeTruthy();
    });

    it("reads the opening line itself when the row hadn't yet, confirming only once it has", async () => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      let answerRow!: (result: DecisionQuestionSummariesResult) => void;
      getQuestionSummaries.mockImplementationOnce(() => new Promise(() => {}));
      getQuestionSummaries.mockImplementationOnce(
        () =>
          new Promise((done) => {
            answerRow = done;
          })
      );
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss question q-42…" }));
      await screen.findByRole("alertdialog");

      expect(getQuestionSummaries).toHaveBeenLastCalledWith({
        terminalId: "t1",
        questionIds: ["q42"],
      });
      expect(dialogButton("Dismiss question").getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        answerRow({
          result: "read",
          summaries: [{ questionId: "q42", result: "read", line: "Merge the release branch?" }],
        });
      });
      expect(screen.getByRole("alertdialog").textContent).toContain("Merge the release branch?");
      expect(dialogButton("Dismiss question").hasAttribute("aria-disabled")).toBe(false);
    });
  });
});

describe("TerminalDecisionsChip, as its questions step down (#18053)", () => {
  const START = Date.parse("2026-11-20T14:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    getStatus.mockResolvedValue({ state: "connected", revision: 1 });
  });

  afterEach(() => {
    // Unmounted under the clock that armed its timers.
    cleanup();
    vi.useRealTimers();
  });

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  function chip(): HTMLElement {
    return screen.getByTestId("terminal-decisions-chip");
  }

  function question(
    alias: number,
    expiresAt: string | null = null
  ): PaneDecisionState["openQuestions"][number] {
    return {
      questionId: `q${alias}`,
      alias,
      status: "open",
      askedAt: new Date(START - 60_000).toISOString(),
      expiresAt,
    };
  }

  function listed(
    alias: number,
    inbox: DecisionQuestionListItem["inbox"]
  ): DecisionQuestionListItem {
    const questionId = `q${alias}`;
    return {
      reference: { hostId: "host_studio", projectId: "project-1", terminalId: "t1", questionId },
      alias,
      agentKind: "claude",
      projectLabel: "Project",
      worktreeId: "wt",
      worktreeRoot: "/repo",
      requirement: "human-required",
      askedAt: "2026-11-20T13:00:00.000Z",
      expiresAt: null,
      settledAt: null,
      standing: { kind: "waiting", reason: "open" },
      replyRequest: null,
      stall: null,
      inbox,
    };
  }

  const CLEARED = { ask: null, seen: true, cleared: true };
  const SEEN = { ask: null, seen: true, cleared: false };
  const UNSEEN = { ask: null, seen: false, cleared: false };

  function pushList(list: DecisionQuestionList): void {
    act(() => {
      for (const listener of listListeners) listener(list);
    });
  }

  it("steps down as a question's deadline passes, with the popover never opened", async () => {
    getPaneState.mockResolvedValue(
      paneState({ openQuestions: [question(42, new Date(START + 60_000).toISOString())] })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().getAttribute("aria-label")).toContain("waiting for an answer");
    expect(chip().textContent).toBe("q-42");

    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(chip().textContent).toBe("q-42");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(chip().textContent).toBe("q-42 awaiting update");
    expect(chip().getAttribute("aria-label")).toBe(
      "Question q-42's deadline passed, awaiting an update"
    );
    // Nothing it says turns on a draft any more.
    expect(typeInAComposer([["other", "draft"]]).reads).toBe(0);
    // Opened, its row says the same, once, and offers no answer.
    fireEvent.click(chip());
    const popover = screen.getByTestId("popover-content");
    expect(popover.textContent).toContain("Deadline passed, awaiting an update");
    expect(screen.queryByTestId("terminal-decisions-deadline")).toBeNull();
    expect(popover.textContent).not.toContain("Open a question to answer it here");
  });

  it("reads the clock afresh as the popover opens, so the chip and its row agree on a deadline passed while closed", async () => {
    getPaneState.mockResolvedValue(
      paneState({ openQuestions: [question(42, new Date(START + 60_000).toISOString())] })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    fireEvent.click(chip());
    expect(screen.getByTestId("terminal-decisions-deadline").textContent).toMatch(/^Reply by /);
    fireEvent.click(chip());
    expect(screen.queryByTestId("popover-content")).toBeNull();

    // The wall clock moves past the deadline without any timer having fired.
    vi.setSystemTime(START + 120_000);
    fireEvent.click(chip());
    expect(chip().textContent).toBe("q-42 awaiting update");
    expect(screen.getByTestId("popover-content").textContent).toContain(
      "Deadline passed, awaiting an update"
    );
  });

  it("reads no drafts for a pane whose only question is past its deadline", async () => {
    getPaneState.mockResolvedValue(
      paneState({ openQuestions: [question(42, new Date(START - 1).toISOString())] })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().textContent).toBe("q-42 awaiting update");
    expect(typeInAComposer([["other", "draft"]]).reads).toBe(0);
  });

  it("steps a question the person cleared out of the count, listing it quieter, still answerable", async () => {
    getPaneState.mockResolvedValue(paneState({ openQuestions: [question(42), question(43)] }));
    // Seen, so clearing it moves no count: the chip has to be told on its own.
    listQuestions.mockResolvedValue({
      revision: 1,
      questions: [listed(42, SEEN), listed(43, UNSEEN)],
    });
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().textContent).toBe("2 questions");
    expect(listQuestions).toHaveBeenCalledTimes(1);
    fireEvent.click(chip());
    await settle();
    expect(getQuestionSummaries).toHaveBeenCalledTimes(1);

    pushList({ revision: 2, questions: [listed(42, CLEARED), listed(43, UNSEEN)] });
    expect(chip().textContent).toBe("q-43");
    expect(chip().getAttribute("aria-label")).toMatch(/1\u00a0cleared on this computer$/);
    const rows = screen.getAllByTestId("terminal-decisions-row");
    expect(rows.map((row) => row.getAttribute("data-question-id"))).toEqual(["q43", "q42"]);
    expect(rows[1]!.textContent).toContain("Cleared on this computer");
    // Moving down the list reads no line again, and loses none.
    expect(getQuestionSummaries).toHaveBeenCalledTimes(1);
    expect(rows[1]!.textContent).toContain("Opening line of q42");
    // A step quieter than the row still waiting.
    const ink = (row: HTMLElement) => row.querySelector("span")!.className;
    expect(ink(rows[1]!)).toContain("text-text-secondary");
    expect(ink(rows[0]!)).toContain("text-text-primary");

    // Dismissing it says nothing of taking it out of Needs you, where it no longer is.
    expect(screen.getAllByRole("button", { name: /^Dismiss question/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question q-42…" }));
    expect(screen.getByRole("alertdialog").textContent).not.toContain("Needs you");
  });

  it("opens a cleared question to answer it", async () => {
    getPaneState.mockResolvedValue(paneState({ openQuestions: [question(42)] }));
    listQuestions.mockResolvedValue({ revision: 1, questions: [listed(42, CLEARED)] });
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().textContent).toBe("q-42 cleared");
    fireEvent.click(chip());
    expect(screen.getByTestId("popover-content").textContent).toContain(
      "Open a question to answer it here"
    );
    fireEvent.click(screen.getByTestId("terminal-decisions-row"));
    expect(useDecisionsQuestionViewStore.getState()).toMatchObject({
      isOpen: true,
      request: { questions: [{ scope: "pane", terminalId: "t1", questionId: "q42" }], index: 0 },
    });
  });

  it("shows a clear the view's list already held as the pane's state arrives, reading the list once", async () => {
    function Toolbar() {
      useDecisionsWaitingCount(true);
      return null;
    }
    let answerPane!: (state: PaneDecisionState) => void;
    getPaneState.mockImplementation(
      () =>
        new Promise((done) => {
          answerPane = done;
        })
    );
    listQuestions.mockResolvedValue({ revision: 1, questions: [listed(42, CLEARED)] });
    render(
      <>
        <Toolbar />
        <TerminalDecisionsChip terminalId="t1" />
      </>
    );
    await settle();
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();

    await act(async () => {
      answerPane(paneState({ openQuestions: [question(42)] }));
    });
    expect(chip().textContent).toBe("q-42 cleared");
    expect(listQuestions).toHaveBeenCalledTimes(1);
  });

  it("reads no question list for a pane with nothing still out", async () => {
    getPaneState.mockResolvedValue(
      paneState({
        openQuestions: [],
        waitingAnswers: [
          { questionId: "q41", alias: 41, kind: "answer", deliveryStatus: "desktop-received" },
        ],
      })
    );
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().textContent).toMatch(/^q-41 /);
    expect(listQuestions).not.toHaveBeenCalled();
    expect(listListeners).toHaveLength(0);
  });

  it("names several questions as questions, never a bare number", async () => {
    getPaneState.mockResolvedValue(paneState({ openQuestions: [question(42), question(43)] }));
    render(<TerminalDecisionsChip terminalId="t1" />);
    await settle();
    expect(chip().textContent).toBe("2 questions");
  });
});
