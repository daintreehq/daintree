// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ErrorsContainer } from "../ErrorsContainer";
import type { TerminalInstance } from "@/store/panelStore";

const mockErrored: TerminalInstance[] = [
  {
    id: "t1",
    title: "Agent 1",
    type: "claude",
    kind: "terminal",
    worktreeId: "w1",
    location: "grid",
    agentState: "exited",
    exitCode: 1,
  } as TerminalInstance,
];

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useErrorTerminals: () => mockErrored,
}));

vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    activateTerminal: vi.fn(),
    pingTerminal: vi.fn(),
  }));
  return { usePanelStore: store };
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

describe("ErrorsContainer icon", () => {
  it("renders ExitedCircle (circle with horizontal dash) for errored terminals", () => {
    const { container } = render(<ErrorsContainer />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);

    // ExitedCircle has a circle + a single horizontal line (cx=8, cy=8, r=6;
    // line at y=8). Distinguishes it from HollowCircle (circle only) and
    // InteractingCircle (circle + cross).
    const hasExitedCircle = Array.from(svgs).some((svg) => {
      const circles = svg.querySelectorAll("circle");
      const lines = svg.querySelectorAll("line");
      if (circles.length !== 1) return false;
      if (lines.length !== 1) return false;
      const circle = circles[0]!;
      const line = lines[0]!;
      return (
        circle.getAttribute("cx") === "8" &&
        circle.getAttribute("cy") === "8" &&
        circle.getAttribute("r") === "6" &&
        line.getAttribute("y1") === "8" &&
        line.getAttribute("y2") === "8"
      );
    });
    expect(hasExitedCircle).toBe(true);
  });

  it("uses the error-status color tokens on the pill icon", () => {
    const { container } = render(<ErrorsContainer />);
    const errorIcon = container.querySelector("svg.text-status-error");
    expect(errorIcon).not.toBeNull();
  });
});
