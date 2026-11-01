// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

let mockResourceEnabled = false;
let mockResourceState: Record<string, unknown> | null = null;

vi.mock("@/store/resourceMonitoringStore", () => ({
  isSettledResourceState: () => false,
  useResourceMonitoringStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      enabled: mockResourceEnabled,
      metrics: {
        get: (_id: string) => mockResourceState,
      },
    }),
}));

vi.mock("../TerminalResourceSparkline", () => ({
  TerminalResourceSparkline: ({ className }: { className?: string }) => (
    <span data-testid="resource-sparkline" className={className} />
  ),
}));

// The real chip only renders once a provider reports children over IPC.
vi.mock("../TerminalNotifyChip", () => ({
  TerminalNotifyChip: () => null,
}));

let mockSubagentChipVisible = false;

vi.mock("../SubagentChip", () => ({
  SubagentChip: () =>
    mockSubagentChipVisible ? <button type="button" data-testid="subagent-chip" /> : null,
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
  mockSubagentChipVisible = false;
  mockResourceEnabled = false;
  mockResourceState = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalHeaderContent — settled-agent trace", () => {
  it("shows exit code when exited", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" isExited={true} exitCode={1} />);

    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("[exit 1]");
  });

  it("shows exit code 0 correctly", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" isExited={true} exitCode={0} />);

    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("[exit 0]");
  });

  it("marks a non-zero exit as failed, in shape and in name, and only that", () => {
    mockTerminal = { id: "t1" };

    const { rerender } = render(<TerminalHeaderContent id="t1" isExited={true} exitCode={2} />);
    expect(screen.getByRole("status").querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("[exit 2], failed");

    rerender(<TerminalHeaderContent id="t1" isExited={true} exitCode={0} />);
    expect(screen.getByRole("status").querySelector("svg")).toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBeNull();

    rerender(<TerminalHeaderContent id="t1" isExited={true} exitCode={null} />);
    expect(screen.getByRole("status").querySelector("svg")).toBeNull();
  });

  it("reads [exited] rather than a dangling 'exit' when there is no code", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" isExited={true} exitCode={null} />);

    const badge = screen.getByRole("status");
    expect(badge.textContent).toBe("[exited]");
    expect(badge.getAttribute("aria-live")).toBe("off");
  });

  it("renders the cost readout for a settled agent with a session cost", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42, sessionTokens: 12_000 };

    render(<TerminalHeaderContent id="t1" agentState="completed" />);

    const trace = screen.getByTestId("terminal-settled-trace");
    expect(trace.textContent).toContain("$0.42");
    expect(trace.textContent).toContain("12k tokens");
    expect(trace.getAttribute("aria-label")).toContain("12,000 tokens");
  });

  it("discloses every digit the summary printed, and never reads a paid run as free", () => {
    mockTerminal = { id: "t1", sessionCost: 0.00001 };

    render(<TerminalHeaderContent id="t1" agentState="completed" />);

    const trace = screen.getByTestId("terminal-settled-trace");
    expect(trace.textContent).toContain("<$0.01");
    expect(trace.getAttribute("aria-label")).toContain("$0.00001 USD");
  });

  it("shows a token-only summary rather than dropping it", () => {
    mockTerminal = { id: "t1", sessionTokens: 84_310 };

    render(<TerminalHeaderContent id="t1" agentState="completed" />);

    expect(screen.getByTestId("terminal-settled-trace").textContent).toContain("84k tokens");
  });

  it("renders no cost readout while the agent is still working", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42 };

    render(<TerminalHeaderContent id="t1" agentState="working" />);

    expect(screen.queryByText(/\$0\.42/)).toBeNull();
  });

  it("says 'Nothing to commit' when completed with an observed clean worktree", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={true} />);

    const trace = screen.getByRole("status", { name: /nothing to commit/i });
    expect(trace.textContent).toContain("Nothing to commit");
    expect(trace.getAttribute("tabindex")).toBe("0");
  });

  it("renders no trace when there is neither a clean worktree nor a summary", () => {
    mockTerminal = { id: "t1" };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={false} />);

    expect(screen.queryByTestId("terminal-settled-trace")).toBeNull();
  });

  it("keeps the clean-worktree fact beside the cost rather than dropping it", () => {
    mockTerminal = { id: "t1", sessionCost: 0.42 };

    render(<TerminalHeaderContent id="t1" agentState="completed" completedWithNoChanges={true} />);

    const trace = screen.getByRole("status", { name: /nothing to commit/i });
    expect(trace.textContent).toContain("Nothing to commit");
    expect(trace.textContent).toContain("$0.42");
  });
});

