import { describe, expect, it } from "vitest";
import { placeMenuAtCaret } from "../useAutocompletePositioning";

const VIEWPORT = { width: 1600, height: 1000 };

/** An Expanded Editor frame at (100, 200), 1000 × 500, with no border. */
function frame(overrides: Partial<{ clientLeft: number; clientTop: number }> = {}) {
  return {
    rect: { left: 100, top: 200, right: 1100, bottom: 700 },
    clientLeft: overrides.clientLeft ?? 0,
    clientTop: overrides.clientTop ?? 0,
    clientHeight: 500 - 2 * (overrides.clientTop ?? 0),
  };
}

/** The menu's box in the frame's padding box, at its tallest. */
function box(placement: ReturnType<typeof placeMenuAtCaret>, frameHeight: number) {
  const height = placement.maxHeight ?? 0;
  const top =
    placement.side === "below" ? placement.top! : frameHeight - placement.bottom! - height;
  // The menu's own 420px, narrowed to what it is allowed.
  const width = Math.min(420, placement.maxWidth ?? 0);
  return { top, bottom: top + height, left: placement.left, width };
}

describe("placeMenuAtCaret", () => {
  it("opens below a token near the top of the editor, inside the frame", () => {
    const token = { left: 140, top: 230, bottom: 250 };
    const placement = placeMenuAtCaret(frame(), token, VIEWPORT);
    const menu = box(placement, 500);

    expect(placement.side).toBe("below");
    expect(menu.top).toBeGreaterThanOrEqual(token.bottom - 200);
    expect(menu.bottom).toBeLessThanOrEqual(500);
    expect(placement.left).toBe(token.left - 100);
  });

  it("opens above a token near the foot of the editor, clear of its line", () => {
    const token = { left: 140, top: 640, bottom: 660 };
    const placement = placeMenuAtCaret(frame(), token, VIEWPORT);
    const menu = box(placement, 500);

    expect(placement.side).toBe("above");
    expect(menu.bottom).toBeLessThanOrEqual(token.top - 200);
    expect(menu.top).toBeGreaterThanOrEqual(0);
  });

  it("clears every line of a token whose query wraps", () => {
    const token = { left: 140, top: 230, bottom: 290 };
    const placement = placeMenuAtCaret(frame(), token, VIEWPORT);

    expect(placement.side).toBe("below");
    expect(placement.top).toBeGreaterThanOrEqual(token.bottom - 200);
  });

  it("shifts left to stay inside the frame at its right edge", () => {
    const token = { left: 1050, top: 230, bottom: 250 };
    const placement = placeMenuAtCaret(frame(), token, VIEWPORT);

    const menu = box(placement, 500);

    expect(menu.left).toBeLessThan(token.left - 100);
    expect(menu.left + menu.width).toBeLessThanOrEqual(1000);
  });

  it("fits the window where the window ends before the frame", () => {
    const token = { left: 140, top: 230, bottom: 250 };
    const placement = placeMenuAtCaret(frame(), token, { width: 800, height: 600 });
    const menu = box(placement, 500);

    expect(200 + menu.bottom).toBeLessThanOrEqual(600);
    expect(100 + menu.left + menu.width).toBeLessThanOrEqual(800);
  });

  it("measures from inside the frame's border", () => {
    const token = { left: 140, top: 230, bottom: 250 };
    const plain = placeMenuAtCaret(frame(), token, VIEWPORT);
    const bordered = placeMenuAtCaret(frame({ clientLeft: 2, clientTop: 3 }), token, VIEWPORT);

    expect(bordered.left).toBe(plain.left - 2);
    expect(bordered.top).toBe(plain.top! - 3);
  });

  it("stays at the frame's edge when the token has scrolled out of it", () => {
    const token = { left: 140, top: 100, bottom: 120 };
    const placement = placeMenuAtCaret(frame(), token, VIEWPORT);
    const menu = box(placement, 500);

    expect(placement.side).toBe("below");
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.bottom).toBeLessThanOrEqual(500);
  });
});
