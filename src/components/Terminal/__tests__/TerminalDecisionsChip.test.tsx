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

// The real popover lazy-loads Radix and renders nothing until primed.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TerminalDecisionsChip } from "../TerminalDecisionsChip";

let statusListeners: Array<(status: DecisionsStatus) => void> = [];
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const getPaneState = vi.fn<(id: string) => Promise<PaneDecisionState | null>>();
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
    decisions: { getStatus, getPaneState },
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
});
