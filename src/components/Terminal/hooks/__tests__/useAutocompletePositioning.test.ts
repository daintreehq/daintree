import { describe, expect, it } from "vitest";
import { placeMenuAtCaret } from "../useAutocompletePositioning";

const VIEWPORT = { width: 1600, height: 1000 };

/** An Expanded Editor frame at (100, 200), 1000 × 500 on screen. */
function frame(
  overrides: Partial<{ clientLeft: number; clientTop: number; scale: number }> = {}
) {
  const scale = overrides.scale ?? 1;
  const clientTop = overrides.clientTop ?? 0;
  return {
    rect: { left: 100, top: 200, right: 100 + 1000 * scale, bottom: 200 + 500 * scale },
    clientLeft: overrides.clientLeft ?? 0,
    clientTop,
    clientHeight: 500 - 2 * clientTop,
    scaleX: scale,
    scaleY: scale,
  };
}

/** A token on one line. */
function token(left: number, top: number, bottom = top + 20) {
  return { left, top, bottom, lastTop: top, lastBottom: bottom };
}

/** The menu's box in the frame's padding box, at its tallest. */
function box(placement: ReturnType<typeof placeMenuAtCaret>, frameHeight = 500) {
  const height = placement.maxHeight ?? 0;
  const top =
    placement.side === "below" ? placement.top! : frameHeight - placement.bottom! - height;
  // The menu's own 420px, narrowed to what it is allowed.
  const width = Math.min(420, placement.maxWidth ?? 0);
  return { top, bottom: top + height, height, left: placement.left, width };
}

describe("placeMenuAtCaret", () => {
  it("opens below a token near the top of the editor, inside the frame", () => {
    const at = token(140, 230);
    const placement = placeMenuAtCaret(frame(), at, VIEWPORT);
    const menu = box(placement);

    expect(placement.side).toBe("below");
    expect(menu.top).toBeGreaterThanOrEqual(at.bottom - 200);
    expect(menu.bottom).toBeLessThanOrEqual(500);
    // Most of the frame is below the token, and the menu may take it.
    expect(menu.height).toBeGreaterThan(250);
    expect(placement.left).toBe(at.left - 100);
  });

  it("opens above a token near the foot of the editor, clear of its line", () => {
    const at = token(140, 640);
    const placement = placeMenuAtCaret(frame(), at, VIEWPORT);
    const menu = box(placement);

    expect(placement.side).toBe("above");
    expect(menu.bottom).toBeLessThanOrEqual(at.top - 200);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.height).toBeGreaterThan(250);
  });

  it("clears every line of a token whose query wraps", () => {
    const at = { left: 140, top: 230, bottom: 290, lastTop: 270, lastBottom: 290 };
    const placement = placeMenuAtCaret(frame(), at, VIEWPORT);

    expect(placement.side).toBe("below");
    expect(placement.top).toBeGreaterThanOrEqual(at.bottom - 200);
  });

  it("opens off the last line of a token wrapped past both edges of the frame", () => {
    const at = { left: 140, top: 50, bottom: 900, lastTop: 400, lastBottom: 420 };
    const placement = placeMenuAtCaret(frame(), at, VIEWPORT);
    const menu = box(placement);

    expect(menu.height).toBeGreaterThan(64);
    if (placement.side === "below") expect(menu.top).toBeGreaterThanOrEqual(at.lastBottom - 200);
    else expect(menu.bottom).toBeLessThanOrEqual(at.lastTop - 200);
  });

  it("shifts left to stay inside the frame at its right edge", () => {
    const at = token(1050, 230);
    const menu = box(placeMenuAtCaret(frame(), at, VIEWPORT));

    expect(menu.left).toBeLessThan(at.left - 100);
    expect(menu.left + menu.width).toBeLessThanOrEqual(1000);
  });

  it("shifts left and up to stay in a window that ends before the frame", () => {
    const at = token(700, 230);
    const viewport = { width: 800, height: 600 };
    const menu = box(placeMenuAtCaret(frame(), at, viewport));

    expect(100 + menu.left).toBeLessThan(at.left);
    expect(100 + menu.left + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(200 + menu.bottom).toBeLessThanOrEqual(viewport.height);
  });

  it("measures from inside the frame's border", () => {
    const at = token(140, 230);
    const plain = placeMenuAtCaret(frame(), at, VIEWPORT);
    const bordered = placeMenuAtCaret(frame({ clientLeft: 2, clientTop: 3 }), at, VIEWPORT);

    expect(bordered.left).toBe(plain.left - 2);
    expect(bordered.top).toBe(plain.top! - 3);
  });

  // A trigger typed while the dialog scales in is measured on a smaller frame.
  it("places the menu the same while the frame is scaled", () => {
    const at = token(140, 230);
    const scale = 0.98;
    const onScreen = (x: number, origin: number) => origin + (x - origin) * scale;
    const scaledAt = token(onScreen(at.left, 100), onScreen(at.top, 200), onScreen(at.bottom, 200));

    const plain = placeMenuAtCaret(frame(), at, VIEWPORT);
    const scaled = placeMenuAtCaret(frame({ scale }), scaledAt, VIEWPORT);

    expect(scaled.side).toBe(plain.side);
    expect(scaled.left).toBeCloseTo(plain.left);
    expect(scaled.top!).toBeCloseTo(plain.top!);
  });

  it("stays at the frame's edge when the token has scrolled out of it", () => {
    const at = token(140, 100);
    const placement = placeMenuAtCaret(frame(), at, VIEWPORT);
    const menu = box(placement);

    expect(placement.side).toBe("below");
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.bottom).toBeLessThanOrEqual(500);
    expect(menu.height).toBeGreaterThan(250);
  });
});
