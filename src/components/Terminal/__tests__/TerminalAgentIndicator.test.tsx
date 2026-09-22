// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalAgentIndicator } from "../TerminalAgentIndicator";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (!v) return;
      if (typeof v === "string" || typeof v === "number") {
        out.push(String(v));
      } else if (Array.isArray(v)) {
        for (const item of v) walk(item);
      } else if (typeof v === "object" && v !== null) {
        for (const [key, val] of Object.entries(v)) {
          if (val) out.push(key);
        }
      }
    };
    for (const a of args) walk(a);
    return out.join(" ");
  },
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
    directing: mockIcon,
    idle: mockIcon,
    completed: mockIcon,
  };
  const STATE_COLORS: Record<string, string> = {
    working: "text-working",
    waiting: "text-waiting",
    directing: "text-directing",
    idle: "text-idle",
    completed: "text-completed",
  };
  const STATE_LABELS: Record<string, string> = {
    working: "working",
    waiting: "waiting",
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

let mockErrors: Array<{ context?: { terminalId?: string }; dismissed?: boolean }> = [];

vi.mock("@/store/errorStore", () => ({
  useErrorStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ errors: mockErrors }),
}));

let mockTerminal: Record<string, unknown> = {};

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      panelsById: { [String(mockTerminal.id)]: mockTerminal },
      panelIds: [mockTerminal.id],
    }),
}));

beforeEach(() => {
  mockTerminal = { id: "t1" };
  mockErrors = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalAgentIndicator — glyph and tooltip", () => {
  it("shows headline, state, trigger, confidence, and relative time", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "output",
      stateChangeConfidence: 0.85,
      lastStateChange: new Date("2026-03-19T11:59:30Z").getTime(),
    };

    render(
      <TerminalAgentIndicator
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

  it("names the waiting reason in the tooltip state line and chip aria-label when classified", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "heuristic",
      stateChangeConfidence: 1,
      waitingReason: "approval",
    };

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const chip = screen.getByRole("status", { name: "Agent state: waiting (approval)" });
    expect(chip).toBeTruthy();
    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: waiting"));
    expect(agentTooltip!.textContent).toContain("State: waiting (approval)");
  });

  it("keeps the plain waiting label for the prompt fallback (no overclaiming)", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "heuristic",
      stateChangeConfidence: 1,
      waitingReason: "prompt",
    };

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const chip = screen.getByRole("status", { name: "Agent state: waiting" });
    expect(chip).toBeTruthy();
    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: waiting"));
    expect(agentTooltip!.textContent).not.toContain("(prompt)");
  });

  it("ignores a stale waiting reason once the agent is no longer waiting", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "output",
      stateChangeConfidence: 1,
      waitingReason: "approval",
    };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    const chip = screen.getByRole("status", { name: "Agent state: working" });
    expect(chip).toBeTruthy();
  });

  it("shows AI classification trigger label", () => {
    mockTerminal = {
      id: "t1",
      stateChangeTrigger: "ai-classification",
      stateChangeConfidence: 0.95,
    };

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent waiting"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("AI classification");
    expect(agentTooltip!.textContent).toContain("(95%)");
  });

  it("omits missing fields gracefully", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

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

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

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
      <TerminalAgentIndicator
        id="t1"

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
      <TerminalAgentIndicator
        id="t1"

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

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

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

    render(<TerminalAgentIndicator id="t1" agentState="idle" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("renders no glyph when completed without a session cost", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalAgentIndicator id="t1" agentState="completed" />);

    expect(screen.queryByRole("status", { name: /agent state/i })).toBeNull();
  });

  it("keeps the settled glyph while there is a session cost to explain", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42, sessionTokens: 12_000 };

    render(<TerminalAgentIndicator id="t1" agentState="completed" />);

    expect(screen.getByRole("status", { name: "Agent state: done" })).toBeTruthy();
    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip.textContent).toContain("Cost: $0.42");
    // The readout itself is metadata and lives in the header row, not here.
    expect(screen.queryByText(/^\$0\.42/)).toBeNull();
  });

  it("marks the glyph with a dot for this terminal's undismissed errors only", () => {
    mockTerminal = { id: "t1" };
    mockErrors = [
      { context: { terminalId: "t1" } },
      { context: { terminalId: "t1" }, dismissed: true },
      { context: { terminalId: "other" } },
    ];

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    expect(screen.getByLabelText("1 error")).toBeTruthy();
    expect(screen.getByTestId("tooltip-content").textContent).toContain("1 error");
  });

  it("pluralises the error dot", () => {
    mockTerminal = { id: "t1" };
    mockErrors = [{ context: { terminalId: "t1" } }, { context: { terminalId: "t1" } }];

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    expect(screen.getByLabelText("2 errors")).toBeTruthy();
  });

  it("shows the exit code in the tooltip when exited", () => {
    mockTerminal = { id: "t1", sessionCost: 0.1 };

    render(<TerminalAgentIndicator id="t1" agentState="exited" isExited={true} exitCode={1} />);

    expect(screen.getByTestId("tooltip-content").textContent).toContain("Exit code: 1");
  });

  it("falls back to Agent {state} when no headline", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalAgentIndicator id="t1" agentState="directing" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent directing"));
    expect(agentTooltip).toBeTruthy();
  });

  it("does not show stalled state for working agent past 60 seconds", () => {
    mockTerminal = {
      id: "t1",
      lastStateChange: new Date("2026-03-19T11:58:00Z").getTime(), // 2 minutes ago
    };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

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

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("Agent working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.textContent).toContain("(0%)");
  });
});

describe("TerminalAgentIndicator — elapsed-state-duration suffix", () => {
  it("omits the duration suffix at exactly 10 seconds since last state change", () => {
    const lastChange = new Date("2026-03-19T11:59:50Z").getTime();
    mockTerminal = { id: "t1", lastStateChange: lastChange };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.querySelector(".motion-safe\\:animate-in")).toBeNull();
  });

  it("renders the duration suffix in an animated span past the 10-second threshold", () => {
    const lastChange = new Date("2026-03-19T11:59:30Z").getTime();
    mockTerminal = { id: "t1", lastStateChange: lastChange };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: working"));
    expect(agentTooltip).toBeTruthy();

    const animatedSpan = agentTooltip!.querySelector(".motion-safe\\:animate-in");
    expect(animatedSpan).toBeTruthy();
    const cls = animatedSpan!.getAttribute("class")!;
    expect(cls).toContain("motion-safe:animate-in");
    expect(cls).toContain("motion-safe:fade-in");
    expect(cls).toContain("motion-safe:duration-150");
    expect(cls).not.toMatch(/\bopacity-/);
    expect(animatedSpan!.textContent).toContain("·");
    expect(animatedSpan!.textContent).toContain("30s");
  });
});