describe("TerminalHeaderContent — resource severity hysteresis", () => {
  // The band is read off `data-severity`, not a colour class: which tone each
  // band paints in is an implementation value, while the ladder position these
  // hysteresis tests exist to prove is what stays true.
  function expectMutedSeverity(severity: string | null) {
    expect(severity).toBe("muted");
  }

  function makeResourceState(cpuPercent: number, memoryKb = 200_000) {
    return {
      cpuPercent,
      memoryKb,
      cpuHistory: [],
      breakdown: [],
    };
  }

  it("tints the CPU line with a narrow colour transition, never transition-all", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const cls = screen.getByTestId("resource-sparkline").getAttribute("class")!;
    expect(cls).toContain("transition-colors");
    expect(cls).not.toMatch(/\btransition-all\b/);
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

    const wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expectMutedSeverity(wrapper!.getAttribute("data-severity"));
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

    const wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expect(wrapper!.getAttribute("data-severity")).toBe("amber");
  });

  it("commits red, amber, then muted on a sustained downward sequence", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () => container.querySelector('[data-testid="terminal-resource-badge"]')!;

    // Escalation reacts in 3 polls.
    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");

    // De-escalation lingers — requires 5 polls per downward step.
    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    pollResource(rerender, 60, 8);
    expect(wrapperFor().getAttribute("data-severity")).toBe("amber");
    expect(wrapperFor().getAttribute("data-severity")).not.toBe("red");

    pollResource(rerender, 10, 9);
    pollResource(rerender, 10, 10);
    pollResource(rerender, 10, 11);
    pollResource(rerender, 10, 12);
    pollResource(rerender, 10, 13);
    expectMutedSeverity(wrapperFor().getAttribute("data-severity"));
  });

  it("does not de-escalate after only 4 polls below the threshold", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () => container.querySelector('[data-testid="terminal-resource-badge"]')!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");

    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");
    expect(wrapperFor().getAttribute("data-severity")).not.toBe("amber");
  });

  it("keeps the hotter band when severity oscillates within the 3-5 de-escalation gap", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () => container.querySelector('[data-testid="terminal-resource-badge"]')!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");

    // 4 cool polls — one short of the 5-poll de-escalation commit.
    pollResource(rerender, 60, 4);
    pollResource(rerender, 60, 5);
    pollResource(rerender, 60, 6);
    pollResource(rerender, 60, 7);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");

    // A single hot poll matches the displayed band and resets the pending counter.
    pollResource(rerender, 90, 8);

    // The de-escalation count restarts from zero; 4 more cool polls still hold red.
    pollResource(rerender, 60, 9);
    pollResource(rerender, 60, 10);
    pollResource(rerender, 60, 11);
    pollResource(rerender, 60, 12);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");
    expect(wrapperFor().getAttribute("data-severity")).not.toBe("amber");
  });

  it("de-escalates red straight to muted without stepping through amber", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);

    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const wrapperFor = () => container.querySelector('[data-testid="terminal-resource-badge"]')!;

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(wrapperFor().getAttribute("data-severity")).toBe("red");

    pollResource(rerender, 10, 4);
    pollResource(rerender, 10, 5);
    pollResource(rerender, 10, 6);
    pollResource(rerender, 10, 7);
    pollResource(rerender, 10, 8);
    expectMutedSeverity(wrapperFor().getAttribute("data-severity"));
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

    const wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expect(wrapper!.getAttribute("data-severity")).toBe("red");
    // The band belongs to memory: the CPU reading and its line stay calm.
    expect(wrapper!.getAttribute("data-memory-severity")).toBe("red");
    expect(wrapper!.getAttribute("data-cpu-severity")).toBe("muted");
  });

  it("marks each escalated reading with a shape that differs by band", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10, 200_000);
    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const marks = () =>
      Array.from(container.querySelectorAll("[data-severity-mark]")).map((el) => ({
        band: el.getAttribute("data-severity-mark"),
        shape: el
          .getAttribute("class")
          ?.match(/lucide-[\w-]+/g)
          ?.join(" "),
      }));

    expect(marks()).toEqual([]);

    // CPU amber, memory red: one mark per escalated reading.
    for (let i = 1; i <= 3; i++) {
      mockResourceState = makeResourceState(60, 2_500_000);
      rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={i} />);
    }
    const [cpuMark, memoryMark] = marks();
    expect(cpuMark!.band).toBe("amber");
    expect(memoryMark!.band).toBe("red");
    // Forced colours and colour-blind readers get the band from the outline.
    expect(cpuMark!.shape).toBeTruthy();
    expect(cpuMark!.shape).not.toBe(memoryMark!.shape);
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
    let wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expect(wrapper!.getAttribute("data-severity")).toBe("amber");

    mockResourceEnabled = false;
    mockResourceState = null;
    rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={4} />);

    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);
    rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={5} />);

    wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expectMutedSeverity(wrapper!.getAttribute("data-severity"));
  });

  it("earns amber from readings that swing between the amber and red bands", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);
    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const severity = () =>
      container
        .querySelector('[data-testid="terminal-resource-badge"]')!
        .getAttribute("data-severity");

    pollResource(rerender, 60, 1);
    pollResource(rerender, 90, 2);
    expectMutedSeverity(severity());
    // Every poll has been above the amber threshold: the third earns it.
    pollResource(rerender, 60, 3);
    expect(severity()).toBe("amber");
    pollResource(rerender, 90, 4);
    pollResource(rerender, 60, 5);
    // Red needs its own unbroken run above the red threshold.
    expect(severity()).toBe("amber");
  });

  it("steps down to the hottest band seen during a quiet run, not straight through", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(10);
    const { rerender, container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
    );
    const severity = () =>
      container
        .querySelector('[data-testid="terminal-resource-badge"]')!
        .getAttribute("data-severity");

    pollResource(rerender, 90, 1);
    pollResource(rerender, 90, 2);
    pollResource(rerender, 90, 3);
    expect(severity()).toBe("red");

    [10, 60, 10, 10, 10].forEach((cpu, i) => pollResource(rerender, cpu, 4 + i));
    expect(severity()).toBe("amber");
  });

  it("counts a sample once even when StrictMode mounts the effect twice", () => {
    mockResourceEnabled = true;
    mockResourceState = makeResourceState(90);
    const { rerender, container } = render(
      <StrictMode>
        <TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />
      </StrictMode>
    );
    mockResourceState = makeResourceState(90);
    rerender(
      <StrictMode>
        <TerminalHeaderContent id="t1" kind="terminal" queueCount={1} />
      </StrictMode>
    );
    // Two polls: one short of the escalation run.
    expectMutedSeverity(
      container
        .querySelector('[data-testid="terminal-resource-badge"]')!
        .getAttribute("data-severity")
    );
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

    const wrapper = container.querySelector('[data-testid="terminal-resource-badge"]');
    expectMutedSeverity(wrapper!.getAttribute("data-severity"));
  });
});

