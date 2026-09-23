/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AgentState } from "@/types";
import { CollapsedSessionIndicators } from "../CollapsedSessionIndicators";
import { TooltipProvider } from "@/components/ui/tooltip";
import { STATE_COLORS, summarizeSessionStates } from "../../terminalStateConfig";

/**
 * Rendered against the real tooltip primitive (`vitest.setup.ts` primes it), so
 * the hover assertions exercise the same Radix trigger the sidebar does.
 */

afterEach(cleanup);

const ZERO: Record<AgentState, number> = {
  idle: 0,
  working: 0,
  waiting: 0,
  directing: 0,
  completed: 0,
  exited: 0,
};

/** The states `getTerminalAgentDisplayState` can actually hand the cluster. */
const REACHABLE = ["working", "directing", "waiting"] as const;

/** The drawn glyph: an svg ring, or the CSS-drawn spinner box. */
const glyphOf = (seg: Element): Element => seg.querySelector("svg, [data-glyph-box]")!;

function renderCluster(byState: Partial<Record<AgentState, number>>, total?: number) {
  const counts = { ...ZERO, ...byState };
  const sum = total ?? Object.values(counts).reduce((a, b) => a + b, 0);
  const summary = summarizeSessionStates(counts, sum);
  render(
    <TooltipProvider delayDuration={0}>
      <button type="button">
        <CollapsedSessionIndicators
          visibleStates={summary.visibleStates}
          sessionAriaLabel={summary.label}
        />
      </button>
    </TooltipProvider>
  );
  const root = screen.getByTestId("collapsed-session-indicators");
  const segments = Array.from(root.querySelectorAll<HTMLElement>("[data-state]"));
  return { root, segments, summary };
}

describe("summarizeSessionStates", () => {
  it("states the total separately, because the breakdown leaves idle out", () => {
    const { label, visibleStates } = summarizeSessionStates({ ...ZERO, working: 2, idle: 3 }, 5);
    const segmentSum = visibleStates.reduce((a, v) => a + v.count, 0);
    expect(segmentSum).toBeLessThan(5);
    expect(label.startsWith("5 sessions")).toBe(true);
  });

  it("never lists a state with nothing in it, nor idle", () => {
    const { visibleStates } = summarizeSessionStates(
      { ...ZERO, working: 1, idle: 4, waiting: 0 },
      5
    );
    expect(visibleStates.every((v) => v.count > 0)).toBe(true);
    expect(visibleStates.some((v) => v.state === "idle")).toBe(false);
  });

  it("leaves no dangling colon when every session is idle", () => {
    const { label, breakdown } = summarizeSessionStates({ ...ZERO, idle: 2 }, 2);
    expect(breakdown).toBe("");
    expect(label.endsWith(":")).toBe(false);
    expect(label.endsWith(": ")).toBe(false);
  });

  it("says nothing when there are no sessions", () => {
    expect(summarizeSessionStates(ZERO, 0).label).toBe("");
  });

  it("agrees with its own segments: every segment's count and label appears in the breakdown", () => {
    const { visibleStates, breakdown } = summarizeSessionStates(
      { ...ZERO, working: 3, directing: 1, waiting: 2 },
      6
    );
    const parts = breakdown.split(", ");
    expect(parts).toHaveLength(visibleStates.length);
    visibleStates.forEach((v, i) => expect(parts[i]!.startsWith(`${v.count} `)).toBe(true));
  });
});

