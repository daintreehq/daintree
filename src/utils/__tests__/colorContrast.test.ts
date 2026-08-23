import { describe, expect, it } from "vitest";
import {
  blend,
  contrast,
  GRAPHIC_FLOOR,
  isDarkGround,
  luminance,
  parse,
  quantize,
  readable,
  readableOn,
  TEXT_FLOOR,
  tintWithin,
  toHex,
  type RGB,
} from "../colorContrast";

/**
 * The colour maths behind the assistant panel's contrast floors.
 *
 * Worth testing directly rather than only through the palette, because every one of
 * these has a failure mode with NO SYMPTOM: a misparsed colour is used as though it
 * were right, an off-by-a-thousandth crossover picks the wrong pole, and a solver that
 * returns just under its target ships text nobody can read while every assertion above
 * it passes.
 */

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

describe("parse", () => {
  it("reads the shapes it claims to", () => {
    expect(parse("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parse("#AABBCC")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parse("  #aabbcc  ")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parse("rgb(1,2,3)")).toEqual([1, 2, 3]);
    expect(parse("rgb( 1 , 2 , 3 )")).toEqual([1, 2, 3]);
    expect(parse("rgb(1 2 3)")).toEqual([1, 2, 3]);
    expect(parse("rgba(1 2 3 / 0.5)")).toEqual([1, 2, 3]);
  });

  it("accepts an alpha channel and drops it", () => {
    // These colours come from terminal themes, which paint an opaque grid. `#rrggbbff`
    // is simply opaque and must not be refused; compositing a translucent one correctly
    // needs a ground this function is not given.
    expect(parse("#aabbccff")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parse("#abcd")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parse("rgba(1,2,3,0.5)")).toEqual([1, 2, 3]);
  });

  it("refuses a valid PREFIX rather than reading a colour out of it", () => {
    // The regexes were unanchored, so each of these came back as a colour. A typo that
    // resolves to a colour is the failure mode with no symptom: nothing errors, the
    // wrong ground is painted, and every contrast check downstream is computed against
    // a value nobody chose.
    for (const junk of ["#1234567", "#123456zz", "rgb(1,2,3)junk", "rgb(1,2,3", "#12345"]) {
      expect(parse(junk), junk).toBeNull();
    }
  });

  it("refuses the wrong number of channels", () => {
    expect(parse("rgb(1,2)")).toBeNull();
    expect(parse("rgb(1,2,3,4,5)")).toBeNull();
    expect(parse("rgb()")).toBeNull();
    expect(parse("rgb(1,2,nope)")).toBeNull();
  });

  it("refuses what it does not understand rather than guessing", () => {
    for (const other of ["hsl(210 40% 12%)", "rebeccapurple", "rgb(100% 0% 0%)", "", "   "]) {
      expect(parse(other), other).toBeNull();
    }
  });

  it("clamps an out-of-gamut channel instead of letting it propagate", () => {
    // An out-of-range channel flows through every blend and luminance downstream.
    // `rgb(1e308,…)` reaches INFINITE luminance and a NaN contrast ratio, and NaN makes
    // every `>=` comparison false — so a correction silently runs to the extreme while
    // reporting that it could not reach its target.
    expect(parse("rgb(-10,-10,-10)")).toEqual([0, 0, 0]);
    expect(parse("rgb(300,300,300)")).toEqual([255, 255, 255]);
    const huge = parse("rgb(1e308,1e308,1e308)")!;
    expect(Number.isFinite(luminance(huge))).toBe(true);
    expect(Number.isFinite(contrast(huge, BLACK))).toBe(true);
  });
});

describe("contrast", () => {
  it("matches the WCAG extremes", () => {
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    const a: RGB = [12, 200, 90];
    const b: RGB = [200, 12, 90];
    expect(contrast(a, b)).toBeCloseTo(contrast(b, a), 10);
  });
});

describe("isDarkGround", () => {
  it("picks the pole with more room, exactly at the crossover", () => {
    // The crossover is `sqrt(0.0525) - 0.05 ≈ 0.17913`, not 0.18. A ground inside that
    // sliver was sent toward white when black had more room — a real difference of
    // about a tenth of a point of contrast, invisible to review and decisive to a floor.
    const sliver: RGB = [0, 108, 255];
    const lum = luminance(sliver);
    expect(lum).toBeGreaterThan(0.17913);
    expect(lum).toBeLessThan(0.18);
    expect(isDarkGround(sliver)).toBe(false);
    expect(contrast(BLACK, sliver)).toBeGreaterThan(contrast(WHITE, sliver));
  });

  it("agrees with the poles across the whole range", () => {
    for (let v = 0; v <= 255; v += 1) {
      const g: RGB = [v, v, v];
      expect(isDarkGround(g), `grey ${v}`).toBe(contrast(WHITE, g) >= contrast(BLACK, g));
    }
  });
});

describe("readable", () => {
  it("leaves a colour that already clears its target completely alone", () => {
    const base: RGB = [0x65, 0x7b, 0x83];
    expect(readable(base, WHITE, 3)).toEqual(base);
  });

  it("corrects one that does not, to at least the target", () => {
    // Solarized Light's own pair: 4.13:1 before correction.
    const fg: RGB = [0x65, 0x7b, 0x83];
    const bg: RGB = [0xfd, 0xf6, 0xe3];
    expect(contrast(fg, bg)).toBeLessThan(TEXT_FLOOR);
    const fixed = readable(fg, bg, TEXT_FLOOR);
    expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  it("clears the target for every grey ground, at both floors", () => {
    // The quantize-inside-the-bisection property. Rounding to 8 bits AFTER solving can
    // shave a hundredth off the ratio — enough to land a corrected ink at 4.49:1, under
    // the floor the correction existed to clear, by an amount no one would spot.
    for (let v = 0; v <= 255; v += 3) {
      const bg: RGB = [v, v, v];
      for (const target of [TEXT_FLOOR, GRAPHIC_FLOOR]) {
        const ink = readable([v, v, v], bg, target);
        const best = Math.max(contrast(WHITE, bg), contrast(BLACK, bg));
        // Where the target is reachable at all, it must actually be reached.
        if (best >= target) {
          expect(contrast(ink, bg), `grey ${v} @ ${target}`).toBeGreaterThanOrEqual(target);
        }
      }
    }
  });

  it("returns the most legible colour there is when the target is unreachable", () => {
    // 21:1 is only available against pure black or pure white. Against a mid grey the
    // best that exists is about 5:1, and the honest answer is that colour — not a
    // failure, and not a value pretending to clear a floor it cannot.
    const bg: RGB = [128, 128, 128];
    const ink = readable(bg, bg, 21);
    expect([toHex(WHITE), toHex(BLACK)]).toContain(toHex(ink));
    expect(contrast(ink, bg)).toBeCloseTo(Math.max(contrast(WHITE, bg), contrast(BLACK, bg)), 5);
  });
});

describe("readableOn", () => {
  it("clears the target against EVERY ground, not just the worst-looking one", () => {
    // The failure this exists for: correcting against one surface and failing another.
    // With a mid-grey ground and white text the raw pair passes at ~5.1:1, but a
    // surface mixed toward the foreground leaves less — and an ink solved for that
    // surface flips to near-black, which then fails against the ground itself.
    const bg: RGB = [0x6e, 0x6e, 0x6e];
    const grounds: RGB[] = [bg, blend(bg, WHITE, 0.03), blend(bg, WHITE, 0.05)].map((g) =>
      quantize(g)
    );
    const pole = isDarkGround(bg) ? WHITE : BLACK;
    const ink = readableOn(WHITE, grounds, TEXT_FLOOR, pole);
    for (const g of grounds) {
      expect(contrast(ink, g), `on ${toHex(g)}`).toBeGreaterThanOrEqual(TEXT_FLOOR);
    }
  });

  it("terminates rather than oscillating when the grounds straddle the crossover", () => {
    // Without a fixed pole, one pass corrects toward white for the darkest ground and
    // the next corrects back toward black for the lightest, and the ink ping-pongs until
    // the pass cap stops it somewhere that satisfies neither.
    const grounds: RGB[] = [quantize([0x40, 0x40, 0x40]), quantize([0xc0, 0xc0, 0xc0])];
    const ink = readableOn([0x80, 0x80, 0x80], grounds, GRAPHIC_FLOOR, BLACK);
    expect(ink.every((c) => Number.isFinite(c))).toBe(true);
  });

  it("returns the input untouched when there is nothing to correct", () => {
    expect(readableOn(BLACK, [WHITE], TEXT_FLOOR)).toEqual(BLACK);
    expect(readableOn(BLACK, [], TEXT_FLOOR)).toEqual(BLACK);
  });
});

describe("tintWithin", () => {
  it("takes the full tint when the ink can afford it", () => {
    const bg: RGB = [0x10, 0x10, 0x10];
    const full = quantize(blend(bg, [0xff, 0xd0, 0x40], 0.12));
    expect(tintWithin(bg, [0xff, 0xd0, 0x40], 0.12, WHITE, TEXT_FLOOR)).toEqual(full);
  });

  it("gives up tint rather than legibility", () => {
    // A tinted ground is a background with an opinion, not a colour in its own right:
    // however much the tint wants to say, the text on top of it keeps its floor.
    const bg: RGB = [0xfd, 0xf6, 0xe3];
    const ink = readable([0x65, 0x7b, 0x83], bg, TEXT_FLOOR);
    const tinted = tintWithin(bg, [0xb5, 0x89, 0x00], 0.4, ink, TEXT_FLOOR);
    expect(contrast(ink, tinted)).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  it("returns the bare ground when its precondition does not hold", () => {
    // Documented behaviour, not an accident: if the ink does not clear the floor on the
    // untinted ground, no tint of any strength can help — the ground is the problem.
    // Callers solve the ink first, which makes this unreachable for them.
    const bg: RGB = [0x20, 0x20, 0x20];
    expect(tintWithin(bg, WHITE, 0.2, bg, TEXT_FLOOR)).toEqual(bg);
  });
});