describe("TerminalHeaderContent — resource breakdown", () => {
  const breakdown = [
    { pid: 11, comm: "cargo", cpuPercent: 212.6, memoryKb: 1_320_000 },
    { pid: 12, comm: "rustc", cpuPercent: 96.3, memoryKb: 940_000 },
  ];

  it("says the rows are a subset when the tree holds more processes than it lists", () => {
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 40,
      memoryKb: 2_500_000,
      cpuHistory: [1, 2],
      breakdown,
      processCount: 14,
    };
    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const tip = screen.getByTestId("tooltip-content").textContent ?? "";
    expect(tip).toContain(`${breakdown.length} of 14`);
  });

  it("adds no subset note when every process is listed", () => {
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 40,
      memoryKb: 2_500_000,
      cpuHistory: [1, 2],
      breakdown,
      processCount: breakdown.length,
    };
    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    expect(screen.getByTestId("tooltip-content").textContent).not.toMatch(/ of \d+ processes/);
  });

  it("leads with the biggest memory row when memory is the high reading", () => {
    const rows = [
      { pid: 21, comm: "codex", cpuPercent: 4.2, memoryKb: 238_000 },
      { pid: 22, comm: "tsserver", cpuPercent: 0, memoryKb: 2_300_000 },
    ];
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 4.2,
      memoryKb: 2_540_000,
      cpuHistory: [1, 2],
      breakdown: rows,
    };
    const { rerender } = render(<TerminalHeaderContent id="t1" kind="terminal" queueCount={0} />);
    for (let i = 1; i <= 3; i++) {
      mockResourceState = {
        cpuPercent: 4.2,
        memoryKb: 2_540_000,
        cpuHistory: [1, 2],
        breakdown: rows,
      };
      rerender(<TerminalHeaderContent id="t1" kind="terminal" queueCount={i} />);
    }
    const breakdownTip = screen
      .getAllByTestId("tooltip-content")
      .find((el) => el.querySelector("table"))!;
    const names = Array.from(breakdownTip.querySelectorAll("tbody tr td:nth-child(2)")).map(
      (td) => td.textContent
    );
    expect(names[0]).toBe("tsserver");
  });

  it("keeps the busiest-CPU order while CPU is the high reading", () => {
    const rows = [
      { pid: 31, comm: "cargo", cpuPercent: 212.6, memoryKb: 400_000 },
      { pid: 32, comm: "tsserver", cpuPercent: 0, memoryKb: 900_000 },
    ];
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 212.6,
      memoryKb: 1_300_000,
      cpuHistory: [1, 2],
      breakdown: rows,
    };
    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const names = Array.from(
      screen.getByTestId("tooltip-content").querySelectorAll("tbody tr td:nth-child(2)")
    ).map((td) => td.textContent);
    expect(names).toEqual(["cargo", "tsserver"]);
  });

  it("reads CPU in cores on the badge, the tooltip and each process row", () => {
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 308.9,
      memoryKb: 2_500_000,
      cpuHistory: [1, 2],
      breakdown: [
        { pid: 1, comm: "cargo", cpuPercent: 300, memoryKb: 2_000_000 },
        { pid: 2, comm: "zsh", cpuPercent: 0.4, memoryKb: 500_000 },
      ],
    };
    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    expect(screen.getByTestId("terminal-resource-badge").textContent).toContain("3.1 cores");
    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip.textContent).toContain("CPU 3.1 cores");
    const cells = Array.from(tooltip.querySelectorAll("tbody tr td:nth-child(3)")).map(
      (td) => td.textContent
    );
    expect(cells).toEqual(["3 cores", "<0.1 cores"]);
    expect(tooltip.textContent).not.toMatch(/%/);
  });
});