describe("CollapsedSessionIndicators", () => {
  it("renders one segment per listed state, in the order it is given", () => {
    const { segments, summary } = renderCluster({ working: 2, directing: 1, waiting: 4 });
    expect(segments.map((s) => s.dataset.state)).toEqual(summary.visibleStates.map((v) => v.state));
    expect(segments.map((s) => s.textContent)).toEqual(
      summary.visibleStates.map((v) => String(v.count))
    );
  });

  it("is one image to assistive tech: the name carries it and nothing inside is spoken twice", () => {
    const { root, segments, summary } = renderCluster({ working: 2, waiting: 1 });
    expect(root.getAttribute("role")).toBe("img");
    expect(root.getAttribute("aria-label")).toBe(summary.label);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) expect(seg.getAttribute("aria-hidden")).toBe("true");
  });

  it("is phrasing content, so it is valid inside the Sessions disclosure button", () => {
    const { root } = renderCluster({ working: 1, waiting: 1 });
    const button = root.closest("button");
    expect(button).not.toBeNull();
    expect(button!.querySelector("div, p, section, ul, ol")).toBeNull();
  });

  it("stays non-interactive, so a click reaches the row it sits on", () => {
    const { root } = renderCluster({ working: 1 });
    expect(root.hasAttribute("tabindex")).toBe(false);
    expect(root.querySelector("button, a, [tabindex]")).toBeNull();
    expect(root.className).not.toContain("pointer-events-none");
  });

  it("gives every reachable state its own glyph shape, so forced colors can still tell them apart", () => {
    const { segments } = renderCluster({ working: 1, directing: 1, waiting: 1 });
    expect(segments.map((s) => s.dataset.state).sort()).toEqual([...REACHABLE].sort());
    const shapes = segments.map((seg) => {
      const glyph = glyphOf(seg);
      return glyph.tagName === "svg"
        ? glyph.innerHTML
        : `css:${glyph.getAttribute("data-glyph-box")}`;
    });
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("animates only the working glyph, and lets reduced motion stop it", () => {
    const { segments } = renderCluster({ working: 1, directing: 1, waiting: 1 });
    for (const seg of segments) {
      const cls = glyphOf(seg).getAttribute("class") ?? "";
      const spins = /\banimate-/.test(cls);
      expect(spins, `${seg.dataset.state} spin`).toBe(seg.dataset.state === "working");
      if (spins) expect(cls).toContain("motion-reduce:animate-none");
    }
  });

  it("draws the glyph box larger than its numeral, whatever the scale", () => {
    // The ring paints at 5/6 of its box, so a box only as tall as the numeral's
    // font size draws a ring smaller than the digit beside it — ~8px at the old
    // 10px step, where working and waiting separated on hue alone.
    const { segments } = renderCluster({ working: 1, waiting: 1 });
    for (const seg of segments) {
      const glyphCls = glyphOf(seg).getAttribute("class") ?? "";
      const size = glyphCls.match(/\bw-(\d+(?:\.\d+)?)\b/);
      expect(size, "glyph has no width step").not.toBeNull();
      const textStep = seg.className.match(/\btext-(3xs|2xs|xs)\b/)?.[1] ?? "xs";
      const textPx = textStep === "3xs" ? 10 : textStep === "2xs" ? 11 : 12;
      expect(Number(size![1]) * 4).toBeGreaterThan(textPx);
    }
  });

  it("keeps the hue on the glyph, reachable by forced colors, and the count neutral", () => {
    // State colours are tuned as graphics (3:1). As 11px text they drop under
    // 4.5:1 in every light theme, so no count may inherit one, while each glyph
    // must still carry its own state's hue.
    const stateHues = new Set<string>(REACHABLE.map((state) => STATE_COLORS[state]));
    const { segments } = renderCluster({ working: 1, directing: 1, waiting: 1 });
    for (const seg of segments) {
      const count = seg.querySelector(".tabular-nums")!;
      const inherited = [seg, count].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
      expect(
        inherited.filter((c) => stateHues.has(c)),
        `${seg.dataset.state} count is state-coloured`
      ).toEqual([]);
      // The hue has to sit on an HTML element the glyph inherits from: forced
      // colors repaints that element's `color`, but a colour set on the svg
      // itself survives and left waiting amber on white at 1.7:1.
      const hued = Array.from(seg.querySelectorAll("*")).filter((el) =>
        (el.getAttribute("class") ?? "").split(/\s+/).some((c) => stateHues.has(c))
      );
      expect(hued, `${seg.dataset.state} glyph carries no state hue`).toHaveLength(1);
      expect(hued[0]!.tagName.toLowerCase()).not.toBe("svg");
      expect(hued[0]!.contains(glyphOf(seg))).toBe(true);
    }
  });

  it("puts the full name, total included, in the tooltip", async () => {
    const { root, summary } = renderCluster({ working: 2, waiting: 1, idle: 2 });
    fireEvent.pointerEnter(root, { pointerType: "mouse" });
    fireEvent.pointerMove(root, { pointerType: "mouse" });
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe(summary.label);
  });
});
