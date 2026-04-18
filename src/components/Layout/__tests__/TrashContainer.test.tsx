// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { TrashContainer } from "../TrashContainer";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal } from "@/store/slices";

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktreeMap: new Map() }),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function makeTrashedItem(id: string): {
  terminal: TerminalInstance;
  trashedInfo: TrashedTerminal;
} {
  return {
    terminal: { id, title: `Terminal ${id}` } as TerminalInstance,
    trashedInfo: {
      id,
      expiresAt: Date.now() + 10_000,
      originalLocation: "grid",
    },
  };
}

describe("TrashContainer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when trashedTerminals is empty", () => {
    const { container } = render(<TrashContainer trashedTerminals={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("does not pulse on initial mount", () => {
    const { container } = render(<TrashContainer trashedTerminals={[makeTrashedItem("1")]} />);
    expect(container.querySelector(".animate-trash-pulse")).toBeNull();
  });

  it("applies pulse class when trashedTerminals.length increases", () => {
    const items = [makeTrashedItem("1")];
    const { container, rerender } = render(<TrashContainer trashedTerminals={items} />);

    const newItems = [...items, makeTrashedItem("2")];
    rerender(<TrashContainer trashedTerminals={newItems} />);

    expect(container.querySelector(".animate-trash-pulse")).not.toBeNull();
  });

  it("removes pulse class after timeout", () => {
    const items = [makeTrashedItem("1")];
    const { container, rerender } = render(<TrashContainer trashedTerminals={items} />);

    rerender(<TrashContainer trashedTerminals={[...items, makeTrashedItem("2")]} />);
    expect(container.querySelector(".animate-trash-pulse")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".animate-trash-pulse")).toBeNull();
  });

  it("does not pulse when trashedTerminals.length decreases", () => {
    const items = [makeTrashedItem("1"), makeTrashedItem("2")];
    const { container, rerender } = render(<TrashContainer trashedTerminals={items} />);

    rerender(<TrashContainer trashedTerminals={[items[0]!]} />);
    expect(container.querySelector(".animate-trash-pulse")).toBeNull();
  });

  it("announces panel closed with correct shortcut on increase", () => {
    const items = [makeTrashedItem("1")];
    const { rerender } = render(<TrashContainer trashedTerminals={items} />);

    rerender(<TrashContainer trashedTerminals={[...items, makeTrashedItem("2")]} />);

    const { polite } = useAnnouncerStore.getState();
    expect(polite).not.toBeNull();
    expect(polite!.msg).toMatch(/Panel closed/);
    expect(polite!.msg).toMatch(/Shift\+T/);
  });

  it("does not announce when trashedTerminals.length decreases", () => {
    const items = [makeTrashedItem("1"), makeTrashedItem("2")];
    const { rerender } = render(<TrashContainer trashedTerminals={items} />);

    useAnnouncerStore.setState({ polite: null });
    rerender(<TrashContainer trashedTerminals={[items[0]!]} />);

    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("clears pulse when count decreases while pulsing", () => {
    const items = [makeTrashedItem("1")];
    const { container, rerender } = render(<TrashContainer trashedTerminals={items} />);

    // Trigger pulse
    rerender(<TrashContainer trashedTerminals={[...items, makeTrashedItem("2")]} />);
    expect(container.querySelector(".animate-trash-pulse")).not.toBeNull();

    // Restore a panel (count decreases) before timeout
    rerender(<TrashContainer trashedTerminals={[items[0]!]} />);
    expect(container.querySelector(".animate-trash-pulse")).toBeNull();
  });

  it("restarts pulse on rapid successive increases", () => {
    const items = [makeTrashedItem("1")];
    const { container, rerender } = render(<TrashContainer trashedTerminals={items} />);

    // First increase
    rerender(<TrashContainer trashedTerminals={[...items, makeTrashedItem("2")]} />);
    expect(container.querySelector(".animate-trash-pulse")).not.toBeNull();

    // Second increase before timeout — should still be pulsing
    rerender(
      <TrashContainer trashedTerminals={[...items, makeTrashedItem("2"), makeTrashedItem("3")]} />
    );
    expect(container.querySelector(".animate-trash-pulse")).not.toBeNull();

    // Timer from second increase should clear the pulse
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".animate-trash-pulse")).toBeNull();
  });
});