// #9204 — per-pane state badges must silence their implicit live region so the
// global announcer (mounted once in App.tsx) is the single source of polite
// announcements. `role="status"` carries an implicit `aria-live="polite"` per
// ARIA spec, so simply removing the explicit attribute is insufficient — each
// badge must opt out with `aria-live="off"`. Flow and submit status render in
// TerminalStatusSlot (#12374), which carries the same coverage.
describe("TerminalHeaderContent — per-pane badges silence implicit live region (#9204)", () => {
  it("queue-count badge sets aria-live='off'", () => {
    mockTerminal = { id: "t1" };
    const { container } = render(<TerminalHeaderContent id="t1" queueCount={3} />);
    const badge = container.querySelector('[role="status"][aria-live="off"]');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toContain("queued");
  });

  it("resource badge stays silent but is reachable and named for keyboard users", () => {
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 12.4,
      memoryKb: 290_000,
      cpuHistory: [1, 2, 3],
      breakdown: [],
    };
    render(<TerminalHeaderContent id="t1" kind="terminal" />);
    const badge = screen.getByTestId("terminal-resource-badge");
    expect(badge.getAttribute("aria-live")).toBe("off");
    expect(badge.tabIndex).toBe(0);
    const name = badge.getAttribute("aria-label") ?? "";
    expect(name).toMatch(/CPU 0\.1 cores/);
    expect(name).toMatch(/memory 283M/);
  });

  it("no badge declares aria-live='polite'", () => {
    mockTerminal = { id: "t1" };
    mockResourceEnabled = true;
    mockResourceState = { cpuPercent: 12, memoryKb: 2048, cpuHistory: [1, 2], breakdown: [] };
    const { container } = render(
      <TerminalHeaderContent id="t1" isExited={true} exitCode={1} queueCount={3} />
    );
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBe(0);
    expect(container.querySelectorAll('[role="status"]:not([aria-live="off"])').length).toBe(0);
  });
});

