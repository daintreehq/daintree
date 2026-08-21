import { hexToRgb } from "./contrast.js";

/**
 * APCA-W3 (`0.98G-4g-W3`) perceptual lightness contrast.
 *
 * Used where WCAG 2.x relative luminance is the wrong instrument: ranking two
 * states of the *same* hue against the *same* backdrop. WCAG's ratio is a
 * ratio of luminances, so it compresses hard at the dark end — a step that
 * reads as one notch on a light theme reads as three on a dark one — and it
 * has no polarity term at all, which is exactly the axis a dark/light theme
 * pair differs on. APCA models both, so a fixed Lc step is a fixed perceived
 * step in either polarity.
 *
 * This is a scale, not a floor. WCAG 1.4.11 stays the accessibility contract
 * (`contrastRatio`); Lc only decides how far apart two states sit on it.
 */

const MAIN_TRC = 2.4;
const S_RCO = 0.2126729;
const S_GCO = 0.7151522;
const S_BCO = 0.072175;

const NORM_BG = 0.56;
const NORM_TXT = 0.57;
const REV_TXT = 0.62;
const REV_BG = 0.65;

const BLK_THRS = 0.022;
const BLK_CLMP = 1.414;
const SCALE_BOW = 1.14;
const SCALE_WOB = 1.14;
const LO_BOW_OFFSET = 0.027;
const LO_WOB_OFFSET = 0.027;
const DELTA_Y_MIN = 0.0005;
const LO_CLIP = 0.1;

/**
 * Screen luminance estimate, with APCA's soft black clamp folded in.
 *
 * Deliberately not `relativeLuminance` from `contrast.ts`: that one implements
 * the IEC 61966-2-1 piecewise transfer function WCAG 2.x specifies, while APCA
 * uses a plain 2.4 power curve plus a low-end clamp modelling screen flare.
 * Mixing the two would silently mis-scale every Lc.
 */
function screenLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const y =
    (r / 255) ** MAIN_TRC * S_RCO + (g / 255) ** MAIN_TRC * S_GCO + (b / 255) ** MAIN_TRC * S_BCO;
  return y > BLK_THRS ? y : y + (BLK_THRS - y) ** BLK_CLMP;
}

/**
 * Signed Lc: positive for dark-on-light, negative for light-on-dark. Callers
 * comparing weight across polarities want `Math.abs`; the sign is what tells
 * you which way a correction has to move.
 */
export function apcaContrast(foregroundHex: string, backgroundHex: string): number {
  const txtY = screenLuminance(foregroundHex);
  const bgY = screenLuminance(backgroundHex);
  if (Math.abs(bgY - txtY) < DELTA_Y_MIN) return 0;

  if (bgY > txtY) {
    const sapc = (bgY ** NORM_BG - txtY ** NORM_TXT) * SCALE_BOW;
    return sapc < LO_CLIP ? 0 : (sapc - LO_BOW_OFFSET) * 100;
  }

  const sapc = (bgY ** REV_BG - txtY ** REV_TXT) * SCALE_WOB;
  return sapc > -LO_CLIP ? 0 : (sapc + LO_WOB_OFFSET) * 100;
}

/** Unsigned perceived weight, which is what a target or a step is expressed in. */
export function apcaLc(foregroundHex: string, backgroundHex: string): number {
  return Math.abs(apcaContrast(foregroundHex, backgroundHex));
}
