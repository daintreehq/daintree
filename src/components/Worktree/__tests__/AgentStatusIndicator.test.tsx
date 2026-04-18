/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AgentStatusIndicator, getDominantAgentState } from "../AgentStatusIndicator";
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
    ["running", "▶"],
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
});

describe("getDominantAgentState", () => {
  it("returns null when all states are undefined", () => {
    expect(getDominantAgentState([undefined, undefined])).toBeNull();
  });

  it("returns null when dominant state is idle", () => {
    expect(getDominantAgentState(["idle", "idle"])).toBeNull();
  });

  it("prefers working over lower-priority states", () => {
    expect(getDominantAgentState(["idle", "running", "working"])).toBe("working");
  });

  it("prefers directing over running", () => {
    expect(getDominantAgentState(["running", "directing"])).toBe("directing");
  });
});
