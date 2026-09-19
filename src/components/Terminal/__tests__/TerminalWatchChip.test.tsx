// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneWatchState } from "@shared/types/terminalWatch";

const onWatchState = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  terminalClient: { onWatchState },
}));

// The real popover lazy-loads Radix and renders nothing until primed. Trigger
// and content render inline so the copy and the stop control are reachable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TerminalWatchChip } from "../TerminalWatchChip";

function paneState(overrides: Partial<PaneWatchState> = {}): PaneWatchState {
  return {
    terminalId: "t1",
    watchCount: 1,
    watchedTerminalCount: 2,
    pendingEvents: 0,
    delivery: { status: "idle" },
    revision: 1,
    ...overrides,
  };
}

let push: ((state: PaneWatchState) => void) | undefined;
const getPaneWatchState = vi.fn();
const stopPaneWatches = vi.fn();

beforeEach(() => {
  push = undefined;
  onWatchState.mockReset();
  onWatchState.mockImplementation((callback: (state: PaneWatchState) => void) => {
    push = callback;
    return () => {
      push = undefined;
    };
  });
  getPaneWatchState.mockReset();
  stopPaneWatches.mockReset().mockResolvedValue(undefined);
  Reflect.set(window, "electron", { mcpServer: { getPaneWatchState, stopPaneWatches } });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("TerminalWatchChip (#12491)", () => {
  it("shows nothing for a pane that holds no watches", async () => {
    getPaneWatchState.mockResolvedValue(null);
    render(<TerminalWatchChip terminalId="t1" />);
    await waitFor(() => expect(getPaneWatchState).toHaveBeenCalledWith("t1"));
    expect(screen.queryByTestId("terminal-watch-chip")).toBeNull();
  });

  it("appears once main reports watches, and disappears when they end", async () => {
    getPaneWatchState.mockResolvedValue(paneState());
    render(<TerminalWatchChip terminalId="t1" />);

    const chip = await screen.findByTestId("terminal-watch-chip");
    expect(chip.getAttribute("aria-label")).toBe("Watching 2 terminals; this pane may be woken");

    act(() => push?.(paneState({ watchCount: 0, watchedTerminalCount: 0, revision: 2 })));
    expect(screen.queryByTestId("terminal-watch-chip")).toBeNull();
  });

  it("ignores another pane's pushes", async () => {
    getPaneWatchState.mockResolvedValue(null);
    render(<TerminalWatchChip terminalId="t1" />);
    await waitFor(() => expect(push).toBeDefined());

    act(() => push?.(paneState({ terminalId: "t2" })));
    expect(screen.queryByTestId("terminal-watch-chip")).toBeNull();
  });

  it("never lets a late snapshot roll back a newer push", async () => {
    let resolveSnapshot: (state: PaneWatchState) => void = () => {};
    getPaneWatchState.mockReturnValue(
      new Promise<PaneWatchState>((resolve) => {
        resolveSnapshot = resolve;
      })
    );
    render(<TerminalWatchChip terminalId="t1" />);
    await waitFor(() => expect(push).toBeDefined());

    act(() => push?.(paneState({ watchCount: 0, revision: 5 })));
    await act(async () => resolveSnapshot(paneState({ revision: 3 })));

    expect(screen.queryByTestId("terminal-watch-chip")).toBeNull();
  });

  it("says when a wake is blocked at an approval", async () => {
    getPaneWatchState.mockResolvedValue(
      paneState({ delivery: { status: "blocked", reason: "approval" } })
    );
    render(<TerminalWatchChip terminalId="t1" />);

    expect(await screen.findByText("Not sent: this pane is waiting on an approval.")).toBeTruthy();
  });

  it("stops every watch the pane holds", async () => {
    getPaneWatchState.mockResolvedValue(paneState());
    render(<TerminalWatchChip terminalId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop watching" }));

    await waitFor(() => expect(stopPaneWatches).toHaveBeenCalledWith("t1"));
  });

  it("stays hidden instead of breaking the header when the bridge is missing", async () => {
    Reflect.deleteProperty(window, "electron");
    expect(() => render(<TerminalWatchChip terminalId="t1" />)).not.toThrow();
    expect(screen.queryByTestId("terminal-watch-chip")).toBeNull();
  });
});
