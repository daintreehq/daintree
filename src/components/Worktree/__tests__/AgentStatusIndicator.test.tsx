/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import {
  AgentStatusIndicator,
  agentStateDotColor,
  getDominantAgentState,
} from "../AgentStatusIndicator";
import type { AgentState } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("AgentStatusIndicator", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    ["working", "⟳"],
    ["completed", "✓"],
    ["exited", "–"],
    ["directing", "✎"],
  ] as const)("renders role=img with aria-label for state %s", (state, glyph) => {
    const { container } = render(<AgentStatusIndicator state={state} />);
    const el = container.querySelector('[role="img"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("aria-label")).toBe(`Agent status: ${state}`);
    expect(el?.textContent).toBe(glyph);
  });

  it("does not render role=status (no live-region spam)", () => {
    const { container } = render(<AgentStatusIndicator state="working" />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each([null, undefined, "idle", "waiting"] as const)("renders nothing for %s", (state) => {
    const { container } = render(
      <AgentStatusIndicator state={state as AgentState | null | undefined} />
    );
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("does not apply the flash class on first render (no pulse-on-mount)", () => {
    const { container } = render(<AgentStatusIndicator state="working" />);
    const el = container.querySelector('[role="img"]');
    expect(el?.className).not.toContain("animate-agent-pulse");
  });

  it("applies the flash class when agent state transitions", () => {
    const { container, rerender } = render(<AgentStatusIndicator state="working" />);
    rerender(<AgentStatusIndicator state="completed" />);
    const el = container.querySelector('[role="img"]');
    expect(el?.className).toContain("animate-agent-pulse");
  });

  it("clears the flash class after the safety timeout fires", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<AgentStatusIndicator state="working" />);
      rerender(<AgentStatusIndicator state="completed" />);
      let el = container.querySelector('[role="img"]') as HTMLElement;
      expect(el.className).toContain("animate-agent-pulse");

      // Under reduced-motion CSS sets `animation: none`, so `animationend`
      // never fires. The 250ms safety timeout must still clear the class so
      // subsequent transitions can re-arm it.
      act(() => {
        vi.advanceTimersByTime(260);
      });

      el = container.querySelector('[role="img"]') as HTMLElement;
      expect(el.className).not.toContain("animate-agent-pulse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-applies the flash class on each state transition (not a mount-only effect)", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<AgentStatusIndicator state="working" />);
      rerender(<AgentStatusIndicator state="directing" />);
      let el = container.querySelector('[role="img"]') as HTMLElement;
      expect(el.className).toContain("animate-agent-pulse");

      // Let the first flash clear via the safety timeout, then trigger a
      // second transition. If the latch bug returned, the class wouldn't
      // remove and re-add.
      act(() => {
        vi.advanceTimersByTime(260);
      });

      rerender(<AgentStatusIndicator state="completed" />);
      el = container.querySelector('[role="img"]') as HTMLElement;
      expect(el.className).toContain("animate-agent-pulse");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getDominantAgentState", () => {
  it("returns null when all states are undefined", () => {
    expect(getDominantAgentState([undefined, undefined])).toBeNull();
  });

  it("returns null when dominant state is idle", () => {
    expect(getDominantAgentState(["idle", "idle"])).toBeNull();
  });

  it("prefers working over lower-priority states", () => {
    expect(getDominantAgentState(["idle", "completed", "working"])).toBe("working");
  });

  it("prefers directing over completed", () => {
    expect(getDominantAgentState(["completed", "directing"])).toBe("directing");
  });

  // Documents the accepted trade-off: when a worktree has both a passive
  // working session and an actionable waiting session, the dominant state
  // resolves to working (priority 7 > 3), so agentStateDotColor returns null
  // and the toolbar dot is suppressed. WorktreeCard's border-flash animation
  // depends on working outranking waiting; the tray dot rides on the same
  // priority table. If this priority is ever inverted, this assertion fails
  // first as a guard.
  it("returns working when a worktree mixes working and waiting (suppresses tray dot)", () => {
    expect(getDominantAgentState(["working", "waiting"])).toBe("working");
  });
});

describe("agentStateDotColor", () => {
  // Exact class assertions guard the color mapping itself: a swap between
  // waiting and directing would still return a non-null string, so a
  // truthiness-only check would let the regression slip past.
  it("returns bg-state-waiting for waiting", () => {
    expect(agentStateDotColor("waiting")).toBe("bg-state-waiting");
  });

  it("returns bg-state-working for directing", () => {
    expect(agentStateDotColor("directing")).toBe("bg-state-working");
  });

  it.each([["working"], ["completed"], ["exited"], ["idle"]] as const)(
    "returns null for passive state %s (no dot rendered)",
    (state) => {
      expect(agentStateDotColor(state as AgentState)).toBeNull();
    }
  );
});
