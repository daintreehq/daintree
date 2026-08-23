import type { InputBarColors } from "@/utils/terminalTheme";
import {
  blend,
  contrast,
  GRAPHIC_FLOOR,
  isDarkGround,
  parse,
  quantize,
  readable,
  readableOn,
  TEXT_FLOOR,
  tintWithin,
  toHex,
  type RGB,
} from "@/utils/colorContrast";

/**
 * The assistant panel's palette, derived from the TERMINAL theme with contrast floors.
 *
 * ## Why the panel has its own palette at all
 *
 * It paints on the terminal's ground, so it must take its ink from the terminal too.
 * The panel used to mix the two — background from the terminal theme, text and surfaces
 * from the app's design tokens — and those are independently chosen. A light app theme
 * with a dark terminal produced dark app ink on a dark terminal ground: the answer
 * measured 1.03:1 against its own background. Not hard to read. Invisible.
 *
 * ## Why the tiers are COMPUTED rather than mixed by a fixed percentage
 *
 * The first fix expressed each tier as a fixed blend — secondary at 74% of the
 * foreground, dim at 52%. That reads well on a theme with headroom and fails silently on
 * one without, because a percentage cannot know what it is standing on:
 *
 *   - Solarized Light's own foreground is `#657b83` on `#fdf6e3` — 4.13:1, ALREADY under
 *     the body floor before anything is derived from it. 74% of it lands at ~2.7:1 and
 *     52% at ~2.0:1.
 *   - ANSI yellow is the warning colour, and on Ayu Light it is `#f2ae49` on `#fafafa` —
 *     1.84:1. That is the colour a rate-limit notice and a stalled-turn warning are
 *     painted in.
 *
 * So each readable tier states the ratio it needs and is walked toward black or white
 * (whichever direction the background makes contrast increase) until it gets there. A
 * colour that already clears its floor is returned UNTOUCHED, so a well-designed theme
 * renders exactly as its author drew it and only a failing one is corrected.
 *
 * ## What the floors are, and why they are measured against the INSET surface
 *
 * 4.5:1 for anything that must be read, 3:1 for icons and focus rings (the WCAG
 * non-text floor), and no floor at all for surfaces and rules, which carry no meaning
 * on their own.
 *
 * They are measured against `inset` rather than the panel's own ground because inset is
 * the WORST case: it is mixed toward the foreground, so it is the surface every ink sits
 * least well on. A tier that clears its floor there clears it everywhere in the panel.
 */

/** Daintree's mark green — the CLI's SPLASH_COLOR_FULL, kept as the brand hue. */
const MARK_GREEN: RGB = [0x36, 0xce, 0x94];

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/**
 * How far past the floor a CORRECTED ink is pushed.
 *
 * Only applies to a theme that failed the floor on its own, and exists so the surfaces
 * capped against that ink still have room to lift off the ground.
 */
const INK_MARGIN = 1.2;

export interface AssistantPalette extends Record<string, string> {
  "--assistant-fg": string;
  "--assistant-surface": string;
}

/**
 * Builds the panel's custom properties from a resolved terminal theme.
 *
 * Everything is emitted as a concrete `#rrggbb` rather than a `color-mix()` expression,
 * so the values can be ASSERTED. `palette.contract.test.ts` walks every shipped terminal
 * scheme and checks each floor, which is only possible because the answer is a number
 * here rather than something the browser resolves later.
 */
