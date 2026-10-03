// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNotifyState } from "@shared/types/terminalNotify";

const onNotifyState = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({
  terminalClient: { onNotifyState },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The real popover lazy-loads Radix and renders nothing until primed. Trigger
// and content render inline so the copy and the stop control are reachable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { TerminalNotifyChip } from "../TerminalNotifyChip";
import { HEADER_CHIP_CLASS } from "../terminalHeaderChip";
import { FOOTER_ITEM_CLASS } from "@/components/HelpPanel/footerItem";

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
      "1 notice waiting to be delivered; Daintree may type a notice into this pane"
    );
  });

  it("stops every notice the pane has pending", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    render(<TerminalNotifyChip terminalId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));

    await waitFor(() => expect(stopPaneNotices).toHaveBeenCalledWith("t1"));
  });

  it("says so when stopping fails, and the retry works", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    stopPaneNotices.mockRejectedValueOnce(new Error("boom"));
    render(<TerminalNotifyChip terminalId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still on/);

    const retry = await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(stopPaneNotices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("never carries a failed stop over to another pane", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    stopPaneNotices.mockRejectedValueOnce(new Error("boom"));
    const { rerender } = render(<TerminalNotifyChip terminalId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));
    await screen.findByRole("alert");

    getPaneNotifyState.mockResolvedValue(paneState({ terminalId: "t2" }));
    rerender(<TerminalNotifyChip terminalId="t2" />);
    await screen.findByTestId("terminal-notify-chip");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop notices" })).toBeTruthy();
  });

  it("ignores a stop that settles after the chip moved to another pane", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    let reject: (err: Error) => void = () => {};
    stopPaneNotices.mockReturnValueOnce(
      new Promise<void>((_resolve, rej) => {
        reject = rej;
      })
    );
    const { rerender } = render(<TerminalNotifyChip terminalId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));

    getPaneNotifyState.mockResolvedValue(paneState({ terminalId: "t2" }));
    rerender(<TerminalNotifyChip terminalId="t2" />);
    await screen.findByTestId("terminal-notify-chip");
    const stopT2 = screen.getByRole("button", { name: "Stop notices" }) as HTMLButtonElement;
    expect(stopT2.disabled).toBe(false);

    await act(async () => reject(new Error("late")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts the next batch of notices without the last batch's failure", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    stopPaneNotices.mockRejectedValueOnce(new Error("boom"));
    render(<TerminalNotifyChip terminalId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop notices" }));
    await screen.findByRole("alert");

    act(() => push?.(paneState({ pendingCount: 0, readyCount: 0, revision: 2 })));
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
    act(() => push?.(paneState({ pendingCount: 1, revision: 3 })));
    await screen.findByTestId("terminal-notify-chip");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps everything it shows inside its accessible name, in both hosts", async () => {
    const states = [
      paneState({ pendingCount: 1 }),
      paneState({ pendingCount: 12 }),
      paneState({ pendingCount: 1204 }),
      paneState({ pendingCount: 0, readyCount: 1204 }),
      paneState({ pendingCount: 0, readyCount: 1 }),
      paneState({ pendingCount: 0, readyCount: 3 }),
    ];
    const hosts = [
      { variant: "header" as const, compact: false },
      { variant: "footer" as const, compact: false },
      { variant: "footer" as const, compact: true },
    ];
    for (const state of states) {
      for (const host of hosts) {
        getPaneNotifyState.mockResolvedValue(state);
        const { unmount } = render(<TerminalNotifyChip terminalId="t1" {...host} />);
        const chip = await screen.findByTestId("terminal-notify-chip");
        const shown = (chip.textContent ?? "").trim();
        expect(shown.length).toBeGreaterThan(0);
        expect(chip.getAttribute("aria-label")).toContain(shown);
        unmount();
      }
    }
  });

  it("says what it counts in the footer until the row compacts it to the count", async () => {
    getPaneNotifyState.mockResolvedValue(paneState({ pendingCount: 2 }));
    const { unmount } = render(<TerminalNotifyChip terminalId="t1" variant="footer" />);
    const roomy = (await screen.findByTestId("terminal-notify-chip")).textContent ?? "";
    unmount();
    render(<TerminalNotifyChip terminalId="t1" variant="footer" compact />);
    const compact = (await screen.findByTestId("terminal-notify-chip")).textContent ?? "";
    expect(compact).toContain("2");
    expect(roomy).toMatch(/\bterminals?\b/);
    expect(compact).not.toMatch(/terminal/);
    expect(roomy).toContain(compact);
  });

  it("wears the footer's own item family in the footer, not the header's pill", async () => {
    getPaneNotifyState.mockResolvedValue(paneState());
    const { unmount } = render(<TerminalNotifyChip terminalId="t1" variant="footer" />);
    const footerClasses = new Set(
      (await screen.findByTestId("terminal-notify-chip")).className.split(/\s+/)
    );
    unmount();
    render(<TerminalNotifyChip terminalId="t1" />);
    const headerClasses = new Set(
      (await screen.findByTestId("terminal-notify-chip")).className.split(/\s+/)
    );
    // The family contract: the footer's target height, shape and focus ring.
    const family = FOOTER_ITEM_CLASS.split(/\s+/).filter((token) =>
      /^(h-|rounded|focus-visible:)/.test(token)
    );
    expect(family.length).toBeGreaterThan(0);
    for (const token of family) expect(footerClasses.has(token)).toBe(true);
    for (const token of HEADER_CHIP_CLASS.split(/\s+/)) expect(headerClasses.has(token)).toBe(true);
    // No boxed pill among the footer's flat items.
    expect(footerClasses.has("border")).toBe(false);
    expect(footerClasses.has("rounded-full")).toBe(false);
  });

  it("marks the footer item open whatever its tone", async () => {
    for (const delivery of [
      { status: "idle" } as const,
      { status: "blocked", reason: "approval" } as const,
    ]) {
      getPaneNotifyState.mockResolvedValue(paneState({ delivery }));
      const { unmount } = render(<TerminalNotifyChip terminalId="t1" variant="footer" />);
      const chip = await screen.findByTestId("terminal-notify-chip");
      expect(chip.className.split(/\s+/).some((c) => c.startsWith("aria-expanded:bg-"))).toBe(true);
      unmount();
    }
  });

  it("stays hidden instead of breaking the header when the bridge is missing", async () => {
    Reflect.deleteProperty(window, "electron");
    expect(() => render(<TerminalNotifyChip terminalId="t1" />)).not.toThrow();
    expect(screen.queryByTestId("terminal-notify-chip")).toBeNull();
  });
});
