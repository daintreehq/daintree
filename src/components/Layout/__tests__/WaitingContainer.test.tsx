// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { WaitingContainer } from "../WaitingContainer";
import type { TerminalInstance } from "@/store/terminalStore";

const mockWaiting: TerminalInstance[] = [
  {
    id: "t1",
    title: "Agent 1",
    type: "claude",
    kind: "terminal",
    worktreeId: "w1",
    location: "grid",
  } as TerminalInstance,
];

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useWaitingTerminals: () => mockWaiting,
}));

vi.mock("@/store/terminalStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    activateTerminal: vi.fn(),
    pingTerminal: vi.fn(),
  }));
  return { useTerminalStore: store };
});

vi.mock("@/store/worktreeStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    activeWorktreeId: null,
    selectWorktree: vi.fn(),
    trackTerminalFocus: vi.fn(),
  }));
  return { useWorktreeSelectionStore: store };
});

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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

describe("WaitingContainer icon", () => {
  it("renders HollowCircle (simple circle SVG) not AlertCircle", () => {
    const { container } = render(<WaitingContainer />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);

    const hasHollowCircle = Array.from(svgs).some((svg) => {
      const circles = svg.querySelectorAll("circle");
      return (
        circles.length === 1 &&
        circles[0].getAttribute("cx") === "8" &&
        circles[0].getAttribute("cy") === "8" &&
        circles[0].getAttribute("r") === "6"
      );
    });
    expect(hasHollowCircle).toBe(true);
  });
});
