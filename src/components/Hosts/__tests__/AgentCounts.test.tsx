// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { BlockedCircle, HollowCircle } from "@/components/icons";
import { AgentCounts } from "../AgentCounts";
import { makeSummary } from "../Overview/__tests__/fixtures";

afterEach(cleanup);

/** What a screen reader hears, and the counts drawn in each column, in order. */
function draw(summary: HostMetricsSummary, quietZero = false) {
  const { container } = render(<AgentCounts summary={summary} quietZero={quietZero} />);
  const cell = container.firstElementChild!;
  const columns = [...cell.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"]')];
  return {
    spoken: container.querySelector(".sr-only")?.textContent ?? "",
    drawn: columns.map((column) => column.textContent ?? ""),
    glyphs: columns.map((column) => column.children.length),
  };
}

describe("AgentCounts", () => {
  it("never draws or says a host's runs at their prompts are waiting (#16058)", () => {
    const summary = makeSummary({
      agentsObserved: { working: 1, waiting: 3, idle: 0 },
      agentAttention: { waiting: 0, blocked: 0, idle: 3 },
    });
    expect(draw(summary)).toEqual({
      spoken: "Agents: 1 working (observed)",
      drawn: ["", "1"],
      glyphs: [0, 1],
    });
  });

  it("draws every agent asking in the waiting column, and says the blocked ones apart", () => {
    const summary = makeSummary({
      agentsObserved: { working: 2, waiting: 3, idle: 0 },
      agentAttention: { waiting: 1, blocked: 1, idle: 1 },
    });
    expect(draw(summary)).toEqual({
      spoken: "Agents: 1 blocked, 1 waiting, 2 working (observed)",
      drawn: ["2", "2"],
      glyphs: [1, 1],
    });
  });

  it("wears the blocked glyph only when a run is blocked", () => {
    const askingGlyph = (attention: { waiting: number; blocked: number }) => {
      const { container } = render(
        <AgentCounts
          summary={makeSummary({
            agentsObserved: { working: 0, waiting: 2, idle: 0 },
            agentAttention: { ...attention, idle: 0 },
          })}
        />
      );
      const glyph = container.firstElementChild!.querySelector(
        ':scope > span[aria-hidden="true"] > *'
      )!;
      return { shape: glyph.innerHTML, tone: glyph.getAttribute("class") };
    };
    const shapeOf = (Glyph: typeof BlockedCircle) =>
      render(<Glyph />).container.firstElementChild!.innerHTML;

    const waiting = askingGlyph({ waiting: 2, blocked: 0 });
    const blocked = askingGlyph({ waiting: 1, blocked: 1 });
    expect(waiting.shape).toBe(shapeOf(HollowCircle));
    expect(blocked.shape).toBe(shapeOf(BlockedCircle));
    expect(blocked.tone).not.toBe(waiting.tone);
  });

  it("says nothing about waiting for a host too old to band its runs", () => {
    const summary = makeSummary({
      agentsObserved: { working: 0, waiting: 2, idle: 0 },
      agentAttention: undefined,
    });
    expect(draw(summary, true)).toEqual({
      spoken: "No agents working (observed)",
      drawn: [],
      glyphs: [],
    });
    expect(
      draw(
        makeSummary({
          agentAttention: { waiting: 0, blocked: 0, idle: 2 },
          agentsObserved: { working: 0, waiting: 2, idle: 0 },
        }),
        true
      ).spoken
    ).toBe("No agents waiting or working (observed)");
  });
});
