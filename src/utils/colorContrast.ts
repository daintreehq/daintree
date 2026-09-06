/**
 * Colour maths: parsing, WCAG luminance and contrast, and contrast-directed correction.
 *
 * Lives here rather than beside its first consumer because two very different callers
 * need it — the assistant panel's palette (`src/components/AssistantPanel/palette.ts`)
 * and the terminal input bar's own shell colours (`terminalTheme.ts`) — and because
 * everything in it is pure arithmetic on numbers. That purity is the point: it can be
 * asserted directly, which is what makes a contrast floor a CONTRACT rather than a
 * comment.
 */

export type RGB = readonly [number, number, number];

/** The two poles every correction walks toward. */
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** WCAG's floor for text that must be read. */
export const TEXT_FLOOR = 4.5;
/** WCAG's floor for non-text: icons, rules that carry state, focus rings. */
export const GRAPHIC_FLOOR = 3;

/**
 * Whether a background is dark enough that ink should go lighter to gain contrast.
 *
 * Answered by COMPARING the two poles rather than by thresholding luminance. The
 * crossover is `sqrt(0.0525) - 0.05 ≈ 0.17913`, and rounding it to 0.18 picks the wrong
 * pole for grounds inside that sliver — a ground at 0.1795 was sent toward white when
 * black had more room. Comparing costs two multiplications and cannot be off by a
 * rounding decision.
 */
export function isDarkGround(bg: RGB): boolean {
  return contrast(WHITE, bg) >= contrast(BLACK, bg);
}

/**
 * A CSS colour as 8-bit channels, or null when it is not one this understands.
 *
 * Accepts exactly: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()` / `rgba()` with
 * comma, space or slash separators. Nothing else — no HSL, no named colours, no
 * percentage channels. Anything unrecognised returns null and the caller's fallback
 * stands, which is the right outcome for a theme with an exotic colour: a fallback is
 * visibly a fallback, where a misread colour is used as though it were right.
 *
 * Every expression is ANCHORED at both ends and the channel count is exact. Unanchored,
 * they matched a valid PREFIX — `#1234567` and `rgb(1,2,3)junk` came back as colours —
 * and a typo that resolves to a colour is the failure mode with no symptom.
 *
 * Alpha is accepted in the syntax and then IGNORED. These colours come from terminal
 * themes, which paint an opaque grid, and compositing a translucent one correctly needs
 * a ground this function is not given. Accepting `#rrggbbff` — which is simply opaque —
 * and dropping the channel is the honest half; refusing it would not be.
 */
export function parse(color: string): RGB | null {
  const text = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(text);
  if (short) {
    return [
      Number.parseInt(short[1]!.repeat(2), 16),
      Number.parseInt(short[2]!.repeat(2), 16),
      Number.parseInt(short[3]!.repeat(2), 16),
    ];
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(text);
  if (long) {
    return [
      Number.parseInt(long[1]!, 16),
      Number.parseInt(long[2]!, 16),
      Number.parseInt(long[3]!, 16),
    ];
  }
  const rgb = /^rgba?\(\s*([^)]*?)\s*\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!
      .split(/\s*[,/]\s*|\s+/)
      .filter((p) => p !== "")
      .map(Number);
    // Exactly three channels, or three plus an alpha. Four-and-a-half is a typo, and a
    // typo must not resolve to a colour.
    if ((parts.length === 3 || parts.length === 4) && parts.every((n) => Number.isFinite(n))) {
      // CLAMPED, not trusted. `rgb(-10,-10,-10)` is out of gamut, and an out-of-range
      // channel propagates through every blend and luminance downstream —
      // `rgb(1e308,…)` reaches infinite luminance and a NaN contrast ratio, which makes
      // every `>=` comparison false and silently drives correction to the extreme.
      return quantize([parts[0]!, parts[1]!, parts[2]!]);
    }
  }
  return null;
}

export function toHex([r, g, b]: RGB): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

/** One channel, linearised out of sRGB's transfer curve. */
function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1:1 to 21:1. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function blend(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * `base`, darkened or lightened just far enough to clear `target` against `bg`.
 *
 * Returns `base` unchanged when it already clears the floor — the common case on a
 * well-designed theme, and the reason this corrects failures without flattening every
 * theme into the same two greys.
 *
 * The direction is decided by the BACKGROUND, not by the base: on a light ground the
 * only way to gain contrast is to go darker, whatever colour we started from. Solved by
 * bisection rather than a formula because contrast is not linear in the blend factor,
 * and 16 iterations resolves it to well under one 8-bit step.
 */
export function readable(base: RGB, bg: RGB, target: number, forcePole?: RGB): RGB {
  const ground = quantize(bg);
  const start = quantize(base);
  if (contrast(start, ground) >= target) return start;
  const pole = forcePole ?? (isDarkGround(ground) ? WHITE : BLACK);
  // Even the pole may not reach the target — white on a mid-grey ground tops out around
  // 5:1. Returning the pole is then the most legible colour that exists, which is the
  // honest answer; the theme itself is what cannot be fixed from here.
  if (contrast(pole, ground) < target) return pole;
  // Bisect on the QUANTIZED colour, not the continuous one. Rounding to 8 bits at the
  // end can shave a hundredth off the ratio, which is enough to land a corrected ink at
  // 4.48:1 — under the floor the correction existed to clear, and by an amount no one
  // would ever spot by eye. Measuring what actually ships closes that gap.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(quantize(blend(start, pole, mid)), ground) >= target) hi = mid;
    else lo = mid;
  }
  // `hi` starts at the pole — which is known to satisfy the target, or we returned
  // above — and only ever moves to a midpoint that also satisfies it. So the result is
  // passing by construction; the re-check is a cheap assertion of that invariant rather
  // than a fallback anyone expects to fire.
  const solved = quantize(blend(start, pole, hi));
  return contrast(solved, ground) >= target ? solved : pole;
}

