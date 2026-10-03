// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { segmentedParts } from "@/components/PluginKit/PluginKitDisplay";
import { chartColor } from "@/components/PluginKit/PluginKitCharts";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

afterEach(cleanup);

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

const plain = (value: number) => String(value);

const SPEND = [
  { value: 1200, label: "Housing" },
  { value: 600, label: "Food" },
  { value: 200, label: "Transport" },
];

function segments(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-segment]")];
}

function growOf(element: HTMLElement): number {
  return Math.round(Number.parseFloat(element.style.flexGrow) * 1000) / 1000;
}

function grows(): number[] {
  return segments().map(growOf);
}

describe("segmentedParts", () => {
  it("folds past the fifth part into one neutral Other, as a donut does", () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({
      value: index + 1,
      label: `P${index}`,
    }));
    const { parts, sum, whole } = segmentedParts(seven, undefined, plain);
    expect(parts.map((part) => part.label)).toEqual(["P0", "P1", "P2", "P3", "P4", "Other"]);
    expect(parts[5]?.value).toBe(6 + 7);
    expect(parts[5]?.color).toBe(chartColor("neutral"));
    expect(sum).toBe(28);
    expect(whole).toBe(28);
    // Six parts all keep their names.
    expect(
      segmentedParts(seven.slice(0, 6), undefined, plain).parts.map((part) => part.label)
    ).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
  });

  it("drops parts that are not sizes", () => {
    const { parts } = segmentedParts(
      [
        { value: 0, label: "Zero" },
        { value: -4, label: "Negative" },
        { value: Number.POSITIVE_INFINITY, label: "Infinite" },
        { value: "5", label: "String" },
        null,
        "junk",
        { value: 3, label: "Kept" },
      ],
      undefined,
      plain
    );
    expect(parts.map((part) => part.label)).toEqual(["Kept"]);
    expect(segmentedParts({ not: "an array" }, 10, plain).parts).toEqual([]);
  });

  it("takes the larger of the total and the sum, so shares never pass 100%", () => {
    const under = segmentedParts(SPEND, 1000, plain);
    expect(under.whole).toBe(2000);
    expect(under.parts.map((part) => part.share)).toEqual(["60%", "30%", "10%"]);
    const over = segmentedParts(SPEND, 4000, plain);
    expect(over.whole).toBe(4000);
    expect(over.parts.map((part) => part.share)).toEqual(["30%", "15%", "5%"]);
    expect(segmentedParts(SPEND, -1, plain).whole).toBe(2000);
  });

  it("drops a part whose size would overflow the sum", () => {
    const { parts, sum } = segmentedParts(
      [
        { value: 1e308, label: "Huge" },
        { value: 1e308, label: "Also huge" },
        { value: 1, label: "Small" },
      ],
      undefined,
      plain
    );
    expect(parts.map((part) => part.label)).toEqual(["Huge", "Small"]);
    expect(Number.isFinite(sum)).toBe(true);
    expect(parts[0]?.share).toBe("100%");
  });

  it("colours around pinned parts from the charts' slots", () => {
    const { parts } = segmentedParts(
      [
        { value: 1, label: "A" },
        { value: 1, label: "B", color: "blue" },
        { value: 1, label: "C", color: "chartreuse" },
      ],
      undefined,
      plain
    );
    expect(parts.map((part) => part.color)).toEqual([
      chartColor("amber"),
      chartColor("blue"),
      chartColor("indigo"),
    ]);
  });
});

