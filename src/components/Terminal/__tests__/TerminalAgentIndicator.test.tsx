// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalAgentIndicator } from "../TerminalAgentIndicator";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";

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
    exited: mockIcon,
    unread: mockIcon,
    blocked: mockIcon,
  };
  const STATE_COLORS: Record<string, string> = {
    working: "text-working",
    waiting: "text-waiting",
    directing: "text-directing",
    idle: "text-idle",
    completed: "text-completed",
    exited: "text-exited",
    unread: "text-unread",
    blocked: "text-blocked",
  };
  const STATE_LABELS: Record<string, string> = {
    working: "working",
    waiting: "waiting",
    directing: "directing",
    idle: "idle",
    completed: "finished",
    exited: "exited",
    unread: "unread",
    blocked: "blocked",
  };
  return {
    STATE_ICONS,
    STATE_COLORS,
    STATE_LABELS,
    SESSION_ICONS: STATE_ICONS,
    SESSION_COLORS: STATE_COLORS,
    SESSION_LABELS: STATE_LABELS,
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

function setHandBack(handBack: FleetRunRow["handBack"], overrides: Partial<FleetRunRow> = {}) {
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        {
          runId: "t1",
          workspaceId: "p1",
          spawnedAt: 0,
          cwd: "/repo",
          agentState: "waiting",
          handBack,
          ...overrides,
        },
      ],
      changedAt: 0,
      degraded: false,
      lastSuccessfulAt: null,
    } satisfies FleetSnapshot,
  });
}

/** The fleet's row for t1 with no hand-back: the band comes from the overrides alone. */
function setRun(overrides: Partial<FleetRunRow>) {
  setHandBack(undefined, overrides);
}

const UNREAD_ASK = { kind: "asked", quote: "Run npm test?", readAt: 1, seen: false } as const;

