// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { SESSION_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { PanelInstance } from "@shared/types/panel";

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-terminal-icon="" />,
}));

import { TerminalDragPreview } from "../TerminalDragPreview";

function agentPanel(agentState = "working"): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id: "p1",
    kind: "terminal",
    title: "Refund pipeline",
    location: "grid",
    isVisible: true,
    launchAgentId: "claude",
    runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
    agentState,
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

  it("shows a badge only when more than one tab is carried", () => {
    const badge = (count?: number) =>
      render(
        <TerminalDragPreview terminal={agentPanel()} groupTabCount={count} />
      ).container.querySelector('[data-slot="badge"]');
    expect(badge()).toBeNull();
    expect(badge(1)).toBeNull();
    expect(badge(3)?.textContent).toBe("3");
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

// The ghost draws the pane's own glyph (#16057): amber only for an unread
// Canopy ask, never for a prompt that asks nothing.
describe("TerminalDragPreview glyph from the fleet band", () => {
  afterEach(() => {
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  function deliverRun(overrides: Partial<FleetRunRow>) {
    act(() => {
      useFleetSnapshotStore.getState().applySnapshot({
        runs: [
          {
            runId: "p1",
            workspaceId: "w1",
            spawnedAt: 1,
            cwd: "/repo",
            agentState: "waiting",
            ...overrides,
          },
        ],
        changedAt: 2,
        degraded: false,
        lastSuccessfulAt: 2,
      });
    });
  }
  // The single drag's only svg is the state glyph: the kind icon is stubbed.
  const glyphClass = (container: HTMLElement) =>
    container.querySelector("svg")?.getAttribute("class") ?? null;

  it("draws nothing for a prompt that asks nothing, and the amber ring for an unread ask", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel("waiting")} />);
    deliverRun({});
    expect(glyphClass(container)).toBeNull();
    deliverRun({ canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } });
    expect(glyphClass(container)).toContain(SESSION_COLORS.waiting);
  });

  it("draws a hand-back unread, then finished once read", () => {
    const { container } = render(<TerminalDragPreview terminal={agentPanel("waiting")} />);
    deliverRun({ handBack: { stoppedAt: 1 } });
    expect(glyphClass(container)).toContain(SESSION_COLORS.unread);
    deliverRun({ handBack: { stoppedAt: 1, seenAt: 2 } });
    expect(glyphClass(container)).toContain(SESSION_COLORS.completed);
    expect(glyphClass(container)).not.toContain(SESSION_COLORS.waiting);
  });
});
