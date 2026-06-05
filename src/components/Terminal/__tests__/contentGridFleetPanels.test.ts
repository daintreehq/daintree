import { describe, it, expect } from "vitest";
import { buildFleetPanels } from "../contentGridFleetPanels";
import type { PanelLocation, PtyPanelData } from "@shared/types/panel";

function makePanel(id: string, location: PanelLocation): PtyPanelData {
  return { id, kind: "terminal", title: id, location } as PtyPanelData;
}

describe("buildFleetPanels", () => {
  it("includes grid panels and excludes non-grid placements", () => {
    const panels = {
      g1: makePanel("g1", "grid"),
      d1: makePanel("d1", "dock"),
      o1: makePanel("o1", "overlay"),
      t1: makePanel("t1", "trash"),
      b1: makePanel("b1", "background"),
    };
    const order = ["g1", "d1", "o1", "t1", "b1"];
    const armed = new Set(order);

    const result = buildFleetPanels(order, armed, panels);

    expect(result.map((p) => p.id)).toEqual(["g1"]);
  });

  it("never admits the overlay assistant into the fleet (#9699)", () => {
    const panels = {
      agent: makePanel("agent", "grid"),
      assistant: makePanel("assistant", "overlay"),
    };
    const order = ["agent", "assistant"];

    const result = buildFleetPanels(order, new Set(order), panels);

    expect(result.map((p) => p.id)).toEqual(["agent"]);
    expect(result.some((p) => p.id === "assistant")).toBe(false);
  });

  it("respects arm order and arm membership", () => {
    const panels = {
      a: makePanel("a", "grid"),
      b: makePanel("b", "grid"),
      c: makePanel("c", "grid"),
    };
    // c first in order, b not armed.
    const result = buildFleetPanels(["c", "a", "b"], new Set(["c", "a"]), panels);

    expect(result.map((p) => p.id)).toEqual(["c", "a"]);
  });
});