beforeEach(() => {
  useFleetSnapshotStore.setState({ snapshot: null });
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
    setRun({ waitingReason: "approval", canopy: UNREAD_ASK });

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
    setRun({ waitingReason: "prompt", canopy: UNREAD_ASK });

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
    setRun({ canopy: UNREAD_ASK });

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

  it("keeps the settled glyph while there is a session cost, and leaves the cost to the row", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42, sessionTokens: 12_000 };

    render(<TerminalAgentIndicator id="t1" agentState="completed" />);

    expect(screen.getByRole("status", { name: "Agent state: finished" })).toBeTruthy();
    // The header row's settled trace is the one place cost is disclosed.
    expect(screen.getByTestId("tooltip-content").textContent).not.toContain("$0.42");
  });

  it("draws a seen hand-back as the white finished ring, with no chip around it", () => {
    mockTerminal = { id: "t1", agentState: "waiting" };
    setHandBack({ stoppedAt: 1, seenAt: 2 });

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const chip = screen.getByRole("status", { name: "Agent state: finished" });
    expect(chip.className).not.toMatch(/\b(bg|border)-/);
    expect(chip.className).toContain("text-text-primary");
    expect(screen.getByTestId("tooltip-content").textContent).toContain("Observed: waiting");
  });

  it("draws an unseen hand-back as unread, without the waiting hue", () => {
    mockTerminal = { id: "t1", agentState: "completed" };
    setHandBack({ stoppedAt: 1 }, { agentState: "completed" });

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const chip = screen.getByRole("status", { name: "Agent state: unread" });
    expect(chip.className).not.toMatch(/\b(bg|border)-/);
    expect(chip.className).toContain("text-unread");
    expect(chip.className).not.toContain("state-waiting");
    // The tooltip names what was observed, not the coerced display state.
    expect(screen.getByTestId("tooltip-content").textContent).toContain("Observed: finished");
  });

  it("draws an approval wait amber only on an unread Canopy ask, whatever the hand-back says", () => {
    mockTerminal = { id: "t1", agentState: "waiting", waitingReason: "approval" };
    // The patterns' guess with no reading is unread news, never the amber ring.
    setRun({ waitingReason: "approval", wait: { stoppedAt: 1 } });
    const { rerender } = render(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.getByRole("status", { name: /^Agent state: unread/ }).className).not.toContain(
      "text-waiting"
    );

    act(() =>
      setHandBack({ stoppedAt: 1, seenAt: 2 }, { waitingReason: "approval", canopy: UNREAD_ASK })
    );
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    const chip = screen.getByRole("status", { name: /^Agent state: waiting/ });
    expect(chip.className).toContain("text-waiting");
    expect(chip.className).not.toMatch(/\b(bg|border)-/);
  });

  it("draws no glyph for a prompt that asks nothing, or before the fleet has reported", () => {
    mockTerminal = { id: "t1", agentState: "waiting", waitingReason: "prompt" };
    const { rerender } = render(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.queryByRole("status")).toBeNull();

    // A restored agent at its prompt: no hand-back record, no reading.
    act(() => setRun({ waitingReason: "prompt" }));
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.queryByRole("status")).toBeNull();

    // A live agent the patterns call idle is drawn waiting by the header's fold.
    mockTerminal = { id: "t1", agentState: "idle" };
    act(() => setRun({ agentState: "idle" }));
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("takes the ring away once the ask is seen, and brings it back for a new one", () => {
    mockTerminal = { id: "t1", agentState: "completed" };
    // Canopy may read an ask on a finished turn; the header folds it to waiting.
    setRun({ agentState: "completed", canopy: UNREAD_ASK });
    const { rerender } = render(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.getByRole("status", { name: /^Agent state: waiting/ })).toBeTruthy();

    act(() => setRun({ agentState: "completed", canopy: { ...UNREAD_ASK, seen: true } }));
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => setRun({ agentState: "completed", canopy: { ...UNREAD_ASK, readAt: 5 } }));
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.getByRole("status", { name: /^Agent state: waiting/ })).toBeTruthy();
  });

  it("drops the ring as soon as the pane restarts, before the band catches up", () => {
    mockTerminal = { id: "t1", agentState: "waiting", waitingReason: "question" };
    setRun({ waitingReason: "question", canopy: UNREAD_ASK });
    const { rerender } = render(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.getByRole("status", { name: /^Agent state: waiting/ })).toBeTruthy();

    mockTerminal = { ...mockTerminal, isRestarting: true };
    rerender(<TerminalAgentIndicator id="t1" agentState="waiting" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws an error wait as blocked, never as the waiting ring", () => {
    mockTerminal = { id: "t1", agentState: "waiting", waitingReason: "error" };
    setRun({ waitingReason: "error" });

    render(<TerminalAgentIndicator id="t1" agentState="waiting" />);

    const chip = screen.getByRole("status", { name: "Agent state: blocked (error)" });
    expect(chip.className).toContain("text-blocked");
    expect(chip.className).not.toContain("text-waiting");
    expect(screen.getByTestId("tooltip-content").textContent).toContain("Observed: waiting");
  });

  it("keeps work in flight as observed whatever the band still says", () => {
    mockTerminal = { id: "t1", agentState: "working" };
    // The band is polled; the pane hears the reply that set the agent working first.
    setRun({ agentState: "completed", canopy: UNREAD_ASK });

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    expect(screen.getByRole("status", { name: "Agent state: working" })).toBeTruthy();
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

  it("colours the tooltip's exit line as an error only for a non-zero code", () => {
    mockTerminal = { id: "t1", sessionCost: 0.1 };
    const exitLine = () =>
      [...screen.getByTestId("tooltip-content").querySelectorAll("span")].find((el) =>
        /^Exit/.test(el.textContent ?? "")
      )!;

    const { rerender } = render(
      <TerminalAgentIndicator id="t1" agentState="exited" isExited={true} exitCode={1} />
    );
    expect(exitLine().className).toContain("text-status-error");

    rerender(<TerminalAgentIndicator id="t1" agentState="exited" isExited={true} exitCode={0} />);
    expect(exitLine().textContent).toContain("Exit code: 0");
    expect(exitLine().className).not.toContain("text-status-error");

    rerender(
      <TerminalAgentIndicator id="t1" agentState="exited" isExited={true} exitCode={null} />
    );
    expect(exitLine().textContent).not.toMatch(/:\s*$/);
    expect(exitLine().className).not.toContain("text-status-error");
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
    expect(agentTooltip!.querySelector(".animate-in")).toBeNull();
  });

  it("renders the duration suffix in an animated span past the 10-second threshold", () => {
    const lastChange = new Date("2026-03-19T11:59:30Z").getTime();
    mockTerminal = { id: "t1", lastStateChange: lastChange };

    render(<TerminalAgentIndicator id="t1" agentState="working" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const agentTooltip = tooltips.find((el) => el.textContent?.includes("State: working"));
    expect(agentTooltip).toBeTruthy();

    const animatedSpan = agentTooltip!.querySelector(".animate-in");
    expect(animatedSpan).toBeTruthy();
    const cls = animatedSpan!.getAttribute("class")!;
    expect(cls).toContain("animate-in");
    expect(cls).toContain("fade-in");
    // A fade is not motion, so it is never gated on a motion variant.
    expect(cls).not.toMatch(/motion-(safe|reduce):/);
    expect(cls).not.toMatch(/\bopacity-/);
    expect(animatedSpan!.textContent).toContain("·");
    expect(animatedSpan!.textContent).toContain("30s");
  });
});