describe("SegmentedBar", () => {
  it("draws one track of parts with a legend of values and shares", () => {
    render(
      withTooltips(
        createElement(kit.SegmentedBar, {
          segments: SPEND,
          label: "Monthly spend",
          "data-testid": "spend",
        })
      )
    );
    const bar = screen.getByTestId("spend");
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toBe(
      "Monthly spend: Housing 1,200, 60%; Food 600, 30%; Transport 200, 10%"
    );
    expect(grows()).toEqual([60, 30, 10]);
    expect(segments()[0]?.style.getPropertyValue("--kit-segment")).toBe(chartColor("blue"));
    // A filled bar leaves no empty track.
    expect(document.querySelector("[data-segment-rest]")).toBeNull();
    const legend = screen.getByRole("list", { name: "Legend" });
    expect([...legend.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Housing1,20060%",
      "Food60030%",
      "Transport20010%",
    ]);
    expect(legend.querySelectorAll("[data-chart-swatch='bar']")).toHaveLength(3);
    expect(document.body.textContent).toContain("Monthly spend");
  });

  it("leaves the rest of a larger total as empty track and says so", () => {
    render(
      withTooltips(
        createElement(kit.SegmentedBar, {
          segments: SPEND,
          label: "Budget",
          total: 4000,
          formatValue: (value: number) => `$${value}`,
          showLabel: false,
          legend: false,
          size: "md",
        })
      )
    );
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toBe(
      "Budget: Housing $1200, 30%; Food $600, 15%; Transport $200, 5%; of $4000"
    );
    expect(grows()).toEqual([30, 15, 5]);
    expect(growOf(document.querySelector<HTMLElement>("[data-segment-rest]")!)).toBe(50);
    expect(screen.queryByRole("list")).toBeNull();
    expect(document.body.textContent).toBe("");
    expect(bar.className).toContain("h-2.5");
  });

  it("fills the whole track with fractional parts", () => {
    render(
      withTooltips(
        createElement(kit.SegmentedBar, {
          segments: [
            { value: 0.1, label: "A" },
            { value: 0.3, label: "B" },
          ],
          label: "Fractions",
        })
      )
    );
    // Grow factors summing below 1 would leave track unclaimed.
    expect(grows()).toEqual([25, 75]);
    expect(document.querySelector("[data-segment-rest]")).toBeNull();
  });

  it("uses a part's own words in the legend and the name", () => {
    render(
      withTooltips(
        createElement(kit.SegmentedBar, {
          segments: [
            { value: 3, label: "Held", valueText: "three lots" },
            { value: 1, label: "Spare" },
          ],
          label: "Lots",
        })
      )
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Lots: Held three lots; Spare 1, 25%"
    );
    const items = screen.getByRole("list", { name: "Legend" }).querySelectorAll("li");
    expect([...items].map((item) => item.textContent)).toEqual(["Heldthree lots", "Spare125%"]);
  });

  it("marks the track and names each part in its tooltip", async () => {
    render(
      withTooltips(
        createElement(kit.SegmentedBar, {
          segments: SPEND,
          label: "Spend",
          total: 2500,
          marks: [
            { value: 2250, label: "Target", head: true },
            // @ts-expect-error a mark with no value, as untyped JS can send
            { label: "No value" },
          ],
        })
      )
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Spend: Housing 1,200, 48%; Food 600, 24%; Transport 200, 8%; of 2,500; Target at 2,250"
    );
    const marks = [...document.querySelectorAll<HTMLElement>("[data-track-mark]")];
    expect(marks.map((mark) => mark.style.left)).toEqual(["90%"]);
    await act(async () => {
      fireEvent.pointerMove(segments()[1]!, { pointerType: "mouse" });
    });
    const tip = await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 });
    expect(tip.textContent).toBe("Food: 600, 24%");
  });

  it("survives bad props", () => {
    const untyped = {
      segments: "nope",
      label: 4,
      total: "lots",
      size: "huge",
      marks: { value: 1 },
      formatValue: "money",
    };
    // @ts-expect-error the untyped shape a JavaScript view can send
    expect(() => render(withTooltips(createElement(kit.SegmentedBar, untyped)))).not.toThrow();
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toBe("Parts: no data");
    expect(bar.className).toContain("h-1.5");
    expect(segments()).toHaveLength(0);
  });
});
