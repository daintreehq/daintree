// Codex 0.154's composer draws an ambient "sparkle" field — a grid of braille
// dots that fade in and out behind the prompt at ~15 fps, forever, whether or
// not the agent is doing anything. It only switches on once the host answers
// the terminal's colour/DA queries, which Daintree does (OscResponder), so we
// see it and a bare `codex` in a dumb harness does not: ~13 KB/s of PTY traffic
// out of an idle agent.
//
// That traffic is indistinguishable from work to three activity gates:
// `isStatusLineRewrite` matches any braille code point, the simple-output byte
// bucket counts the glyphs, and the viewport temperature model sees dozens of
// changed cells per frame. The agent therefore reports "working" forever, and
// — because a status-line rewrite suppresses pattern detection — its *real*
// working/completion patterns stop being read.
//
// Each particle write is structurally exact, and was verified against a real
// captured session (9.7k draws): an optional absolute cursor position, an SGR
// setting a 24-bit ACHROMATIC foreground (r == g == b, a 90-step grey ramp from
// 36 to 125), then a single braille code point with AT MOST ONE DOT SET.
//
// That last constraint is what keeps spinners safe. Braille spinners cycle
// multi-dot frames (⠋⠙⠹⠸⠼⠴⠦⠧), never the one-dot patterns, and they are drawn
// in an accent colour rather than a grey ramp — so a spinner frame matches
// neither half of the rule. Spinner frames remain valid liveness evidence, per
// the same contract IdleSequenceFilter documents.
//
// Stripping is gated on seeing MIN_PARTICLE_DRAWS styled draws in one chunk: a
// status line emits one braille glyph per frame, a particle field emits dozens.
// Only once a chunk has proven itself a particle field does the second pass mop
// up draws that inherit the previous SGR instead of restating it.
//
// Like IdleSequenceFilter, this only ever feeds activity classification — the
// renderer is handed the untouched PTY bytes, so the sparkles still render.
// Quantifiers are bounded, so the patterns are ReDoS-safe against a hostile
// PTY peer.

// Braille patterns with at most one of the eight dots set: U+2800 plus the
// eight single-dot cells.
const PARTICLE_GLYPH_CLASS = "\\u2800\\u2801\\u2802\\u2804\\u2808\\u2810\\u2820\\u2840\\u2880";
const CUP = "(?:\\x1b\\[\\d{1,4};\\d{1,4}H)?";

// `(\d{1,3});\1;\1` is the achromatic test: Codex writes the same decimal for
// all three channels, so a backreference is both exact and cheaper than
// parsing. The optional trailing `48;2;...` is the field's flat backdrop.
const STYLED_PARTICLE = new RegExp(
  `${CUP}\\x1b\\[38;2;(\\d{1,3});\\1;\\1(?:;48;2;\\d{1,3};\\d{1,3};\\d{1,3})?m[${PARTICLE_GLYPH_CLASS}]`,
  "gu"
);
// node-pty's ~1 KB reads split a frame at arbitrary bytes. When the cut lands
// inside a particle's SGR, the next chunk opens with the parameter tail and
// the glyph it coloured — never text, and the achromatic check is simply
// unavailable. It counts toward the density gate like a styled draw, so a
// frame tail that also carries a couple of intact draws still clears it.
const SPLIT_STYLED_PARTICLE = new RegExp(`^[0-9;]{0,32}m[${PARTICLE_GLYPH_CLASS}]`, "u");
// A glyph with a foreground-colour SGR of its own right before it — directly,
// or with a cursor move in between — is not an inherited draw: pass 1 already
// consumed every achromatic one, so what is left carrying its own colour is
// chromatic and may be somebody's indicator. Density says nothing about it, so
// the mop-up must leave it alone. Every way a foreground colour can be set
// counts — 16-colour (`31m`, `91m`), 256-colour (`38;5;Nm`), truecolour
// (`38;2;r;g;bm`) — as long as it is the SGR's final parameter group. A reset
// (`\x1b[0m`) or default-fg (`39m`) before an inherited draw is still just an
// inherited draw. Attribute params may sit on either side of the colour
// (`1;31m`, `31;1m`).
const FG_COLOUR_SGR =
  "\\x1b\\[(?:[0-9;]{0,32};)?(?:3[0-7]|9[0-7]|38;5;\\d{1,3}|38;2;\\d{1,3};\\d{1,3};\\d{1,3})(?:;[0-9;]{0,16})?m";
const BARE_PARTICLE = new RegExp(
  `(?<!${FG_COLOUR_SGR})(?<!${FG_COLOUR_SGR}\\x1b\\[\\d{1,4};\\d{1,4}H)[${PARTICLE_GLYPH_CLASS}]`,
  "gu"
);

const MIN_PARTICLE_DRAWS = 3;
/**
 * Viewport-level analogue of the byte-path density gate: grey one-dot cells
 * are dropped from the activity snapshot only when the viewport holds at least
 * this many, so a lone glyph that is some CLI's whole indicator still counts
 * as content while a particle field (dozens per frame) does not.
 */
export const MIN_PARTICLE_CELLS = MIN_PARTICLE_DRAWS;

const PARTICLE_CODE_POINTS = new Set([
  0x2800, 0x2801, 0x2802, 0x2804, 0x2808, 0x2810, 0x2820, 0x2840, 0x2880,
]);

/**
 * Remove an ambient particle-animation frame from a PTY chunk before activity
 * gates measure it. Returns `data` unchanged unless the chunk contains at least
 * `MIN_PARTICLE_DRAWS` styled particle writes.
 */
export function stripCosmeticParticles(data: string): string {
  // Every styled draw carries a 24-bit SGR; a split one leaves its tail at the
  // chunk start. Skip the passes when neither is present.
  const splitDraw = SPLIT_STYLED_PARTICLE.test(data);
  if (!splitDraw && !data.includes("\x1b[38;2;")) {
    return data;
  }
  let draws = splitDraw ? 1 : 0;
  let stripped = data.replace(STYLED_PARTICLE, () => {
    draws += 1;
    return "";
  });
  if (draws < MIN_PARTICLE_DRAWS) {
    return data;
  }
  if (splitDraw) {
    stripped = stripped.replace(SPLIT_STYLED_PARTICLE, "");
  }
  return stripped.replace(BARE_PARTICLE, "");
}

// xterm's attribute-word colour mode for a 24-bit foreground, the value both
// `IBufferCell.getFgColorMode()` and the raw `fg & COLOR_MODE_MASK` produce.
export const PARTICLE_FG_COLOR_MODE = 0x3000000;

/**
 * Cell-level counterpart for the viewport snapshot, which reads xterm's buffer
 * rather than the byte stream and so cannot use the per-chunk density gate. A
 * grey one-dot braille cell carries no work-progress information on its own.
 */
export function isCosmeticParticleCell(
  codePoint: number | undefined,
  fgColorMode: number,
  fgColor: number
): boolean {
  if (codePoint === undefined || (codePoint & ~0xff) !== 0x2800) {
    return false;
  }
  if (fgColorMode !== PARTICLE_FG_COLOR_MODE || fgColor < 0) {
    return false;
  }
  const red = (fgColor >>> 16) & 0xff;
  const green = (fgColor >>> 8) & 0xff;
  return red === green && green === (fgColor & 0xff) && PARTICLE_CODE_POINTS.has(codePoint);
}
