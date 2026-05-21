// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalHeaderContent } from "../TerminalHeaderContent";

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
      } else if (typeof v === "object") {
        for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
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

vi.mock("@/store/errorStore", () => ({
  useErrorStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ errors: [] }),
}));

let mockResourceEnabled = false;
let mockResourceState: Record<string, unknown> | null = null;

vi.mock("@/store/resourceMonitoringStore", () => ({
  useResourceMonitoringStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      enabled: mockResourceEnabled,
      metrics: {
        get: (_id: string) => mockResourceState,
      },
    }),
}));

vi.mock("../TerminalResourceSparkline", () => ({
  TerminalResourceSparkline: () => <span data-testid="resource-sparkline" />,
}));

let mockTerminal: Record<string, unknown> = {};

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      panelsById: { [mockTerminal.id as string]: mockTerminal },
      panelIds: [mockTerminal.id],
    }),
}));

beforeEach(() => {
  mockTerminal = { id: "t1" };
  mockResourceEnabled = false;
  mockResourceState = null;
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

  it("renders 'Finished, no changes' pill when completed with no file changes", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={true} />);

    const pill = screen.getByRole("status", { name: /no file changes/i });
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("Finished, no changes");
  });

  it("omits 'Finished, no changes' pill when completedWithNoChanges is false", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={false} />);

    expect(screen.queryByRole("status", { name: /no file changes/i })).toBeNull();
  });

  it("omits 'Finished, no changes' pill when sessionCost is present (regular cost chip wins)", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42 };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={true} />);

    expect(screen.queryByRole("status", { name: /no file changes/i })).toBeNull();
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

describe("TerminalHeaderContent — resource severity hysteresis", () => {
  function makeResourceState(cpuPercent: number, memoryKb = 200_000) {
    return {
      cpuPercent,
      memoryKb,
      cpuHistory: [],
      breakdown: [],
    };
  }

  it("renders resource wrapper with transition-colors and not transition-all", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { container } = render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper).toBeTruthy();
    const cls = wrapper!.getAttribute("class")!;
    expect(cls).toContain("transition-colors");
    expect(cls).toContain("duration-150");
    expect(cls).not.toMatch(/\btransition-all\b/);
  });

  it("starts at muted severity when CPU is low", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { container } = render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapper!.getAttribute("class")).not.toContain("text-status-warning");
    expect(wrapper!.getAttribute("class")).not.toContain("text-status-error");
  });

  // Vary `queueCount` between renders so React.memo doesn't skip the re-render
  // on identical props (the resource store mock isn't reactive on its own).
  function pollResource(
    rerender: (ui: React.ReactElement) => void,
    cpuPercent: number,
    iteration: number
  ) {
    mockResourceState = makeResourceState(cpuPercent);
    rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={iteration} />);
  }

  it("does not commit to amber after fewer than 3 polls above the threshold", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );

    pollResource(rerender, 60, 1);
    pollResource(rerender, 60, 2);

    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapper!.getAttribute("class")).not.toContain("text-status-warning");
  });

  it("commits to amber after 3 consecutive polls above the threshold", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );

    pollResource(rerender, 60, 1);
    pollResource(rerender, 60, 2);
    pollResource(rerender, 60, 3);

    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-status-warning");
    expect(wrapper!.getAttribute("class")).not.toContain("text-daintree-text/40");
  });

  it("commits red, amber, then muted on a sustained downward sequence", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () =>
      container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]")!;

    // Escalation reacts in 3 polls.
    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    // De-escalation lingers — requires 5 polls per downward step.
    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    pollResource(rerender, 60, 8);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-warning");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-error");

    pollResource(rerender, 10, 9);
    pollResource(rerender, 10, 10);
    pollResource(rerender, 10, 11);
    pollResource(rerender, 10, 12);
    pollResource(rerender, 10, 13);
    expect(wrapperFor().getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-warning");
  });

  it("does not de-escalate after only 4 polls below the threshold", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () =>
      container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]")!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-warning");
  });

  it("de-escalates on exactly the 5th poll below the threshold", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () =>
      container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]")!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    pollResource(rerender, 60, 8);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-warning");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-error");
  });

  it("keeps the hotter band when severity oscillates within the 3-5 de-escalation gap", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () =>
      container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]")!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    // 4 cool polls — one short of the 5-poll de-escalation commit.
    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    // A single hot poll matches the displayed band and resets the pending counter.
    pollResource(rerender, 90, 8);

    // The de-escalation count restarts from zero; 4 more cool polls still hold red.
    pollResource(rerender, 60, 9);
    pollResource(rerender, 60, 10);
    pollResource(rerender, 60, 11);
    pollResource(rerender, 60, 12);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-warning");
  });

  it("de-escalates red straight to muted without stepping through amber", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () =>
      container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]")!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("class")).toContain("text-status-error");

    pollResource(rerender, 10, 4);
    pollResource(rerender, 10, 5);
    pollResource(rerender, 10, 6);
    pollResource(rerender, 10, 7);
    pollResource(rerender, 10, 8);
    expect(wrapperFor().getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-warning");
    expect(wrapperFor().getAttribute("class")).not.toContain("text-status-error");
  });

  it("commits to red via the memory threshold alone", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10, 200_000);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );

    function pollMemory(memoryKb: number, iteration: number) {
      mockResourceState = makeResourceState(10, memoryKb);
      rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={iteration} />);
    }

    pollMemory(2_500_000, 1);
    pollMemory(2_500_000, 2);
    pollMemory(2_500_000, 3);

    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-status-error");
    expect(wrapper!.getAttribute("class")).not.toContain("text-daintree-text/40");
  });

  it("resets sticky severity to muted when monitoring is disabled and re-enabled", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );

    pollResource(rerender, 60, 1);
    pollResource(rerender, 60, 2);
    pollResource(rerender, 60, 3);
    let wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-status-warning");

    mockResourceEnabled = false;
    mockResourceState = null;
    rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={4} />);

    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);
    rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={5} />);

    wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapper!.getAttribute("class")).not.toContain("text-status-warning");
  });

  it("resets candidate counter when severity oscillates back during the run", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );

    pollResource(rerender, 60, 1);
    pollResource(rerender, 60, 2);
    pollResource(rerender, 10, 3);
    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);

    const wrapper = container.querySelector(".inline-flex.items-center.gap-1.text-\\[11px\\]");
    expect(wrapper!.getAttribute("class")).toContain("text-daintree-text/40");
    expect(wrapper!.getAttribute("class")).not.toContain("text-status-warning");
  });
});

