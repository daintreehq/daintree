// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalHeaderContent } from "../TerminalHeaderContent";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

const { MockIcon } = vi.hoisted(() => {
  const MockIcon = ({ className }: { className?: string }) => (
    <svg data-testid="state-icon" className={className} />
  );
  return { MockIcon };
});

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  STATE_ICONS: {
    working: MockIcon,
    running: MockIcon,
    waiting: MockIcon,
    directing: MockIcon,
    error: MockIcon,
  },
  STATE_COLORS: {
    working: "text-working",
    running: "text-running",
    waiting: "text-waiting",
    directing: "text-directing",
    error: "text-error",
  },
}));

let mockStoreState: Record<string, unknown> = {
  terminals: [],
};

vi.mock("@/store", () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}));

afterEach(() => {
  vi.useRealTimers();
  mockStoreState = { terminals: [] };
});

describe("TerminalHeaderContent", () => {
  it("shows elapsed time in tooltip when startedAt is present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T14:30:00Z"));

    mockStoreState = {
      terminals: [
        {
          id: "t1",
          isInputLocked: false,
          startedAt: new Date("2024-01-15T12:16:00Z").getTime(),
        },
      ],
    };

    render(
      <TerminalHeaderContent
        id="t1"
        kind="agent"
        agentState="working"
        activity={{ headline: "Installing deps", status: "working", type: "background" }}
      />
    );

    const tooltipContent = screen.getByTestId("tooltip-content");
    expect(tooltipContent.textContent).toContain("Installing deps");
    expect(tooltipContent.textContent).toContain("·");
    expect(tooltipContent.textContent).toContain("2h 14m");
  });

  it("omits elapsed time when startedAt is undefined", () => {
    mockStoreState = {
      terminals: [{ id: "t1", isInputLocked: false }],
    };

    render(
      <TerminalHeaderContent
        id="t1"
        kind="agent"
        agentState="working"
        activity={{ headline: "Building project", status: "working", type: "background" }}
      />
    );

    const tooltipContent = screen.getByTestId("tooltip-content");
    expect(tooltipContent.textContent).toBe("Building project");
    expect(tooltipContent.textContent).not.toContain("·");
  });

  it("renders no chip for idle state", () => {
    mockStoreState = {
      terminals: [{ id: "t1", isInputLocked: false, startedAt: Date.now() }],
    };

    render(<TerminalHeaderContent id="t1" kind="agent" agentState="idle" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("renders no chip for completed state", () => {
    mockStoreState = {
      terminals: [{ id: "t1", isInputLocked: false, startedAt: Date.now() }],
    };

    render(<TerminalHeaderContent id="t1" kind="agent" agentState="completed" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("updates elapsed time after timer interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:05:00Z"));

    const startedAt = new Date("2024-01-15T12:00:00Z").getTime();
    mockStoreState = {
      terminals: [{ id: "t1", isInputLocked: false, startedAt }],
    };

    render(<TerminalHeaderContent id="t1" kind="agent" agentState="working" />);

    const tooltipContent = screen.getByTestId("tooltip-content");
    expect(tooltipContent.textContent).toContain("5m");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(tooltipContent.textContent).toContain("5m");
  });

  it("falls back to agent state text when no activity headline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:01:00Z"));

    mockStoreState = {
      terminals: [
        {
          id: "t1",
          isInputLocked: false,
          startedAt: new Date("2024-01-15T12:00:00Z").getTime(),
        },
      ],
    };

    render(<TerminalHeaderContent id="t1" kind="agent" agentState="working" />);

    const tooltipContent = screen.getByTestId("tooltip-content");
    expect(tooltipContent.textContent).toContain("Agent working");
    expect(tooltipContent.textContent).toContain("· 1m");
  });
});
