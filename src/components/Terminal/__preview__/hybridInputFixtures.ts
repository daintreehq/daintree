/**
 * Fixtures for the hybrid-input layout harness.
 *
 * The composer's layout is decided by two things the component itself cannot be
 * asked for: how wide its column is, and how many lines the draft wraps to. In
 * the app both come from the grid — a pane's width is whatever the splits leave
 * it, and the wrap point follows from that width. So the fixtures here are
 * (width × draft) pairs rather than component states.
 */

/** Column widths, in px, spanning the range the content grid actually produces. */
export const WIDTHS = [1100, 720, 520, 420, 360, 300, 260, 220] as const;

export type Width = (typeof WIDTHS)[number];

/**
 * The draft from the reported screenshot. Long enough to wrap to three lines at
 * a middling width, which is the case where centred trailing buttons sit beside
 * the middle line and the first and last lines run into dead space.
 */
export const REPORTED_DRAFT =
  "Thisa dias dasd naslknf asdkljnf kdlsjan klajsnd vclkjnasd cklnjsdc klsdanc sldknc sdlkacn sadlknc dssdc sdnalcds";

export const DRAFTS = {
  empty: "",
  short: "Fix the test",
  /** Exactly the reported case. */
  reported: REPORTED_DRAFT,
  /** Past the 160px / 8-line autosize cap, so the editor scrolls internally. */
  overflow: Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long standing draft`).join(
    "\n"
  ),
  /** The second reported case, from the Daintree Assistant sidebar: three lines at ~430px. */
  sidebar:
    "afsJ FDASLJHF ADSKJHF SDA F JDSKAFH SAD FSADH FKJDSHAF DSKJFH SDAKJFHSD KAFHKDSJ FHKJASDFHDSAK JFHAKSDJFH DSAKHF DSKJFHASDKFH DASKFA",
} as const;

export type DraftName = keyof typeof DRAFTS;

/** Resolves a `?draft=` query value, falling back to the reported case. */
export function resolveDraft(name: string | null): string {
  const byName: Record<string, string | undefined> = DRAFTS;
  return (name === null ? undefined : byName[name]) ?? DRAFTS.reported;
}

/**
 * Agents for the tile view, so the placeholders differ the way they do in a real
 * fleet. Ten distinct ones: two tiles reading the same placeholder is a fixture
 * artefact that reads as a rendering bug in review.
 */
export const TILE_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "aider",
  "opencode",
  "grok",
  "copilot",
  "goose",
  "amp",
] as const;