describe("TerminalHeaderContent — elapsed-state-duration suffix", () => {
  it("omits the duration suffix at exactly 10 seconds since last state change", () => {
    const lastChange = new Date("2026-03-19T11:59:50Z").getTime();
    mockTerminal = { id: "t1", lastStateChange: lastChange };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: working"));
    expect(agentTooltip).toBeTruthy();
    expect(agentTooltip!.querySelector(".motion-safe\\:animate-in")).toBeNull();
  });

  it("renders the duration suffix in an animated span past the 10-second threshold", () => {
    const lastChange = new Date("2026-03-19T11:59:30Z").getTime();
    mockTerminal = { id: "t1", lastStateChange: lastChange };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

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

describe("TerminalHeaderContent — paused / suspended tooltips", () => {
  it("paused tooltip shows two-tier copy and omits the action instruction", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" flowStatus="paused-backpressure" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const pausedTooltip = tooltips.find((el) => el.textContent?.includes("Buffer overflow"));
    expect(pausedTooltip).toBeTruthy();
    const text = pausedTooltip!.textContent!;
    expect(text).toContain("Buffer overflow");
    expect(text).toContain("Output paused to prevent data loss.");
    expect(text).not.toMatch(/right-click/i);
    expect(text).not.toMatch(/Force Resume/i);

    const stack = pausedTooltip!.querySelector(".flex.flex-col.gap-0\\.5");
    expect(stack).toBeTruthy();
    const primary = stack!.querySelector(".font-medium");
    expect(primary).toBeTruthy();
    expect(primary!.textContent).toBe("Buffer overflow");
  });

  it("suspended tooltip shows two-tier copy with stative title", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" flowStatus="suspended" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const suspendedTooltip = tooltips.find((el) => el.textContent?.includes("Output suspended"));
    expect(suspendedTooltip).toBeTruthy();
    const text = suspendedTooltip!.textContent!;
    expect(text).toContain("Output suspended");
    expect(text).toContain("Streaming stalled.");
    expect(text).toContain("Recovers automatically on focus.");

    const stack = suspendedTooltip!.querySelector(".flex.flex-col.gap-0\\.5");
    expect(stack).toBeTruthy();
    const primary = stack!.querySelector(".font-medium");
    expect(primary).toBeTruthy();
    expect(primary!.textContent).toBe("Output suspended");
  });
});
