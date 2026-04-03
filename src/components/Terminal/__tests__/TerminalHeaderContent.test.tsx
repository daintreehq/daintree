// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalHeaderContent } from "../TerminalHeaderContent";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

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

vi.mock("@/components/Worktree/terminalStateConfig", () => {
  const mockIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="state-icon" {...props} />
  );
  const STATE_ICONS: Record<string, typeof mockIcon> = {
    working: mockIcon,
    waiting: mockIcon,
    running: mockIcon,
    directing: mockIcon,
    idle: mockIcon,
    completed: mockIcon,
  };
  const STATE_COLORS: Record<string, string> = {
    working: "text-working",
    waiting: "text-waiting",
    running: "text-running",
    directing: "text-directing",
    idle: "text-idle",
    completed: "text-completed",
  };
  const STATE_LABELS: Record<string, string> = {
    working: "working",
    waiting: "waiting",
    running: "running",
    directing: "directing",
    idle: "idle",
    completed: "done",
  };
  return {
    STATE_ICONS,
    STATE_COLORS,
    STATE_LABELS,
    getEffectiveStateIcon: (state: string) => STATE_ICONS[state] ?? mockIcon,
    getEffectiveStateColor: (state: string) => STATE_COLORS[state] ?? "text-unknown",
    getEffectiveStateLabel: (state: string) => STATE_LABELS[state] ?? state,
  };
});

vi.mock("@/store/errorStore", () => ({
  useErrorStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ errors: [] }),
}));

let mockTerminal: Record<string, unknown> = {};

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("@/store", () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      terminalsById: { [mockTerminal.id as string]: mockTerminal },
      terminalIds: [mockTerminal.id],
    }),
}));

beforeEach(() => {
  mockTerminal = { id: "t1" };
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalHeaderContent — agent state chip tooltip", () => {
  it("shows headline, state, trigger, confidence, and relative time", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "output",
      stateChangeConfidence: 0.85,
      lastStateChange: new Date("2026-03-19T11:59:30Z").getTime(),
    };

    render(
      <TerminalHeaderContent
        id="t1"
        agentState="working"
        activity={{ headline: "Installing deps", status: "working", type: "background" }}
      />
    );

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Installing deps"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("State: working");
    expect(agentTooltip!.textContent).toContain("Output");
    expect(agentTooltip!.textContent).toContain("(85%)");
    expect(agentTooltip!.textContent).toContain("Since:");
  });

  it("shows AI classification trigger label", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "ai-classification",
      stateChangeConfidence: 0.95,
    };

    render(<TerminalHeaderContent id="t1" agentState="waiting" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent waiting"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("AI classification");
    expect(agentTooltip!.textContent).toContain("(95%)");
  });

  it("shows exit code when exited", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" isExited={true} exitCode={1} />);

    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("[exit 1]");
  });

  it("omits missing fields gracefully", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    const text = agentTooltip!.textContent!;
    expect(text).toContain("State: working");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("·");
    expect(text).not.toContain("Since:");
    expect(text).not.toContain("Exit code:");
    expect(text).not.toContain("%");
  });

  it("hides confidence when exactly 1.0", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "output",
      stateChangeConfidence: 1.0,
    };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).not.toContain("%");
  });

  it("shows elapsed time when startedAt is present", () => {
    mockTerminal = {
      id: "t1",
      isInputLocked: false,
      startedAt: new Date("2026-03-19T09:46:00Z").getTime(),
    };

    render(
      <TerminalHeaderContent
        id="t1"
        kind="agent"
        agentState="working"
        activity={{ headline: "Installing deps", status: "working", type: "background" }}
      />
    );

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Installing deps"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("·");
    expect(agentTooltip!.textContent).toContain("2h 14m");
  });

  it("omits elapsed time when startedAt is undefined", () => {
    mockTerminal = { id: "t1", isInputLocked: false };

    render(
      <TerminalHeaderContent
        id="t1"
        kind="agent"
        agentState="working"
        activity={{ headline: "Building project", status: "working", type: "background" }}
      />
    );

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Building project"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).not.toContain("· ");
  });

  it("updates elapsed time after timer interval", () => {
    const base = new Date("2026-03-19T11:59:15Z").getTime();

    mockTerminal = {
      id: "t1",
      isInputLocked: false,
      startedAt: base,
    };

    render(<TerminalHeaderContent id="t1" kind="agent" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("45s");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(agentTooltip!.textContent).toContain("1m");
    expect(agentTooltip!.textContent).not.toContain("45s");
  });

  it("renders no chip when idle", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="idle" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("renders no chip when completed", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("falls back to Agent {state} when no headline", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="directing" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent directing"));
    expect(agentTooltip).toBeTruthy();
  });

  it("shows exit code 0 correctly", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" isExited={true} exitCode={0} />);

    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("[exit 0]");
  });

  it("does not show stalled state for working agent past 60 seconds", () => {
    mockTerminal = {
      id: "t1",
      lastStateChange: new Date("2026-03-19T11:58:00Z").getTime(), // 2 minutes ago
    };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    const chip = screen.getByRole("status", { name: /agent state/i });
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("aria-label")).toBe("Agent state: working");

    const icon = chip.querySelector("[data-testid='state-icon']");
    expect(icon).toBeTruthy();
    expect(icon!.getAttribute("class")).toContain("animate-spin-slow");

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("State: working");
    expect(agentTooltip!.textContent).not.toContain("stalled");

    // Advance past 90s to ensure no timer-driven stall detection kicks in
    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    expect(chip.getAttribute("aria-label")).toBe("Agent state: working");
    expect(icon!.getAttribute("class")).toContain("animate-spin-slow");
    expect(agentTooltip!.textContent).toContain("State: working");
    expect(agentTooltip!.textContent).not.toContain("stalled");
  });

  it("shows 0% confidence when stateChangeConfidence is 0", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "heuristic",
      stateChangeConfidence: 0,
    };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("(0%)");
  });
});
