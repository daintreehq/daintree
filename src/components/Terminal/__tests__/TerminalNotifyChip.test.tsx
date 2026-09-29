// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNotifyState } from "@shared/types/terminalNotify";

const onNotifyState = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  terminalClient: { onNotifyState },
}));

// The real popover lazy-loads Radix and renders nothing until primed. Trigger
// and content render inline so the copy and the stop control are reachable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TerminalNotifyChip } from "../TerminalNotifyChip";

function paneState(overrides: Partial<PaneNotifyState> = {}): PaneNotifyState {
  return {
    terminalId: "t1",
    pendingCount: 2,
    readyCount: 0,
    delivery: { status: "idle" },
    revision: 1,
    ...overrides,
  };
}

let push: ((state: PaneNotifyState) => void) | undefined;
const getPaneNotifyState = vi.fn();
const stopPaneNotices = vi.fn();

beforeEach(() => {
  push = undefined;
  onNotifyState.mockReset();
  onNotifyState.mockImplementation((callback: (state: PaneNotifyState) => void) => {
    push = callback;
    return () => {
      push = undefined;
    };
  });
  getPaneNotifyState.mockReset();
  stopPaneNotices.mockReset().mockResolvedValue(undefined);
  Reflect.set(window, "electron", { mcpServer: { getPaneNotifyState, stopPaneNotices } });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("TerminalNotifyChip", () => {
  it("shows nothing for a pane with no notices pending", async () => {
    getPaneNotifyState.mockResolvedValue(null);
    render(<TerminalNotifyChip terminalId="t1" />);
    await waitFor(() => expect(getPaneNotifyState).toHaveBeenCalledWith("t1"));
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });

  it("appears once main reports pending notices, and disappears when they end", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    render(<TerminalNotifyChip terminalId="t1" />);

    const chip = await screen.findByTestId("terminal-notify-chip");
    expect(chip.getAttribute("aria-label")).toBe(
      "Waiting on 2 terminals; Daintree may type a notice into this pane"
    );

    act(() => push?.(paneState({ pendingCount: 0, readyCount: 0, revision: 2 })));
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });

  it("ignores another pane's pushes", async () => {
    getPaneNotifyState.mockResolvedValue(null);
    render(<TerminalNotifyChip terminalId="t1" />);
    await waitFor(() => expect(push).toBeDefined());

    act(() => push?.(paneState({ terminalId: "t2" })));
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });

  it("never lets a late snapshot roll back a newer push", async () => {
    let resolveSnapshot: (state: PaneNotifyState) => void = () => {};
    getPaneNotifyState.mockReturnValue(
      new Promise<PaneNotifyState>((resolve) => {
        resolveSnapshot = resolve;
      })
    );
    render(<TerminalNotifyChip terminalId="t1" />);
    await waitFor(() => expect(push).toBeDefined());

    act(() => push?.(paneState({ pendingCount: 0, revision: 5 })));
    await act(async () => resolveSnapshot(paneState({ revision: 3 })));

    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });

  it("says when a notice is blocked at an approval", async () => {
    getPaneNotifyState.mockResolvedValue(
      paneState({ delivery: { status: "blocked", reason: "approval" } })
    );
    render(<TerminalNotifyChip terminalId="t1" />);

    expect(await screen.findByText("Not sent: this pane is waiting on an approval.")).toBeTruthy();
  });

  it("stays visible while a fired notice waits to be delivered", async () => {
    getPaneNotifyState.mockResolvedValue(paneState({ pendingCount: 0, readyCount: 1 }));
    render(<TerminalNotifyChip terminalId="t1" />);

    const chip = await screen.findByTestId("terminal-notify-chip");
    expect(chip.getAttribute("aria-label")).toBe(
      "A notice is waiting to be delivered; Daintree may type a notice into this pane"
    );
  });

  it("stops every notice the pane has pending", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    render(<TerminalNotifyChip terminalId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));

    await waitFor(() => expect(stopPaneNotices).toHaveBeenCalledWith("t1"));
  });

  it("stays hidden instead of breaking the header when the bridge is missing", async () => {
    Reflect.deleteProperty(window, "electron");
    expect(() => render(<TerminalNotifyChip terminalId="t1" />)).not.toThrow();
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });
});