// #9814 — chip row vocabulary calibration. The agent glyph is not in this row
// at all (PanelHeader keeps it past the close button), and the resource sparkline
// trails as ambient telemetry.
// Transient flow status left this row for TerminalStatusSlot's reserved box in
// #12374.
describe("TerminalHeaderContent — chip vocabulary and order (#9814)", () => {
  it("keeps the agent glyph out of the row entirely", () => {
    mockTerminal = { id: "t1" };
    const { container } = render(
      <TerminalHeaderContent
        id="t1"
        agentState="working"
        isExited={true}
        exitCode={1}
        queueCount={2}
      />
    );
    const badges = Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'));
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((el) => /^Agent state:/.test(el.getAttribute("aria-label") ?? ""))).toBe(
      false
    );
  });

  // PanelHeader clips this row from its trailing end in a narrow pane, so order
  // decides what survives: the subagent chip is the row's only pointer entry
  // point and must sit ahead of the lock glyph and telemetry (#12374).
  it("clips telemetry and the lock glyph before the subagent chip", () => {
    mockTerminal = { id: "t1", isInputLocked: true };
    mockSubagentChipVisible = true;
    mockResourceEnabled = true;
    mockResourceState = { cpuPercent: 12, memoryKb: 2048, cpuHistory: [1, 2, 3], breakdown: [] };
    const { container } = render(
      <TerminalHeaderContent id="t1" kind="terminal" agentState="working" queueCount={2} />
    );
    const subagent = screen.getByTestId("subagent-chip");
    const lockTooltip = screen
      .getAllByTestId("tooltip-content")
      .find((el) => el.textContent?.includes("Input locked"));
    const lock = lockTooltip?.parentElement?.querySelector('[role="status"]');
    const resource = container.querySelector<HTMLElement>(
      '[data-testid="terminal-resource-badge"]'
    );
    expect(lock).toBeTruthy();
    expect(resource).toBeTruthy();
    expect(subagent.compareDocumentPosition(lock!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      lock!.compareDocumentPosition(resource!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("combined render: telemetry trails the exit badge", () => {
    mockTerminal = { id: "t1", isInputLocked: true };
    mockResourceEnabled = true;
    mockResourceState = {
      cpuPercent: 12,
      memoryKb: 2048,
      cpuHistory: [1, 2, 3],
      breakdown: [],
    };
    const { container } = render(
      <TerminalHeaderContent
        id="t1"
        kind="terminal"
        agentState="working"
        isExited={true}
        exitCode={1}
        queueCount={2}
      />
    );
    const allStatuses = Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'));
    // The resource badge is NOT the first status — it trails the pane-local
    // exit badge.
    const resource = screen.getByTestId("terminal-resource-badge");
    expect(allStatuses[0]).not.toBe(resource);
    expect(resource).toBeTruthy();
    const exitBadge = allStatuses[0]!;
    expect(
      exitBadge.compareDocumentPosition(resource) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
