// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { TerminalStatusSlot } from "../TerminalStatusSlot";

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

let mockTerminal: { id: string } & Record<string, unknown> = { id: "t1" };

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: { [mockTerminal.id]: mockTerminal } }),
}));

beforeEach(() => {
  mockTerminal = { id: "t1", kind: "terminal" };
});

// FUTURE_SAB: `suspended` has no production producer (#9900); it stays in the
// matrix so the forward-looking presentation keeps its semantics.
const HOLDS = ["paused-backpressure", "paused-resource-governor", "suspended"] as const;

function tooltipText(): string {
  return screen.getByTestId("tooltip-content").textContent ?? "";
}

function expectIdle(container: HTMLElement): void {
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByTestId("tooltip-content")).toBeNull();
  expect(container.querySelector("svg")).toBeNull();
  // Nothing to explain, so nothing to reach with Tab.
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    expect(el.tabIndex).toBeLessThan(0);
  }
}

describe("TerminalStatusSlot", () => {
  it.each([
    { flowStatus: undefined, submitStatus: undefined },
    { flowStatus: "running", submitStatus: undefined },
    { flowStatus: "data-loss", submitStatus: undefined },
    { flowStatus: undefined, submitStatus: "stalled" },
    { flowStatus: undefined, submitStatus: "failed" },
  ] as const)(
    "shows no status for flow $flowStatus / submit $submitStatus",
    ({ flowStatus, submitStatus }) => {
      const { container } = render(
        <TerminalStatusSlot id="t1" flowStatus={flowStatus} submitStatus={submitStatus} />
      );
      expectIdle(container);
    }
  );

  it.each(HOLDS)("%s is a bare glyph with its explanation in the tooltip", (flowStatus) => {
    render(<TerminalStatusSlot id="t1" flowStatus={flowStatus} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBeTruthy();
    expect(status.textContent).toBe("");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(tooltipText()).not.toBe("");
  });

  it("gives each flow hold its own accessible name", () => {
    const names = HOLDS.map((flowStatus) => {
      const { unmount } = render(<TerminalStatusSlot id="t1" flowStatus={flowStatus} />);
      const name = screen.getByRole("status").getAttribute("aria-label");
      unmount();
      return name;
    });
    expect(new Set(names).size).toBe(HOLDS.length);
  });

  it("is a tab stop while showing, since the tooltip is the only place its explanation is visible", () => {
    render(<TerminalStatusSlot id="t1" flowStatus="paused-resource-governor" />);
    const status = screen.getByRole("status");
    expect(status.tabIndex).toBeGreaterThanOrEqual(0);
    status.focus();
    expect(document.activeElement).toBe(status);
  });

  it("keeps keyboard focus in place when the status clears and returns", () => {
    const { rerender, container } = render(
      <TerminalStatusSlot id="t1" flowStatus="paused-backpressure" />
    );
    const glyph = screen.getByRole("status");
    glyph.focus();

    rerender(<TerminalStatusSlot id="t1" flowStatus="running" />);
    expect(document.activeElement).toBe(glyph);
    expectIdle(container);

    rerender(<TerminalStatusSlot id="t1" submitStatus="slow" />);
    expect(document.activeElement).toBe(glyph);
    expect(screen.getByRole("status")).toBe(glyph);
  });

  it.each(HOLDS)("%s stays off the warning and error hues", (flowStatus) => {
    render(<TerminalStatusSlot id="t1" flowStatus={flowStatus} />);
    const className = screen.getByRole("status").getAttribute("class") ?? "";
    expect(className).not.toMatch(/status-(warning|error)/);
  });

  // Flow holds are Tier-1 ambient and recover on their own. An instruction here
  // would point at force-resume, which drops every hold on the host at once.
  it.each(HOLDS)("%s explains the hold without instructing an action", (flowStatus) => {
    render(<TerminalStatusSlot id="t1" flowStatus={flowStatus} submitStatus="slow" />);
    expect(tooltipText()).not.toMatch(/right-click|force resume/i);
  });

  it("tells the user a memory-pressure pause recovers without them", () => {
    render(<TerminalStatusSlot id="t1" flowStatus="paused-resource-governor" />);
    expect(tooltipText()).toMatch(/recovers automatically/i);
  });

  it("tells the user a suspended stream recovers on focus (FUTURE_SAB; #9900)", () => {
    render(<TerminalStatusSlot id="t1" flowStatus="suspended" />);
    expect(tooltipText()).toMatch(/recovers automatically on focus/i);
  });

  // #9204 — role="status" carries an implicit polite live region; the global
  // announcer is the single source of announcements across a fleet of panes.
  it.each([
    { flowStatus: "paused-backpressure" as const },
    { flowStatus: "paused-resource-governor" as const },
    { flowStatus: "suspended" as const },
    { submitStatus: "slow" as const },
    { flowStatus: "paused-backpressure" as const, submitStatus: "slow" as const },
  ])("opts out of the implicit polite live region for %o", (props) => {
    const { container } = render(<TerminalStatusSlot id="t1" {...props} />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("off");
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBe(0);
  });

  it("names a slow submit and explains why later prompts wait", () => {
    render(<TerminalStatusSlot id="t1" submitStatus="slow" />);
    expect(screen.getByRole("status", { name: "Prompt still sending" })).toBeTruthy();
    expect(tooltipText()).toContain("Later prompts stay queued");
  });

  it("shows one glyph for a slow prompt during a backpressure pause, and names both", () => {
    const { container: pauseOnly, unmount } = render(
      <TerminalStatusSlot id="t1" flowStatus="paused-backpressure" />
    );
    const pauseGlyph = pauseOnly.querySelector("svg")?.outerHTML;
    unmount();

    render(<TerminalStatusSlot id="t1" flowStatus="paused-backpressure" submitStatus="slow" />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    const label = statuses[0]!.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/output paused/i);
    expect(label).toMatch(/prompt still sending/i);
    expect(statuses[0]!.querySelector("svg")?.outerHTML).toBe(pauseGlyph);
    const text = tooltipText();
    expect(text).toContain("Output paused to prevent data loss.");
    expect(text).toContain("Later prompts stay queued");
  });

  it.each([
    ["the prompt arrives first", { submitStatus: "slow" as const }],
    ["the pause arrives first", { flowStatus: "paused-backpressure" as const }],
  ])("tracks a slow prompt and a backpressure pause when %s", (_order, first) => {
    const { rerender, container } = render(<TerminalStatusSlot id="t1" {...first} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(<TerminalStatusSlot id="t1" flowStatus="paused-backpressure" submitStatus="slow" />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").getAttribute("aria-label")).toMatch(
      /output paused.*prompt still sending/i
    );

    rerender(<TerminalStatusSlot id="t1" flowStatus="running" submitStatus="slow" />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Prompt still sending");

    rerender(<TerminalStatusSlot id="t1" flowStatus="running" />);
    expectIdle(container);
  });

  it("reports how long backpressure has held output", () => {
    mockTerminal = { id: "t1", kind: "terminal", heldDurationMs: 65_000 };
    render(<TerminalStatusSlot id="t1" flowStatus="paused-backpressure" />);
    expect(tooltipText()).toContain(`Paused for ${formatElapsedDuration(65_000)}`);
  });

  it("omits the held duration until one has accrued", () => {
    mockTerminal = { id: "t1", kind: "terminal", heldDurationMs: 0 };
    render(<TerminalStatusSlot id="t1" flowStatus="paused-backpressure" />);
    expect(tooltipText()).not.toContain("Paused for");
  });

  it("never claims a held duration for a memory-pressure pause, which has no duration producer", () => {
    mockTerminal = { id: "t1", kind: "terminal", heldDurationMs: 65_000 };
    render(<TerminalStatusSlot id="t1" flowStatus="paused-resource-governor" />);
    expect(tooltipText()).not.toContain("Paused for");
  });
});