/** The colour as it will actually be written: 8 bits per channel, clamped. */
export function quantize([r, g, b]: RGB): RGB {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return [c(r), c(g), c(b)];
}

/**
 * A tint of `color` over `bg`, no stronger than `maxT`, that `ink` stays legible on.
 *
 * A tinted ground is a BACKGROUND with an opinion, not a colour in its own right: an
 * approval card's warning wash sits under the panel's own body text, so however much
 * the tint wants to say, the text on top of it has to keep clearing its floor.
 *
 * Solved rather than guessed because the safe strength depends on all three colours.
 * A 12% wash of ANSI yellow is invisible on one theme and takes body text from 4.6:1 to
 * 4.3:1 on another, and the difference is not something a fixed percentage can know.
 */
export function tintWithin(bg: RGB, color: RGB, maxT: number, ink: RGB, floor: number): RGB {
  const ground = quantize(bg);
  const full = quantize(blend(ground, color, maxT));
  if (contrast(ink, full) >= floor) return full;
  // NO TINT is the floor of this search, and it is checked rather than assumed: the
  // bisection below only ever moves `lo` to a tint it has PROVED passes, so without this
  // it would return `t = 0` as though it had been verified.
  //
  // PRECONDITION, stated because it cannot be enforced from in here: `ink` must already
  // clear `floor` against `bg`. When it does not, no tint of any strength can help — the
  // ground itself is the problem — and the least-bad answer is the bare ground, which is
  // what comes back. Solve the ink first (`readable`/`readableOn`) and this branch is
  // unreachable, which is how `palette.ts` uses it.
  if (contrast(ink, ground) < floor) return ground;
  let lo = 0;
  let hi = maxT;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(ink, quantize(blend(ground, color, mid))) >= floor) lo = mid;
    else hi = mid;
  }
  // `lo` is the strongest tint PROVED to clear the floor. Bisection assumes contrast
  // falls monotonically as the tint strengthens, which holds for the shallow washes this
  // is used for; where it does not, the answer is merely conservative — a weaker tint
  // than the true maximum, never an illegible one.
  return quantize(blend(ground, color, lo));
}

/**
 * `base`, corrected until it clears `target` against EVERY ground it can land on.
 *
 * Correcting against one ground and hoping the rest follow is only safe while all the
 * grounds sit on the same side of the ink, and they do not always: with a mid-grey
 * background and a white foreground, the raw pair already passes, but the INSET surface
 * (mixed toward the foreground, so lighter still) pushed the correction the other way
 * and produced a near-black primary that then failed against the panel's own ground at
 * 3.6:1. Solved for one surface, broken on another, and the arithmetic looked right the
 * whole time.
 *
 * So each pass finds the ground the ink currently reads WORST against and corrects for
 * that one. Every correction moves toward a pole, which raises contrast against every
 * ground on the far side of it, so the worst case can only improve — the loop settles
 * in two or three passes and is capped so a pathological theme cannot spin.
 *
 * `forcePole` is what makes that convergence guarantee real when the grounds straddle
 * the black/white crossover. Left to choose per ground, one pass corrects toward white
 * for the darkest ground and the next corrects back toward black for the lightest, and
 * the ink oscillates until the cap stops it — arriving somewhere that satisfies
 * neither. Pass the pole chosen ONCE from the panel's own ground and every pass pulls
 * the same way.
 */
export function readableOn(
  base: RGB,
  grounds: readonly RGB[],
  target: number,
  forcePole?: RGB
): RGB {
  if (grounds.length === 0) return quantize(base);
  let ink = quantize(base);
  for (let pass = 0; pass < 6; pass++) {
    let worst = grounds[0]!;
    for (const ground of grounds) {
      if (contrast(ink, ground) < contrast(ink, worst)) worst = ground;
    }
    if (contrast(ink, worst) >= target) break;
    const next = readable(ink, worst, target, forcePole);
    // No movement means the pole itself cannot reach the target against that ground;
    // another pass would find the same answer.
    if (next[0] === ink[0] && next[1] === ink[1] && next[2] === ink[2]) break;
    ink = next;
  }
  return ink;
}