export function buildAssistantPalette(term: InputBarColors): AssistantPalette {
  const fg = parse(term.foreground) ?? [204, 204, 204];
  const bg = parse(term.background) ?? [30, 30, 30];

  // The direction surfaces are lifted away from the ground.
  //
  // The foreground normally, and the opposite POLE when the theme gives us nothing to
  // lift toward — a theme declaring the same colour for both (a broken import, a
  // half-written custom scheme) would otherwise produce five surfaces identical to the
  // ground, so the panel would lose every card, rule and inset edge while its text was
  // still being corrected to something legible. Structure should degrade last.
  const lift = contrast(fg, bg) > 1.05 ? fg : isDarkGround(bg) ? WHITE : BLACK;

  // PRIMARY INK FIRST, against the panel's own ground — then the surfaces are capped so
  // it stays legible on them.
  //
  // The other order does not work, and the reason is worth stating because it looked
  // fine for a long time. Surfaces are the ground lifted TOWARD the foreground, so they
  // sit between the two: on a mid-grey ground with white text the raw pair passes at
  // 5.1:1, while the inset surface — lighter still — leaves only 3.7:1. Solve the ink
  // against inset and it flips to near-black, which then fails against the ground at
  // 3.6:1. Solve it against the ground and it fails on inset. There is no ink that
  // serves both, because the SURFACES have taken all the headroom.
  //
  // So the surface is what gives way. `tintWithin` takes as much lift as body text can
  // afford and no more, which on a normal theme is the whole of it (the ground is far
  // from the ink and a 7% lift costs nothing) and on a cramped one is less. A slightly
  // flatter card is a fair price for a legible one.
  // One POLE for the whole palette, chosen from the panel's own ground.
  //
  // Every correction below pulls the same way. Letting each ink pick its own pole per
  // ground looks more precise and is worse: the surfaces straddle the black/white
  // crossover on a mid-grey theme, so one pass corrects toward white for the ground and
  // the next corrects back toward black for the inset, and the ink oscillates between
  // them until the pass cap stops it somewhere that satisfies neither.
  const pole = isDarkGround(bg) ? WHITE : BLACK;

  // Primary ink, corrected with MARGIN rather than to the bare floor.
  //
  // A theme whose own foreground already clears the floor is left exactly as its author
  // drew it. One that does not is pushed past the floor, not onto it — because the
  // surfaces below are then capped to keep this ink legible on them, and an ink sitting
  // at exactly 4.5:1 leaves them no room at all to lift off the ground. A degenerate
  // theme (foreground equal to background) is the extreme: corrected to precisely 4.5 it
  // flattens every card into the ground; corrected past it, the cards survive.
  const primary =
    contrast(fg, bg) >= TEXT_FLOOR ? quantize(fg) : readable(fg, bg, TEXT_FLOOR + INK_MARGIN, pole);
  const surface = (maxT: number): RGB => tintWithin(bg, lift, maxT, primary, TEXT_FLOOR);

  const raised = surface(0.07);
  const inset = surface(0.1);
  const hover = surface(0.09);
  // Borders and rules carry no text, so they keep their full lift — the cap exists to
  // protect what is READ on a surface, and nothing is read on a one-pixel rule.
  const border = blend(bg, lift, 0.16);
  const borderStrong = blend(bg, lift, 0.3);

  // EVERY ground an ink can land on. Correcting against just one is only safe while
  // they all sit on the same side of the ink, and they do not always — see `readableOn`.
  const grounds: readonly RGB[] = [bg, raised, inset];

  const ink = (color: string | undefined, fallback: RGB, floor = TEXT_FLOOR): RGB =>
    readableOn(parse(color ?? "") ?? fallback, grounds, floor, pole);
  // The two dimmer tiers keep the hierarchy where the theme has room for it, and give
  // it up rather than the floor where it does not.
  const secondary = readableOn(blend(primary, inset, 0.26), grounds, TEXT_FLOOR, pole);
  // Dim is DECORATION — a marker, a placeholder, an aria-hidden glyph — so it takes the
  // graphical floor. Nothing that has to be read may use it; that is pinned by the
  // contract test, which reads the usages rather than trusting this comment.
  const dim = readableOn(blend(primary, inset, 0.48), grounds, GRAPHIC_FLOOR, pole);

  const danger = ink(term.errorColor, [244, 71, 71]);
  const warning = ink(term.voiceCursor, [229, 192, 123]);
  const success = ink(term.successColor, [137, 209, 133]);
  const accent = ink(term.accent, [88, 166, 255]);

  return {
    "--assistant-fg": toHex(primary),
    "--assistant-fg-secondary": toHex(secondary),
    "--assistant-fg-dim": toHex(dim),
    "--assistant-surface": toHex(bg),
    "--assistant-raised": toHex(raised),
    "--assistant-inset": toHex(inset),
    "--assistant-hover": toHex(hover),
    "--assistant-border": toHex(border),
    "--assistant-border-strong": toHex(borderStrong),
    "--assistant-danger": toHex(danger),
    "--assistant-success": toHex(success),
    "--assistant-warning": toHex(warning),
    // A warning GROUND, not a warning ink. It sits UNDER the panel's own body text, so
    // its strength is solved against that text rather than fixed: a 12% wash reads as
    // nothing on one theme and costs body text a quarter of a point of contrast on
    // another. `tintWithin` takes as much of it as the floor allows and no more.
    "--assistant-warning-surface": toHex(tintWithin(bg, warning, 0.12, primary, TEXT_FLOOR)),
    "--assistant-accent": toHex(accent),
    // Icons and focus rings take the graphical floor rather than the text one, so they
    // stay recognisably the theme's own colours instead of being pushed to near-black
    // or near-white by a floor written for prose.
    "--assistant-danger-graphic": toHex(ink(term.errorColor, [244, 71, 71], GRAPHIC_FLOOR)),
    "--assistant-warning-graphic": toHex(ink(term.voiceCursor, [229, 192, 123], GRAPHIC_FLOOR)),
    "--assistant-success-graphic": toHex(ink(term.successColor, [137, 209, 133], GRAPHIC_FLOOR)),
    "--assistant-focus": toHex(ink(term.accent, [88, 166, 255], GRAPHIC_FLOOR)),
    // The boot mark. Daintree's own green, corrected to the graphical floor — the raw
    // #36ce94 is 1.93:1 on a light terminal ground, and a logo nobody can see is not
    // branding, it is a blank pane while the engine connects.
    "--assistant-mark": toHex(readableOn(MARK_GREEN, grounds, GRAPHIC_FLOOR, pole)),
    "--assistant-mark-partial": toHex(
      readableOn(blend(MARK_GREEN, inset, 0.28), grounds, GRAPHIC_FLOOR - 0.6, pole)
    ),
  };
}
