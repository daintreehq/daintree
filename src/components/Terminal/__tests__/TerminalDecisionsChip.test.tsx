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
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import type { DecisionQuestionSummariesResult } from "@shared/types/decisionsQuestion";

let statusListeners: Array<(status: DecisionsStatus) => void> = [];
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const getPaneState = vi.fn<(id: string) => Promise<PaneDecisionState | null>>();
const getQuestionSummaries =
  vi.fn<
    (payload: {
      terminalId: string;
      questionIds: string[];
    }) => Promise<DecisionQuestionSummariesResult>
  >();
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

beforeEach(() => {
  statusListeners = [];
  paneListeners = [];
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
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  onDecisionState.mockClear();
  Reflect.set(window, "electron", {
    events: {
      on: (name: string, callback: (status: DecisionsStatus) => void) => {
        if (name !== "decisions:status-changed") return () => {};
        statusListeners.push(callback);
        return () => {
          statusListeners = statusListeners.filter((listener) => listener !== callback);
        };
      },
    },
    decisions: { getStatus, getPaneState, getQuestionSummaries },
    terminal: { onDecisionState },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("TerminalDecisionsChip", () => {
  it("with Decisions off, reads and watches no pane and shows nothing", async () => {
    render(<TerminalDecisionsChip terminalId="t1" />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await act(async () => {});

    expect(getPaneState).not.toHaveBeenCalled();
    expect(onDecisionState).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-decisions-chip")).toBeNull();
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

    it.each([
      [
        "a line-less summary",
        { result: "read", summaries: [{ questionId: "q42", result: "read", line: null }] },
      ],
      ["Decisions not running", { result: "not-running" }],
      ["Decisions off", { result: "off" }],
    ] as const)("keeps rows openable by alias with %s", async (_name, result) => {
      getStatus.mockResolvedValue({ state: "connected", revision: 1 });
      getQuestionSummaries.mockResolvedValue(result as DecisionQuestionSummariesResult);
      render(<TerminalDecisionsChip terminalId="t1" />);
      fireEvent.click(await screen.findByTestId("terminal-decisions-chip"));
      const row = await screen.findByTestId("terminal-decisions-row");
      await act(async () => {});
      expect(screen.queryByTestId("terminal-decisions-row-line")).toBeNull();
      fireEvent.click(row);
      expect(useDecisionsQuestionViewStore.getState().request?.questionIds).toEqual(["q42"]);
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
        request: { terminalId: "t1", questionIds: ["q42", "q43"], index: 1 },
      });
      expect(screen.queryByTestId("popover-content")).toBeNull();
    });
  });
});
