import { describe, expect, it } from "vitest";
import {
  CANOPY_RANK_IDLE_MS,
  CANOPY_RANK_SPACING_MS,
  canopyReorderWaiting,
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
    needsYou: [],
    selected: null,
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
  return { ids, rankedFor: 1, urgent: [], band: [], ...extra };
}

function idsOf(step: ReturnType<typeof nextCanopyOrder>): readonly string[] | null {
  return step.kind === "set" ? step.order.ids : null;
}

describe("nextCanopyOrder", () => {
  it("moves rows past one another only where one's priority now beats the other's", () => {
    // b and c tie, so they keep their places; d now clearly outranks both.
    const step = nextCanopyOrder(
      order(["a", "b", "c", "d"]),
      input({ a: 90, c: 55, b: 55, d: 70 })
    );
    expect(idsOf(step)).toEqual(["a", "d", "b", "c"]);
  });

  it("holds through a refinement of a few points, and moves for one that clearly outranks", () => {
    // A score refined from 50 to 58 is still 50's neighbour: nothing moves.
    expect(idsOf(nextCanopyOrder(order(["a", "b", "c"]), input({ a: 50, b: 52, c: 58 })))).toEqual([
      "a",
      "b",
      "c",
    ]);
    // At 60 it clearly beats a and b and goes above both, in one move.
    expect(idsOf(nextCanopyOrder(order(["a", "b", "c"]), input({ a: 50, b: 50, c: 60 })))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("never leaves a row below one it clearly beats, however small each step between them", () => {
    // Each neighbour is within the margin of the next, but 86 beats 70 by 16.
    const ids = idsOf(nextCanopyOrder(order(["a", "b", "c"]), input({ a: 70, b: 78, c: 86 })));
    expect(ids).not.toBeNull();
    const priorities: Record<string, number> = { a: 70, b: 78, c: 86 };
    for (const [i, above] of ids!.entries()) {
      for (const below of ids!.slice(i + 1)) {
        expect(priorities[below]! - priorities[above]!).toBeLessThan(10);
      }
    }
    // And it moved only what it had to: c above a, passing b on the way since
    // it can't be above a and below b; b keeps its place.
    expect(ids).toEqual(["c", "a", "b"]);
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

  it("places an ask newly urgent by the readers on an open or a Refresh, however near the row above", () => {
    // b turns urgent while the list is closed, a few points above a.
    const left = order(["a", "b"]);
    const priorities = { a: 84, b: 90 };
    expect(
      idsOf(nextCanopyOrder(left, input(priorities, { opening: true, urgent: ["b"] })))
    ).toEqual(["b", "a"]);
    expect(
      idsOf(
        nextCanopyOrder(
          order(["a", "b"], { rankedFor: 2 }),
          input(priorities, { requested: true, urgent: ["b"] })
        )
      )
    ).toEqual(["b", "a"]);
    // Already urgent at the last rank: the margin holds it like any other row.
    expect(
      idsOf(
        nextCanopyOrder(
          order(["a", "b"], { urgent: ["b"] }),
          input(priorities, { opening: true, urgent: ["b"] })
        )
      )
    ).toEqual(["a", "b"]);
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

  it("places each score as it lands while revealing, before the scan ends", () => {
    const step = nextCanopyOrder(
      order(["b", "a"], { rankedFor: 2 }),
      input({ a: 90, b: 40 }, { revealing: true })
    );
    expect(idsOf(step)).toEqual(["a", "b"]);
    expect(
      nextCanopyOrder(
        order(["a", "b"], { rankedFor: 2 }),
        input({ a: 90, b: 40 }, { revealing: true })
      )
    ).toEqual({ kind: "hold" });
    expect(
      nextCanopyOrder(
        order(["b", "a"], { rankedFor: 2 }),
        input({ a: 90, b: 40 }, { revealing: true, pressing: true })
      )
    ).toEqual({ kind: "hold" });
  });

  it("holds a revealing list under the pointer, but still places an ask newly urgent", () => {
    expect(
      nextCanopyOrder(
        order(["b", "a"], { rankedFor: 2 }),
        input({ a: 90, b: 40 }, { revealing: true, pointerInList: true })
      )
    ).toEqual({ kind: "hold" });
    expect(
      idsOf(
        nextCanopyOrder(
          order(["b", "a"], { rankedFor: 2 }),
          input({ a: 95, b: 40 }, { revealing: true, pointerInList: true, urgent: ["a"] })
        )
      )
    ).toEqual(["a", "b"]);
  });

  it("offers a held reorder only once a scan has read one that clears the margin", () => {
    // A scan landed since the rank, and the run it read clearly passes another.
    expect(canopyReorderWaiting(order(["b", "a"]), input({ a: 90, b: 40 }))).toBe(true);
    // Nothing read since the rank: the clock alone never offers a move.
    expect(canopyReorderWaiting(order(["b", "a"], { rankedFor: 2 }), input({ a: 90, b: 40 }))).toBe(
      false
    );
    // Read, but within the margin: noise, not a move.
    expect(canopyReorderWaiting(order(["b", "a"]), input({ a: 45, b: 40 }))).toBe(false);
    expect(canopyReorderWaiting(order(["a", "b"]), input({ a: 90, b: 40 }))).toBe(false);
    expect(canopyReorderWaiting(null, input({ a: 90, b: 40 }))).toBe(false);
  });
});

describe("the Needs you band", () => {
  const bandOf = (step: ReturnType<typeof nextCanopyOrder>) =>
    step.kind === "set" ? [...step.order.band].sort() : null;

  it("keeps who is in it through a reading that crosses the floor, until the list may re-rank", () => {
    // No scan since the rank: b's reading moved over the floor, and c's under it.
    const held = order(["a", "b", "c"], { rankedFor: 2, band: ["a", "c"] });
    const now = { a: 90, b: 60, c: 50 };
    const crossed = { needsYou: ["a", "b"] };
    expect(
      nextCanopyOrder(held, input(now, { ...crossed, lastInteractionAt: NOW - 1_000 }))
    ).toEqual({ kind: "wait", ms: CANOPY_RANK_IDLE_MS - 1_000 });
    expect(nextCanopyOrder(held, input(now, { ...crossed, pointerInList: true }))).toEqual({
      kind: "hold",
    });
    // The held change is the reorder the panel offers, though no scan read anything.
    expect(canopyReorderWaiting(held, input(now, crossed))).toBe(true);
    // Once the user leaves the list alone, the band takes who needs them now.
    expect(bandOf(nextCanopyOrder(held, input(now, crossed)))).toEqual(["a", "b"]);
  });

  it("leaves who is in it alone when a run arrives or leaves while the list holds", () => {
    const held = order(["a", "gone", "b"], { rankedFor: 2, band: ["a", "gone"] });
    const step = nextCanopyOrder(
      held,
      input({ a: 90, b: 60, c: 70 }, { needsYou: ["a", "b", "c"], pointerInList: true })
    );
    expect(idsOf(step)).toEqual(["a", "b", "c"]);
    expect(bandOf(step)).toEqual(["a"]);
  });

  it("keeps a handled row in it while it is selected, and lets it go at a rank once it isn't", () => {
    // a was replied to: it no longer needs the user, and ranks below b now.
    const held = order(["a", "b"], { rankedFor: 2, band: ["a", "b"] });
    const replied = { a: 0, b: 70 };
    const onA = { needsYou: ["b"], selected: "a" };
    expect(nextCanopyOrder(held, input(replied, onA))).toEqual({ kind: "hold" });
    expect(canopyReorderWaiting(held, input(replied, onA))).toBe(false);
    // A scan lands and the list re-ranks: a moves below b, but stays in the band.
    const ranked = nextCanopyOrder(held, input(replied, { ...onA, refreshedAt: 3 }));
    expect(idsOf(ranked)).toEqual(["b", "a"]);
    expect(bandOf(ranked)).toEqual(["a", "b"]);

    // The user moves to b: a is held in the band until the list may re-rank.
    const settled = ranked.kind === "set" ? ranked.order : held;
    const onB = { needsYou: ["b"], selected: "b", refreshedAt: 3 };
    expect(
      nextCanopyOrder(settled, input(replied, { ...onB, lastInteractionAt: NOW - 1_000 }))
    ).toEqual({ kind: "wait", ms: CANOPY_RANK_IDLE_MS - 1_000 });
    expect(canopyReorderWaiting(settled, input(replied, onB))).toBe(true);
    expect(bandOf(nextCanopyOrder(settled, input(replied, onB)))).toEqual(["b"]);
  });

  it("never puts a selected run into it that wasn't there", () => {
    const step = nextCanopyOrder(
      order(["a", "b"], { band: ["a"] }),
      input({ a: 90, b: 20 }, { needsYou: ["a"], selected: "b" })
    );
    expect(bandOf(step)).toEqual(["a"]);
  });

  it("keeps a replied urgent ask in it when it stops paging the user", () => {
    const held = order(["b", "a"], { rankedFor: 2, urgent: ["b"], band: ["b"] });
    const step = nextCanopyOrder(
      held,
      input({ a: 40, b: 0 }, { urgent: [], needsYou: [], pointerInList: true })
    );
    expect(step).toEqual({ kind: "set", order: { ...held, urgent: [] }, ranked: false });
  });

  it("takes an ask newly urgent at once, even under the pointer, but not under a press", () => {
    const held = order(["a", "b"], { rankedFor: 2, band: ["a"] });
    const paged = { urgent: ["b"], needsYou: ["a", "b"], pointerInList: true };
    const step = nextCanopyOrder(held, input({ a: 70, b: 95 }, paged));
    expect(idsOf(step)).toEqual(["b", "a"]);
    expect(bandOf(step)).toEqual(["a", "b"]);
    expect(nextCanopyOrder(held, input({ a: 70, b: 95 }, { ...paged, pressing: true }))).toEqual({
      kind: "hold",
    });
  });

  it("ranks who is in it afresh on an open, a Refresh and a reveal", () => {
    const held = order(["a", "b"], { rankedFor: 2, band: ["a"] });
    const now = { a: 90, b: 60 };
    const needs = { needsYou: ["a", "b"], pointerInList: true };
    expect(bandOf(nextCanopyOrder(held, input(now, { ...needs, opening: true })))).toEqual([
      "a",
      "b",
    ]);
    expect(bandOf(nextCanopyOrder(held, input(now, { ...needs, requested: true })))).toEqual([
      "a",
      "b",
    ]);
    expect(
      bandOf(nextCanopyOrder(held, input(now, { needsYou: ["a", "b"], revealing: true })))
    ).toEqual(["a", "b"]);
    // With nothing changed, an open holds still.
    expect(
      nextCanopyOrder(
        order(["a", "b"], { rankedFor: 2, band: ["a", "b"] }),
        input(now, { ...needs, opening: true })
      )
    ).toEqual({ kind: "hold" });
  });
});
