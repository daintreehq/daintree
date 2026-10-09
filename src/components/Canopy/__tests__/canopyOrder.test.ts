import { describe, expect, it } from "vitest";
import {
  CANOPY_RANK_IDLE_MS,
  CANOPY_RANK_SPACING_MS,
  nextCanopyOrder,
  type CanopyOrder,
  type CanopyRankInput,
} from "../canopyOrder";

const NOW = 1_000_000;

function input(
  priorities: Record<string, number>,
  extra: Partial<CanopyRankInput> = {}
): CanopyRankInput {
  const fresh = Object.keys(priorities).sort((a, b) => priorities[b]! - priorities[a]!);
  return {
    fresh,
    priorities: new Map(Object.entries(priorities)),
    urgent: [],
    refreshedAt: 2,
    now: NOW,
    opening: false,
    requested: false,
    pressing: false,
    pointerInList: false,
    lastInteractionAt: 0,
    lastRankAt: 0,
    ...extra,
  };
}

function order(ids: string[], extra: Partial<CanopyOrder> = {}): CanopyOrder {
  return { ids, rankedFor: 1, urgent: [], ...extra };
}

function idsOf(step: ReturnType<typeof nextCanopyOrder>): readonly string[] | null {
  return step.kind === "set" ? step.order.ids : null;
}

describe("nextCanopyOrder", () => {
  it("moves rows past one another only where one's priority now beats the other's", () => {
    // b and c tie, so they keep their places; d now outranks both.
    const step = nextCanopyOrder(
      order(["a", "b", "c", "d"]),
      input({ a: 90, c: 55, b: 55, d: 60 })
    );
    expect(idsOf(step)).toEqual(["a", "d", "b", "c"]);
  });

  it("holds the order until the user has paused and the last rank is a while ago", () => {
    const held = order(["b", "a"]);
    const priorities = { a: 90, b: 40 };
    expect(
      nextCanopyOrder(held, input(priorities, { lastInteractionAt: NOW - 1_000, lastRankAt: 0 }))
    ).toEqual({ kind: "wait", ms: CANOPY_RANK_IDLE_MS - 1_000 });
    expect(nextCanopyOrder(held, input(priorities, { lastRankAt: NOW - 2_000 }))).toEqual({
      kind: "wait",
      ms: CANOPY_RANK_SPACING_MS - 2_000,
    });
    expect(nextCanopyOrder(held, input(priorities, { pointerInList: true }))).toEqual({
      kind: "hold",
    });
    expect(idsOf(nextCanopyOrder(held, input(priorities)))).toEqual(["a", "b"]);
  });

  it("never re-ranks for a scan that read nothing new", () => {
    expect(nextCanopyOrder(order(["b", "a"], { rankedFor: 2 }), input({ a: 90, b: 40 }))).toEqual({
      kind: "hold",
    });
  });

  it("re-ranks at once on Refresh, whatever the hold", () => {
    const step = nextCanopyOrder(
      order(["b", "a"], { rankedFor: 2 }),
      input({ a: 90, b: 40 }, { requested: true, pointerInList: true })
    );
    expect(idsOf(step)).toEqual(["a", "b"]);
  });

  it("moves an ask newly urgent up to its place alone, leaving the rest where they are", () => {
    const step = nextCanopyOrder(
      order(["a", "b", "c", "d"], { rankedFor: 2 }),
      input({ a: 98, d: 94, b: 50, c: 40 }, { urgent: ["a", "d"] })
    );
    // Only d moves; b and c keep their order though the readers rank them otherwise.
    expect(idsOf(step)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the row under a press where it is, and places the ask once it is let go", () => {
    const held = order(["a", "b"], { rankedFor: 2 });
    const pressed = nextCanopyOrder(
      held,
      input({ a: 50, b: 94 }, { urgent: ["b"], pressing: true })
    );
    expect(pressed).toEqual({ kind: "hold" });
    expect(idsOf(nextCanopyOrder(held, input({ a: 50, b: 94 }, { urgent: ["b"] })))).toEqual([
      "b",
      "a",
    ]);
  });

  it("never re-ranks under a held press, however long it is held", () => {
    expect(nextCanopyOrder(order(["b", "a"]), input({ a: 90, b: 40 }, { pressing: true }))).toEqual(
      { kind: "hold" }
    );
  });

  it("drops runs that left before promoting an ask past the rest", () => {
    const step = nextCanopyOrder(
      order(["a", "gone", "b", "d"], { rankedFor: 2, urgent: ["a", "b"] }),
      input({ a: 98, b: 99, d: 94 }, { urgent: ["a", "b", "d"] })
    );
    // d is urgent now, but b outranks it: d stays below b.
    expect(idsOf(step)).toEqual(["a", "b", "d"]);
  });

  it("places an ask again when it stops being urgent and later asks again", () => {
    const urgentOnce = order(["b", "a"], { rankedFor: 2, urgent: ["a"] });
    const quiet = nextCanopyOrder(urgentOnce, input({ b: 60, a: 40 }, { urgent: [] }));
    expect(quiet.kind).toBe("set");
    const settled = quiet.kind === "set" ? quiet.order : urgentOnce;
    expect(settled.ids).toEqual(["b", "a"]);
    expect(
      idsOf(
        nextCanopyOrder(settled, input({ a: 95, b: 60 }, { urgent: ["a"], pointerInList: true }))
      )
    ).toEqual(["a", "b"]);
  });

  it("puts a run that arrived after the rest, without moving the others", () => {
    const step = nextCanopyOrder(
      order(["b", "a"], { rankedFor: 2 }),
      input({ a: 90, b: 40, c: 70 })
    );
    expect(idsOf(step)).toEqual(["b", "a", "c"]);
  });

  it("opens in the order it was left, ranked first only when something was read meanwhile", () => {
    expect(
      nextCanopyOrder(
        order(["b", "a"], { rankedFor: 2 }),
        input({ a: 90, b: 40 }, { opening: true })
      )
    ).toEqual({ kind: "hold" });
    expect(
      idsOf(nextCanopyOrder(order(["b", "a"]), input({ a: 90, b: 40 }, { opening: true })))
    ).toEqual(["a", "b"]);
    expect(idsOf(nextCanopyOrder(null, input({ a: 40, b: 90 }, { opening: true })))).toEqual([
      "b",
      "a",
    ]);
  });
});
