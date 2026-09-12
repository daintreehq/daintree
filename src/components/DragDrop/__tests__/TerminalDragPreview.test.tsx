// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { PanelInstance } from "@shared/types/panel";

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-terminal-icon="" />,
}));

import { TerminalDragPreview } from "../TerminalDragPreview";

function agentPanel(): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id: "p1",
    kind: "terminal",
    title: "Refund pipeline",
    location: "grid",
    isVisible: true,
    launchAgentId: "claude",
    runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
    agentState: "working",
  } as unknown as PanelInstance;
}

function titleBar(container: HTMLElement): HTMLElement {
  const title = [...container.querySelectorAll("span")].find(
    (el) => el.textContent === "Refund pipeline"
  );
  if (!title?.parentElement) throw new Error("title bar not rendered");
  return title.parentElement;
}

/**
 * A group drag carries two identifiers in the same corner — the tab count and
 * the agent-state glyph — and the badge used to sit on top of the glyph. The
 * rule is that both survive: the badge lives outside the card's clipping box
 * so it can overhang, and the title bar gives it room instead of the glyph.
 */
describe("TerminalDragPreview group badge", () => {
  it("renders the count outside the clipping wrapper so it can overhang the corner", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel()} groupTabCount={3} />);
    const clip = container.querySelector(".overflow-hidden");
    expect(clip).not.toBeNull();
    const badge = [...container.querySelectorAll("span")].find((el) => el.textContent === "3");
    expect(badge).toBeDefined();
    expect(clip!.contains(badge!)).toBe(false);
  });

  it("keeps the agent-state glyph alongside the count", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel()} groupTabCount={3} />);
    expect(container.querySelector(".animate-spin-slow")).not.toBeNull();
  });

  it("reserves title-bar room for the badge only on group drags", () => {
    const single = titleBar(render(<TerminalDragPreview terminal={agentPanel()} />).container);
    const group = titleBar(
      render(<TerminalDragPreview terminal={agentPanel()} groupTabCount={3} />).container
    );
    const singleClasses = new Set(single.className.split(/\s+/));
    const extra = group.className.split(/\s+/).filter((c) => !singleClasses.has(c));
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((c) => c.startsWith("pr-"))).toBe(true);
  });

  it("shows no badge for a single panel", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel()} />);
    expect([...container.querySelectorAll("span")].some((el) => el.textContent === "3")).toBe(
      false
    );
  });
});

describe("TerminalDragPreview chrome", () => {
  it("identifies the kind with the shared glyph component, not a bespoke mark", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel()} />);
    expect(container.querySelector("[data-terminal-icon]")).not.toBeNull();
  });

  it("never fades text with alpha or an inline colour", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel()} groupTabCount={3} />);
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.className.toString()).not.toMatch(/(?:^|\s)text-[a-z-]+\/\d+/);
      expect(el.style.color).toBe("");
    }
  });
});
